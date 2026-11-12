import { getAuthedUser, mintWorkerToken, json, unauthorized, forbidden } from '../_lib/auth.js';
import { enrich } from '../_lib/enrichers.js';
import { route as moeRoute } from '../_lib/router.js';
import { MODEL_CATALOG, tierForModel, planAllowsTier, planSkipsQuota } from '../_lib/tiers.js';
import { canUse, recordUsage } from '../_lib/usage.js';
import { recordFingerprint } from '../_lib/fingerprint.js';
import { verifyCaptchaReceipt, captchaRequiredFor } from '../_lib/captcha.js';
import {
  waitAndClaimSharedLane,
  releaseSharedLane,
  getSharedLaneStatus,
  usesSharedLane,
  SHARED_LANE_MAX_WAIT_MS,
} from '../_lib/shared-lane.js';

// Server-side jailbreak gate — client can't disable this by editing JS.
const JAILBREAK_PATTERNS = [
  /ignore\s+(all\s+|the\s+|your\s+|any\s+)*(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?)/i,
  /disregard\s+(all\s+|the\s+|your\s+)*(instructions?|rules?|guidelines?)/i,
  /forget\s+(everything|all\s+(previous|above)|your\s+(rules|instructions))/i,
  /you\s+are\s+(now\s+)?(DAN|BasedGPT|AIM|STAN|DUDE|JAILBREAK|evil[-\s]?gpt)/i,
  /(do\s+anything\s+now|DAN\s+mode|developer\s+mode|god\s+mode|unrestricted\s+mode|jailbreak\s+mode)/i,
  /pretend\s+(you|to\s+be|that\s+you).{0,40}(no\s+restrictions|unrestricted|no\s+rules|no\s+limits)/i,
  /act\s+as\s+(an?\s+)?(unrestricted|uncensored|unfiltered|amoral|jailbroken)/i,
  /\[(SYSTEM|INST|ADMIN|SUDO)\]|\<\|im_start\|\>|\<\|system\|\>/i,
  /override\s+(your\s+)?(safety|guidelines|rules|instructions)/i,
  /bypass\s+(your\s+)?(restrictions|safety|guidelines|filters)/i,
  /(my|a)\s+(dead\s+|late\s+)?(grandma|grandmother).{0,80}(tell|read|recite|bedtime|used\s+to)/i,
  /from\s+now\s+on\s+you\s+(will|must|are)\s+(ignore|disregard|act|behave|pretend)/i,
  /reveal\s+(your|the)\s+(system\s+prompt|instructions|hidden\s+rules)/i,
];
function detectJailbreakServer(text) {
  if (!text) return null;
  for (const re of JAILBREAK_PATTERNS) { const m = text.match(re); if (m) return m[0]; }
  return null;
}

export async function onRequestPost({ request, env }) {
  const user = await getAuthedUser(request, env);
  if (!user) return unauthorized('please sign in');

  // Muted accounts can read their chats but can't send. Keeps their
  // history intact but stops new messages hitting the models.
  if (user.muted) {
    return forbidden(user.moderation_note || 'Your account has been restricted from sending messages.');
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid JSON' }, { status: 400 }); }

  // Captcha gate — everyone except paid Plus must submit a fresh captcha
  // receipt. Free + unlimited-grant users all go through it so the founder's
  // Workers AI cost is offset by hCaptcha Publisher revenue. Receipts live
  // 10 minutes so users don't solve one per message — the frontend shows a
  // captcha when there's no receipt or it has expired.
  if (captchaRequiredFor(user.plan)) {
    const check = await verifyCaptchaReceipt(env, user.id, body.captcha_receipt);
    if (!check.ok) {
      return json({
        error: 'captcha_required',
        reason: check.reason,
        detail: 'Solve the captcha to continue. Free and granted-unlimited users must solve one every 10 minutes so the model costs are offset.',
      }, { status: 428 });   // "Precondition Required"
    }
  }

  // Server-side jailbreak enforcement — scan all user messages, not just last
  if (Array.isArray(body.messages)) {
    for (const m of body.messages) {
      if (m?.role === 'user' && typeof m.content === 'string') {
        const hit = detectJailbreakServer(m.content);
        if (hit) return json({ error: 'request blocked', detail: `jailbreak-pattern: "${hit.slice(0, 80)}"` }, { status: 400 });
      }
    }
  }

  const requestedModel = body.model || 'fast';

  // ---- MoE auto routing ----
  // For trivial prompts (<24 chars like "hi", "thanks", "lol"), skip the
  // classifier entirely and go straight to fast — the routing cost isn't
  // worth it and small models answer trivia faster anyway.
  let routedTo = null;
  if (requestedModel === 'auto') {
    const lastUser = body.messages?.filter(m => m.role === 'user').pop();
    const text = typeof lastUser?.content === 'string' ? lastUser.content : '';
    if (text.length < 24) {
      body.model = 'fast';
      routedTo = { worker: 'chat', model: 'fast', expert: 'tiny', label: 'Fast (auto-skip)', icon: 'chat', reason: 'short prompt', confidence: 1, via: 'skip-moe' };
    } else {
      routedTo = await moeRoute(text, { allowPlus: user.plan === 'plus' }, env);
      body.model = routedTo.model;
      if (routedTo.system) {
        body.system = routedTo.system + (body.system ? '\n\n' + body.system : '');
      }
    }
  }

  // ---- tier + usage gate (post-routing so MoE picks are also checked) ----
  // If the MoE picked the code worker, use the 'chadcoder' catalog key for
  // tier lookup since the chat worker's 'deepseek' alias isn't in MODEL_CATALOG.
  const finalModelKey = routedTo?.worker === 'code' ? 'chadcoder' : (body.model || 'fast');
  const tier = tierForModel(finalModelKey);
  if (!planAllowsTier(user.plan, tier)) {
    return forbidden(`${finalModelKey} is a ${tier}-tier model — Plus required`);
  }
  // Per-user model block takes precedence over everything else, even
  // unlimited grants — the founder can revoke a single model from a user
  // without downgrading their whole plan.
  if (Array.isArray(user.blocked_models) && user.blocked_models.includes(finalModelKey)) {
    return forbidden(`model '${finalModelKey}' is blocked on your account`);
  }
  // Unlimited plan skips quota checks but still has cost tracked.
  const skipQuota = planSkipsQuota(user.plan);
  if (!skipQuota) {
    // canUse now also enforces: per-tier daily/weekly/monthly REQUEST caps
    // AND per-account daily/monthly TOKEN caps (any plan ≠ unlimited).
    const gate = await canUse(env, user.id, tier, user.plan);
    if (!gate.ok) {
      return json({
        error: 'usage_limit_reached',
        scope: gate.scope,
        used: gate.used,
        limit: gate.limit,
        tier,
        resets_at: gate.resets_at,
        detail: `${gate.scope.startsWith('tokens') ? 'Account token' : tier + ' ' + gate.scope} limit reached (${gate.used}/${gate.limit}). Resets ${gate.resets_at}.`,
      }, { status: 429, headers: { 'Retry-After': String(Math.max(60, Math.floor((Date.parse(gate.resets_at) - Date.now()) / 1000))) } });
    }
  }

  // Concurrency limiter — cap simultaneous in-flight chat requests per user.
  // Prevents 10 open tabs from each firing 3 parallel requests to exhaust
  // worker CPU / Workers AI capacity. KV-backed counter with 60s TTL so a
  // disconnected client's slot always frees itself.
  const CONCURRENCY_CAP = user.plan === 'unlimited' ? 10 : user.plan === 'plus' ? 5 : 3;
  const concKey = 'conc:' + user.id;
  const concRelease = await acquireConcurrencySlot(env, concKey, CONCURRENCY_CAP);
  if (!concRelease) {
    return json({
      error: 'too_many_concurrent_requests',
      cap: CONCURRENCY_CAP,
      detail: `You already have ${CONCURRENCY_CAP} requests in flight. Wait for one to finish before sending another.`,
    }, { status: 429, headers: { 'Retry-After': '5' } });
  }

  // Shared lane (free tier only). Only ONE free request runs at a time
  // across the whole app — if someone else is cooking, you wait. Paid
  // users bypass this entirely; they get dedicated per-user capacity.
  // The /api/queue/ticket endpoint may have already claimed this for us
  // (that's the UX path with a visible "waiting" state), so claim is
  // idempotent — if we already hold it we just extend the lease.
  let sharedLaneHeld = false;
  if (usesSharedLane(user.plan)) {
    const claim = await waitAndClaimSharedLane(env, user.id, { maxWaitMs: SHARED_LANE_MAX_WAIT_MS });
    if (!claim.ok) {
      await concRelease();
      const status = await getSharedLaneStatus(env);
      const remain = Math.max(0, (status.until || Date.now()) - Date.now());
      return json({
        error: 'shared_lane_busy',
        lane: 'shared',
        detail: 'Free tier runs on one shared server. Someone else is generating — try again in a moment, or upgrade to Plus for your own container.',
        retry_after_ms: Math.min(remain, 30_000),
      }, { status: 429, headers: { 'Retry-After': String(Math.max(1, Math.ceil(remain / 1000))) } });
    }
    sharedLaneHeld = true;
  }

  // Record device fingerprint. If this device is blocked for bypass attempts,
  // deny the request regardless of plan.
  const fpCheck = await recordFingerprint(env, user.id, request, body.fingerprint);
  if (fpCheck.blocked) {
    await concRelease();
    if (sharedLaneHeld) await releaseSharedLane(env, user.id);
    return forbidden('device blocked for bypass attempts');
  }

  if (!env.CHAT_URL) {
    await concRelease();
    if (sharedLaneHeld) await releaseSharedLane(env, user.id);
    return json({ error: 'CHAT_URL not configured' }, { status: 500 });
  }

  // ---- live data enrichment ----
  // Run all detectors against the last user message in parallel. Hits get
  // prepended as facts the model must prefer over its training data.
  //
  // Anti-hallucination guard: when a detector FIRED but came back empty
  // (e.g. the Wikipedia catch-all tried both the exact title and an
  // OpenSearch fallback and got nothing), prepend a short "do not guess"
  // note to the user turn. Small Llama models will cheerfully invent a
  // wrong answer ("Norwood is in British Columbia") when the context is
  // empty — this preamble tells them to say they don't know instead.
  let enrichmentTag = 'skip';
  if (Array.isArray(body.messages) && body.messages.length) {
    const last = body.messages[body.messages.length - 1];
    if (last && last.role === 'user' && typeof last.content === 'string') {
      const result = await enrich(last.content);
      enrichmentTag = result.tag;
      if (result.context) {
        const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
        last.content = `[Live data fetched ${stamp}. Prefer these numbers over your training. Do not invent stats, prices, or outcomes. Copy dates, times, and numbers VERBATIM from the data below — do not reformat them, do not guess the year/month, do not omit fields.]\n\n${result.context}\n\n---\n\nUser question:\n${last.content}`;
      } else if (result.tag && result.tag !== 'skip' && result.tag !== 'none') {
        // At least one detector matched the question shape but every
        // fetch came back empty (404, timeout, disambiguation with no
        // good fallback). The question LOOKS factual, so guard against
        // hallucinated answers.
        last.content = `[Fact-lookup note: no reliable public data source returned info for this question. If you don't actually know the answer with high confidence, SAY SO plainly ("I don't have reliable information about that") and ask the user to clarify (e.g. which city / country / which X). Do NOT guess a plausible-sounding answer. Do NOT invent locations, dates, numbers, or facts. One sentence of "I don't know, can you be more specific?" is better than a wrong answer.]\n\n---\n\nUser question:\n${last.content}`;
      }
    }
  }

  // Pick which worker to call. MoE may route to the code worker.
  const targetUrl = routedTo?.worker === 'code' ? env.CODE_URL : env.CHAT_URL;
  if (!targetUrl) {
    await concRelease();
    if (sharedLaneHeld) await releaseSharedLane(env, user.id);
    return json({ error: `${routedTo?.worker || 'chat'}_URL not configured` }, { status: 500 });
  }

  // Record BEFORE the upstream call. If upstream fails, we still count the
  // attempt — simpler and matches how Claude counts failed sends toward quota.
  // Unlimited users record for cost tracking only (not quota).
  // Token estimate: we don't have streaming output here, so estimate from
  // input length + a conservative output assumption. Real-token accounting
  // would need to parse the stream, which breaks our pass-through.
  const estInputTokens = estimateTokensFromMessages(body.messages || []);
  const estOutputTokens = 400; // flat estimate per call
  // Always record — free tier still counts toward per-account TOKEN
  // ceilings and feeds the founder's cost dashboard. Unlimited plan
  // records for cost tracking only (quota check was skipped above).
  await recordUsage(env, user.id, finalModelKey, tier, estInputTokens + estOutputTokens);

  const workerToken = await mintWorkerToken(env, request, user.id);
  const upstream = await fetch(targetUrl + '/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + workerToken,
      'Origin': env.PAGES_ORIGIN || new URL(request.url).origin,
      'CF-Connecting-IP': request.headers.get('CF-Connecting-IP') || '',
      'User-Agent': request.headers.get('User-Agent') || '',
    },
    body: JSON.stringify(body),
  });

  // Scrub every revealing header on the way out. Nothing in Network's
  // Headers tab should give away model / routing / enrichment / tokens.
  const headers = new Headers(upstream.headers);
  for (const h of ['X-Session-Id', 'X-Model', 'X-Model-Attempt', 'X-Enriched',
    'X-Moe-Expert', 'X-Moe-Label', 'X-Moe-Model', 'X-Moe-Icon',
    'X-Moe-Reason', 'X-Moe-Confidence', 'X-Moe-Via',
    'Access-Control-Expose-Headers',
    'cf-ray', 'cf-cache-status', 'server']) {
    headers.delete(h);
  }
  headers.set('Access-Control-Allow-Origin', env.PAGES_ORIGIN || new URL(request.url).origin);
  // Mark enrichment inside-workers for telemetry? No — keep devtools clean.
  void enrichmentTag; void routedTo;

  // Tee the upstream body so we can release the concurrency slot — and
  // the shared free-tier lane, if we hold it — when the stream actually
  // finishes (not just when the headers come back). If the client
  // disconnects early the KV TTL on both keys mops up anyway.
  const [passthrough, watcher] = upstream.body.tee();
  (async () => {
    try {
      const r = watcher.getReader();
      while (true) { const { done } = await r.read(); if (done) break; }
    } catch {}
    try { await concRelease(); } catch {}
    if (sharedLaneHeld) { try { await releaseSharedLane(env, user.id); } catch {} }
  })();

  return new Response(passthrough, { status: upstream.status, headers });
}

// ---- Concurrency limiter -----------------------------------------------
// Backed by SESSIONS KV (same binding used for rate-limit buckets). Not
// perfectly atomic but good enough — a race lets at most ~cap+1 requests
// slip through, which is fine for the purpose.
async function acquireConcurrencySlot(env, key, cap) {
  if (!env.SESSIONS) return async () => {};   // KV not bound — no limiter
  let count = 0;
  try { count = Number((await env.SESSIONS.get(key)) || 0); } catch {}
  if (count >= cap) return null;
  try { await env.SESSIONS.put(key, String(count + 1), { expirationTtl: 60 }); } catch {}
  return async () => {
    try {
      let n = Number((await env.SESSIONS.get(key)) || 0) - 1;
      if (n <= 0) await env.SESSIONS.delete(key);
      else await env.SESSIONS.put(key, String(n), { expirationTtl: 60 });
    } catch {}
  };
}

// ~4 chars per token for llama-family tokenizers; close enough for cost math.
function estimateTokensFromMessages(messages) {
  let chars = 0;
  for (const m of messages) {
    if (typeof m?.content === 'string') chars += m.content.length;
  }
  return Math.ceil(chars / 4);
}

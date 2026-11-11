import { getAuthedUser, mintWorkerToken, json, unauthorized, forbidden } from '../_lib/auth.js';
import { enrich } from '../_lib/enrichers.js';
import { route as moeRoute } from '../_lib/router.js';
import { MODEL_CATALOG, tierForModel, planAllowsTier, planSkipsQuota } from '../_lib/tiers.js';
import { canUse, recordUsage } from '../_lib/usage.js';
import { recordFingerprint } from '../_lib/fingerprint.js';

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
  if (tier !== 'free' && !skipQuota) {
    const gate = await canUse(env, user.id, tier);
    if (!gate.ok) {
      return json({
        error: 'usage_limit_reached',
        scope: gate.scope,
        used: gate.used,
        limit: gate.limit,
        tier,
        resets_at: gate.resets_at,
        detail: `${tier} ${gate.scope} limit reached (${gate.used}/${gate.limit}). Resets ${gate.resets_at}.`,
      }, { status: 429, headers: { 'Retry-After': String(Math.max(60, Math.floor((Date.parse(gate.resets_at) - Date.now()) / 1000))) } });
    }
  }

  // Record device fingerprint. If this device is blocked for bypass attempts,
  // deny the request regardless of plan.
  const fpCheck = await recordFingerprint(env, user.id, request, body.fingerprint);
  if (fpCheck.blocked) {
    return forbidden('device blocked for bypass attempts');
  }

  if (!env.CHAT_URL) return json({ error: 'CHAT_URL not configured' }, { status: 500 });

  // ---- live data enrichment ----
  // Run all detectors against the last user message in parallel. Hits get
  // prepended as facts the model must prefer over its training data.
  let enrichmentTag = 'skip';
  if (Array.isArray(body.messages) && body.messages.length) {
    const last = body.messages[body.messages.length - 1];
    if (last && last.role === 'user' && typeof last.content === 'string') {
      const result = await enrich(last.content);
      enrichmentTag = result.tag;
      if (result.context) {
        const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
        last.content = `[Live data fetched ${stamp}. Prefer these numbers over your training. Do not invent stats, prices, or outcomes. Copy dates, times, and numbers VERBATIM from the data below — do not reformat them, do not guess the year/month, do not omit fields.]\n\n${result.context}\n\n---\n\nUser question:\n${last.content}`;
      }
    }
  }

  // Pick which worker to call. MoE may route to the code worker.
  const targetUrl = routedTo?.worker === 'code' ? env.CODE_URL : env.CHAT_URL;
  if (!targetUrl) return json({ error: `${routedTo?.worker || 'chat'}_URL not configured` }, { status: 500 });

  // Record BEFORE the upstream call. If upstream fails, we still count the
  // attempt — simpler and matches how Claude counts failed sends toward quota.
  // Unlimited users record for cost tracking only (not quota).
  // Token estimate: we don't have streaming output here, so estimate from
  // input length + a conservative output assumption. Real-token accounting
  // would need to parse the stream, which breaks our pass-through.
  const estInputTokens = estimateTokensFromMessages(body.messages || []);
  const estOutputTokens = 400; // flat estimate per call
  if (tier !== 'free' || skipQuota) {
    await recordUsage(env, user.id, finalModelKey, tier, estInputTokens + estOutputTokens);
  }

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

  const headers = new Headers(upstream.headers);
  headers.delete('X-Session-Id');
  headers.set('Access-Control-Allow-Origin', env.PAGES_ORIGIN || new URL(request.url).origin);
  headers.set('X-Enriched', enrichmentTag);
  if (routedTo) {
    headers.set('X-Moe-Expert', routedTo.expert);
    headers.set('X-Moe-Label', routedTo.label);
    headers.set('X-Moe-Model', routedTo.modelName || '');
    headers.set('X-Moe-Icon', routedTo.icon || 'chat');
    headers.set('X-Moe-Reason', routedTo.reason || '');
    headers.set('X-Moe-Confidence', String(routedTo.confidence || 0));
    headers.set('X-Moe-Via', routedTo.via || '');
    headers.set('Access-Control-Expose-Headers', 'X-Moe-Expert,X-Moe-Label,X-Moe-Model,X-Moe-Icon,X-Moe-Reason,X-Moe-Confidence,X-Moe-Via,X-Enriched');
  } else {
    headers.set('Access-Control-Expose-Headers', 'X-Enriched');
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}

// ~4 chars per token for llama-family tokenizers; close enough for cost math.
function estimateTokensFromMessages(messages) {
  let chars = 0;
  for (const m of messages) {
    if (typeof m?.content === 'string') chars += m.content.length;
  }
  return Math.ceil(chars / 4);
}

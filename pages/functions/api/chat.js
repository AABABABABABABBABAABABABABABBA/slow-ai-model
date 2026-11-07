import { getAuthedUser, mintWorkerToken, userCanUseChatModel, json, unauthorized, forbidden } from '../_lib/auth.js';
import { enrich } from '../_lib/enrichers.js';
import { route as moeRoute } from '../_lib/router.js';

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
  // If the client asks for "auto", classify the last user message and pick an
  // expert from the pool. The picked expert may be on the chat worker OR the
  // code worker — we proxy to whichever is right.
  let routedTo = null;
  if (requestedModel === 'auto') {
    const lastUser = body.messages?.filter(m => m.role === 'user').pop();
    const text = typeof lastUser?.content === 'string' ? lastUser.content : '';
    routedTo = await moeRoute(text, { allowPlus: user.plan === 'plus' }, env);
    body.model = routedTo.model;
  } else {
    if (!userCanUseChatModel(user, requestedModel)) {
      return forbidden(`model "${requestedModel}" requires Plus`);
    }
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
    headers.set('X-Moe-Reason', routedTo.reason);
    headers.set('X-Moe-Via', routedTo.via);
    headers.set('Access-Control-Expose-Headers', 'X-Moe-Expert,X-Moe-Label,X-Moe-Reason,X-Moe-Via,X-Enriched');
  } else {
    headers.set('Access-Control-Expose-Headers', 'X-Enriched');
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}

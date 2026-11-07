import { getAuthedUser, mintWorkerToken, userCanUseChatModel, json, unauthorized, forbidden } from '../_lib/auth.js';
import { enrich } from '../_lib/enrichers.js';
import { route as moeRoute } from '../_lib/router.js';

export async function onRequestPost({ request, env }) {
  const user = await getAuthedUser(request, env);
  if (!user) return unauthorized('please sign in');

  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid JSON' }, { status: 400 }); }

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
        last.content = `[Live data fetched ${stamp}. Prefer these numbers over your training. Do not invent stats, prices, or outcomes.]\n\n${result.context}\n\n---\n\nUser question:\n${last.content}`;
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

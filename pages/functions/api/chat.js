import { getAuthedUser, mintWorkerToken, userCanUseChatModel, json, unauthorized, forbidden } from '../_lib/auth.js';
import { detectBasketball, fetchNbaContext } from '../_lib/espn.js';
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
  // If the last user message mentions basketball / an NBA team, fetch live data
  // from ESPN and splice it in so the model answers with real facts instead of
  // stale training data.
  let espnTag = 'skip';
  if (Array.isArray(body.messages) && body.messages.length) {
    const last = body.messages[body.messages.length - 1];
    if (last && last.role === 'user' && typeof last.content === 'string') {
      const hint = detectBasketball(last.content);
      if (hint) {
        try {
          const ctx = await fetchNbaContext(hint);
          if (ctx) {
            espnTag = `nba:${ctx.length}b`;
            const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
            last.content = `[Live ESPN NBA data as of ${stamp}. Use ONLY these numbers for any factual claim about scores, standings, records, or schedules. These override your training data. Do not invent stats.]\n\n${ctx}\n\n---\n\nUser question:\n${last.content}`;
          } else {
            espnTag = 'nba:empty';
          }
        } catch (_) {
          espnTag = 'nba:err';
        }
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
  headers.set('X-Enriched', espnTag);
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

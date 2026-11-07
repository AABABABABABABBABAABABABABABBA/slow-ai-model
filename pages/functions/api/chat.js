import { getAuthedUser, mintWorkerToken, userCanUseChatModel, json, unauthorized, forbidden } from '../_lib/auth.js';
import { detectBasketball, fetchNbaContext } from '../_lib/espn.js';

export async function onRequestPost({ request, env }) {
  const user = await getAuthedUser(request, env);
  if (!user) return unauthorized('please sign in');

  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid JSON' }, { status: 400 }); }

  const model = body.model || 'fast';
  if (!userCanUseChatModel(user, model)) {
    return forbidden(`model "${model}" requires Plus`);
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

  // Mint a worker-trusted token on behalf of the user. Workers have no idea
  // this user exists — they just verify the signed token.
  const workerToken = await mintWorkerToken(env, request, user.id);

  // Proxy the request to the chat worker, forwarding client IP + UA so the
  // worker's binding check matches what we signed.
  const upstream = await fetch(env.CHAT_URL + '/chat', {
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

  // Stream the SSE response back to the browser untouched.
  const headers = new Headers(upstream.headers);
  headers.delete('X-Session-Id');
  headers.set('Access-Control-Allow-Origin', env.PAGES_ORIGIN || new URL(request.url).origin);
  headers.set('X-Enriched', espnTag);
  return new Response(upstream.body, { status: upstream.status, headers });
}

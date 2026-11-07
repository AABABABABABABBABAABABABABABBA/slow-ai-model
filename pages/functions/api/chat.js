import { getAuthedUser, mintWorkerToken, userCanUseChatModel, json, unauthorized, forbidden } from '../_lib/auth.js';

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
  return new Response(upstream.body, { status: upstream.status, headers });
}

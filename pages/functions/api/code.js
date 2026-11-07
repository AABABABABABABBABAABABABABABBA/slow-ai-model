import { getAuthedUser, mintWorkerToken, userCanUseCode, json, unauthorized, forbidden } from '../_lib/auth.js';

export async function onRequestPost({ request, env }) {
  const user = await getAuthedUser(request, env);
  if (!user) return unauthorized('please sign in');
  if (!userCanUseCode(user)) return forbidden('ChadCoder requires Plus');

  if (!env.CODE_URL) return json({ error: 'CODE_URL not configured' }, { status: 500 });

  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid JSON' }, { status: 400 }); }

  const workerToken = await mintWorkerToken(env, request, user.id);
  const upstream = await fetch(env.CODE_URL + '/chat', {
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
  return new Response(upstream.body, { status: upstream.status, headers });
}

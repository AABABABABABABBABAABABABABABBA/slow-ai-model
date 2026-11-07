import { getAuthedUser, mintWorkerToken, userCanUseVision, json, unauthorized, forbidden } from '../_lib/auth.js';

export async function onRequestPost({ request, env }) {
  const user = await getAuthedUser(request, env);
  if (!user) return unauthorized('please sign in');
  if (!userCanUseVision(user)) return forbidden('image understanding requires Plus');

  if (!env.IMAGE_URL) return json({ error: 'IMAGE_URL not configured' }, { status: 500 });

  const workerToken = await mintWorkerToken(env, request, user.id);
  const upstream = await fetch(env.IMAGE_URL + '/describe', {
    method: 'POST',
    headers: {
      'Content-Type': request.headers.get('content-type') || 'application/json',
      'Authorization': 'Bearer ' + workerToken,
      'Origin': env.PAGES_ORIGIN || new URL(request.url).origin,
      'CF-Connecting-IP': request.headers.get('CF-Connecting-IP') || '',
      'User-Agent': request.headers.get('User-Agent') || '',
    },
    body: request.body,
  });
  const headers = new Headers(upstream.headers);
  headers.delete('X-Session-Id');
  headers.set('Access-Control-Allow-Origin', env.PAGES_ORIGIN || new URL(request.url).origin);
  return new Response(upstream.body, { status: upstream.status, headers });
}

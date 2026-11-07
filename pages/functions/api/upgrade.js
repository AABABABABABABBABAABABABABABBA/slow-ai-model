import { getAuthedUser, mintUserJwt, setSessionCookieHeader, json, unauthorized } from '../_lib/auth.js';

// Demo upgrade: flips plan. In production, verify Stripe webhook and set plan there.
export async function onRequestPost({ request, env }) {
  const user = await getAuthedUser(request, env);
  if (!user) return unauthorized();
  if (!env.DB) return json({ error: 'database not configured' }, { status: 500 });

  let body = {};
  try { body = await request.json(); } catch {}
  const target = body.plan === 'free' ? 'free' : 'plus';

  await env.DB.prepare('UPDATE users SET plan = ?, updated_at = ? WHERE id = ?')
    .bind(target, Date.now(), user.id).run();

  // Reissue cookie with updated plan claim so proxies see it immediately.
  const token = await mintUserJwt(env, { user_id: user.id, email: user.email, plan: target });
  return json({ ok: true, plan: target }, { headers: { 'Set-Cookie': setSessionCookieHeader(token) } });
}

import { verifyPassword, mintUserJwt, setSessionCookieHeader, json, badRequest, unauthorized } from '../_lib/auth.js';

export async function onRequestPost({ request, env }) {
  if (!env.DB) return json({ error: 'database not configured' }, { status: 500 });

  let body;
  try { body = await request.json(); } catch { return badRequest('invalid JSON'); }

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!email || !password) return badRequest('email and password required');

  const row = await env.DB.prepare(
    'SELECT id, email, password_hash, plan FROM users WHERE email = ?'
  ).bind(email).first();

  if (!row) {
    // Timing-equalize a tiny bit so email enumeration is harder
    await verifyPassword(password, 'pbkdf2$150000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    return unauthorized('invalid credentials');
  }

  const ok = await verifyPassword(password, row.password_hash);
  if (!ok) return unauthorized('invalid credentials');

  const token = await mintUserJwt(env, { user_id: row.id, email: row.email, plan: row.plan });
  return json(
    { ok: true, user: { id: row.id, email: row.email, plan: row.plan } },
    { headers: { 'Set-Cookie': setSessionCookieHeader(token) } }
  );
}

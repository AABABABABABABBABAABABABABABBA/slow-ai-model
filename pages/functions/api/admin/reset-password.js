// POST /api/admin/reset-password — emergency recovery path.
// Does not require a session cookie (so you can use it when locked out).
// Authenticates via Bearer <FOUNDER_TOKEN> instead.
//
// Body: { email, new_password }
//
// The bearer token lives in the Pages project's env vars (wrangler pages
// secret put FOUNDER_TOKEN). Treat it like a root credential — rotate it
// right after any emergency use.

import { hashPassword, json, badRequest } from '../../_lib/auth.js';

function tokenAuth(request, env) {
  const got = request.headers.get('Authorization') || '';
  const want = 'Bearer ' + (env.FOUNDER_TOKEN || '');
  if (!env.FOUNDER_TOKEN) return false;
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

export async function onRequestPost({ request, env }) {
  if (!tokenAuth(request, env)) {
    return json({ error: 'forbidden' }, { status: 403 });
  }
  if (!env.DB) return json({ error: 'DB not bound' }, { status: 500 });

  let body;
  try { body = await request.json(); } catch { return badRequest('invalid JSON'); }
  const email = (body.email || '').trim().toLowerCase();
  const next = typeof body.new_password === 'string' ? body.new_password : '';
  if (!email) return badRequest('email required');
  if (!next || next.length < 8) return badRequest('new_password must be at least 8 characters');

  const row = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (!row) return json({ error: 'user not found' }, { status: 404 });

  const newHash = await hashPassword(next);
  // Also lift any ban/mute that would prevent login — it's a recovery path.
  await env.DB.prepare(
    'UPDATE users SET password_hash = ?, banned = 0, muted = 0, updated_at = ? WHERE id = ?'
  ).bind(newHash, Date.now(), row.id).run();

  return json({ ok: true, email });
}

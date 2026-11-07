// POST /api/password — logged-in user changes their own password.
// Body: { current_password, new_password }

import { getAuthedUser, verifyPassword, hashPassword, json, unauthorized, badRequest } from '../_lib/auth.js';

export async function onRequestPost({ request, env }) {
  const user = await getAuthedUser(request, env);
  if (!user) return unauthorized('please sign in');
  if (!env.DB) return json({ error: 'database not configured' }, { status: 500 });

  let body;
  try { body = await request.json(); } catch { return badRequest('invalid JSON'); }
  const current = typeof body.current_password === 'string' ? body.current_password : '';
  const next = typeof body.new_password === 'string' ? body.new_password : '';
  if (!current || !next) return badRequest('current_password and new_password required');
  if (next.length < 8) return badRequest('new password must be at least 8 characters');

  const row = await env.DB.prepare('SELECT id, password_hash FROM users WHERE id = ?').bind(user.id).first();
  if (!row) return unauthorized();

  const ok = await verifyPassword(current, row.password_hash);
  if (!ok) return json({ error: 'current password is wrong' }, { status: 403 });

  const newHash = await hashPassword(next);
  await env.DB.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
    .bind(newHash, Date.now(), user.id).run();

  return json({ ok: true });
}

// POST /api/password — logged-in user changes their own password.
// Body: { current_password, new_password, nonce }
// nonce is a client-generated 16-64 char hex/base36 string (one-shot).

import { getAuthedUser, verifyPassword, hashPassword, json, unauthorized } from '../_lib/auth.js';
import { readJsonBody, assertFreshNonce, ValidationError } from '../_lib/validate.js';

export async function onRequestPost({ request, env }) {
  const user = await getAuthedUser(request, env);
  if (!user) return unauthorized('please sign in');
  if (!env.DB) return json({ error: 'database not configured' }, { status: 500 });

  let body;
  try {
    body = await readJsonBody(request, {
      method: 'POST',
      maxBytes: 4 * 1024,
      allowedKeys: ['current_password', 'new_password', 'nonce'],
      requiredKeys: ['current_password', 'new_password', 'nonce'],
    });
    await assertFreshNonce(env, user, body.nonce, 'password:change');
  } catch (err) {
    if (err instanceof ValidationError) return json(err.body, { status: err.status });
    throw err;
  }

  const current = typeof body.current_password === 'string' ? body.current_password : '';
  const next = typeof body.new_password === 'string' ? body.new_password : '';
  if (!current || !next) return json({ error: 'current_password and new_password required' }, { status: 400 });
  if (next.length < 8)  return json({ error: 'new password must be at least 8 characters' }, { status: 400 });
  if (next.length > 200) return json({ error: 'new password too long (max 200 chars)' }, { status: 400 });

  const row = await env.DB.prepare('SELECT id, password_hash FROM users WHERE id = ?').bind(user.id).first();
  if (!row) return unauthorized();

  const ok = await verifyPassword(current, row.password_hash);
  if (!ok) return json({ error: 'current password is wrong' }, { status: 403 });

  const newHash = await hashPassword(next);
  await env.DB.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
    .bind(newHash, Date.now(), user.id).run();

  return json({ ok: true });
}

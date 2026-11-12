// POST /api/admin/grant — founder-only. Grants unlimited to a user by email,
// or revokes it (plan=plus or plan=free).
//
// Body: { email: string, plan: 'unlimited' | 'plus' | 'free' }

import { getAuthedUser, isFounder, json, unauthorized, forbidden, badRequest } from '../../_lib/auth.js';
import { readJsonBody, assertFreshNonce, ValidationError } from '../../_lib/validate.js';

export async function onRequestPost({ request, env }) {
  const user = await getAuthedUser(request, env);
  if (!user) return unauthorized();
  if (!isFounder(env, user)) return forbidden('founder only');
  if (!env.DB) return json({ error: 'DB not bound' }, { status: 500 });

  let body;
  try {
    body = await readJsonBody(request, {
      method: 'POST',
      maxBytes: 4 * 1024,
      allowedKeys: ['email', 'plan', 'nonce'],
      requiredKeys: ['email', 'plan', 'nonce'],
    });
    await assertFreshNonce(env, user, body.nonce, 'admin:grant');
  } catch (err) {
    if (err instanceof ValidationError) return json(err.body, { status: err.status });
    throw err;
  }
  const email = (body.email || '').trim().toLowerCase();
  const plan = body.plan;
  if (!email) return badRequest('email required');
  if (!['unlimited', 'plus', 'free'].includes(plan)) return badRequest('plan must be unlimited | plus | free');

  const target = await env.DB.prepare('SELECT id, email, plan FROM users WHERE email = ?').bind(email).first();
  if (!target) return json({ error: 'user not found' }, { status: 404 });

  const now = Date.now();
  if (plan === 'unlimited') {
    await env.DB.prepare(
      'UPDATE users SET plan = ?, granted_by = ?, granted_at = ?, updated_at = ? WHERE id = ?'
    ).bind(plan, user.email, now, now, target.id).run();
  } else {
    // Revoking — clear grant columns.
    await env.DB.prepare(
      'UPDATE users SET plan = ?, granted_by = NULL, granted_at = NULL, updated_at = ? WHERE id = ?'
    ).bind(plan, now, target.id).run();
  }

  return json({ ok: true, email, from: target.plan, to: plan });
}

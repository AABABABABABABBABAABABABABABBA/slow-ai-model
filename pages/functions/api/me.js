import { getAuthedUser, json, unauthorized } from '../_lib/auth.js';

export async function onRequestGet({ request, env }) {
  const user = await getAuthedUser(request, env);
  if (!user) return unauthorized();
  // Pull fresh plan + usage score from D1 in case they were upgraded elsewhere
  if (env.DB) {
    const row = await env.DB.prepare(
      'SELECT id, email, plan, usage_score, usage_last_at FROM users WHERE id = ?'
    ).bind(user.id).first();
    if (row) {
      return json({ user: { id: row.id, email: row.email, plan: row.plan, usage_score: row.usage_score, usage_last_at: row.usage_last_at } });
    }
  }
  return json({ user });
}

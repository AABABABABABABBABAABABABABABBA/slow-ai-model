import { getAuthedUser, isFounder, json, unauthorized } from '../_lib/auth.js';

export async function onRequestGet({ request, env }) {
  const user = await getAuthedUser(request, env);
  if (!user) return unauthorized();
  const founder = isFounder(env, user);
  if (env.DB) {
    const row = await env.DB.prepare(
      'SELECT id, email, plan, usage_score, usage_last_at FROM users WHERE id = ?'
    ).bind(user.id).first();
    if (row) {
      return json({ user: { id: row.id, email: row.email, plan: row.plan, usage_score: row.usage_score, usage_last_at: row.usage_last_at, is_founder: founder } });
    }
  }
  return json({ user: { ...user, is_founder: founder } });
}

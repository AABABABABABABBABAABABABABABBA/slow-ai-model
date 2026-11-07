// GET /api/admin/users — founder-only. Lists every user with their plan,
// lifetime cost (micro-USD and USD), call count, and device-count.
// Also returns the founder's total cost burden broken down per-user.

import { getAuthedUser, isFounder, json, unauthorized, forbidden } from '../../_lib/auth.js';

export async function onRequestGet({ request, env }) {
  const user = await getAuthedUser(request, env);
  if (!user) return unauthorized();
  if (!isFounder(env, user)) return forbidden('founder only');
  if (!env.DB) return json({ error: 'DB not bound' }, { status: 500 });

  const rows = await env.DB.prepare(`
    SELECT
      u.id, u.email, u.plan, u.granted_by, u.granted_at, u.created_at,
      COALESCE(SUM(l.cost_micro), 0) AS cost_micro,
      COUNT(l.id)                    AS calls,
      COALESCE(SUM(l.tokens), 0)     AS tokens
    FROM users u
    LEFT JOIN usage_log l ON l.user_id = u.id
    GROUP BY u.id
    ORDER BY cost_micro DESC
  `).all();

  const users = (rows.results || []).map(r => ({
    id: r.id,
    email: r.email,
    plan: r.plan,
    granted_by: r.granted_by,
    granted_at: r.granted_at,
    created_at: r.created_at,
    cost_micro: Number(r.cost_micro),
    cost_usd: Number(r.cost_micro) / 1_000_000,
    calls: Number(r.calls),
    tokens: Number(r.tokens),
  }));

  // Founder burden = everyone the founder granted unlimited to.
  const grantedUsers = users.filter(u => u.plan === 'unlimited');
  const founder_burden_micro = grantedUsers.reduce((a, b) => a + b.cost_micro, 0);

  return json({
    users,
    totals: {
      user_count: users.length,
      total_cost_micro: users.reduce((a, b) => a + b.cost_micro, 0),
      total_cost_usd: users.reduce((a, b) => a + b.cost_micro, 0) / 1_000_000,
      founder_burden_micro,
      founder_burden_usd: founder_burden_micro / 1_000_000,
      granted_count: grantedUsers.length,
    },
  });
}

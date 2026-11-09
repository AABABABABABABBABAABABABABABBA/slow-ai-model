// GET /api/admin/ratings — founder-only. Returns per-model up/down counts
// plus the N most recent downvotes with their text, so the founder can see
// which models are producing bad answers and what those answers looked like.

import { getAuthedUser, isFounder, json, unauthorized, forbidden } from '../../_lib/auth.js';

export async function onRequestGet({ request, env }) {
  const user = await getAuthedUser(request, env);
  if (!user) return unauthorized();
  if (!isFounder(env, user)) return forbidden('founder only');
  if (!env.DB) return json({ error: 'DB not bound' }, { status: 500 });

  const byModel = await env.DB.prepare(`
    SELECT COALESCE(model_key, 'unknown') AS model,
           SUM(CASE WHEN rating =  1 THEN 1 ELSE 0 END) AS up,
           SUM(CASE WHEN rating = -1 THEN 1 ELSE 0 END) AS down
    FROM message_ratings
    WHERE rating != 0
    GROUP BY model_key
    ORDER BY down DESC, up DESC
  `).all();

  const recentDown = await env.DB.prepare(`
    SELECT r.message_hash, r.model_key, r.note, r.created_at, u.email
    FROM message_ratings r
    JOIN users u ON u.id = r.user_id
    WHERE r.rating = -1
    ORDER BY r.created_at DESC
    LIMIT 25
  `).all();

  return json({
    by_model: byModel.results || [],
    recent_downvotes: recentDown.results || [],
  });
}

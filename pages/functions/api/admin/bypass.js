// GET /api/admin/bypass — founder-only.
// Surfaces patterns that suggest a user is dodging limits:
//   - One device fingerprint registered on multiple accounts
//   - Rapid signups (>N new accounts in a time window — potential farm)
//   - Users who hit 429 (usage_limit_reached) recently
// Returns ranked lists the founder can act on from the admin panel.

import { getAuthedUser, isFounder, json, unauthorized, forbidden } from '../../_lib/auth.js';

export async function onRequestGet({ request, env }) {
  const user = await getAuthedUser(request, env);
  if (!user) return unauthorized();
  if (!isFounder(env, user)) return forbidden('founder only');
  if (!env.DB) return json({ error: 'DB not bound' }, { status: 500 });

  // 1. Fingerprints bound to 2+ user accounts. Most likely signal of
  //    multi-account abuse from one physical machine.
  const sharedFps = await env.DB.prepare(`
    SELECT d.fp_hash,
           COUNT(DISTINCT d.user_id) AS user_count,
           GROUP_CONCAT(DISTINCT u.email) AS emails,
           MAX(d.last_seen_at) AS last_seen_at
    FROM device_fingerprints d
    JOIN users u ON u.id = d.user_id
    GROUP BY d.fp_hash
    HAVING user_count > 1
    ORDER BY user_count DESC, last_seen_at DESC
    LIMIT 25
  `).all();

  // 2. Signup bursts — 5+ new accounts in the last hour from (anything).
  //    Doesn't geo-cluster yet; but the rate itself is a smell.
  const now = Date.now();
  const hourAgo = now - 60 * 60 * 1000;
  const recentSignups = await env.DB.prepare(`
    SELECT email, created_at FROM users
    WHERE created_at > ? ORDER BY created_at DESC LIMIT 25
  `).bind(hourAgo).all();

  // 3. Users with lots of distinct devices — suggests they're trying
  //    multiple hardware hashes (VM-hopping, container churn).
  const multiDevice = await env.DB.prepare(`
    SELECT u.email, COUNT(DISTINCT d.fp_hash) AS devices
    FROM users u
    JOIN device_fingerprints d ON d.user_id = u.id
    GROUP BY u.id
    HAVING devices >= 3
    ORDER BY devices DESC
    LIMIT 25
  `).all();

  // 4. Heavy hitters today — who's actually using the most, by request count.
  const today = new Date().toISOString().slice(0, 10);
  const heaviestToday = await env.DB.prepare(`
    SELECT u.email, u.plan,
           COUNT(*) AS calls,
           COALESCE(SUM(l.tokens), 0) AS tokens
    FROM usage_log l
    JOIN users u ON u.id = l.user_id
    WHERE l.day_key = ?
    GROUP BY l.user_id
    ORDER BY calls DESC
    LIMIT 25
  `).bind(today).all();

  return json({
    generated_at: new Date().toISOString(),
    shared_fingerprints: (sharedFps.results || []).map(r => ({
      fp_hash: r.fp_hash,
      user_count: Number(r.user_count),
      emails: (r.emails || '').split(','),
      last_seen_at: r.last_seen_at,
    })),
    recent_signups_last_hour: recentSignups.results || [],
    multi_device_users: multiDevice.results || [],
    heaviest_today: heaviestToday.results || [],
    notes: [
      'shared_fingerprints: same hw hash across ≥2 emails — strong signal of account farming. Block the fp_hash via /api/admin/block-device.',
      'recent_signups_last_hour: >5 is suspicious on a small user base.',
      'multi_device_users: ≥3 distinct hw hashes under one email is unusual — maybe a dev, maybe spoofing.',
      'heaviest_today: ranked by call count; use for cost + quota review.',
    ],
  });
}

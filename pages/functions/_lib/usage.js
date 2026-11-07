// Read + record usage for a user against the LIMITS table.
// All date keys computed in UTC.

import { LIMITS, dayKey, weekKey, nextDailyResetMs, nextWeeklyResetMs } from './tiers.js';

export async function readUsage(env, userId) {
  if (!env.DB) throw new Error('DB not bound');
  const dk = dayKey();
  const wk = weekKey();
  // Count per tier for today + this week in a single pass.
  const daily = await env.DB.prepare(
    'SELECT tier, COUNT(*) AS n FROM usage_log WHERE user_id = ? AND day_key = ? GROUP BY tier'
  ).bind(userId, dk).all();
  const weekly = await env.DB.prepare(
    'SELECT tier, COUNT(*) AS n FROM usage_log WHERE user_id = ? AND week_key = ? GROUP BY tier'
  ).bind(userId, wk).all();
  const dailyMap = {}, weeklyMap = {};
  for (const r of (daily.results || [])) dailyMap[r.tier] = r.n;
  for (const r of (weekly.results || [])) weeklyMap[r.tier] = r.n;
  const out = {};
  for (const tier of Object.keys(LIMITS)) {
    const lim = LIMITS[tier];
    out[tier] = {
      daily_used: dailyMap[tier] || 0,
      daily_limit: lim.daily === Infinity ? null : lim.daily,
      weekly_used: weeklyMap[tier] || 0,
      weekly_limit: lim.weekly === Infinity ? null : lim.weekly,
    };
  }
  return {
    day: dk,
    week: wk,
    resets_daily_at:  new Date(nextDailyResetMs()).toISOString(),
    resets_weekly_at: new Date(nextWeeklyResetMs()).toISOString(),
    tiers: out,
  };
}

export async function canUse(env, userId, tier) {
  const lim = LIMITS[tier];
  if (!lim) return { ok: false, reason: 'unknown tier' };
  if (lim.daily === Infinity && lim.weekly === Infinity) return { ok: true };
  const u = await readUsage(env, userId);
  const row = u.tiers[tier];
  if (row.daily_limit !== null && row.daily_used >= row.daily_limit) {
    return { ok: false, scope: 'daily', used: row.daily_used, limit: row.daily_limit, resets_at: u.resets_daily_at };
  }
  if (row.weekly_limit !== null && row.weekly_used >= row.weekly_limit) {
    return { ok: false, scope: 'weekly', used: row.weekly_used, limit: row.weekly_limit, resets_at: u.resets_weekly_at };
  }
  return { ok: true, used_today: row.daily_used, used_week: row.weekly_used };
}

export async function recordUsage(env, userId, modelKey, tier, tokens = 0) {
  if (!env.DB) return;
  try {
    await env.DB.prepare(
      'INSERT INTO usage_log (user_id, model_key, tier, day_key, week_key, tokens, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(userId, modelKey, tier, dayKey(), weekKey(), tokens, Date.now()).run();
  } catch (_) { /* swallow — logging is best-effort */ }
}

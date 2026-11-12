// Read + record usage for a user against the LIMITS table.
// All date keys computed in UTC.

import {
  LIMITS, ACCOUNT_TOKEN_LIMITS,
  dayKey, weekKey, monthKey,
  nextDailyResetMs, nextWeeklyResetMs, nextMonthlyResetMs,
  costMicro,
} from './tiers.js';

export async function readUsage(env, userId) {
  if (!env.DB) throw new Error('DB not bound');
  const dk = dayKey();
  const wk = weekKey();
  const mk = monthKey();

  const daily = await env.DB.prepare(
    'SELECT tier, COUNT(*) AS n, COALESCE(SUM(tokens),0) AS tok FROM usage_log WHERE user_id = ? AND day_key = ? GROUP BY tier'
  ).bind(userId, dk).all();
  const weekly = await env.DB.prepare(
    'SELECT tier, COUNT(*) AS n FROM usage_log WHERE user_id = ? AND week_key = ? GROUP BY tier'
  ).bind(userId, wk).all();
  const monthly = await env.DB.prepare(
    `SELECT tier, COUNT(*) AS n, COALESCE(SUM(tokens),0) AS tok
     FROM usage_log WHERE user_id = ? AND substr(day_key, 1, 7) = ? GROUP BY tier`
  ).bind(userId, mk).all();
  const costRow = await env.DB.prepare(
    'SELECT COALESCE(SUM(cost_micro), 0) AS total, COUNT(*) AS calls FROM usage_log WHERE user_id = ?'
  ).bind(userId).first();

  const dailyMap = {}, weeklyMap = {}, monthlyMap = {};
  let dailyTokensTotal = 0, monthlyTokensTotal = 0;
  for (const r of (daily.results   || [])) { dailyMap[r.tier] = r.n;   dailyTokensTotal   += Number(r.tok || 0); }
  for (const r of (weekly.results  || [])) { weeklyMap[r.tier] = r.n; }
  for (const r of (monthly.results || [])) { monthlyMap[r.tier] = r.n; monthlyTokensTotal += Number(r.tok || 0); }

  const out = {};
  for (const tier of Object.keys(LIMITS)) {
    const lim = LIMITS[tier];
    out[tier] = {
      daily_used: dailyMap[tier] || 0,
      daily_limit: lim.daily === Infinity ? null : lim.daily,
      weekly_used: weeklyMap[tier] || 0,
      weekly_limit: lim.weekly === Infinity ? null : lim.weekly,
      monthly_used: monthlyMap[tier] || 0,
      monthly_limit: lim.monthly === Infinity ? null : lim.monthly,
    };
  }
  return {
    day: dk,
    week: wk,
    month: mk,
    resets_daily_at:   new Date(nextDailyResetMs()).toISOString(),
    resets_weekly_at:  new Date(nextWeeklyResetMs()).toISOString(),
    resets_monthly_at: new Date(nextMonthlyResetMs()).toISOString(),
    tiers: out,
    account_tokens: {
      daily:   dailyTokensTotal,
      monthly: monthlyTokensTotal,
    },
    lifetime_cost_micro: Number(costRow?.total || 0),
    lifetime_cost_usd:   Number(costRow?.total || 0) / 1_000_000,
    lifetime_calls:      Number(costRow?.calls || 0),
  };
}

export async function canUse(env, userId, tier, plan = 'free') {
  const lim = LIMITS[tier];
  if (!lim) return { ok: false, reason: 'unknown tier' };
  if (plan === 'unlimited') return { ok: true, used_today: 0, used_week: 0, used_month: 0 };

  const u = await readUsage(env, userId);

  // Per-tier request caps first (daily, weekly, monthly).
  const row = u.tiers[tier];
  if (row.daily_limit !== null && row.daily_used >= row.daily_limit) {
    return { ok: false, scope: 'daily', used: row.daily_used, limit: row.daily_limit, resets_at: u.resets_daily_at };
  }
  if (row.weekly_limit !== null && row.weekly_used >= row.weekly_limit) {
    return { ok: false, scope: 'weekly', used: row.weekly_used, limit: row.weekly_limit, resets_at: u.resets_weekly_at };
  }
  if (row.monthly_limit !== null && row.monthly_used >= row.monthly_limit) {
    return { ok: false, scope: 'monthly', used: row.monthly_used, limit: row.monthly_limit, resets_at: u.resets_monthly_at };
  }

  // Per-account token ceilings across all tiers.
  const tokenLim = ACCOUNT_TOKEN_LIMITS[plan === 'plus' ? 'plus' : 'free'];
  if (tokenLim) {
    if (u.account_tokens.daily >= tokenLim.daily) {
      return { ok: false, scope: 'tokens_daily', used: u.account_tokens.daily, limit: tokenLim.daily, resets_at: u.resets_daily_at };
    }
    if (u.account_tokens.monthly >= tokenLim.monthly) {
      return { ok: false, scope: 'tokens_monthly', used: u.account_tokens.monthly, limit: tokenLim.monthly, resets_at: u.resets_monthly_at };
    }
  }

  return { ok: true, used_today: row.daily_used, used_week: row.weekly_used, used_month: row.monthly_used };
}

export async function recordUsage(env, userId, modelKey, tier, tokens = 0) {
  if (!env.DB) return;
  try {
    const cost = costMicro(modelKey, tokens);
    await env.DB.prepare(
      'INSERT INTO usage_log (user_id, model_key, tier, day_key, week_key, tokens, cost_micro, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(userId, modelKey, tier, dayKey(), weekKey(), tokens, cost, Date.now()).run();
  } catch (_) { /* swallow — logging is best-effort */ }
}

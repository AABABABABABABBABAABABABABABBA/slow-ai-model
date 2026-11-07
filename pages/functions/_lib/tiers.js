// Model catalog + tiering + Claude-style weekly/daily usage limits.

export const MODEL_CATALOG = {
  // ---- free tier: unlimited for everyone ----
  'fast':         { tier: 'free',  worker: 'chat', displayName: 'ChadGPT Fast',       modelName: 'Llama 3.1 8B fast' },
  'small':        { tier: 'free',  worker: 'chat', displayName: 'ChadGPT Small',      modelName: 'Llama 3.2 3B' },
  'tiny':         { tier: 'free',  worker: 'chat', displayName: 'ChadGPT Tiny',       modelName: 'Llama 3.2 1B' },
  'mistral':      { tier: 'free',  worker: 'chat', displayName: 'Mistral 7B',         modelName: 'Mistral 7B Instruct' },
  'gemma':        { tier: 'free',  worker: 'chat', displayName: 'Gemma 7B',           modelName: 'Google Gemma 7B' },
  'openchat':     { tier: 'free',  worker: 'chat', displayName: 'OpenChat 3.5',       modelName: 'OpenChat 3.5 0106' },
  'phi':          { tier: 'free',  worker: 'chat', displayName: 'Phi-2',              modelName: 'Microsoft Phi-2' },

  // ---- pro tier: Plus only, 50/day 300/week ----
  'llama-3':      { tier: 'pro',   worker: 'chat', displayName: 'Llama 3 8B',         modelName: 'Llama 3 8B Instruct' },
  'hermes':       { tier: 'pro',   worker: 'chat', displayName: 'Hermes 2 Pro',       modelName: 'Hermes 2 Pro Mistral 7B' },
  'qwen-14b':     { tier: 'pro',   worker: 'chat', displayName: 'Qwen 1.5 14B',       modelName: 'Qwen 1.5 14B Chat' },
  'gemma-12b':    { tier: 'pro',   worker: 'chat', displayName: 'Gemma 3 12B',        modelName: 'Google Gemma 3 12B' },
  'mistral-24b':  { tier: 'pro',   worker: 'chat', displayName: 'Mistral 24B',        modelName: 'Mistral Small 3.1 24B' },
  'chadcoder':    { tier: 'pro',   worker: 'code', model: 'deepseek', displayName: 'ChadCoder', modelName: 'DeepSeek Coder 6.7B' },

  // ---- ultra tier: Plus only, 15/day 75/week ----
  'llama-70b':    { tier: 'ultra', worker: 'chat', displayName: 'Llama 3.3 70B',      modelName: 'Llama 3.3 70B fp8 fast' },
  'deepseek-r1':  { tier: 'ultra', worker: 'chat', displayName: 'DeepSeek R1 32B',    modelName: 'DeepSeek R1 Distill Qwen 32B' },
  'qwen-coder':   { tier: 'ultra', worker: 'chat', displayName: 'Qwen2.5 Coder 32B',  modelName: 'Qwen 2.5 Coder 32B' },
};

// Daily and weekly caps per tier. Mirrors the shape of Claude's plan limits.
export const LIMITS = {
  free:  { daily: Infinity, weekly: Infinity },
  pro:   { daily: 50,  weekly: 300 },
  ultra: { daily: 15,  weekly: 75 },
};

export function tierForModel(key) {
  return MODEL_CATALOG[key]?.tier || 'free';
}

export function modelMeta(key) {
  return MODEL_CATALOG[key] || null;
}

// ISO week number (UTC)
export function weekKey(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function dayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

// When the next daily/weekly window opens, as epoch ms.
export function nextDailyResetMs(now = Date.now()) {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0);
}
export function nextWeeklyResetMs(now = Date.now()) {
  const d = new Date(now);
  const dayNum = d.getUTCDay() || 7;        // Mon=1..Sun=7
  const daysUntilMonday = ((8 - dayNum) % 7) || 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + daysUntilMonday, 0, 0, 0);
}

// Does this user's plan allow this tier at all? (ignores quota)
export function planAllowsTier(plan, tier) {
  if (tier === 'free') return true;
  return plan === 'plus';
}

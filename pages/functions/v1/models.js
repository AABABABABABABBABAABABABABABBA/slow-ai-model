// GET /v1/models — OpenAI-compatible model list.
//
// Returns ChadGPT's catalog in the OAI shape so clients that call this
// endpoint on startup (opencode, aider, continue.dev, raw openai SDK)
// see our models instead of the empty default. Tier is stashed on each
// entry so a UI can group Free / Plus / Unlimited.

import { getAuthedUser, json } from '../_lib/auth.js';
import { MODEL_CATALOG } from '../_lib/tiers.js';

export async function onRequestGet({ request, env }) {
  const user = await getAuthedUser(request, env);   // optional — list is the same, but we filter to usable models when authed
  const plan = user?.plan || 'anonymous';

  const now = Math.floor(Date.now() / 1000);
  const items = Object.entries(MODEL_CATALOG).map(([key, m]) => ({
    id: 'chadgpt-' + key,
    object: 'model',
    created: now,
    owned_by: 'chadgpt',
    tier: m.tier,
    display_name: m.displayName,
    model_name: m.modelName,
    worker: m.worker,
    // Help OAI-compat CLIs: flag free-tier entries so they pick a sensible default.
    free: m.tier === 'free',
  }));
  // Signed-in users get an "allowed" flag so a TUI can gray out
  // models their plan can't use without hiding them.
  for (const it of items) {
    if (plan === 'anonymous') it.allowed = it.tier === 'free';
    else if (plan === 'plus' || plan === 'unlimited') it.allowed = true;
    else it.allowed = it.tier === 'free';
  }

  return json({ object: 'list', data: items });
}

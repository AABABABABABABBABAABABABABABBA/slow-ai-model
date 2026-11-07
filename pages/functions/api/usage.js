// GET /api/usage — returns the user's plan + current period usage + limits.
import { getAuthedUser, isFounder, json, unauthorized } from '../_lib/auth.js';
import { readUsage } from '../_lib/usage.js';
import { MODEL_CATALOG } from '../_lib/tiers.js';

export async function onRequestGet({ request, env }) {
  const user = await getAuthedUser(request, env);
  if (!user) return unauthorized();
  if (!env.DB) return json({ error: 'database not configured' }, { status: 500 });
  try {
    const u = await readUsage(env, user.id);
    return json({
      plan: user.plan,
      granted_by: user.granted_by,
      is_founder: isFounder(env, user),
      ...u,
      catalog: MODEL_CATALOG,
    });
  } catch (err) {
    return json({ error: 'usage read failed', detail: err?.message || String(err) }, { status: 500 });
  }
}

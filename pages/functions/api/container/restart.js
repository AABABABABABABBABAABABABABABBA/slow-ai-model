// POST /api/container/restart — stop current, provision fresh.
import { getAuthedUser, json, unauthorized } from '../../_lib/auth.js';
import { ensureRunning, toResponse } from '../../_lib/container.js';

export async function onRequestPost({ request, env }) {
  const user = await getAuthedUser(request, env);
  if (!user) return unauthorized();
  if (!env.DB) return json({ error: 'database not configured' }, { status: 500 });
  const region = request.cf?.colo || null;
  try {
    const now = Date.now();
    await env.DB.prepare(
      'UPDATE containers SET status = ?, stopped_at = ?, last_seen_at = ? WHERE user_id = ? AND status = ?'
    ).bind('stopped', now, now, user.id, 'running').run();
    const row = await ensureRunning(env, user.id, region);
    return json({ container: toResponse(row, region), restarted: true });
  } catch (err) {
    return json({ error: 'restart failed', detail: err?.message || String(err) }, { status: 500 });
  }
}

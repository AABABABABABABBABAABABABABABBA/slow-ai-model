// POST /api/container/stop — stop the user's running container.
import { getAuthedUser, json, unauthorized } from '../../_lib/auth.js';

export async function onRequestPost({ request, env }) {
  const user = await getAuthedUser(request, env);
  if (!user) return unauthorized();
  if (!env.DB) return json({ error: 'database not configured' }, { status: 500 });
  try {
    const now = Date.now();
    await env.DB.prepare(
      'UPDATE containers SET status = ?, stopped_at = ?, last_seen_at = ? WHERE user_id = ? AND status = ?'
    ).bind('stopped', now, now, user.id, 'running').run();
    return json({ ok: true, stopped: true });
  } catch (err) {
    return json({ error: 'stop failed', detail: err?.message || String(err) }, { status: 500 });
  }
}

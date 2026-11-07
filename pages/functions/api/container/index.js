// GET /api/container — return the user's running container (auto-provisions).
// POST /api/container — same (POST allowed for convenience).
import { getAuthedUser, json, unauthorized } from '../../_lib/auth.js';
import { ensureRunning, toResponse } from '../../_lib/container.js';

async function handle(request, env) {
  const user = await getAuthedUser(request, env);
  if (!user) return unauthorized();
  if (!env.DB) return json({ error: 'database not configured' }, { status: 500 });
  const region = request.cf?.colo || null;
  try {
    const row = await ensureRunning(env, user.id, region);
    return json({ container: toResponse(row, region) });
  } catch (err) {
    return json({ error: 'container failed', detail: err?.message || String(err) }, { status: 500 });
  }
}

export const onRequestGet  = ({ request, env }) => handle(request, env);
export const onRequestPost = ({ request, env }) => handle(request, env);

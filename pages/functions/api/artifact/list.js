// GET /api/artifact/list — list artifacts owned by the authed user.
import { getAuthedUser, json, unauthorized } from '../../_lib/auth.js';
import { listArtifactsForUser } from '../../_lib/artifacts.js';

export async function onRequestGet({ request, env }) {
  const user = await getAuthedUser(request, env);
  if (!user) return unauthorized();
  const items = await listArtifactsForUser(env, user.id, { limit: 100 });
  return json({ ok: true, items });
}

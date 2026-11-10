// GET /api/deployments        — list the user's hosted Workers
// DELETE /api/deployments?name=<script_name> — delete one (removes from CF + DB)

import { getAuthedUser, json, unauthorized, forbidden, badRequest } from '../_lib/auth.js';

export async function onRequestGet({ request, env }) {
  const user = await getAuthedUser(request, env);
  if (!user) return unauthorized();
  if (!env.DB) return json({ error: 'DB not bound' }, { status: 500 });

  const r = await env.DB.prepare(
    'SELECT id, script_name, slug, url, size_bytes, created_at, updated_at FROM deployments WHERE user_id = ? ORDER BY created_at DESC'
  ).bind(user.id).all();
  return json({ deployments: r.results || [] });
}

export async function onRequestDelete({ request, env }) {
  const user = await getAuthedUser(request, env);
  if (!user) return unauthorized();
  if (user.plan !== 'plus' && user.plan !== 'unlimited') return forbidden('Plus required');
  if (!env.DB) return json({ error: 'DB not bound' }, { status: 500 });
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) return json({ error: 'deploy not configured' }, { status: 503 });

  const url = new URL(request.url);
  const name = url.searchParams.get('name');
  if (!name) return badRequest('name query param required');

  // Ownership check — user can only delete their own scripts.
  const row = await env.DB.prepare('SELECT user_id FROM deployments WHERE script_name = ?').bind(name).first();
  if (!row) return json({ error: 'not found' }, { status: 404 });
  if (Number(row.user_id) !== Number(user.id)) return forbidden('not your deployment');

  const del = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/workers/scripts/${encodeURIComponent(name)}`,
    { method: 'DELETE', headers: { 'Authorization': `Bearer ${env.CF_API_TOKEN}` } }
  );
  // CF returns 200 or 404 (already gone) — both fine from the user's POV.
  await env.DB.prepare('DELETE FROM deployments WHERE script_name = ?').bind(name).run();

  return json({ ok: true, name, cloudflare_status: del.status });
}

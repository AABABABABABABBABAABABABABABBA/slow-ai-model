// POST /api/cli/license  (logged-in users)
//   Body: {} or { note?: string }
//   Returns: { key, plan, bound_devices, instructions }
//   One-shot: the raw key is only in the response. We store only its SHA-256
//   hash on the license worker's licenses table (keyed by owner_email).
//
// GET /api/cli/license    (logged-in users)
//   Lists this user's licenses (metadata only — never the raw key again).
//
// Plans:
//   free      -> 'free' license, 1 device, no Pro features
//   plus      -> 'pro'  license, 2 devices
//   unlimited -> 'team' license, 10 devices, no expiry
//
// This endpoint talks to the chadcode-license Worker via its REST surface.
// The caller is proved out via the normal Pages session cookie; we attach a
// server-side bearer (CHADCODE_LICENSE_ADMIN_TOKEN) to the worker call.

import { getAuthedUser, json, unauthorized, badRequest } from '../../_lib/auth.js';

const PLAN_TO_LICENSE = {
  free:      { plan: 'free',  max_devices: 1  },
  plus:      { plan: 'pro',   max_devices: 2  },
  unlimited: { plan: 'team',  max_devices: 10 },
};

function randomKey() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  // Human-readable format: chad-xxxxx-xxxxx-xxxxx-xxxxx-xxxxx-xxxxx
  const groups = [];
  for (let i = 0; i < hex.length; i += 10) groups.push(hex.slice(i, i + 10));
  return 'chad-' + groups.slice(0, 6).join('-');
}

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function onRequestPost({ request, env }) {
  const user = await getAuthedUser(request, env);
  if (!user) return unauthorized();
  if (!env.LICENSE_WORKER_URL || !env.CHADCODE_LICENSE_ADMIN_TOKEN) {
    return json({
      error: 'cli licensing not configured',
      detail: 'Server is missing LICENSE_WORKER_URL or CHADCODE_LICENSE_ADMIN_TOKEN. Founder must set both via wrangler pages secret put.',
    }, { status: 503 });
  }

  let body;
  try { body = await request.json(); } catch { body = {}; }
  const spec = PLAN_TO_LICENSE[user.plan] || PLAN_TO_LICENSE.free;
  const key = randomKey();
  const keyHash = await sha256Hex(key);
  const id = 'lic_' + keyHash.slice(0, 20);
  const note = typeof body.note === 'string' ? body.note.slice(0, 200) : `Issued to ${user.email} on ${new Date().toISOString().slice(0, 10)}`;

  // Call the license worker's admin create endpoint.
  const r = await fetch(env.LICENSE_WORKER_URL + '/license/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + env.CHADCODE_LICENSE_ADMIN_TOKEN },
    body: JSON.stringify({ id, key_hash: keyHash, plan: spec.plan, owner_email: user.email, max_devices: spec.max_devices, note }),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    return json({ error: 'license worker rejected the issue', status: r.status, detail }, { status: 502 });
  }

  return json({
    ok: true,
    key,
    plan: spec.plan,
    bound_devices: 0,
    max_devices: spec.max_devices,
    instructions: {
      env: `export CHADCODE_LICENSE='${key}'`,
      run: 'chadcode',
      note: 'Save this key — we never show it again. To bind it to this machine, run `chadcode` once and the CLI calls /license/activate automatically.',
    },
  });
}

export async function onRequestGet({ request, env }) {
  const user = await getAuthedUser(request, env);
  if (!user) return unauthorized();
  if (!env.LICENSE_WORKER_URL || !env.CHADCODE_LICENSE_ADMIN_TOKEN) {
    return json({ error: 'cli licensing not configured' }, { status: 503 });
  }
  const r = await fetch(env.LICENSE_WORKER_URL + '/license/list?owner_email=' + encodeURIComponent(user.email), {
    headers: { 'Authorization': 'Bearer ' + env.CHADCODE_LICENSE_ADMIN_TOKEN },
  });
  if (!r.ok) return json({ error: 'license worker list failed', status: r.status }, { status: 502 });
  return new Response(r.body, { status: 200, headers: { 'Content-Type': 'application/json' } });
}

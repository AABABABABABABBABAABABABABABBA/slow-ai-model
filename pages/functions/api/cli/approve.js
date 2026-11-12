// POST /api/cli/approve
//
// Browser-side: the user is signed in on this origin and clicked "Approve"
// after being bounced here from the CLI. We:
//   1. Look up the pending device-code by its user_code.
//   2. Mint a license key for this user via the chadcode-license worker
//      (reuses the same plan → max_devices mapping as /api/cli/license).
//   3. Flip the record to approved with the key attached.
//   4. Return the deep-link the browser should navigate to so the OS
//      "Open ChadCode?" protocol handler fires:
//           chadcode://login?key=<key>&device_code=<dc>
//      (The CLI is already polling /api/cli/poll in the background, so
//      even if the protocol handler isn't installed the login still
//      completes — the deep-link is just the fast path.)
//
// Requires: signed-in session cookie.

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
  if (!user) return unauthorized('please sign in first');
  if (!env.SESSIONS) return json({ error: 'SESSIONS KV not bound' }, { status: 500 });
  if (!env.LICENSE_WORKER_URL || !env.CHADCODE_LICENSE_ADMIN_TOKEN) {
    return json({ error: 'license worker not configured' }, { status: 503 });
  }

  let body;
  try { body = await request.json(); } catch { body = {}; }
  const uc = typeof body.user_code === 'string' ? body.user_code.toUpperCase().trim() : '';
  if (!uc || !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(uc)) {
    return badRequest('user_code must look like ABCD-EFGH');
  }

  // Resolve user_code → device_code
  const dc = await env.SESSIONS.get(`cli:uc:${uc}`);
  if (!dc) return json({ error: 'code not found or expired — restart the CLI and try again' }, { status: 404 });

  const raw = await env.SESSIONS.get(`cli:dc:${dc}`);
  if (!raw) return json({ error: 'device code expired — restart the CLI' }, { status: 410 });

  let rec;
  try { rec = JSON.parse(raw); } catch { return json({ error: 'device record corrupt' }, { status: 500 });}
  if (rec.status === 'approved') return json({ error: 'already approved' }, { status: 409 });

  // Mint the license through the license worker (same shape as
  // /api/cli/license so one user doesn't get a different kind of key
  // depending on which path they took).
  const spec = PLAN_TO_LICENSE[user.plan] || PLAN_TO_LICENSE.free;
  const key = randomKey();
  const keyHash = await sha256Hex(key);
  const id = 'lic_' + keyHash.slice(0, 20);
  const note = `CLI device-login for ${user.email} on ${new Date().toISOString().slice(0, 10)} (${rec?.client?.hostname || 'unknown host'})`;

  const r = await fetch(env.LICENSE_WORKER_URL + '/license/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + env.CHADCODE_LICENSE_ADMIN_TOKEN },
    body: JSON.stringify({ id, key_hash: keyHash, plan: spec.plan, owner_email: user.email, max_devices: spec.max_devices, note }),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    return json({ error: 'license worker rejected the issue', status: r.status, detail }, { status: 502 });
  }

  // Flip the record to approved — key lives here only until the CLI polls.
  rec.status = 'approved';
  rec.user_id = user.id;
  rec.email = user.email;
  rec.plan = spec.plan;
  rec.key = key;
  rec.approved_at = Date.now();
  // Keep TTL short — the CLI should poll inside a few seconds.
  await env.SESSIONS.put(`cli:dc:${dc}`, JSON.stringify(rec), { expirationTtl: 120 });

  // Deep-link the browser should hit next. The CLI polling path is the
  // real transport; this is just the OS "Open ChadCode?" popup trigger
  // when the protocol handler is installed on this machine.
  const deepLink = `chadcode://login?key=${encodeURIComponent(key)}&device_code=${encodeURIComponent(dc)}`;

  return json({
    ok: true,
    deep_link: deepLink,
    plan: spec.plan,
    email: user.email,
  });
}

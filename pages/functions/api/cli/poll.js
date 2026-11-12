// POST /api/cli/poll
//
// The CLI calls this every `interval` seconds (hinted by /device-code)
// with { device_code }. Three possible outcomes:
//
//   status: 'pending'   — nobody has approved yet; keep polling
//   status: 'approved'  — someone signed in and approved; here's the key
//   status: 'expired'   — the device code TTL ran out; mint a new one
//
// On 'approved' we delete the record so a second poll can't re-read the
// key — the CLI should have persisted it before polling again anyway.
//
// Public endpoint. The device code itself is the capability.

import { json } from '../../_lib/auth.js';

export async function onRequestPost({ request, env }) {
  if (!env.SESSIONS) return json({ error: 'SESSIONS KV not bound' }, { status: 500 });

  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid JSON' }, { status: 400 }); }
  const dc = typeof body.device_code === 'string' ? body.device_code : '';
  if (!dc || !dc.startsWith('de_')) return json({ error: 'device_code required' }, { status: 400 });

  const raw = await env.SESSIONS.get(`cli:dc:${dc}`);
  if (!raw) return json({ status: 'expired' });

  let rec;
  try { rec = JSON.parse(raw); } catch { return json({ status: 'expired' }); }

  if (rec.status === 'approved' && rec.key) {
    // One-shot read: consume the record so the key can't be re-fetched.
    await env.SESSIONS.delete(`cli:dc:${dc}`);
    if (rec.user_code) await env.SESSIONS.delete(`cli:uc:${rec.user_code}`);
    return json({
      status: 'approved',
      key: rec.key,
      user_id: rec.user_id,
      email: rec.email || '',
      plan: rec.plan || 'free',
    });
  }

  return json({ status: rec.status || 'pending' });
}

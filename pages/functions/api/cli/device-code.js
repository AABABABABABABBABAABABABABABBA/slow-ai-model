// POST /api/cli/device-code
//
// First step of the CLI device-code flow — matches RFC 8628 shape but
// scoped to our own minting, no OAuth provider.
//
// The CLI calls this with no auth. We mint a random device code + a short
// human-readable user code (so the person can paste it manually if the
// click-through doesn't work), stash the pending state in KV with a 10-
// minute TTL, and hand back the two codes plus the browser URL. The CLI
// then starts polling /api/cli/poll until the pairing is approved.
//
// Public endpoint: no cookie required.
//
// Request:  (empty body ok)
// Returns:
//   {
//     device_code: 'de_...',                 // long random id the CLI keeps secret
//     user_code:   'ABCD-EFGH',              // short code shown to the user
//     verification_uri:          '.../cli-auth',
//     verification_uri_complete: '.../cli-auth?code=ABCD-EFGH',
//     expires_in: 600,                       // seconds
//     interval:   2,                         // poll interval hint
//   }

import { json } from '../../_lib/auth.js';

const TTL_SECONDS = 600;        // 10 minutes
const POLL_INTERVAL = 2;        // seconds

function rand(bytes = 32) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a).map(b => b.toString(16).padStart(2, '0')).join('');
}

// User-facing short code: 8 chars from an ambiguity-free alphabet,
// grouped as XXXX-XXXX. Short enough to type on a phone, unique enough
// across any realistic window of in-flight device codes.
function userCode() {
  const alpha = 'BCDFGHJKLMNPQRSTVWXYZ23456789';  // no vowels or 0/1/I/O
  const a = new Uint8Array(8);
  crypto.getRandomValues(a);
  let s = '';
  for (let i = 0; i < 8; i++) s += alpha[a[i] % alpha.length];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

export async function onRequestPost({ request, env }) {
  if (!env.SESSIONS) return json({ error: 'SESSIONS KV not bound' }, { status: 500 });

  const origin = env.PAGES_ORIGIN || new URL(request.url).origin;
  const deviceCode = 'de_' + rand(32);
  const userCodeStr = userCode();

  // Optional client metadata — logged but not required.
  let meta = {};
  try { meta = await request.json(); } catch {}
  const clientMeta = {
    platform: typeof meta.platform === 'string' ? meta.platform.slice(0, 40) : '',
    version:  typeof meta.version  === 'string' ? meta.version.slice(0, 40)  : '',
    hostname: typeof meta.hostname === 'string' ? meta.hostname.slice(0, 80) : '',
    created:  Date.now(),
  };

  const record = {
    status: 'pending',          // pending | approved | expired
    user_code: userCodeStr,
    client: clientMeta,
    user_id: null,              // filled on approve
    key: null,                  // filled on approve
    approved_at: null,
  };

  // Two keys so we can look up by either side. User-code key stores only a
  // pointer to the device-code key, so the long secret never moves.
  await env.SESSIONS.put(`cli:dc:${deviceCode}`, JSON.stringify(record), { expirationTtl: TTL_SECONDS });
  await env.SESSIONS.put(`cli:uc:${userCodeStr}`, deviceCode, { expirationTtl: TTL_SECONDS });

  return json({
    device_code: deviceCode,
    user_code: userCodeStr,
    verification_uri: `${origin}/cli-auth`,
    verification_uri_complete: `${origin}/cli-auth?code=${encodeURIComponent(userCodeStr)}`,
    expires_in: TTL_SECONDS,
    interval: POLL_INTERVAL,
  });
}

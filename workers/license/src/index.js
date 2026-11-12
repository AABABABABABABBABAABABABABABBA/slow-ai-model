// ChadCode license + auto-update worker.
// Backs the forked OpenCode distribution. Every running client calls this
// on startup to prove it has a valid license bound to its hardware, and
// periodically to pick up signed updates.
//
// Endpoints
//   POST /license/activate  — bind a key to a fingerprint (first run only)
//   POST /license/verify    — check key is valid + bound to this fingerprint
//   POST /license/revoke    — founder-only
//   GET  /update/check      — returns { latest, url, signature } per platform
//   POST /update/publish    — founder-only; publishes a new build
//
// Storage is Cloudflare D1 (LIC_DB). Builds live in R2 (BUILDS). Config in KV
// (LIC_KV) for release channel + update signing key fingerprint.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    try {
      if (url.pathname === '/license/activate' && request.method === 'POST')  return activate(request, env);
      if (url.pathname === '/license/verify'   && request.method === 'POST')  return verify(request, env);
      if (url.pathname === '/license/revoke'   && request.method === 'POST')  return revoke(request, env);
      if (url.pathname === '/license/create'   && request.method === 'POST')  return createLicense(request, env);
      if (url.pathname === '/license/list'     && request.method === 'GET')   return listLicenses(request, env);
      if (url.pathname === '/download'         && request.method === 'GET')   return downloadBinary(request, env);
      if (url.pathname === '/update/check'     && request.method === 'GET')   return updateCheck(request, env);
      if (url.pathname === '/update/publish'   && request.method === 'POST')  return updatePublish(request, env);
      if (url.pathname === '/health')                                          return j({ ok: true, service: 'chadcode-license', ts: Date.now() });
      return j({ error: 'not found' }, 404);
    } catch (err) {
      return j({ error: 'server error', detail: err?.message || String(err) }, 500);
    }
  },
};

function j(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function founderAuth(request, env) {
  const got = request.headers.get('Authorization') || '';
  const want = 'Bearer ' + (env.FOUNDER_TOKEN || '');
  // constant-time-ish compare
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0 && !!env.FOUNDER_TOKEN;
}

// ---------- /license/activate ----------
// Body: { key, fingerprint, hostname?, platform? }
// On first call: bind key to fingerprint. Second call with a different
// fingerprint: reject (unless the key is marked transferable).
async function activate(request, env) {
  const body = await request.json().catch(() => null);
  if (!body?.key || !body?.fingerprint) return j({ error: 'key and fingerprint required' }, 400);
  if (!env.LIC_DB) return j({ error: 'LIC_DB not bound' }, 500);

  const keyHash = await sha256Hex(body.key);
  const row = await env.LIC_DB.prepare(
    'SELECT id, plan, max_devices, expires_at, revoked, transferable FROM licenses WHERE key_hash = ?'
  ).bind(keyHash).first();
  if (!row) return j({ error: 'invalid license key' }, 404);
  if (row.revoked) return j({ error: 'license revoked' }, 403);
  if (row.expires_at && row.expires_at < Date.now()) return j({ error: 'license expired', expires_at: row.expires_at }, 403);

  // Count devices already bound.
  const devs = await env.LIC_DB.prepare(
    'SELECT fingerprint FROM license_devices WHERE license_id = ?'
  ).bind(row.id).all();
  const bound = (devs.results || []).map(r => r.fingerprint);
  if (bound.includes(body.fingerprint)) {
    await env.LIC_DB.prepare(
      'UPDATE license_devices SET last_seen_at = ?, hostname = ?, platform = ? WHERE license_id = ? AND fingerprint = ?'
    ).bind(Date.now(), body.hostname || '', body.platform || '', row.id, body.fingerprint).run();
    return j({ ok: true, plan: row.plan, expires_at: row.expires_at, fingerprint: body.fingerprint, newly_bound: false });
  }
  if (bound.length >= row.max_devices && !row.transferable) {
    return j({ error: 'license device limit reached', max_devices: row.max_devices, bound: bound.length }, 403);
  }
  await env.LIC_DB.prepare(
    'INSERT INTO license_devices (license_id, fingerprint, hostname, platform, bound_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(row.id, body.fingerprint, body.hostname || '', body.platform || '', Date.now(), Date.now()).run();

  return j({ ok: true, plan: row.plan, expires_at: row.expires_at, fingerprint: body.fingerprint, newly_bound: true });
}

// ---------- /license/verify ----------
// Called on every client startup + every few hours during runtime.
// Returns a short-lived signed token the client caches; if the client
// can't reach us, it falls back to the cached token until it expires.
async function verify(request, env) {
  const body = await request.json().catch(() => null);
  if (!body?.key || !body?.fingerprint) return j({ error: 'key and fingerprint required' }, 400);
  if (!env.LIC_DB) return j({ error: 'LIC_DB not bound' }, 500);

  const keyHash = await sha256Hex(body.key);
  const row = await env.LIC_DB.prepare(
    'SELECT l.id, l.plan, l.expires_at, l.revoked FROM licenses l WHERE l.key_hash = ?'
  ).bind(keyHash).first();
  if (!row) return j({ valid: false, reason: 'unknown key' }, 404);
  if (row.revoked) return j({ valid: false, reason: 'revoked' }, 403);
  if (row.expires_at && row.expires_at < Date.now()) return j({ valid: false, reason: 'expired' }, 403);

  const bound = await env.LIC_DB.prepare(
    'SELECT 1 AS yes FROM license_devices WHERE license_id = ? AND fingerprint = ? LIMIT 1'
  ).bind(row.id, body.fingerprint).first();
  if (!bound) return j({ valid: false, reason: 'fingerprint not bound — run activate first' }, 403);

  await env.LIC_DB.prepare(
    'UPDATE license_devices SET last_seen_at = ? WHERE license_id = ? AND fingerprint = ?'
  ).bind(Date.now(), row.id, body.fingerprint).run();

  // Signed verification token the client caches for offline use.
  const token = await signToken(env, {
    plan: row.plan,
    exp: Date.now() + 24 * 60 * 60 * 1000,   // 24h ceiling for offline runs
    fp: body.fingerprint,
    lic: row.id,
  });
  return j({ valid: true, plan: row.plan, expires_at: row.expires_at, token });
}

async function signToken(env, payload) {
  const secret = env.TOKEN_SECRET || 'chadcode-dev-secret';
  const header = { alg: 'HS256', typ: 'LIC' };
  const b64 = (o) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  const body = `${b64(header)}.${b64(payload)}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${body}.${sigB64}`;
}

// ---------- /license/create ----------
// Founder-only (via FOUNDER_TOKEN). Issues a license row from a pre-hashed
// key — the Pages API computes the SHA-256 on the raw key so we never see
// the plaintext here. Body: { id, key_hash, plan, owner_email, max_devices, note? }
async function createLicense(request, env) {
  if (!founderAuth(request, env)) return j({ error: 'founder only' }, 403);
  const b = await request.json().catch(() => null);
  for (const k of ['id', 'key_hash', 'plan', 'owner_email', 'max_devices']) {
    if (b?.[k] === undefined || b?.[k] === null) return j({ error: `${k} required` }, 400);
  }
  if (!/^[0-9a-f]{64}$/i.test(b.key_hash)) return j({ error: 'key_hash must be 64-char hex' }, 400);
  if (!['free', 'pro', 'team', 'founder-grant'].includes(b.plan)) return j({ error: 'plan must be free/pro/team/founder-grant' }, 400);
  await env.LIC_DB.prepare(
    'INSERT INTO licenses (id, key_hash, plan, owner_email, max_devices, transferable, issued_at, expires_at, revoked, notes) VALUES (?, ?, ?, ?, ?, 0, ?, NULL, 0, ?)'
  ).bind(b.id, b.key_hash, b.plan, b.owner_email, b.max_devices, Date.now(), b.note || null).run();
  return j({ ok: true, id: b.id });
}

// ---------- /license/list ----------
// Founder-only. Returns metadata for an owner's licenses (no raw keys ever).
async function listLicenses(request, env) {
  if (!founderAuth(request, env)) return j({ error: 'founder only' }, 403);
  const url = new URL(request.url);
  const owner = url.searchParams.get('owner_email');
  if (!owner) return j({ error: 'owner_email required' }, 400);
  const rows = await env.LIC_DB.prepare(
    'SELECT id, plan, max_devices, issued_at, expires_at, revoked, notes FROM licenses WHERE owner_email = ? ORDER BY issued_at DESC'
  ).bind(owner).all();
  const withCounts = [];
  for (const row of (rows.results || [])) {
    const dev = await env.LIC_DB.prepare(
      'SELECT COUNT(*) AS n FROM license_devices WHERE license_id = ?'
    ).bind(row.id).first();
    withCounts.push({ ...row, bound_devices: Number(dev?.n || 0) });
  }
  return j({ licenses: withCounts });
}

// ---------- /download ----------
// GET /download?platform=darwin-arm64  with Authorization: Bearer <license-key>
// Streams the matching binary from R2 after verifying the license is active.
// Platforms map 1:1 to the folder names in the build output
// (darwin-arm64, darwin-x64, linux-x64, linux-arm64, windows-x64, windows-arm64).
async function downloadBinary(request, env) {
  if (!env.BINARIES) return j({ error: 'binary bucket not bound' }, 503);
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) return j({ error: 'bearer license key required' }, 401);

  const keyHash = await sha256Hex(token);
  const row = await env.LIC_DB.prepare(
    'SELECT id, plan, expires_at, revoked FROM licenses WHERE key_hash = ?'
  ).bind(keyHash).first();
  if (!row) return j({ error: 'invalid license' }, 403);
  if (row.revoked) return j({ error: 'license revoked' }, 403);
  if (row.expires_at && row.expires_at < Date.now()) return j({ error: 'license expired' }, 403);

  const url = new URL(request.url);
  const platform = (url.searchParams.get('platform') || '').toLowerCase();
  if (!/^(darwin|linux|windows)-(arm64|x64)(-baseline)?(-musl)?$/.test(platform)) {
    return j({ error: 'invalid platform', expected: 'darwin-arm64 | darwin-x64 | linux-x64 | linux-arm64 | windows-x64 | windows-arm64' }, 400);
  }
  const ext = platform.startsWith('windows') ? '.exe' : '';
  const key = `chadcode/${platform}/chadcode${ext}`;

  const obj = await env.BINARIES.get(key);
  if (!obj) return j({ error: 'binary not found in R2', key }, 404);

  return new Response(obj.body, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="chadcode${ext}"`,
      'Content-Length': String(obj.size),
      'X-License-Plan': row.plan,
    },
  });
}

// ---------- /license/revoke ----------
async function revoke(request, env) {
  if (!founderAuth(request, env)) return j({ error: 'founder only' }, 403);
  const body = await request.json().catch(() => null);
  if (!body?.key) return j({ error: 'key required' }, 400);
  const keyHash = await sha256Hex(body.key);
  const r = await env.LIC_DB.prepare('UPDATE licenses SET revoked = 1 WHERE key_hash = ?').bind(keyHash).run();
  return j({ ok: true, changes: r.meta?.changes || 0 });
}

// ---------- /update/check ----------
async function updateCheck(request, env) {
  const url = new URL(request.url);
  const current = url.searchParams.get('version') || '0.0.0';
  const platform = url.searchParams.get('platform') || 'unknown';
  const channel = url.searchParams.get('channel') || 'stable';
  if (!env.LIC_DB) return j({ error: 'LIC_DB not bound' }, 500);

  const row = await env.LIC_DB.prepare(
    'SELECT version, platform, url, sha256, signature, published_at FROM releases WHERE channel = ? AND platform = ? ORDER BY published_at DESC LIMIT 1'
  ).bind(channel, platform).first();
  if (!row) return j({ update_available: false, current, reason: 'no release for platform' });
  if (semverCompare(row.version, current) <= 0) {
    return j({ update_available: false, current, latest: row.version });
  }
  return j({
    update_available: true,
    current,
    latest: row.version,
    url: row.url,
    sha256: row.sha256,
    signature: row.signature,
    published_at: row.published_at,
  });
}

function semverCompare(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

// ---------- /update/publish ----------
// Founder-only. Body: { channel, version, platform, url, sha256, signature }
async function updatePublish(request, env) {
  if (!founderAuth(request, env)) return j({ error: 'founder only' }, 403);
  const b = await request.json().catch(() => null);
  const need = ['channel', 'version', 'platform', 'url', 'sha256', 'signature'];
  for (const k of need) if (!b?.[k]) return j({ error: `${k} required` }, 400);
  await env.LIC_DB.prepare(
    'INSERT INTO releases (channel, version, platform, url, sha256, signature, published_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(b.channel, b.version, b.platform, b.url, b.sha256, b.signature, Date.now()).run();
  return j({ ok: true });
}

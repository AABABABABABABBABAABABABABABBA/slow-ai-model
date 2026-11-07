// Device fingerprinting — collect signals from the request + optional client
// payload, hash them together, and store them against the user. The founder
// can review repeat devices across emails via /api/admin/users.
//
// Nothing here is bypass-proof: a determined attacker can spoof every signal.
// The point is to make it *annoying* and to spot the "same laptop, five free
// accounts" pattern. The real anti-abuse is server-side per-user quotas.

async function sha256Hex(input) {
  const bytes = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function serverSignals(request) {
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const ua = request.headers.get('User-Agent') || '';
  const cfRay = request.headers.get('CF-Ray') || '';
  // CF-IPCountry / CF-IPCity are *geographic* — useful for drift detection.
  const country = request.headers.get('CF-IPCountry') || '';
  return { ip, ua, country, cfRay };
}

export async function recordFingerprint(env, userId, request, clientSignals) {
  if (!env.DB) return { blocked: false };
  const srv = serverSignals(request);
  // Fingerprint is the hash of client-reported + server-observed signals.
  // client signals (optional) carry things only the browser knows: screen,
  // timezone, navigator stats, canvas/webgl hash. Server signals cover IP + UA.
  const material = JSON.stringify({
    client: clientSignals || {},
    ua: srv.ua,
    country: srv.country,
  });
  const fpHash = await sha256Hex(material);
  const ipHash = await sha256Hex((env.FP_SALT || 'chadgpt-v1') + ':' + srv.ip);
  const uaHash = await sha256Hex(srv.ua);
  const now = Date.now();

  try {
    // Is this fingerprint already blocked (anywhere, for anyone)? Block regardless of user.
    const blocked = await env.DB.prepare(
      'SELECT 1 AS yes FROM device_fingerprints WHERE fp_hash = ? AND blocked = 1 LIMIT 1'
    ).bind(fpHash).first();
    if (blocked) return { blocked: true, fpHash };

    // Upsert this (user, fp) pair.
    const existing = await env.DB.prepare(
      'SELECT id FROM device_fingerprints WHERE user_id = ? AND fp_hash = ? LIMIT 1'
    ).bind(userId, fpHash).first();
    if (existing) {
      await env.DB.prepare(
        'UPDATE device_fingerprints SET last_seen_at = ?, ip_hash = ?, ua_hash = ? WHERE id = ?'
      ).bind(now, ipHash, uaHash, existing.id).run();
    } else {
      await env.DB.prepare(
        'INSERT INTO device_fingerprints (user_id, fp_hash, ip_hash, ua_hash, first_seen_at, last_seen_at, blocked) VALUES (?, ?, ?, ?, ?, ?, 0)'
      ).bind(userId, fpHash, ipHash, uaHash, now, now).run();
    }
  } catch (_) { /* fingerprinting is best-effort */ }

  return { blocked: false, fpHash };
}

export async function usersSharingFingerprint(env, fpHash) {
  if (!env.DB) return [];
  const r = await env.DB.prepare(
    'SELECT DISTINCT u.id, u.email, u.plan FROM device_fingerprints d JOIN users u ON u.id = d.user_id WHERE d.fp_hash = ? ORDER BY u.id'
  ).bind(fpHash).all();
  return r.results || [];
}

export async function blockFingerprint(env, fpHash) {
  if (!env.DB) return;
  await env.DB.prepare(
    'UPDATE device_fingerprints SET blocked = 1 WHERE fp_hash = ?'
  ).bind(fpHash).run();
}

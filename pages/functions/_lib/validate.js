// Strict request validation for Burp / replay / mass-assignment defense.
//
// Every sensitive endpoint runs its JSON body through readJsonBody() which
// enforces:
//   - Request method matches what the endpoint declared
//   - Content-Type is application/json (prevents form-encoded smuggling)
//   - Content-Length (or actual body size) is under the configured cap
//   - JSON parses cleanly (no HTML/binary payloads)
//   - Top-level is an object (not array/null/number — rules out polymorphic injection)
//   - No property outside the allowedKeys set (rejects mass-assignment
//     attempts like POST /password { current_password, new_password,
//     plan: "unlimited", role: "admin" })
//
// Throws a VALIDATION_ERROR with { status, body } the caller can return as-is.

export class ValidationError extends Error {
  constructor(status, body) {
    super(body?.error || 'validation');
    this.status = status;
    this.body = body;
  }
}

export async function readJsonBody(request, opts = {}) {
  const {
    method = 'POST',
    maxBytes = 32 * 1024,      // 32 KB default — chat uses its own larger cap
    allowedKeys = null,         // null = any keys allowed
    requiredKeys = [],
  } = opts;

  if (request.method !== method) {
    throw new ValidationError(405, { error: 'method not allowed', expected: method });
  }

  const ct = (request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (ct !== 'application/json') {
    throw new ValidationError(415, { error: 'unsupported media type', expected: 'application/json', got: ct || '(none)' });
  }

  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > maxBytes) {
    throw new ValidationError(413, { error: 'request too large', max_bytes: maxBytes, got_bytes: len });
  }

  // Read with a hard cap even if Content-Length lied.
  let text;
  try {
    text = await request.text();
  } catch (e) {
    throw new ValidationError(400, { error: 'could not read body', detail: String(e?.message || e) });
  }
  if (text.length > maxBytes) {
    throw new ValidationError(413, { error: 'request too large', max_bytes: maxBytes });
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new ValidationError(400, { error: 'invalid JSON' });
  }

  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError(400, { error: 'body must be a JSON object' });
  }

  for (const key of requiredKeys) {
    if (!(key in body)) throw new ValidationError(400, { error: `missing required field: ${key}` });
  }

  if (allowedKeys) {
    const allowed = new Set(allowedKeys);
    const extras = Object.keys(body).filter(k => !allowed.has(k));
    if (extras.length) {
      throw new ValidationError(400, { error: 'unexpected properties', extras });
    }
  }

  return body;
}

// Simple D1-backed replay protection. Each sensitive mutation sends a client
// nonce + timestamp; we reject if the nonce was used in the last 10 minutes.
// Caller must have applied the `used_nonces` migration (schema.sql).
export async function assertFreshNonce(env, user, nonce, opName) {
  if (!env.DB) return;
  if (typeof nonce !== 'string' || !/^[a-z0-9-]{16,64}$/i.test(nonce)) {
    throw new ValidationError(400, { error: 'nonce required (16-64 hex/base36 chars)' });
  }
  const now = Date.now();
  const ttl = 10 * 60 * 1000;
  // Try to insert — unique index on nonce enforces one-shot.
  try {
    await env.DB.prepare(
      'INSERT INTO used_nonces (nonce, user_id, op, created_at) VALUES (?, ?, ?, ?)'
    ).bind(nonce, user?.id || 0, opName || 'unknown', now).run();
  } catch (err) {
    const msg = String(err?.message || err);
    if (/UNIQUE constraint|constraint failed/i.test(msg)) {
      throw new ValidationError(409, { error: 'replay detected', detail: 'this nonce was already used' });
    }
    throw new ValidationError(500, { error: 'nonce check failed', detail: msg });
  }
  // Best-effort cleanup — drop rows older than the TTL window to keep the
  // table small.
  try {
    await env.DB.prepare('DELETE FROM used_nonces WHERE created_at < ?').bind(now - ttl).run();
  } catch {}
}

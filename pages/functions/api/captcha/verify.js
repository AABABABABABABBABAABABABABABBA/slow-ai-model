// POST /api/captcha/verify — exchanges an hCaptcha token for a short-lived
// signed "captcha receipt" the client includes on subsequent chat calls.
//
// Body: { token } — the response token from hCaptcha's widget
// Returns: { ok, receipt, expires_at } — JWT-style receipt, valid 10 min
//
// The chat endpoint checks the receipt BEFORE allowing a free or unlimited
// user to send a message. Paid Plus users skip the captcha entirely.
//
// Secrets (set via wrangler pages secret put):
//   HCAPTCHA_SECRET - server-side secret from hcaptcha.com/publisher
//
// Public config (vars):
//   HCAPTCHA_SITEKEY - the public site key the client widget embeds

import { getAuthedUser, json, unauthorized } from '../../_lib/auth.js';
import { readJsonBody, ValidationError } from '../../_lib/validate.js';

// hCaptcha's always-pass test keys. REPLACE with real keys from
// hcaptcha.com/publisher to actually earn revenue.
const TEST_SECRET = '0x0000000000000000000000000000000000000000';

export async function onRequestPost({ request, env }) {
  const user = await getAuthedUser(request, env);
  if (!user) return unauthorized();

  let body;
  try {
    body = await readJsonBody(request, {
      method: 'POST',
      maxBytes: 8 * 1024,
      allowedKeys: ['token'],
      requiredKeys: ['token'],
    });
  } catch (err) {
    if (err instanceof ValidationError) return json(err.body, { status: err.status });
    throw err;
  }

  const secret = env.HCAPTCHA_SECRET || TEST_SECRET;
  const form = new URLSearchParams();
  form.set('secret', secret);
  form.set('response', body.token);
  const ip = request.headers.get('CF-Connecting-IP') || '';
  if (ip) form.set('remoteip', ip);

  let verifyRes;
  try {
    verifyRes = await fetch('https://api.hcaptcha.com/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
  } catch (err) {
    return json({ ok: false, error: 'hcaptcha unreachable', detail: String(err?.message || err) }, { status: 502 });
  }

  const vj = await verifyRes.json().catch(() => ({}));
  if (!vj.success) {
    return json({ ok: false, error: 'captcha failed', codes: vj['error-codes'] || [] }, { status: 403 });
  }

  // Mint a short-lived signed receipt bound to this user.
  const nowSec = Math.floor(Date.now() / 1000);
  const ttlSec = 10 * 60;
  const payload = { sub: user.id, exp: nowSec + ttlSec, iat: nowSec, typ: 'captcha' };
  const receipt = await mintReceipt(env, payload);

  return json({ ok: true, receipt, expires_at: (nowSec + ttlSec) * 1000 });
}

async function mintReceipt(env, payload) {
  const secret = env.JWT_SECRET || 'chadgpt-dev-jwt';
  const b64u = (s) => btoa(typeof s === 'string' ? s : JSON.stringify(s)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const header = b64u({ alg: 'HS256', typ: 'CRP' });
  const body = b64u(payload);
  const signInput = `${header}.${body}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signInput));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${signInput}.${sigB64}`;
}

// Verify a captcha receipt the client includes on gated calls.
// Returns { ok: true, payload } or { ok: false, reason }.

export async function verifyCaptchaReceipt(env, userId, receipt) {
  if (!receipt || typeof receipt !== 'string') {
    return { ok: false, reason: 'receipt_missing' };
  }
  const parts = receipt.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'receipt_malformed' };

  const secret = env.JWT_SECRET || 'chadgpt-dev-jwt';
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);

  // Recompute the signature and compare — constant-time via byte equality.
  const expected = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  const expectedB64 = btoa(String.fromCharCode(...new Uint8Array(expected))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  if (parts[2].length !== expectedB64.length) return { ok: false, reason: 'bad_sig' };
  let diff = 0;
  for (let i = 0; i < parts[2].length; i++) diff |= parts[2].charCodeAt(i) ^ expectedB64.charCodeAt(i);
  if (diff !== 0) return { ok: false, reason: 'bad_sig' };

  let payload;
  try {
    const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    payload = JSON.parse(atob(padded + '==='.slice((padded.length + 3) % 4)));
  } catch { return { ok: false, reason: 'bad_payload' }; }

  if (payload.typ !== 'captcha') return { ok: false, reason: 'wrong_type' };
  if (payload.sub !== userId) return { ok: false, reason: 'wrong_user' };
  if (payload.exp * 1000 < Date.now()) return { ok: false, reason: 'expired' };

  return { ok: true, payload };
}

// Which plans must solve a captcha before each chat.
// Paid Plus is the only exemption — they're already paying.
// Unlimited grants still get the gate so the founder's bill is offset.
export function captchaRequiredFor(plan) {
  return plan !== 'plus';
}

import { clearSessionCookieHeader, json } from '../_lib/auth.js';

export async function onRequestPost() {
  return json({ ok: true }, { headers: { 'Set-Cookie': clearSessionCookieHeader() } });
}

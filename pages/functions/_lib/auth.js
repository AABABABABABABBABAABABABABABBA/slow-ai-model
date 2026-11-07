// Shared helpers for ChadGPT Pages Functions.
// - Password hashing (PBKDF2-SHA256 via Web Crypto)
// - JWT mint + verify (HMAC-SHA256)
// - Worker session token mint (same format the workers already accept)
// - Cookie helpers

const PBKDF2_ITER = 100000;  // Cloudflare Workers caps at 100k
const JWT_TTL_SEC = 60 * 60 * 24 * 7;    // 7 days
const WORKER_TOKEN_TTL_SEC = 60 * 60;    // 1 hour

const te = new TextEncoder();
const td = new TextDecoder();

function b64u(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64uToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function randBytes(n) { const a = new Uint8Array(n); crypto.getRandomValues(a); return a; }
function timingSafeEq(a, b) {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0;
}

// ---------- password hashing (PBKDF2-SHA256) ----------
export async function hashPassword(password) {
  const salt = randBytes(16);
  const key = await crypto.subtle.importKey('raw', te.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: PBKDF2_ITER, hash: 'SHA-256' }, key, 256);
  return `pbkdf2$${PBKDF2_ITER}$${b64u(salt)}$${b64u(new Uint8Array(bits))}`;
}
export async function verifyPassword(password, stored) {
  const parts = (stored || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iter = parseInt(parts[1], 10);
  const salt = b64uToBytes(parts[2]);
  const want = parts[3];
  const key = await crypto.subtle.importKey('raw', te.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, key, 256);
  return timingSafeEq(b64u(new Uint8Array(bits)), want);
}

// ---------- HMAC helpers ----------
async function hmac(secret, data) {
  const key = await crypto.subtle.importKey('raw', te.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, te.encode(data));
  return b64u(new Uint8Array(sig));
}

// ---------- user JWT (session cookie) ----------
export async function mintUserJwt(env, payload) {
  const now = Math.floor(Date.now() / 1000);
  const body = {
    sub: payload.user_id,
    email: payload.email,
    plan: payload.plan || 'free',
    iat: now,
    exp: now + JWT_TTL_SEC,
  };
  const header = b64u(te.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const bodyB64 = b64u(te.encode(JSON.stringify(body)));
  const signingInput = header + '.' + bodyB64;
  const sig = await hmac(env.JWT_SECRET || 'dev-jwt-secret', signingInput);
  return signingInput + '.' + sig;
}

export async function verifyUserJwt(env, token) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const signingInput = parts[0] + '.' + parts[1];
  const expected = await hmac(env.JWT_SECRET || 'dev-jwt-secret', signingInput);
  if (!timingSafeEq(expected, parts[2])) return null;
  try {
    const body = JSON.parse(td.decode(b64uToBytes(parts[1])));
    if (typeof body.exp !== 'number' || body.exp * 1000 < Date.now()) return null;
    return body;
  } catch { return null; }
}

// ---------- worker session token (compatible with the three workers) ----------
// Format: v1.<sess_id>.<expires>.<binding>.<hmac>
export async function mintWorkerToken(env, request, userId) {
  const sessionId = 'sess_' + b64u(randBytes(12)).replace(/_/g, '').slice(0, 24);
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + WORKER_TOKEN_TTL_SEC;
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const ua = (request.headers.get('User-Agent') || '').slice(0, 200);
  const binding = await sha256Hex(ip + '|' + ua);
  const bindingPrefix = binding.slice(0, 16);
  const payload = `${sessionId}.${expiresAt}.${bindingPrefix}`;
  const sig = await hmac(env.WORKER_SESSION_SECRET || 'dev-worker-secret', payload);
  return 'v1.' + payload + '.' + sig;
}

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', te.encode(s));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ---------- cookie helpers ----------
const COOKIE_NAME = 'chadgpt_session';

export function parseCookies(req) {
  const h = req.headers.get('Cookie') || '';
  const out = {};
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function setSessionCookieHeader(token, opts = {}) {
  const maxAge = opts.maxAge ?? JWT_TTL_SEC;
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}
export function clearSessionCookieHeader() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}
export const SESSION_COOKIE_NAME = COOKIE_NAME;

// ---------- auth middleware helpers ----------
export async function getAuthedUser(request, env) {
  const cookies = parseCookies(request);
  const token = cookies[COOKIE_NAME];
  const claims = await verifyUserJwt(env, token);
  if (!claims) return null;
  return { id: claims.sub, email: claims.email, plan: claims.plan, exp: claims.exp };
}

// ---------- JSON response helpers ----------
export function json(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json' }, init.headers || {}),
  });
}
export function badRequest(msg) { return json({ error: msg }, { status: 400 }); }
export function unauthorized(msg) { return json({ error: msg || 'unauthorized' }, { status: 401 }); }
export function forbidden(msg) { return json({ error: msg || 'forbidden' }, { status: 403 }); }

// ---------- model gating ----------
// On Workers Paid, all chat models are free for every user. The Plus gate is
// feature-based (code specialist, image generation, vision) not capability-based.
export const FREE_CHAT_MODELS = new Set(['fast', 'small', 'tiny', 'auto']);
export function userCanUseChatModel(user, model) {
  if (!user) return false;
  if (user.plan === 'plus') return true;
  return FREE_CHAT_MODELS.has(model || 'fast');
}
export function userCanUseCode(user) { return !!user && user.plan === 'plus'; }
export function userCanUseImage(user) { return !!user && user.plan === 'plus'; }
export function userCanUseVision(user) { return !!user && user.plan === 'plus'; }

// chadgpt-image worker
// Image generation (Flux schnell) + vision (Llama 3.2 vision).
// Session-token auth, origin check, per-session rate limit.

const IMAGE_MODELS = {
  'flux':       '@cf/black-forest-labs/flux-1-schnell',
  'sdxl-light': '@cf/bytedance/stable-diffusion-xl-lightning',
  'sdxl':       '@cf/stabilityai/stable-diffusion-xl-base-1.0',
};
const VISION_MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';
const DEFAULT_IMAGE = 'flux';

const RATE_LIMIT_WINDOW_SEC = 60;
const RATE_LIMIT_PER_WINDOW = 10;  // image gen is heavier, tighter limit
const MAX_PROMPT_LEN = 4000;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    try {
      if (url.pathname === '/' || url.pathname === '/health') {
        return json({
          service: 'chadgpt-image',
          image_models: Object.keys(IMAGE_MODELS),
          default_image_model: DEFAULT_IMAGE,
          vision_model: VISION_MODEL,
          endpoints: ['POST /image', 'POST /describe'],
          edge: request.cf?.colo || 'unknown',
        }, 200, cors);
      }
      const originCheck = verifyOrigin(request, env);
      if (!originCheck.ok) return json({ error: 'origin not allowed' }, 403, cors);

      if (url.pathname === '/image' && request.method === 'POST') return handleImage(request, env, cors);
      if (url.pathname === '/describe' && request.method === 'POST') return handleDescribe(request, env, cors);
      return json({ error: 'Not found' }, 404, cors);
    } catch (err) {
      return json({ error: 'internal', detail: err?.message || String(err) }, 500, cors);
    }
  },
};

async function handleImage(request, env, cors) {
  const session = await verifySession(request, env);
  if (!session.ok) return json({ error: 'unauthorized', detail: session.err }, 401, cors);
  const rl = await rateCheck(env, session.sessionId, 'rl-img');
  if (!rl.ok) return json({ error: 'rate limited', retry_after: rl.resetIn }, 429, Object.assign({}, cors, { 'Retry-After': String(rl.resetIn) }));

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400, cors); }
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim().slice(0, MAX_PROMPT_LEN) : '';
  if (!prompt) return json({ error: 'prompt required' }, 400, cors);

  const modelKey = (body.model && IMAGE_MODELS[body.model]) ? body.model : DEFAULT_IMAGE;
  const model = IMAGE_MODELS[modelKey];
  const steps = Math.min(Math.max(body.steps || 4, 1), 8);

  try {
    const result = await env.AI.run(model, { prompt, steps });
    if (result && typeof result.image === 'string') {
      const bin = Uint8Array.from(atob(result.image), c => c.charCodeAt(0));
      return new Response(bin, {
        headers: Object.assign({
          'Content-Type': 'image/png',
          'Cache-Control': 'public, max-age=3600',
          'X-Session-Id': session.sessionId,
          'X-Model': model,
        }, cors),
      });
    }
    return new Response(result, { headers: Object.assign({ 'Content-Type': 'image/png', 'X-Model': model }, cors) });
  } catch (err) {
    return json({ error: 'image generation failed', detail: err?.message || String(err) }, 500, cors);
  }
}

async function handleDescribe(request, env, cors) {
  const session = await verifySession(request, env);
  if (!session.ok) return json({ error: 'unauthorized', detail: session.err }, 401, cors);
  const rl = await rateCheck(env, session.sessionId, 'rl-vision');
  if (!rl.ok) return json({ error: 'rate limited', retry_after: rl.resetIn }, 429, Object.assign({}, cors, { 'Retry-After': String(rl.resetIn) }));

  const contentType = request.headers.get('content-type') || '';
  let imageBytes = null;
  let prompt = 'Describe this image in detail.';
  try {
    if (contentType.startsWith('multipart/form-data')) {
      const form = await request.formData();
      const file = form.get('image');
      if (!(file instanceof File)) return json({ error: 'image file required' }, 400, cors);
      if (file.size > MAX_IMAGE_BYTES) return json({ error: 'image too large (max 6MB)' }, 413, cors);
      imageBytes = new Uint8Array(await file.arrayBuffer());
      const p = form.get('prompt');
      if (typeof p === 'string' && p.trim()) prompt = p.trim().slice(0, MAX_PROMPT_LEN);
    } else if (contentType.includes('application/json')) {
      const body = await request.json();
      if (typeof body.image_b64 !== 'string') return json({ error: 'image_b64 required' }, 400, cors);
      if (body.image_b64.length > MAX_IMAGE_BYTES * 1.4) return json({ error: 'image too large' }, 413, cors);
      imageBytes = Uint8Array.from(atob(body.image_b64), c => c.charCodeAt(0));
      if (typeof body.prompt === 'string' && body.prompt.trim()) prompt = body.prompt.trim().slice(0, MAX_PROMPT_LEN);
    } else {
      return json({ error: 'multipart with "image" file OR JSON with image_b64' }, 400, cors);
    }

    const result = await env.AI.run(VISION_MODEL, {
      image: Array.from(imageBytes),
      prompt,
      max_tokens: 512,
    });
    return json({ response: result.description || result.response || JSON.stringify(result), model: VISION_MODEL }, 200, cors);
  } catch (err) {
    return json({ error: 'vision failed', detail: err?.message || String(err) }, 500, cors);
  }
}

// ---------- shared security ----------
async function verifySession(request, env) {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return { ok: false, err: 'missing auth' };
  const token = auth.slice(7).trim();
  const parts = token.split('.');
  if (parts.length !== 5 || parts[0] !== 'v1') return { ok: false, err: 'bad token format' };
  const [, sessionId, expiresAtStr, bindingPrefix, sig] = parts;
  const payload = `${sessionId}.${expiresAtStr}.${bindingPrefix}`;
  const expected = await hmacSign(env.SESSION_SECRET || 'dev-secret-replace-me', payload);
  if (!timingSafeEq(expected, sig)) return { ok: false, err: 'bad signature' };
  const expiresAt = Number(expiresAtStr);
  if (!Number.isFinite(expiresAt) || expiresAt * 1000 < Date.now()) return { ok: false, err: 'expired' };
  if (env.ENFORCE_IP_BINDING !== 'false') {
    const ip = request.headers.get('CF-Connecting-IP') || '';
    const ua = (request.headers.get('User-Agent') || '').slice(0, 200);
    const nowBinding = (await sha256Hex(ip + '|' + ua)).slice(0, 16);
    if (nowBinding !== bindingPrefix) return { ok: false, err: 'binding mismatch' };
  }
  if (env.SESSIONS && env.ENFORCE_KV_REVOCATION === 'true') {
    try { if (!(await env.SESSIONS.get('sess:' + sessionId))) return { ok: false, err: 'revoked' }; } catch (_) {}
  }
  return { ok: true, sessionId };
}

async function rateCheck(env, sessionId, prefix) {
  if (!env.SESSIONS) return { ok: true };
  const bucket = Math.floor(Date.now() / 1000 / RATE_LIMIT_WINDOW_SEC);
  const key = `${prefix}:${sessionId}:${bucket}`;
  try {
    const current = Number(await env.SESSIONS.get(key)) || 0;
    if (current >= RATE_LIMIT_PER_WINDOW) return { ok: false, resetIn: RATE_LIMIT_WINDOW_SEC - (Math.floor(Date.now() / 1000) % RATE_LIMIT_WINDOW_SEC) };
    await env.SESSIONS.put(key, String(current + 1), { expirationTtl: RATE_LIMIT_WINDOW_SEC * 2 });
  } catch (_) {}
  return { ok: true };
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = parseAllowed(env.ALLOWED_ORIGINS || '*');
  const match = (allowed.includes('*') || allowed.includes(origin)) ? (allowed.includes('*') ? '*' : origin) : 'null';
  return {
    'Access-Control-Allow-Origin': match,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}
function verifyOrigin(request, env) {
  const allowed = parseAllowed(env.ALLOWED_ORIGINS || '*');
  if (allowed.includes('*')) return { ok: true };
  const origin = request.headers.get('Origin') || '';
  return { ok: !!origin && allowed.includes(origin) };
}
function parseAllowed(s) { return String(s).split(',').map(x => x.trim()).filter(Boolean); }
function json(body, status, cors) {
  return new Response(JSON.stringify(body), { status, headers: Object.assign({ 'Content-Type': 'application/json' }, cors || {}) });
}
async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}
async function hmacSign(secret, data) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  let s = '';
  for (const b of new Uint8Array(sig)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function timingSafeEq(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

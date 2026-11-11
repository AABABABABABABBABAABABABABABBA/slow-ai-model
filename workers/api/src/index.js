// ChadGPT API dispatcher — single URL that fronts every backend worker.
//
// Clients only ever call this host. The paths map as:
//   /chat/*     → chat worker   (chadgpt-chat)
//   /code/*     → code worker   (chadgpt-code)
//   /image/*    → image worker  (chadgpt-image)
//   /license/*  → license worker (chadcode-license)
//
// Why: so attackers scanning our frontend code see only ONE host instead of
// four separate .workers.dev URLs. Each backend can then be moved to
// private-origin / "disable the preview subdomain" mode so direct hits are
// rejected — the only way in is through here with a signed dispatcher token.
//
// Deployment: this ships as its own Worker. Attach a custom subdomain
// (api.<yourdomain>) via the Cloudflare dashboard → Workers → Triggers →
// Custom Domains. Until then it's reachable at chadgpt-api.<acct>.workers.dev.

const BACKENDS = {
  '/chat':    { env: 'CHAT_URL',    label: 'chat' },
  '/code':    { env: 'CODE_URL',    label: 'code' },
  '/image':   { env: 'IMAGE_URL',   label: 'image' },
  '/license': { env: 'LICENSE_URL', label: 'license' },
};

const CORS_ALLOWED_HEADERS = 'Content-Type, Authorization, X-Requested-With';
const CORS_METHODS = 'GET, POST, PUT, DELETE, OPTIONS';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Health check — no backend hop, no auth.
    if (url.pathname === '/' || url.pathname === '/health') {
      return json({
        service: 'chadgpt-api',
        routes: Object.keys(BACKENDS),
        version: 1,
      }, 200, corsFor(request, env));
    }

    // CORS preflight.
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsFor(request, env, true) });
    }

    // Match the longest route prefix. /chat/stream → /chat; /license/verify → /license.
    const match = pickRoute(url.pathname);
    if (!match) {
      return json({ error: 'not found', paths: Object.keys(BACKENDS) }, 404, corsFor(request, env));
    }

    const targetBase = env[match.env];
    if (!targetBase) {
      return json({ error: 'backend not configured', binding: match.env }, 503, corsFor(request, env));
    }

    // Build the upstream URL. Strip the /chat prefix so the backend sees the
    // same paths it always has (e.g. '/' for the main handler, '/verify' for
    // license.verify, etc.).
    const subPath = url.pathname.slice(match.prefix.length) || '/';
    const upstreamUrl = targetBase.replace(/\/+$/, '') + subPath + url.search;

    // Clone the request body + headers, drop any Host/Origin that would
    // confuse the backend, inject a dispatcher-signed header so the backend
    // can later reject direct hits if we lock it down.
    const upstreamHeaders = new Headers(request.headers);
    upstreamHeaders.delete('host');
    if (env.DISPATCHER_TOKEN) {
      upstreamHeaders.set('X-Dispatcher-Token', env.DISPATCHER_TOKEN);
    }
    // Pass through the user's real origin as X-Forwarded-Origin so the
    // backend's own CORS check can still see it.
    const originalOrigin = request.headers.get('Origin') || '';
    if (originalOrigin) upstreamHeaders.set('X-Forwarded-Origin', originalOrigin);

    const upstreamRequest = new Request(upstreamUrl, {
      method: request.method,
      headers: upstreamHeaders,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      redirect: 'manual',
    });

    let upstream;
    try {
      upstream = await fetch(upstreamRequest);
    } catch (err) {
      return json({ error: 'backend unreachable', backend: match.label, detail: err?.message || String(err) }, 502, corsFor(request, env));
    }

    // Stream the response back verbatim. Rewrite CORS so the browser sees
    // the dispatcher's origin policy, not the backend's.
    const outHeaders = new Headers(upstream.headers);
    applyCors(outHeaders, request, env);
    // Hide which backend answered. A curious attacker shouldn't learn
    // "oh, /chat actually goes to chadgpt-chat.corbyiscool.workers.dev".
    outHeaders.delete('x-session-id');
    outHeaders.set('X-Served-By', 'chadgpt-api');
    return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
  },
};

function pickRoute(pathname) {
  // Match longest prefix that ends at a /, so /chatroom doesn't match /chat.
  for (const prefix of Object.keys(BACKENDS)) {
    if (pathname === prefix || pathname.startsWith(prefix + '/')) {
      return { prefix, ...BACKENDS[prefix] };
    }
  }
  return null;
}

function parseAllowed(raw) {
  if (!raw) return [];
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

function corsFor(request, env, preflight = false) {
  const origin = request.headers.get('Origin') || '';
  const allowed = parseAllowed(env.ALLOWED_ORIGINS || '*');
  const allowOrigin = (allowed.includes('*') || allowed.includes(origin)) ? (origin || '*') : 'null';
  const h = {
    'Access-Control-Allow-Origin': allowOrigin,
    'Vary': 'Origin',
    'Access-Control-Allow-Credentials': 'true',
  };
  if (preflight) {
    h['Access-Control-Allow-Methods'] = CORS_METHODS;
    h['Access-Control-Allow-Headers'] = CORS_ALLOWED_HEADERS;
    h['Access-Control-Max-Age'] = '86400';
  }
  return h;
}

function applyCors(headers, request, env) {
  const h = corsFor(request, env);
  for (const [k, v] of Object.entries(h)) headers.set(k, v);
}

function json(body, status, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

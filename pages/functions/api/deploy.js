// POST /api/deploy — Plus-only. Takes a JS/TS code snippet and deploys it
// as a dedicated Cloudflare Worker under the user's account, giving them a
// .workers.dev URL that runs 24/7 for free.
//
// Body: { code, name?, runtime?: 'js' | 'ts' }
//
// How the hosting works:
//   - Worker name = `chadgpt-user-<user_id>-<slug>` so scripts are scoped per user
//   - Deployed via Cloudflare REST API using CF_API_TOKEN + CF_ACCOUNT_ID
//     secrets on the Pages project (both need to be set via wrangler pages
//     secret put)
//   - Returns the live URL + the deploy's internal id
//   - Each user is capped at MAX_WORKERS deployments to keep bills predictable
//
// What this does NOT give you:
//   - Python or other runtimes (Workers is JS/TS/Wasm only)
//   - Long-running processes that can't fit the Workers compute budget
//   - WebSocket-persistent Discord gateway bots (use webhook mode instead)
//   For those, a real container host (fly.io, Railway, Cloudflare Containers)
//   is required — see the README section at the bottom of deploy.js.

import { getAuthedUser, json, unauthorized, forbidden, badRequest } from '../_lib/auth.js';

const MAX_WORKERS_PER_USER = 10;
const MAX_CODE_BYTES = 200_000;    // 200 KB per script
const NAME_RE = /^[a-z][a-z0-9-]{0,40}$/;

export async function onRequestPost({ request, env }) {
  const user = await getAuthedUser(request, env);
  if (!user) return unauthorized();
  if (user.plan !== 'plus' && user.plan !== 'unlimited') {
    return forbidden('24/7 hosted deploys are a Plus feature');
  }
  if (!env.DB) return json({ error: 'DB not bound' }, { status: 500 });
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) {
    return json({
      error: 'deploy not configured',
      detail: 'Server is missing CF_API_TOKEN or CF_ACCOUNT_ID. The founder must set both via `wrangler pages secret put` for deploys to work.',
    }, { status: 503 });
  }

  let body;
  try { body = await request.json(); } catch { return badRequest('invalid JSON'); }
  const code = typeof body.code === 'string' ? body.code : '';
  if (!code.trim()) return badRequest('code required');
  if (code.length > MAX_CODE_BYTES) return badRequest(`code too large (max ${MAX_CODE_BYTES} bytes)`);

  // Normalize name: user-chosen slug or derived from code's first comment.
  const rawName = (body.name || deriveName(code)).trim().toLowerCase();
  const slug = rawName.replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 30);
  if (!NAME_RE.test(slug)) return badRequest('name must start with a letter and contain only lowercase letters, numbers, dashes');

  const scriptName = `chadgpt-user-${user.id}-${slug}`;

  // Quota check — count current deploys for this user from our own DB.
  const count = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM deployments WHERE user_id = ?'
  ).bind(user.id).first().catch(() => ({ n: 0 }));
  if (count && Number(count.n) >= MAX_WORKERS_PER_USER) {
    return json({
      error: 'deployment limit reached',
      limit: MAX_WORKERS_PER_USER,
      hint: 'Delete an old deployment before creating a new one.',
    }, { status: 429 });
  }

  // Wrap bare module code so it at least has a fetch handler if the user's
  // code doesn't export one. If they already export default, leave theirs.
  const wrapped = ensureFetchHandler(code);

  // Build the multipart payload the Cloudflare Workers upload API expects.
  const metadata = JSON.stringify({
    main_module: 'index.mjs',
    compatibility_date: '2025-01-01',
    compatibility_flags: ['nodejs_compat'],
  });
  const form = new FormData();
  form.append('metadata', new Blob([metadata], { type: 'application/json' }));
  form.append('index.mjs', new Blob([wrapped], { type: 'application/javascript+module' }), 'index.mjs');

  const uploadUrl = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/workers/scripts/${encodeURIComponent(scriptName)}`;
  const upRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${env.CF_API_TOKEN}` },
    body: form,
  });
  const upJson = await upRes.json().catch(() => ({}));
  if (!upRes.ok || !upJson.success) {
    return json({
      error: 'cloudflare upload failed',
      status: upRes.status,
      detail: upJson.errors || upJson.error || 'unknown',
    }, { status: 502 });
  }

  // Enable the workers.dev subdomain for this specific script so it's
  // publicly reachable without a custom route.
  const subdomainUrl = `${uploadUrl}/subdomain`;
  await fetch(subdomainUrl, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.CF_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true }),
  }).catch(() => {});

  // Fetch the account's workers.dev subdomain so we can build the URL.
  let subdomain = env.CF_WORKERS_SUBDOMAIN;
  if (!subdomain) {
    try {
      const sr = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/workers/subdomain`, {
        headers: { 'Authorization': `Bearer ${env.CF_API_TOKEN}` },
      });
      const sj = await sr.json();
      subdomain = sj?.result?.subdomain || '';
    } catch { subdomain = ''; }
  }
  const liveUrl = subdomain ? `https://${scriptName}.${subdomain}.workers.dev` : null;

  // Record it so the user can list / delete later.
  const now = Date.now();
  await env.DB.prepare(`
    INSERT INTO deployments (user_id, script_name, slug, url, size_bytes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(script_name) DO UPDATE SET url = excluded.url, size_bytes = excluded.size_bytes, updated_at = excluded.updated_at
  `).bind(user.id, scriptName, slug, liveUrl, code.length, now, now).run().catch(() => {});

  return json({ ok: true, name: scriptName, slug, url: liveUrl, runtime: 'workers-js' });
}

// Picks a slug from the first comment line like `// name: discord-bot`,
// else from the first real identifier it finds.
function deriveName(code) {
  const nameTag = code.match(/\/\/\s*name:\s*([a-z0-9-]+)/i);
  if (nameTag) return nameTag[1];
  const first = code.match(/(?:function|const|class|async\s+function)\s+([a-zA-Z_$][\w$]*)/);
  if (first) return first[1].toLowerCase();
  return 'app-' + Math.random().toString(36).slice(2, 7);
}

// If the user's code doesn't already export a default fetch handler, wrap
// whatever they wrote in one. Ensures the Worker will respond to HTTP at all.
function ensureFetchHandler(code) {
  if (/export\s+default\s+\{/.test(code) || /export\s+default\s+async?\s*function/.test(code) || /addEventListener\s*\(\s*['"]fetch['"]/.test(code)) {
    return code;
  }
  return `${code}\n\nexport default {
  async fetch(request, env, ctx) {
    try {
      if (typeof handleRequest === 'function') return handleRequest(request, env, ctx);
      if (typeof main === 'function') return main(request, env, ctx);
      return new Response('ChadGPT-deployed Worker is live. Add an exported default { fetch() } handler to return HTTP responses.', { status: 200 });
    } catch (err) {
      return new Response('Worker error: ' + (err?.message || String(err)), { status: 500 });
    }
  }
};`;
}

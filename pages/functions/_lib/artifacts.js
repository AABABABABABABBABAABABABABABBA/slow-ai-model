// AI-generated artifacts — self-contained HTML pages the model produces on
// demand. Storage goes to R2 (ARTIFACTS bucket). Each artifact lives at
//   r2://chadgpt-artifacts/<id>/index.html
//   r2://chadgpt-artifacts/<id>/meta.json
// Served publicly via /a/<id> → pages/functions/a/[id].js
//
// Metadata captured per artifact:
//   id         short random slug, user-visible in URL
//   user_id    owner (so /api/artifact/list can scope)
//   title      display name (also served as <title> if the HTML has none)
//   prompt     the user's original request (truncated)
//   model      which model produced it
//   created_at unix ms
//   version    monotonic int — edits bump this; history is append-only
//   built_url  if deployed as a standalone Pages project, that URL
//
// The Cloudflare Artifacts product (artifacts.cloudflare.dev) is a preview
// API the user has access to via a ChadGPT repo. This module tries that
// upstream when env.CLOUDFLARE_ARTIFACTS_TOKEN is set, and falls back to
// the R2 path regardless. We ALWAYS keep a copy in R2 so a publish never
// depends on a flaky preview endpoint.

const ARTIFACTS_HOST = 'https://artifacts.cloudflare.dev';
const ARTIFACTS_REPO = 'ChadGPT';                      // the user's preview repo

function randomId() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  const alpha = '23456789abcdefghjkmnpqrstvwxyz';
  let s = '';
  for (const b of bytes) s += alpha[b % alpha.length];
  return s;
}

/**
 * Create a new artifact. Writes HTML + metadata to R2 and (best-effort)
 * mirrors to the Cloudflare Artifacts preview if configured.
 *
 * @returns {Promise<{id, url, title, version, upstream?: {ok, status, body}}>}
 */
export async function createArtifact(env, { user_id, title, html, prompt, model }) {
  if (!env.ARTIFACTS) throw new Error('ARTIFACTS bucket not bound');

  const id = randomId();
  const createdAt = Date.now();
  const sanitizedHtml = ensureHtmlShell(html, title || 'ChadGPT Artifact');
  const meta = {
    id,
    user_id,
    title: title || 'Untitled artifact',
    prompt: (prompt || '').slice(0, 2000),
    model: model || 'unknown',
    created_at: createdAt,
    version: 1,
    built_url: null,
  };

  await env.ARTIFACTS.put(`${id}/index.html`, sanitizedHtml, {
    httpMetadata: { contentType: 'text/html; charset=utf-8' },
  });
  await env.ARTIFACTS.put(`${id}/meta.json`, JSON.stringify(meta), {
    httpMetadata: { contentType: 'application/json' },
  });
  await env.ARTIFACTS.put(`${id}/v1.html`, sanitizedHtml, {
    httpMetadata: { contentType: 'text/html; charset=utf-8' },
  });

  // Best-effort mirror to Cloudflare Artifacts preview. Never fails the
  // create — the R2 copy is the source of truth.
  let upstream;
  if (env.CLOUDFLARE_ARTIFACTS_TOKEN) {
    upstream = await mirrorToCloudflareArtifacts(env, id, sanitizedHtml, meta).catch((e) => ({
      ok: false, status: 0, body: String(e?.message || e),
    }));
  }

  const origin = env.PAGES_ORIGIN || '';
  return {
    id,
    url: `${origin}/a/${id}`,
    title: meta.title,
    version: meta.version,
    upstream,
  };
}

/**
 * Overwrite an artifact's HTML, keeping a versioned snapshot of the old copy.
 */
export async function updateArtifact(env, { id, user_id, html, title, prompt, model }) {
  if (!env.ARTIFACTS) throw new Error('ARTIFACTS bucket not bound');
  const metaObj = await env.ARTIFACTS.get(`${id}/meta.json`);
  if (!metaObj) throw new Error(`artifact ${id} not found`);
  const meta = JSON.parse(await metaObj.text());
  if (meta.user_id !== user_id) throw new Error('not your artifact');

  const nextVersion = (meta.version || 1) + 1;
  const sanitized = ensureHtmlShell(html, title || meta.title);

  await env.ARTIFACTS.put(`${id}/index.html`, sanitized, { httpMetadata: { contentType: 'text/html; charset=utf-8' } });
  await env.ARTIFACTS.put(`${id}/v${nextVersion}.html`, sanitized, { httpMetadata: { contentType: 'text/html; charset=utf-8' } });

  const nextMeta = { ...meta, title: title || meta.title, prompt: prompt || meta.prompt, model: model || meta.model, version: nextVersion, updated_at: Date.now() };
  await env.ARTIFACTS.put(`${id}/meta.json`, JSON.stringify(nextMeta), { httpMetadata: { contentType: 'application/json' } });

  const origin = env.PAGES_ORIGIN || '';
  return { id, url: `${origin}/a/${id}`, title: nextMeta.title, version: nextVersion };
}

/** Fetch an artifact's HTML + metadata by id. */
export async function getArtifact(env, id, { withVersion } = {}) {
  if (!env.ARTIFACTS) throw new Error('ARTIFACTS bucket not bound');
  const key = withVersion ? `${id}/v${withVersion}.html` : `${id}/index.html`;
  const htmlObj = await env.ARTIFACTS.get(key);
  if (!htmlObj) return null;
  const metaObj = await env.ARTIFACTS.get(`${id}/meta.json`);
  const meta = metaObj ? JSON.parse(await metaObj.text()) : null;
  return { html: await htmlObj.text(), meta };
}

/** List artifacts for a user. R2 list, filtered by meta.user_id. */
export async function listArtifactsForUser(env, user_id, { limit = 50 } = {}) {
  if (!env.ARTIFACTS) return [];
  const out = [];
  let cursor;
  // We can't filter by owner in a single list call, so we page through
  // meta.json objects and skim. Fine for the sizes we expect per-user.
  do {
    const page = await env.ARTIFACTS.list({ prefix: '', cursor, limit: 1000 });
    for (const obj of page.objects) {
      if (!obj.key.endsWith('/meta.json')) continue;
      const m = await env.ARTIFACTS.get(obj.key);
      if (!m) continue;
      let meta;
      try { meta = JSON.parse(await m.text()); } catch { continue; }
      if (meta.user_id !== user_id) continue;
      out.push(meta);
      if (out.length >= limit) return sortByCreated(out);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return sortByCreated(out);
}

function sortByCreated(xs) { return xs.sort((a, b) => (b.created_at || 0) - (a.created_at || 0)); }

/**
 * Ensure the model's HTML has a doctype, charset, viewport, and <title>.
 * If the model returned a full doc already, pass through. If it returned
 * fragments only, wrap them.
 */
export function ensureHtmlShell(html, title) {
  const s = (html || '').trim();
  if (/^<!doctype html/i.test(s)) {
    if (!/<title>/i.test(s)) {
      return s.replace(/<head[^>]*>/i, (m) => `${m}\n<title>${escapeHtml(title)}</title>`);
    }
    return s;
  }
  if (/^<html/i.test(s)) return `<!doctype html>\n${s}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
</head>
<body>
${s}
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * Deploy an artifact as a standalone Cloudflare Pages project. Returns
 * the live URL. Requires env.CLOUDFLARE_API_TOKEN + env.CLOUDFLARE_ACCOUNT_ID.
 *
 * Project naming: `art-<id>-<slug>` so the URL is self-contained and
 * discoverable. The project is created fresh every time; a rebuild bumps
 * the project's deployment, not the project.
 */
export async function deployAsPagesProject(env, { id, html, title }) {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken  = env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) {
    return { ok: false, error: 'build backend not configured — need CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN secrets' };
  }
  const slug = (title || 'site').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'site';
  const projectName = `art-${id}-${slug}`.slice(0, 58);

  // Step 1 — create the project (idempotent-ish: re-create fails with 409, we
  // treat that as success and just push a new deployment on top).
  const createRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiToken}` },
    body: JSON.stringify({
      name: projectName,
      production_branch: 'main',
    }),
  });
  if (!createRes.ok) {
    const txt = await createRes.text();
    // 409 = already exists — fine, continue to upload.
    if (createRes.status !== 409) {
      return { ok: false, error: `pages project create failed: ${createRes.status}`, detail: txt.slice(0, 400) };
    }
  }

  // Step 2 — upload the single index.html as a direct-upload deployment.
  // The Pages Direct Upload API wants a multipart manifest + file hashes.
  // We POST a single deployment via the /deployments endpoint with form data.
  const form = new FormData();
  const htmlBlob = new Blob([html], { type: 'text/html' });
  form.append('index.html', htmlBlob, 'index.html');
  // A minimal _headers to send long cache on everything but html.
  const headersFile = new Blob(['/*\n  Cache-Control: public, max-age=3600\n'], { type: 'text/plain' });
  form.append('_headers', headersFile, '_headers');

  const deployRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/${projectName}/deployments`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiToken}` },
    body: form,
  });
  if (!deployRes.ok) {
    const txt = await deployRes.text();
    return { ok: false, error: `deploy failed: ${deployRes.status}`, detail: txt.slice(0, 400) };
  }
  const deploy = await deployRes.json().catch(() => ({}));
  const url = deploy?.result?.url || `https://${projectName}.pages.dev`;
  return { ok: true, url, project: projectName };
}

/**
 * Best-effort mirror of an artifact to the Cloudflare Artifacts preview
 * product the user is on. The exact API shape is still in preview — this
 * follows the pattern their curl example implied (POST a file to
 * /v1/api/repos/<repo>/files or similar). If the shape is wrong the error
 * gets returned to the caller for diagnostics but the R2 copy still works.
 */
async function mirrorToCloudflareArtifacts(env, id, html, meta) {
  const token = env.CLOUDFLARE_ARTIFACTS_TOKEN;
  if (!token) return { ok: false, status: 0, body: 'no token' };
  const res = await fetch(`${ARTIFACTS_HOST}/v1/api/repos/${encodeURIComponent(ARTIFACTS_REPO)}/files`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({
      path: `${id}/index.html`,
      content: html,
      meta,
    }),
  });
  const body = await res.text().catch(() => '');
  return { ok: res.ok, status: res.status, body: body.slice(0, 400) };
}

// POST /api/artifact/build
//
// Take an existing artifact id (or inline HTML) and deploy it as a real,
// standalone Cloudflare Pages project. Returns the live *.pages.dev URL.
//
// This is the "build it" follow-up to /api/artifact/create: the artifact
// stays available at /a/<id> as a preview, and the built URL is a
// separate Pages project the user can share, point a domain at, etc.
//
// Body: { id: string, title?: string }   // deploy that artifact
//    OR { html: string, title: string }  // one-shot deploy raw HTML
// Returns: { ok, url, project }

import { getAuthedUser, json, unauthorized, badRequest } from '../../_lib/auth.js';
import { getArtifact, deployAsPagesProject } from '../../_lib/artifacts.js';

export async function onRequestPost({ request, env }) {
  const user = await getAuthedUser(request, env);
  if (!user) return unauthorized();
  // Plus-only — building burns a real Pages project per site, and this
  // keeps free-tier abuse from spamming our account with throwaway projects.
  if (user.plan !== 'plus' && user.plan !== 'unlimited') {
    return json({
      error: 'build_requires_plus',
      detail: 'Deploying an artifact as a live site is a Plus feature. Previews at /a/<id> are free.',
    }, { status: 402 });
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid JSON' }, { status: 400 }); }

  let html, title, id;
  if (typeof body.id === 'string' && body.id) {
    id = body.id;
    const art = await getArtifact(env, id);
    if (!art) return json({ error: 'artifact not found' }, { status: 404 });
    if (art.meta && art.meta.user_id !== user.id) return json({ error: 'not your artifact' }, { status: 403 });
    html = art.html;
    title = body.title || art.meta?.title || 'ChadGPT Site';
  } else if (typeof body.html === 'string') {
    html = body.html;
    title = (typeof body.title === 'string' ? body.title.slice(0, 120) : '') || 'ChadGPT Site';
    id = 'inline-' + Math.random().toString(36).slice(2, 8);
  } else {
    return badRequest('provide { id } or { html, title }');
  }

  if (!html || html.length < 20) return badRequest('html is empty');
  if (html.length > 2_000_000) return badRequest('html too large (max 2 MB)');

  const r = await deployAsPagesProject(env, { id, html, title });
  if (!r.ok) {
    return json({ error: r.error || 'deploy failed', detail: r.detail }, { status: 502 });
  }
  return json({ ok: true, url: r.url, project: r.project });
}

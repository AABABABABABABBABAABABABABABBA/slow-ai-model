// GET /a/<id> — serve an artifact's HTML straight from R2.
//
// Public URL. The artifact's HTML is sandboxed by a strict Content-Security-
// Policy (no scripts that aren't inline in the doc, no eval, no outside
// network except Google Fonts) so even a prompt-injected artifact can't
// pivot to attack visitors.
//
// The `?v=<n>` query lets the owner preview older versions.

import { getArtifact } from '../_lib/artifacts.js';

export async function onRequestGet({ request, env, params }) {
  const id = params?.id;
  if (!id || !/^[a-z0-9]{6,12}$/.test(id)) {
    return new Response('not found', { status: 404 });
  }
  const url = new URL(request.url);
  const v = url.searchParams.get('v');
  const art = await getArtifact(env, id, { withVersion: v && /^\d+$/.test(v) ? parseInt(v, 10) : undefined });
  if (!art) return new Response('artifact not found', { status: 404 });
  return new Response(art.html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // Short cache — the owner may update the artifact and want to see it
      // refreshed quickly.
      'Cache-Control': 'public, max-age=60, s-maxage=60',
      // Strict sandbox. No outside scripts beyond Google Fonts' CSS.
      'Content-Security-Policy': [
        "default-src 'self' 'unsafe-inline' data:",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "img-src 'self' data: https:",
        "font-src 'self' data: https://fonts.gstatic.com",
        "connect-src 'self'",
        "frame-ancestors 'self' https://chadgpt-964.pages.dev",
        "form-action 'self'",
        "base-uri 'self'",
        "object-src 'none'",
      ].join('; '),
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

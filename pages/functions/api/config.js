// GET /api/config — public client-facing config. Safe to cache briefly.
// Only exposes values the browser will see anyway (site keys, never secrets).

import { json } from '../_lib/auth.js';

export async function onRequestGet({ env }) {
  return json({
    // hCaptcha always-pass test site key by default. Replace with the site
    // key from hcaptcha.com/publisher to actually earn revenue.
    hcaptcha_sitekey: env.HCAPTCHA_SITEKEY || '10000000-ffff-ffff-ffff-000000000001',
  }, { headers: { 'Cache-Control': 'public, max-age=60' } });
}

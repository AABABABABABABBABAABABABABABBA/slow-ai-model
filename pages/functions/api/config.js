// GET /api/config — public client-facing config. Safe to cache briefly.
// Only exposes values the browser will see anyway (site keys, never secrets).

import { json } from '../_lib/auth.js';
import { activeAdProviders } from '../_lib/ad-providers.js';

export async function onRequestGet({ env }) {
  return json({
    hcaptcha_sitekey: env.HCAPTCHA_SITEKEY || '10000000-ffff-ffff-ffff-000000000001',
    ad_providers: activeAdProviders(env),
  }, { headers: { 'Cache-Control': 'public, max-age=60' } });
}

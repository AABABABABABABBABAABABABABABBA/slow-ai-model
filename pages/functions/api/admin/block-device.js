// POST /api/admin/block-device — founder-only. Blocks a fingerprint hash
// across every account that's used it. Everyone sharing that hash hits a
// forbidden on their next chat/image/code call.
//
// Body: { fp_hash: string }

import { getAuthedUser, isFounder, json, unauthorized, forbidden, badRequest } from '../../_lib/auth.js';
import { blockFingerprint, usersSharingFingerprint } from '../../_lib/fingerprint.js';

export async function onRequestPost({ request, env }) {
  const user = await getAuthedUser(request, env);
  if (!user) return unauthorized();
  if (!isFounder(env, user)) return forbidden('founder only');
  if (!env.DB) return json({ error: 'DB not bound' }, { status: 500 });

  let body;
  try { body = await request.json(); } catch { return badRequest('invalid JSON'); }
  const fp = (body.fp_hash || '').trim();
  if (!/^[0-9a-f]{64}$/.test(fp)) return badRequest('fp_hash must be a 64-char hex string');

  const affected = await usersSharingFingerprint(env, fp);
  await blockFingerprint(env, fp);
  return json({ ok: true, fp_hash: fp, affected_users: affected });
}

// POST /api/queue/ticket  (auth required)
//
// Free-plan users call this before sending a chat message. The endpoint
// returns their current position in a server-side "free queue" counter
// (atomic-ish, backed by SESSIONS KV) and holds the connection open for
// the wait duration before responding with { ok: true }.
//
// Plus / unlimited users skip the queue entirely (the client doesn't call
// this endpoint for them). The queue is intentional product differentiation:
// free tier always feels slightly slower than Plus, even at zero contention.

import { getAuthedUser, json, unauthorized } from '../../_lib/auth.js';
import { planSkipsQuota } from '../../_lib/tiers.js';

const KEY = 'q:free:inflight';
const COUNT_TTL_SEC = 30;        // stale slots evaporate after 30s
const BASE_WAIT_MS = 1500;       // every free user waits at least this long
const PER_POSITION_MS = 800;     // each person ahead of you adds this
const MAX_WAIT_MS = 15_000;      // hard ceiling so a bug can't hang forever

export async function onRequestPost({ request, env }) {
  const user = await getAuthedUser(request, env);
  if (!user) return unauthorized();

  // Plus / unlimited never wait.
  if (user.plan === 'plus' || planSkipsQuota(user.plan)) {
    return json({ ok: true, queued: false, position: 0, wait_ms: 0 });
  }

  if (!env.SESSIONS) {
    // No KV binding — degrade to the base wait so the UX still feels right.
    await sleep(BASE_WAIT_MS);
    return json({ ok: true, queued: true, position: 1, wait_ms: BASE_WAIT_MS, depth: 1 });
  }

  // Read-increment-write — not perfectly atomic, but close enough. Racey
  // callers end up a slot or two off, which is fine for a product queue.
  let depth = 0;
  try { depth = Number((await env.SESSIONS.get(KEY)) || 0); } catch {}
  const position = Math.min(depth + 1, 50);
  try { await env.SESSIONS.put(KEY, String(depth + 1), { expirationTtl: COUNT_TTL_SEC }); } catch {}

  const waitMs = Math.min(BASE_WAIT_MS + (position - 1) * PER_POSITION_MS, MAX_WAIT_MS);
  await sleep(waitMs);

  // Release our slot so the next person ahead advances. If the count is
  // already stale (TTL fired) treat it as empty.
  try {
    const now = Number((await env.SESSIONS.get(KEY)) || 0);
    const next = Math.max(0, now - 1);
    if (next === 0) await env.SESSIONS.delete(KEY);
    else await env.SESSIONS.put(KEY, String(next), { expirationTtl: COUNT_TTL_SEC });
  } catch {}

  return json({ ok: true, queued: true, position, wait_ms: waitMs, depth: depth + 1 });
}

function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}

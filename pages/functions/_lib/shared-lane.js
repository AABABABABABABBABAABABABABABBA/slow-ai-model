// Shared-lane gate — one in-flight request at a time across ALL free users.
// Paid users (plus / unlimited) skip this entirely; each of them runs on
// their own per-user concurrency slot.
//
// Storage: single KV key `lane:shared` in SESSIONS. Value is JSON:
//   { holder: <user_id>, until: <unix_ms>, since: <unix_ms> }
// We set a KV TTL that matches `until` + 15s of slack so a crashed Worker
// can never permanently lock the lane — if nothing touches the key, it
// evaporates on its own.
//
// Atomicity note: Cloudflare KV does not give us compare-and-swap. We fake
// it with write-then-read: claim writes our record, waits 150ms for eventual
// consistency to catch up, then re-reads. If the value still matches ours,
// we won. If not, somebody else won the race and we back off. In the worst
// case two free users slip through on the same slot — not a correctness
// problem, just a brief loss of "only one at a time."
//
// The lease TTL (default 90s) caps how long the lane can be held by a
// single request. If a Worker dies mid-stream, the next free user will be
// able to claim within TTL seconds regardless.

const KEY = 'lane:shared';

export const SHARED_LANE_DEFAULT_TTL_MS = 90_000;   // 90s per request
export const SHARED_LANE_WAIT_SLICE_MS   = 500;     // poll cadence while waiting
export const SHARED_LANE_MAX_WAIT_MS     = 20_000;  // max a free user blocks

/**
 * Who's on the lane right now?
 * @returns {Promise<{busy: boolean, holder?: string, until?: number, since?: number}>}
 */
export async function getSharedLaneStatus(env) {
  if (!env.SESSIONS) return { busy: false };
  let rec;
  try {
    const raw = await env.SESSIONS.get(KEY);
    if (!raw) return { busy: false };
    rec = JSON.parse(raw);
  } catch { return { busy: false }; }
  if (!rec || !rec.until || rec.until < Date.now()) return { busy: false };
  return { busy: true, holder: rec.holder, until: rec.until, since: rec.since };
}

/**
 * Try to grab the lane for this user. Returns {ok:true} on success,
 * {ok:false, holder, until} if someone else holds it.
 * Does NOT wait — callers that want to block should loop with sleep().
 */
export async function tryClaimSharedLane(env, userId, ttlMs = SHARED_LANE_DEFAULT_TTL_MS) {
  if (!env.SESSIONS) return { ok: true, degraded: true }; // no KV → no gate (fail open)

  const now = Date.now();
  const existing = await getSharedLaneStatus(env);
  if (existing.busy && existing.holder !== userId) {
    return { ok: false, holder: existing.holder, until: existing.until };
  }

  const record = { holder: userId, until: now + ttlMs, since: now };
  // TTL 15s past `until` so ghost locks evaporate server-side even if
  // release() never runs. Minimum 60s because KV requires it.
  const ttlSec = Math.max(60, Math.ceil((ttlMs + 15_000) / 1000));
  try {
    await env.SESSIONS.put(KEY, JSON.stringify(record), { expirationTtl: ttlSec });
  } catch {
    // KV write failure → fail open rather than lock everyone out.
    return { ok: true, degraded: true };
  }

  // Wait for propagation, then re-read. Someone else racing us would have
  // written their own record after ours, and we'd see their holder here.
  await sleep(150);
  const confirmed = await getSharedLaneStatus(env);
  if (confirmed.busy && confirmed.holder === userId) return { ok: true };
  return { ok: false, holder: confirmed.holder, until: confirmed.until };
}

/**
 * Wait up to `maxWaitMs` for the lane to be free, then claim it.
 * Returns the same shape as tryClaimSharedLane plus {waited_ms}.
 */
export async function waitAndClaimSharedLane(env, userId, {
  ttlMs = SHARED_LANE_DEFAULT_TTL_MS,
  maxWaitMs = SHARED_LANE_MAX_WAIT_MS,
  signal,
} = {}) {
  const started = Date.now();
  let attempt = 0;
  while (Date.now() - started < maxWaitMs) {
    if (signal?.aborted) return { ok: false, aborted: true, waited_ms: Date.now() - started };
    const r = await tryClaimSharedLane(env, userId, ttlMs);
    if (r.ok) return { ok: true, waited_ms: Date.now() - started, degraded: r.degraded };
    attempt++;
    // Back off a little — extra slack for the holder's record to expire
    // if they're near end-of-lease. First few attempts poll fast; later
    // ones slow down to save Worker CPU.
    const delay = Math.min(SHARED_LANE_WAIT_SLICE_MS * (attempt < 4 ? 1 : 2), 1500);
    await sleep(delay);
  }
  // Time's up — tell the caller.
  const final = await getSharedLaneStatus(env);
  return {
    ok: false,
    timed_out: true,
    waited_ms: Date.now() - started,
    holder: final.holder,
    until: final.until,
  };
}

/**
 * Release the lane — but ONLY if we still hold it. Prevents a late release
 * from a stale request from stealing someone else's active lease.
 */
export async function releaseSharedLane(env, userId) {
  if (!env.SESSIONS) return;
  try {
    const raw = await env.SESSIONS.get(KEY);
    if (!raw) return;
    const rec = JSON.parse(raw);
    if (rec && rec.holder === userId) {
      await env.SESSIONS.delete(KEY);
    }
  } catch { /* nothing to do */ }
}

/**
 * True if this user's plan belongs on the shared free-tier lane.
 * Paid plans (plus, unlimited) get their own per-user concurrency slot.
 */
export function usesSharedLane(plan) {
  return plan !== 'plus' && plan !== 'unlimited';
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

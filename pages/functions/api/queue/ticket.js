// POST /api/queue/ticket  (auth required)
//
// The free tier runs through ONE shared lane — only one free-user request
// is served at a time across the whole app. This endpoint blocks until
// that lane is yours, then returns { ok: true } so the client can open
// /api/chat. Paid plans (plus / unlimited) skip the lane entirely and
// return immediately.
//
// Behavior for a free user:
//   - If the lane is free → claim it immediately, return ok: true.
//   - If the lane is busy → poll until it frees (max 20s). Once we claim,
//     return ok: true plus waited_ms so the client can show "waited X".
//   - If the 20s budget blows → return 429 with queued=false and a hint
//     how long the current holder is still expected to run. The client
//     shows "Someone's generating, retry in X seconds" and the user can
//     retry whenever they want.
//
// The lease the ticket takes is released by /api/chat when its stream
// ends, OR by KV TTL if the serving Worker dies mid-stream.

import { getAuthedUser, json, unauthorized } from '../../_lib/auth.js';
import {
  waitAndClaimSharedLane,
  getSharedLaneStatus,
  usesSharedLane,
  SHARED_LANE_MAX_WAIT_MS,
} from '../../_lib/shared-lane.js';

export async function onRequestPost({ request, env }) {
  const user = await getAuthedUser(request, env);
  if (!user) return unauthorized();

  // Paid plans never wait on the shared lane — each gets their own
  // per-user concurrency slot inside /api/chat.
  if (!usesSharedLane(user.plan)) {
    return json({ ok: true, queued: false, position: 0, wait_ms: 0, lane: 'dedicated' });
  }

  const result = await waitAndClaimSharedLane(env, user.id, { maxWaitMs: SHARED_LANE_MAX_WAIT_MS });
  if (result.ok) {
    return json({
      ok: true,
      queued: result.waited_ms > 500,
      lane: 'shared',
      wait_ms: result.waited_ms,
      degraded: !!result.degraded,
    });
  }

  // Lane still busy after the max wait. Tell the client how long the
  // current holder is still expected to run so the UI can pick a sane
  // retry delay.
  const status = await getSharedLaneStatus(env);
  const remain = Math.max(0, (status.until || Date.now()) - Date.now());
  return json({
    ok: false,
    queued: true,
    lane: 'shared',
    wait_ms: result.waited_ms,
    retry_after_ms: Math.min(remain, 30_000),
    message: 'Free tier is shared — someone else is generating right now. Upgrade to Plus to skip the line.',
  }, {
    status: 429,
    headers: { 'Retry-After': String(Math.max(1, Math.ceil(remain / 1000))) },
  });
}

// GET /api/queue/ticket — peek at the lane without claiming.
export async function onRequestGet({ request, env }) {
  const user = await getAuthedUser(request, env);
  if (!user) return unauthorized();
  const status = await getSharedLaneStatus(env);
  return json({
    busy: status.busy,
    lane: usesSharedLane(user.plan) ? 'shared' : 'dedicated',
    remaining_ms: status.busy ? Math.max(0, (status.until || 0) - Date.now()) : 0,
  });
}

// POST /api/rate — thumbs-up / thumbs-down a specific assistant message.
// Body: { message_hash, rating: 1 | -1 | 0, model?, chat_id?, note? }
//
// We identify messages by a client-computed SHA-256 of the message text so
// we don't have to send full chat history across — ratings are idempotent
// by (user_id, message_hash).

import { getAuthedUser, json, unauthorized, badRequest } from '../_lib/auth.js';

export async function onRequestPost({ request, env }) {
  const user = await getAuthedUser(request, env);
  if (!user) return unauthorized();
  if (!env.DB) return json({ error: 'DB not bound' }, { status: 500 });

  let body;
  try { body = await request.json(); } catch { return badRequest('invalid JSON'); }
  const hash = String(body.message_hash || '').trim();
  const rating = Number(body.rating);
  if (!/^[0-9a-f]{16,128}$/i.test(hash)) return badRequest('message_hash must be hex');
  if (![1, -1, 0].includes(rating)) return badRequest('rating must be 1, -1, or 0');

  const now = Date.now();
  // Upsert on (user_id, message_hash).
  await env.DB.prepare(`
    INSERT INTO message_ratings (user_id, chat_id, message_hash, model_key, rating, note, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, message_hash) DO UPDATE SET
      rating = excluded.rating,
      note = excluded.note,
      model_key = COALESCE(excluded.model_key, message_ratings.model_key),
      created_at = excluded.created_at
  `).bind(
    user.id,
    body.chat_id || null,
    hash,
    body.model || null,
    rating,
    body.note ? String(body.note).slice(0, 500) : null,
    now,
  ).run();

  return json({ ok: true, rating });
}

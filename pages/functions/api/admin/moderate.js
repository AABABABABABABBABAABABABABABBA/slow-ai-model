// POST /api/admin/moderate — founder-only. Single endpoint that flips any
// moderation flag on a user. Body: { email, action, value?, note? }
//
// action: 'ban' | 'unban' | 'mute' | 'unmute' | 'block_model' | 'unblock_model'
//       | 'clear_blocks' | 'reset_usage' | 'delete_chats' | 'set_note'
//
// 'block_model' + 'unblock_model' take `value` = model key.
// 'set_note' takes `value` = free-text note.

import { getAuthedUser, isFounder, json, unauthorized, forbidden, badRequest } from '../../_lib/auth.js';

export async function onRequestPost({ request, env }) {
  const user = await getAuthedUser(request, env);
  if (!user) return unauthorized();
  if (!isFounder(env, user)) return forbidden('founder only');
  if (!env.DB) return json({ error: 'DB not bound' }, { status: 500 });

  let body;
  try { body = await request.json(); } catch { return badRequest('invalid JSON'); }
  const email = (body.email || '').trim().toLowerCase();
  const action = body.action;
  if (!email) return badRequest('email required');
  if (!action) return badRequest('action required');

  const target = await env.DB.prepare(
    'SELECT id, email, banned, muted, blocked_models, moderation_note FROM users WHERE email = ?'
  ).bind(email).first();
  if (!target) return json({ error: 'user not found' }, { status: 404 });

  // Guard: founder can't ban or mute themselves. Easy to lock yourself out.
  if (target.email.toLowerCase() === user.email.toLowerCase() && ['ban', 'mute'].includes(action)) {
    return badRequest("can't " + action + ' yourself');
  }

  let blocked;
  try { blocked = JSON.parse(target.blocked_models || '[]'); } catch { blocked = []; }

  const now = Date.now();
  let changed = {};

  switch (action) {
    case 'ban':
      await env.DB.prepare('UPDATE users SET banned = 1, moderation_note = ?, updated_at = ? WHERE id = ?')
        .bind(body.note || target.moderation_note || null, now, target.id).run();
      changed = { banned: true };
      break;
    case 'unban':
      await env.DB.prepare('UPDATE users SET banned = 0, updated_at = ? WHERE id = ?')
        .bind(now, target.id).run();
      changed = { banned: false };
      break;
    case 'mute':
      await env.DB.prepare('UPDATE users SET muted = 1, moderation_note = ?, updated_at = ? WHERE id = ?')
        .bind(body.note || target.moderation_note || null, now, target.id).run();
      changed = { muted: true };
      break;
    case 'unmute':
      await env.DB.prepare('UPDATE users SET muted = 0, updated_at = ? WHERE id = ?')
        .bind(now, target.id).run();
      changed = { muted: false };
      break;
    case 'block_model': {
      const mk = String(body.value || '').trim();
      if (!mk) return badRequest('value (model key) required');
      if (!blocked.includes(mk)) blocked.push(mk);
      await env.DB.prepare('UPDATE users SET blocked_models = ?, updated_at = ? WHERE id = ?')
        .bind(JSON.stringify(blocked), now, target.id).run();
      changed = { blocked_models: blocked };
      break;
    }
    case 'unblock_model': {
      const mk = String(body.value || '').trim();
      if (!mk) return badRequest('value (model key) required');
      blocked = blocked.filter(k => k !== mk);
      await env.DB.prepare('UPDATE users SET blocked_models = ?, updated_at = ? WHERE id = ?')
        .bind(JSON.stringify(blocked), now, target.id).run();
      changed = { blocked_models: blocked };
      break;
    }
    case 'clear_blocks':
      await env.DB.prepare("UPDATE users SET blocked_models = '[]', updated_at = ? WHERE id = ?")
        .bind(now, target.id).run();
      changed = { blocked_models: [] };
      break;
    case 'reset_usage': {
      const r = await env.DB.prepare('DELETE FROM usage_log WHERE user_id = ?').bind(target.id).run();
      changed = { usage_rows_deleted: r.meta?.changes || 0 };
      break;
    }
    case 'delete_chats': {
      // Chats live in chat_events. Also nuke their container session so
      // nothing stale persists after we blow the history away.
      const a = await env.DB.prepare('DELETE FROM chat_events WHERE user_id = ?').bind(target.id).run();
      const b = await env.DB.prepare('DELETE FROM containers WHERE user_id = ?').bind(target.id).run();
      changed = {
        chat_events_deleted: a.meta?.changes || 0,
        containers_deleted: b.meta?.changes || 0,
      };
      break;
    }
    case 'set_note':
      await env.DB.prepare('UPDATE users SET moderation_note = ?, updated_at = ? WHERE id = ?')
        .bind(String(body.value || ''), now, target.id).run();
      changed = { note: String(body.value || '') };
      break;
    default:
      return badRequest(`unknown action: ${action}`);
  }

  return json({ ok: true, email, action, changed });
}

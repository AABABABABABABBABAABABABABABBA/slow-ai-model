// POST /api/obfuscate — turn source code into a run-only, unreadable blob.
//
// Currently supports Lua. The obfuscator itself is in /functions/_lib/lua-obfuscator.js.
// Open to any authenticated user — this is a utility, not an AI call,
// so it doesn't burn Workers AI tokens and doesn't gate behind captcha.
//
// Body: { lang: 'lua', source: string, level?: 'light'|'heavy'|'extreme' }
// Returns: { ok, code, stats, notes[] }

import { getAuthedUser, json, unauthorized } from '../_lib/auth.js';
import { obfuscateLua } from '../_lib/lua-obfuscator.js';

export async function onRequestPost({ request, env }) {
  const user = await getAuthedUser(request, env);
  if (!user) return unauthorized('please sign in');

  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid JSON' }, { status: 400 }); }

  const lang = (body.lang || 'lua').toLowerCase();
  const source = typeof body.source === 'string' ? body.source : '';
  const level = typeof body.level === 'string' ? body.level : 'extreme';

  if (!source.trim()) return json({ error: 'source is empty' }, { status: 400 });
  if (source.length > 500000) return json({ error: 'source too large (max 500KB)' }, { status: 413 });

  let result;
  try {
    switch (lang) {
      case 'lua':
        result = obfuscateLua(source, { level });
        break;
      default:
        return json({ error: `language not supported: ${lang}` }, { status: 400 });
    }
  } catch (err) {
    return json({ error: 'obfuscation failed', detail: String(err?.message || err) }, { status: 500 });
  }

  // Honest notes for the client so they aren't sold a false sense of security.
  const notes = [];
  if (level === 'light') notes.push('light: strings encrypted at runtime; names and numbers unchanged');
  if (level === 'heavy') notes.push('heavy: locals renamed, strings encrypted, numbers obfuscated');
  if (level === 'extreme') {
    notes.push('extreme: full source is XOR+hex encoded; runs through load() at runtime');
    notes.push('this stops casual reading — a determined attacker can still hook load() and dump the decoded source');
  }

  return json({ ok: true, code: result.code, stats: result.stats, notes });
}

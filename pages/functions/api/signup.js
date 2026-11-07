import { hashPassword, mintUserJwt, setSessionCookieHeader, json, badRequest } from '../_lib/auth.js';

export async function onRequestPost({ request, env }) {
  try {
    if (!env.DB) return json({ error: 'database not configured' }, { status: 500 });

    let body;
    try { body = await request.json(); } catch { return badRequest('invalid JSON'); }

    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return badRequest('invalid email');
    if (password.length < 8) return badRequest('password must be at least 8 characters');
    if (password.length > 256) return badRequest('password too long');
    if (email.length > 254) return badRequest('email too long');

    const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
    if (existing) return json({ error: 'email already registered' }, { status: 409 });

    const hash = await hashPassword(password);
    const now = Date.now();
    const result = await env.DB.prepare(
      'INSERT INTO users (email, password_hash, plan, created_at, updated_at, usage_score, usage_last_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(email, hash, 'free', now, now, 100, now).run();

    const userId = result.meta.last_row_id;
    const token = await mintUserJwt(env, { user_id: userId, email, plan: 'free' });

    return json(
      { ok: true, user: { id: userId, email, plan: 'free' } },
      { headers: { 'Set-Cookie': setSessionCookieHeader(token) } }
    );
  } catch (err) {
    return json({ error: 'signup failed', detail: err?.message || String(err), stack: (err?.stack || '').slice(0, 500) }, { status: 500 });
  }
}

// API client for ChadGPT Pages Functions. Shares cookies via same-origin.
// When running the dev server on localhost:5173, requests go to the live
// production site — set VITE_API_BASE in .env.local to override.

const BASE = (import.meta.env.VITE_API_BASE as string) || '';

export interface User {
  id: number;
  email: string;
  plan: 'free' | 'plus' | 'unlimited';
  granted_by?: string | null;
  is_founder?: boolean;
}

export async function api<T = any>(path: string, opts: RequestInit = {}): Promise<{ ok: boolean; status: number; data: T }> {
  const res = await fetch(BASE + '/api' + path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  });
  let data: any = null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    try { data = await res.json(); } catch {}
  } else if (opts.method === 'GET' || !opts.method) {
    // Streaming responses aren't JSON; caller handles body.
    data = res;
  }
  return { ok: res.ok, status: res.status, data };
}

export async function me(): Promise<User | null> {
  const r = await api<{ ok: boolean; user: User }>('/me');
  return r.ok ? r.data.user : null;
}

export async function login(email: string, password: string): Promise<User> {
  const r = await api<{ ok: boolean; user: User; error?: string; detail?: string }>('/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  if (!r.ok) throw new Error(r.data?.detail || r.data?.error || `login failed (${r.status})`);
  return r.data.user;
}

export async function signup(email: string, password: string): Promise<User> {
  const r = await api<{ ok: boolean; user: User; error?: string }>('/signup', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  if (!r.ok) throw new Error(r.data?.error || `signup failed (${r.status})`);
  return r.data.user;
}

export async function logout(): Promise<void> {
  await api('/logout', { method: 'POST' });
}

// Streaming chat. Returns an async iterator of text chunks.
export async function* streamChat(messages: { role: string; content: string }[], model: string, opts: { chadMode?: boolean; temperature?: number; signal?: AbortSignal } = {}) {
  const res = await fetch(BASE + '/api/chat', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages, model, stream: true,
      chad_mode: opts.chadMode ?? true,
      temperature: opts.temperature ?? 0.6,
    }),
    signal: opts.signal,
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({ error: `${res.status}` }));
    throw Object.assign(new Error(j.error || 'chat failed'), { status: res.status, detail: j });
  }
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split('\n');
    buf = parts.pop() || '';
    for (const line of parts) {
      const l = line.trim();
      if (!l.startsWith('data:')) continue;
      const payload = l.slice(5).trim();
      if (payload === '[DONE]') return;
      try {
        const obj = JSON.parse(payload);
        if (typeof obj.response === 'string') yield obj.response as string;
      } catch { /* malformed chunk */ }
    }
  }
}

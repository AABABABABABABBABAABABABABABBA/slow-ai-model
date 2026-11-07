// Hacker News front page via the official Firebase API (no key).

const TRIGGERS = /\b(hacker\s*news|hn|y\s*combinator|show\s*hn|ask\s*hn|front\s*page\s*of\s*hn)\b/i;

export function detect(text) {
  if (!text || !TRIGGERS.test(text)) return null;
  return {};
}

async function j(url, timeoutMs = 3500) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'Accept': 'application/json' } });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
  finally { clearTimeout(t); }
}

export async function fetchContext() {
  const ids = await j('https://hacker-news.firebaseio.com/v0/topstories.json');
  if (!ids || !Array.isArray(ids)) return null;
  const top = ids.slice(0, 10);
  const items = await Promise.all(top.map(id => j(`https://hacker-news.firebaseio.com/v0/item/${id}.json`)));
  const lines = items.filter(Boolean).map((it, i) => `${i + 1}. ${it.title} (${it.score || 0} pts, ${it.descendants || 0} comments)${it.url ? ' — ' + it.url : ''}`);
  if (!lines.length) return null;
  return 'Hacker News top 10 right now:\n' + lines.join('\n');
}

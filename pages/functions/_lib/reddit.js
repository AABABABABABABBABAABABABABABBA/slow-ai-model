// Reddit top posts via the public JSON endpoint (no key, needs User-Agent).

const TRIGGERS = /\b(?:r\/([a-z0-9_]+)|reddit(?:'s)?\s+(?:top\s+(?:posts?)?|front\s*page)|(?:top\s+of\s+|whats\s+hot\s+on\s+)reddit)\b/i;

export function detect(text) {
  if (!text) return null;
  const m = text.match(TRIGGERS);
  if (!m) return null;
  const subreddit = m[1] || 'popular';
  return { subreddit };
}

export async function fetchContext(hint) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 5000);
  try {
    const r = await fetch(`https://www.reddit.com/r/${encodeURIComponent(hint.subreddit)}/top.json?limit=8&t=day`, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'ChadGPT/1.0 (+https://chadgpt.pages.dev)', 'Accept': 'application/json' },
    });
    if (!r.ok) return null;
    const d = await r.json();
    const items = d?.data?.children || [];
    if (!items.length) return null;
    const lines = items.map((c, i) => {
      const p = c.data;
      return `${i + 1}. ${p.title} (r/${p.subreddit}, ${p.score} up, ${p.num_comments} comments) — https://reddit.com${p.permalink}`;
    });
    return `Top ${items.length} posts in r/${hint.subreddit} today:\n` + lines.join('\n');
  } catch { return null; }
  finally { clearTimeout(t); }
}

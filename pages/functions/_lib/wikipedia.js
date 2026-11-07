// Wikipedia summary via the public REST API (no key).
// Catches most "who/what is X" / "tell me about X" questions as a backstop
// to other more specific enrichers.

const Q = /(?:\bwho\s+(?:is|was|were|are)\s+|\bwhat\s+(?:is|are|was|were)\s+|\btell\s+me\s+about\s+|\bdefine\s+)(?:the\s+|a\s+|an\s+)?([A-Z][A-Za-z0-9 '\-.,]{1,80})/;

export function detect(text) {
  if (!text) return null;
  const m = text.match(Q);
  if (!m) return null;
  const topic = m[1].trim().replace(/[.?!,:]+$/, '').replace(/\s+/g, ' ');
  if (topic.length < 2) return null;
  return { topic };
}

export async function fetchContext(hint) {
  const title = encodeURIComponent(hint.topic.replace(/ /g, '_'));
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 4000);
  try {
    const r = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${title}`, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'ChadGPT/1.0 (+https://chadgpt.pages.dev)', 'Accept': 'application/json' },
    });
    if (!r.ok) return null;
    const d = await r.json();
    if (d.type === 'disambiguation' || !d.extract) return null;
    return `Wikipedia · ${d.title}:\n${d.extract.slice(0, 1200)}${d.content_urls?.desktop?.page ? '\nSource: ' + d.content_urls.desktop.page : ''}`;
  } catch { return null; }
  finally { clearTimeout(t); }
}

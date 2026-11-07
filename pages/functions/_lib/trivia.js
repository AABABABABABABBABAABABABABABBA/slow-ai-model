// Random fact / trivia via uselessfacts.jsph.pl (no key).

const TRIGGERS = /\b(random fact|useless fact|fun fact|trivia|tell me a fact|random trivia)\b/i;

export function detect(text) {
  if (!text || !TRIGGERS.test(text)) return null;
  return {};
}

export async function fetchContext() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 4000);
  try {
    const r = await fetch('https://uselessfacts.jsph.pl/api/v2/facts/random?language=en', {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'ChadGPT/1.0 (+https://chadgpt.pages.dev)', 'Accept': 'application/json' },
    });
    if (!r.ok) return null;
    const d = await r.json();
    if (!d?.text) return null;
    return `Random fact (uselessfacts): ${d.text}${d.source ? ' — source: ' + d.source : ''}`;
  } catch { return null; }
  finally { clearTimeout(t); }
}

// Wikipedia summary via the public REST API (no key).
// Catches most "who/what is X" / "tell me about X" questions as a backstop
// to other more specific enrichers.
//
// What this used to miss (and now handles):
//   - lowercase topics ("tell me about norwood") — the original regex
//     required the topic to start with a capital, so casual-typed
//     questions never triggered Wikipedia
//   - disambiguation pages (no extract) — now falls back to an OpenSearch
//     query and tries the top real hit
//   - plain 404 (the literal topic isn't a Wikipedia page title) — same
//     OpenSearch fallback
//   - missing article extract — handled as a miss so callers can insert
//     an anti-hallucination guard
//
// The small free-tier Llama models will confidently invent a wrong place
// name ("Norwood is a town in British Columbia") if we hand them an empty
// context. Returning a real Wikipedia summary — even a short one — kills
// most of that.

// Trigger shapes. Case-insensitive, accepts lowercase topics, trailing
// punctuation stripped by the caller. Keep the set tight so we don't
// hit Wikipedia for every third turn.
const PATTERNS = [
  /\b(?:who|what)\s+(?:is|are|was|were)\s+(?:the\s+|a\s+|an\s+)?([A-Za-z][A-Za-z0-9 '\-.,&]{1,80})/i,
  /\btell\s+me\s+about\s+(?:the\s+|a\s+|an\s+)?([A-Za-z][A-Za-z0-9 '\-.,&]{1,80})/i,
  /\bdefine\s+(?:the\s+|a\s+|an\s+)?([A-Za-z][A-Za-z0-9 '\-.,&]{1,80})/i,
  /\bwhere\s+is\s+(?:the\s+|a\s+|an\s+)?([A-Za-z][A-Za-z0-9 '\-.,&]{1,80})/i,
  /\binfo(?:rmation)?\s+(?:on|about)\s+(?:the\s+|a\s+|an\s+)?([A-Za-z][A-Za-z0-9 '\-.,&]{1,80})/i,
];

// Topics that are clearly not Wikipedia-y — skip to save the fetch.
const BAD_TOPICS = /^(you|me|it|this|that|us|them|they|he|she|him|her|myself|yourself|anything|everything|something|nothing|anyone|everyone|someone|noone)\b/i;

export function detect(text) {
  if (!text) return null;
  for (const re of PATTERNS) {
    const m = text.match(re);
    if (!m) continue;
    const topic = m[1]
      .trim()
      .replace(/[.?!,:;]+$/, '')
      .replace(/\s+/g, ' ');
    if (topic.length < 2) continue;
    if (BAD_TOPICS.test(topic)) continue;
    return { topic };
  }
  return null;
}

async function fetchSummary(title, signal) {
  const enc = encodeURIComponent(title.replace(/ /g, '_'));
  const r = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${enc}`, {
    signal,
    headers: { 'User-Agent': 'ChadGPT/1.0 (+https://chadgpt-964.pages.dev)', 'Accept': 'application/json' },
  });
  if (!r.ok) return null;
  const d = await r.json().catch(() => null);
  if (!d || !d.extract) return null;
  // Disambiguation pages have a specific type — caller can fall back.
  if (d.type === 'disambiguation') return { disambiguation: true, title: d.title };
  return {
    title: d.title,
    extract: d.extract,
    url: d.content_urls?.desktop?.page || '',
  };
}

async function searchBestTitle(query, signal) {
  // OpenSearch returns the top matching article titles when the query
  // isn't an exact title match. Perfect for "norwood" → "Norwood, Massachusetts".
  const url = `https://en.wikipedia.org/w/api.php?action=opensearch&format=json&limit=5&search=${encodeURIComponent(query)}`;
  const r = await fetch(url, {
    signal,
    headers: { 'User-Agent': 'ChadGPT/1.0 (+https://chadgpt-964.pages.dev)' },
  });
  if (!r.ok) return null;
  const data = await r.json().catch(() => null);
  // Shape: [query, [title1, title2, ...], [desc1, ...], [url1, ...]]
  const titles = Array.isArray(data) && Array.isArray(data[1]) ? data[1] : [];
  for (const t of titles) {
    // Skip the "X (disambiguation)" entries — if that's the only hit the
    // query is genuinely ambiguous and we return the disambig page title
    // for the model to handle gracefully.
    if (!/\(disambiguation\)/i.test(t)) return t;
  }
  return titles[0] || null;
}

export async function fetchContext(hint) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 4500);
  try {
    // 1. Try the topic verbatim.
    let page = await fetchSummary(hint.topic, ctrl.signal);
    // 2. If no article OR disambig, run an OpenSearch and retry with
    //    the best matching real title.
    if (!page || page.disambiguation) {
      const alt = await searchBestTitle(hint.topic, ctrl.signal);
      if (alt && alt.toLowerCase() !== hint.topic.toLowerCase()) {
        const second = await fetchSummary(alt, ctrl.signal);
        if (second && !second.disambiguation) page = second;
      }
    }
    if (!page || page.disambiguation) return null;

    const extract = page.extract.slice(0, 1200);
    const src = page.url ? `\nSource: ${page.url}` : '';
    return `Wikipedia · ${page.title}:\n${extract}${src}`;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

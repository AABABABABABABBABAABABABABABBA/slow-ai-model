// Free dictionary API (no key) for word definitions.

const DEF_HINT = /\b(?:define|definition of|what does (?:the word )?["'`]?([a-z]+)["'`]? mean|meaning of)\b/i;
const WORD_CAPTURE = /(?:define|definition of|meaning of)\s+["'`]?([a-z][a-z-]{1,30})["'`]?/i;

export function detect(text) {
  if (!text) return null;
  if (!DEF_HINT.test(text)) return null;
  const m = text.match(WORD_CAPTURE) || text.match(/what does (?:the word )?["'`]?([a-z]+)["'`]? mean/i);
  if (!m) return null;
  return { word: m[1].toLowerCase() };
}

export async function fetchContext(hint) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 4000);
  try {
    const r = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(hint.word)}`, { signal: ctrl.signal });
    if (!r.ok) return null;
    const d = await r.json();
    const entry = Array.isArray(d) ? d[0] : null;
    if (!entry) return null;
    const lines = [`Dictionary · ${entry.word}${entry.phonetic ? ' /' + entry.phonetic + '/' : ''}`];
    for (const m of (entry.meanings || []).slice(0, 3)) {
      lines.push(`  ${m.partOfSpeech}: ${(m.definitions?.[0]?.definition || '').slice(0, 220)}`);
      if (m.definitions?.[0]?.example) lines.push(`    e.g. "${m.definitions[0].example}"`);
    }
    return lines.join('\n');
  } catch { return null; }
  finally { clearTimeout(t); }
}

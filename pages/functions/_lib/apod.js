// NASA Astronomy Picture of the Day via api.nasa.gov (DEMO_KEY allows ~30/day).

const TRIGGERS = /\b(apod|astronomy\s+picture|picture\s+of\s+the\s+day|nasa\s+picture|space\s+picture|nasa\s+today|hubble\s+picture)\b/i;

export function detect(text) {
  if (!text || !TRIGGERS.test(text)) return null;
  return {};
}

export async function fetchContext() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 5000);
  try {
    const r = await fetch('https://api.nasa.gov/planetary/apod?api_key=DEMO_KEY', {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'ChadGPT/1.0 (+https://chadgpt.pages.dev)', 'Accept': 'application/json' },
    });
    if (!r.ok) return null;
    const d = await r.json();
    if (!d?.title) return null;
    const img = d.url ? `\n![${d.title}](${d.url})` : '';
    return `NASA Astronomy Picture of the Day · ${d.date} · ${d.title}:\n${(d.explanation || '').slice(0, 800)}${img}\nInclude the image markdown verbatim.`;
  } catch { return null; }
  finally { clearTimeout(t); }
}

// Free currency exchange rates via open.er-api.com (no key).

const CONV = /\bconvert\s+(\d+(?:[.,]\d+)?)\s*([a-z]{3})\s+(?:to|in|into)\s+([a-z]{3})\b/i;
const RATE = /\b([a-z]{3})\s+(?:to|in|vs|against)\s+([a-z]{3})\s*(?:rate|exchange|conversion)?\b/i;

export function detect(text) {
  if (!text) return null;
  const c = text.match(CONV);
  if (c) return { amount: parseFloat(c[1].replace(',', '.')), from: c[2].toUpperCase(), to: c[3].toUpperCase() };
  const r = text.match(RATE);
  if (r) return { amount: 1, from: r[1].toUpperCase(), to: r[2].toUpperCase() };
  return null;
}

export async function fetchContext(hint) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 4000);
  try {
    const r = await fetch(`https://open.er-api.com/v6/latest/${hint.from}`, { signal: ctrl.signal });
    if (!r.ok) return null;
    const d = await r.json();
    const rate = d?.rates?.[hint.to];
    if (!rate) return null;
    const out = hint.amount * rate;
    const fmt = v => v.toLocaleString('en-US', { maximumFractionDigits: v < 1 ? 6 : 2 });
    return `Currency (open.er-api.com, as of ${d.time_last_update_utc || 'recent'}): 1 ${hint.from} = ${fmt(rate)} ${hint.to}. ${fmt(hint.amount)} ${hint.from} = ${fmt(out)} ${hint.to}.`;
  } catch { return null; }
  finally { clearTimeout(t); }
}

// Live Fortnite data via fortnite-api.com (community run, no key required).

const TRIGGERS = /\b(fortnite|v[- ]?bucks|battle\s+royale|item\s+shop|zero[- ]?build|battle\s+pass|fncs|back\s*bling|pickaxe|glider|loading\s*screen|victory\s*royale|epic\s*games)\b/i;
// Also treat any "<Name> skin/outfit/emote" as a Fortnite question since those
// are overwhelmingly a Fortnite usage of those words.
// Non-greedy name capture with REQUIRED trailing type word, so "the Peely skin"
// captures just "Peely" and not "Peely skin".
const SKIN_WORD = /\b([A-Z][a-zA-Z0-9][a-zA-Z0-9 .\-']{0,38}?)\s+(?:skin|outfit|emote|wrap|back\s*bling|pickaxe|glider)\b/;
const SKIN_HINT = /\b(?:about|tell me about|who is|what is|show me|look up)\s+(?:the\s+)?["'`]?([A-Z][a-zA-Z0-9][a-zA-Z0-9 .\-']{0,38}?)["'`]?\s+(?:skin|outfit|cosmetic|back\s*bling|pickaxe|glider|emote|wrap|loading\s*screen)\b/;
const SHOP_HINT = /\b(shop|item\s*shop|for\s*sale|buy|cost|price|featured)\b/i;
const NEWS_HINT = /\b(news|update|patch|chapter\s*\d|season\s*\d|new)\b/i;

const UA = 'ChadGPT/1.0 (+https://chadgpt.pages.dev)';

export function detect(text) {
  if (!text) return null;
  const skinMatch = text.match(SKIN_HINT) || text.match(SKIN_WORD);
  const triggered = TRIGGERS.test(text) || !!skinMatch;
  if (!triggered) return null;
  const searchName = skinMatch && skinMatch[1] ? skinMatch[1].trim() : null;
  return {
    searchName,
    wantShop: SHOP_HINT.test(text),
    wantNews: NEWS_HINT.test(text),
  };
}

async function fetchJson(url, timeoutMs = 6000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA } });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
  finally { clearTimeout(t); }
}

function fmtSearch(name, d) {
  const items = (d?.data || []).slice(0, 5);
  if (!items.length) return '';
  return `Fortnite cosmetics matching "${name}":\n` + items.map(it => {
    const type = it.type?.displayValue || 'item';
    const rarity = it.rarity?.displayValue || '';
    const intro = it.introduction?.text ? ` · intro ${it.introduction.text}` : '';
    const price = it.shopHistory?.length ? ` · last seen in shop ${it.shopHistory[it.shopHistory.length - 1].slice(0, 10)}` : '';
    const desc = it.description ? ` — ${it.description.slice(0, 180)}` : '';
    return `- ${it.name} (${type}, ${rarity}${intro}${price})${desc}`;
  }).join('\n');
}

function fmtShop(d) {
  const entries = d?.data?.entries || [];
  if (!entries.length) return '';
  const date = d?.data?.date?.slice(0, 10) || new Date().toISOString().slice(0, 10);
  const lines = entries.slice(0, 20).map(e => {
    const names = (e.brItems || e.items || []).map(i => i.name).filter(Boolean).join(' + ') || e.bundle?.name || 'bundle';
    const price = e.finalPrice ?? e.regularPrice ?? '?';
    return `- ${names} — ${price} V-Bucks`;
  });
  return `Current Fortnite item shop (${date}):\n` + lines.join('\n');
}

function fmtNews(d) {
  const items = d?.data?.motds || d?.data?.messages || [];
  if (!items.length) return '';
  return 'Latest Fortnite BR news:\n' + items.slice(0, 5).map(n => {
    const title = n.title || n.header || '(untitled)';
    const body = (n.body || n.subgame || '').replace(/\s+/g, ' ').slice(0, 220);
    return `- ${title}${body ? ': ' + body : ''}`;
  }).join('\n');
}

export async function fetchContext(hint) {
  const tasks = [];
  if (hint.searchName) {
    // Narrow to outfit by default — keeps response small (~18KB vs 35KB) and
    // returns the primary skin instead of unrelated back blings / emotes.
    const url = `https://fortnite-api.com/v2/cosmetics/br/search/all?name=${encodeURIComponent(hint.searchName)}&matchMethod=contains&type=outfit`;
    tasks.push(fetchJson(url, 9000).then(d => fmtSearch(hint.searchName, d)));
  }
  // Include shop unless the question is purely about a specific skin
  if (hint.wantShop || !hint.searchName) {
    tasks.push(fetchJson('https://fortnite-api.com/v2/shop').then(fmtShop));
  }
  if (hint.wantNews) {
    tasks.push(fetchJson('https://fortnite-api.com/v2/news/br').then(fmtNews));
  }
  const parts = (await Promise.all(tasks)).filter(Boolean);
  return parts.join('\n\n');
}

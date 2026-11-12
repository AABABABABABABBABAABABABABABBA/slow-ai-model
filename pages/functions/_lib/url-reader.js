// URL reader enricher — when the user pastes a URL into a chat, we fetch
// the page, strip it down to text, and inject it as context before the
// model answers. No API key needed. Caps per-page content so one giant
// article can't blow out the prompt window.

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const MAX_URLS_PER_TURN = 2;
const MAX_CHARS_PER_PAGE = 8000;
const FETCH_TIMEOUT_MS = 4000;

// Hosts we won't fetch: localhost, private ranges, our own workers,
// anything that could leak internal network or recurse into ourselves.
const DENYLIST = /(^|\.)(localhost|workers\.dev|pages\.dev|internal|svc\.cluster\.local)$/i;
const PRIVATE_IP = /^(10\.|172\.(1[6-9]|2\d|3[0-1])\.|192\.168\.|127\.|169\.254\.)/;

export function detect(text) {
  if (!text) return null;
  const matches = text.match(URL_RE);
  if (!matches) return null;
  const clean = [];
  for (const raw of matches) {
    try {
      const u = new URL(raw.replace(/[.,;:!?)\]}>]+$/, ''));
      if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
      if (DENYLIST.test(u.hostname) || PRIVATE_IP.test(u.hostname)) continue;
      if (clean.length >= MAX_URLS_PER_TURN) break;
      clean.push(u.toString());
    } catch {}
  }
  return clean.length ? clean : null;
}

export async function fetchContext(urls) {
  const results = await Promise.all(urls.map(fetchOne));
  const good = results.filter(Boolean);
  if (!good.length) return '';
  return good.map(r => `### ${r.url}\n${r.title ? '**' + r.title + '**\n\n' : ''}${r.text}`).join('\n\n');
}

async function fetchOne(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      signal: ctl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ChadGPT-Fetcher/1.0; +https://chadgpt-964.pages.dev)',
        'Accept': 'text/html,application/xhtml+xml,text/plain,application/json;q=0.8',
      },
      redirect: 'follow',
    });
    if (!r.ok) return null;
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    if (ct.includes('application/json')) {
      const txt = (await r.text()).slice(0, MAX_CHARS_PER_PAGE);
      return { url, title: '', text: '```json\n' + txt + '\n```' };
    }
    if (!ct.includes('text/html') && !ct.includes('text/plain') && !ct.includes('xml')) return null;
    const html = await r.text();
    const title = (html.match(/<title[^>]*>([^<]{1,200})<\/title>/i) || [])[1]?.trim() || '';
    const text = stripHtml(html).slice(0, MAX_CHARS_PER_PAGE);
    if (!text.trim()) return null;
    return { url, title, text };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Fast HTML-to-text: drop scripts/styles/nav/footer, decode a few entities,
// collapse whitespace. Not perfect but keeps the enricher under 4KB and
// avoids a cheerio-size dep.
function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<(nav|footer|header|aside|form|svg)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

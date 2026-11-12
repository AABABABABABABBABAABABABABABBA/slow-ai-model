// Web tools: fetch a URL and strip to text, lightweight web search.
//
// web_fetch has `risk: medium` — pulling a URL leaks the user's IP and
// could be used for SSRF against the local network (metadata endpoints,
// internal services). We keep a tight denylist for the common bad targets.

import type { ToolDef, ToolResult, ToolContext } from './types.js';

const MAX_FETCH_BYTES = 2_000_000;
const DEFAULT_TIMEOUT_MS = 15_000;

// Hosts we never let the model fetch — cloud metadata endpoints, localhost,
// private IPv4 ranges. If the user really wants one of these, they can run
// the fetch themselves.
const DENY_HOSTS = [
  'localhost', '127.0.0.1', '0.0.0.0', '::1',
  '169.254.169.254',        // AWS / GCP / Azure instance metadata
  'metadata.google.internal',
];
function isPrivateHost(host: string): boolean {
  if (DENY_HOSTS.includes(host)) return true;
  // 10.x.x.x, 172.16-31.x.x, 192.168.x.x
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  return false;
}

// ---------- web_fetch ----------
export const webFetch: ToolDef<{ url: string; method?: string; headers?: Record<string, string>; body?: string; as?: 'text' | 'json' | 'markdown' }> = {
  name: 'web_fetch',
  description: 'Fetch a URL and return its body. `as=markdown` strips HTML to text. Private-network addresses (10.x, 192.168.x, 127.x, cloud metadata) are blocked.',
  risk: 'medium',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string' },
      method: { type: 'string', description: 'GET, POST, HEAD, … default GET' },
      headers: { type: 'object', description: 'Request headers.' },
      body: { type: 'string', description: 'Request body (POST/PUT).' },
      as: { type: 'string', enum: ['text', 'json', 'markdown'], description: 'How to decode the body. Default text.' },
    },
    required: ['url'],
  },
  async execute(input, ctx) {
    let u: URL;
    try { u = new URL(input.url); } catch { return { ok: false, error: `invalid URL: ${input.url}` }; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return { ok: false, error: `only http(s) allowed, not ${u.protocol}` };
    }
    if (isPrivateHost(u.hostname)) {
      return { ok: false, error: `private / metadata host blocked: ${u.hostname}` };
    }
    const method = (input.method || 'GET').toUpperCase();
    const okd = await ctx.confirm({
      tool: 'web_fetch',
      action: `${method} ${u.toString()}`,
      risk: method === 'GET' || method === 'HEAD' ? 'low' : 'medium',
    });
    if (!okd) return { ok: false, error: 'user denied' };

    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), DEFAULT_TIMEOUT_MS);
    if (ctx.signal) ctx.signal.addEventListener('abort', () => abort.abort());
    try {
      const res = await fetch(u.toString(), {
        method,
        headers: { 'User-Agent': 'ChadCode/0.1 (+https://chadgpt-964.pages.dev)', ...(input.headers || {}) },
        body: input.body,
        signal: abort.signal,
        redirect: 'follow',
      });
      // Enforce size cap.
      const reader = res.body?.getReader();
      if (!reader) {
        const text = await res.text();
        return formatFetchResult(res, text, input.as);
      }
      let buf = new Uint8Array(0);
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (buf.length + value.length > MAX_FETCH_BYTES) {
          const extra = new Uint8Array(MAX_FETCH_BYTES - buf.length);
          extra.set(value.slice(0, extra.length));
          const merged = new Uint8Array(buf.length + extra.length);
          merged.set(buf); merged.set(extra, buf.length);
          buf = merged;
          break;
        }
        const merged = new Uint8Array(buf.length + value.length);
        merged.set(buf); merged.set(value, buf.length);
        buf = merged;
      }
      const text = new TextDecoder().decode(buf);
      return formatFetchResult(res, text, input.as);
    } catch (e: any) {
      return { ok: false, error: e?.name === 'AbortError' ? `timeout after ${DEFAULT_TIMEOUT_MS}ms` : (e?.message || String(e)) };
    } finally {
      clearTimeout(timer);
    }
  },
};

function formatFetchResult(res: Response, text: string, as: string | undefined): ToolResult {
  const header = `HTTP ${res.status} ${res.statusText}  ${res.headers.get('content-type') || ''}`;
  if (as === 'markdown') {
    return { ok: res.ok, content: `${header}\n\n${htmlToMarkdown(text)}` };
  }
  if (as === 'json') {
    try {
      const j = JSON.parse(text);
      return { ok: res.ok, content: `${header}\n\n${JSON.stringify(j, null, 2)}` };
    } catch {
      return { ok: false, error: 'body is not valid JSON', content: `${header}\n\n${text.slice(0, 2000)}` };
    }
  }
  return { ok: res.ok, content: `${header}\n\n${text}` };
}

// Very rough HTML → text. Not a full parser, just enough to let the model
// read a page without drowning in tags. For serious scraping, the user
// should use a real tool; this is "give me the gist".
function htmlToMarkdown(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, l, t) => `\n${'#'.repeat(+l)} ${stripTags(t)}\n`)
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_, t) => `\n${stripTags(t)}\n`)
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, t) => `- ${stripTags(t)}\n`)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, h, t) => `[${stripTags(t)}](${h})`)
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
function stripTags(s: string): string { return s.replace(/<[^>]+>/g, '').trim(); }

// ---------- web_search ----------
export const webSearch: ToolDef<{ search_term: string; num?: number }> = {
  name: 'web_search',
  description: 'Search the web via DuckDuckGo. Returns top result titles, URLs, and snippets. No API key required.',
  risk: 'low',
  parameters: {
    type: 'object',
    properties: {
      search_term: { type: 'string' },
      num: { type: 'integer', description: 'Max results to return. Default 8, cap 20.' },
    },
    required: ['search_term'],
  },
  async execute(input, ctx) {
    const n = Math.min(input.num || 8, 20);
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(input.search_term)}`;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), DEFAULT_TIMEOUT_MS);
    if (ctx.signal) ctx.signal.addEventListener('abort', () => abort.abort());
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ChadCode/0.1)' },
        signal: abort.signal,
      });
      if (!res.ok) return { ok: false, error: `search failed: HTTP ${res.status}` };
      const html = await res.text();
      const hits = parseDuckResults(html).slice(0, n);
      if (!hits.length) return { ok: true, content: '(no results)' };
      const out = hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet}`).join('\n\n');
      return { ok: true, content: out };
    } catch (e: any) {
      return { ok: false, error: e?.name === 'AbortError' ? 'search timed out' : (e?.message || String(e)) };
    } finally {
      clearTimeout(timer);
    }
  },
};

function parseDuckResults(html: string): { title: string; url: string; snippet: string }[] {
  const out: { title: string; url: string; snippet: string }[] = [];
  const blockRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?result__snippet[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(html)) !== null) {
    let url = m[1];
    // DDG wraps URLs; strip the redirect.
    const redir = url.match(/[?&]uddg=([^&]+)/);
    if (redir) try { url = decodeURIComponent(redir[1]); } catch {}
    out.push({ title: stripTags(m[2]), url, snippet: stripTags(m[3]) });
  }
  return out;
}

export const webTools = { webFetch, webSearch };

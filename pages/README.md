# ChadGPT frontend (Cloudflare Pages)

Plain static site. No Vite, no bundler, no build step. Just HTML, CSS, JS, served straight from Cloudflare Pages.

## Files

| File | What it is |
|---|---|
| `index.html` | page structure |
| `styles.css` | all styles, theme tokens, mobile breakpoints |
| `app.js` | all behavior — chat, streaming, model switcher, image gen, container, settings |
| `config.js` | worker URLs + Turnstile sitekey (edit this after deploy) |
| `_headers` | Pages headers file — CSP, HSTS, XFO, Permissions-Policy, etc. |

## 1. Deploy the three workers first

See [../workers/README.md](../workers/README.md). You need the three `*.workers.dev` URLs before this site is useful.

## 2. Set up Turnstile (recommended)

Go to [dash.cloudflare.com → Turnstile](https://dash.cloudflare.com) → **Add site**. Pick *Managed* mode. Cloudflare gives you a **site key** (public, goes in `config.js`) and a **secret key** (goes into the chat worker, see workers README).

## 3. Edit `config.js`

Paste in the three worker URLs and your Turnstile sitekey:
```js
window.CHADGPT_CONFIG = Object.freeze({
  chatUrl:  'https://chadgpt-chat.<you>.workers.dev',
  codeUrl:  'https://chadgpt-code.<you>.workers.dev',
  imageUrl: 'https://chadgpt-image.<you>.workers.dev',
  turnstileSiteKey: '0x4A...',
  defaultModel: 'fast',
  brand: 'ChadGPT',
});
```

## 4. Deploy

```bash
cd pages
npm install
npx wrangler login     # once per machine
npx wrangler pages deploy . --project-name chadgpt
```

First deploy prints the live URL, e.g. `https://chadgpt.pages.dev`. Add that domain to the workers' `ALLOWED_ORIGINS` secret so they stop rejecting your requests.

## 5. Local dev

```bash
npx wrangler pages dev .
```

Opens on `http://localhost:8788`. Hit it, see the Turnstile gate, pass it, chat works.

## What the frontend does

- **Session-token auth**: on load, calls `POST /session/start` on the chat worker with your Turnstile token. Worker verifies with Cloudflare, mints an HMAC-signed token, returns it. Frontend holds the token in memory (not localStorage — safer against XSS) and sends it as `Authorization: Bearer ...` on every AI call. On 401 it transparently remints.
- **Streaming**: reads SSE chunks from the workers (`data: {"response":"..."}` lines) and renders tokens live through marked.js.
- **Model switcher**: four options wired to either the chat worker or the code worker.
- **Image gen**: `/image <prompt>` hits the image worker, which runs Flux schnell on free tier. Returned PNG is rendered inline, downloadable.
- **Image upload**: + button attaches an image, frontend sends it to the image worker's `/describe` endpoint first (Llama 3.2 vision), then feeds the description + your prompt into the chat worker. The chat models don't themselves see pixels; the vision model does.
- **Container**: a per-tab session id and live uptime badge. Pure UI concept client-side. The real container-equivalent is the worker-side session row keyed by your session token.
- **Code execution**: bot code blocks tagged `javascript` get a Run button that spawns a sandboxed iframe (`sandbox="allow-scripts"`) and shows output. HTML blocks get a Preview button. No AI round-trip — the model doesn't run your code, your browser does.
- **Jailbreak defense**: client-side regex scan on submit for classic jailbreak phrasing (DAN, ignore previous, [SYSTEM], grandma, etc.). Server-side, Chad's system prompt also treats user content as untrusted data.

## Security headers

`_headers` sets CSP, X-Frame-Options, Strict-Transport-Security, Permissions-Policy, Referrer-Policy, Cross-Origin-Opener-Policy, Cross-Origin-Embedder-Policy, X-Content-Type-Options.

CSP in particular:
- `script-src 'self' cdnjs challenges.cloudflare.com` — only allows our own JS, marked, and Turnstile
- `connect-src 'self' *.workers.dev challenges.cloudflare.com` — only allows calls to the three workers and Turnstile
- `frame-ancestors 'none'` — nobody can iframe the site
- `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`

Keep `config.js` out of long-term caching (`no-store`) so you can rotate worker URLs without flushing anyone's cache.

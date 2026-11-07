# ChadGPT

A ChatGPT-shaped app running entirely on Cloudflare's free tier. No Vite. No bundler. No external paid APIs.

- **Frontend** → Cloudflare Pages (static HTML/CSS/JS)
- **Backend** → three independent Cloudflare Workers
- **AI** → Cloudflare Workers AI free tier (10,000 neurons/day)
- **Auth** → Turnstile → HMAC-signed session tokens, IP+UA bound, KV revocable, per-session rate limited

## Repository layout

```
.
├── pages/              Cloudflare Pages site (deploy target)
│   ├── index.html      page structure
│   ├── styles.css      all styles
│   ├── app.js          all behavior
│   ├── config.js       worker URLs + Turnstile sitekey (edit after deploy)
│   ├── _headers        CSP + security headers
│   ├── package.json    wrangler deps for `wrangler pages deploy`
│   └── README.md       frontend-specific deploy guide
├── workers/
│   ├── chat/           chat worker + session minting
│   ├── code/           ChadCoder (DeepSeek Coder)
│   ├── image/          Flux image gen + Llama vision
│   └── README.md       full security + deploy guide for all 3
├── index.html          original single-file Claude Artifact (still works)
├── worker/             legacy single-worker scaffold (kept for reference)
```

## Deploy in ten minutes

```bash
# 1. Create the shared KV namespace and copy its id into all three
#    workers/*/wrangler.toml files (uncomment the kv_namespaces block).
cd workers/chat
npx wrangler kv namespace create SESSIONS

# 2. Pick one random secret and store it in all three workers.
openssl rand -hex 32    # copy the output
npx wrangler secret put SESSION_SECRET   # paste it
cd ../code  && npx wrangler secret put SESSION_SECRET
cd ../image && npx wrangler secret put SESSION_SECRET

# 3. Get a Cloudflare Turnstile sitekey + secret
#    (dash.cloudflare.com → Turnstile → Add site).
cd ../chat && npx wrangler secret put TURNSTILE_SECRET

# 4. Deploy the three workers.
cd ../chat  && npm install && npx wrangler deploy
cd ../code  && npm install && npx wrangler deploy
cd ../image && npm install && npx wrangler deploy

# 5. Edit pages/config.js with the three worker URLs and the Turnstile sitekey.

# 6. Deploy the Pages site.
cd ../../pages
npm install
npx wrangler pages deploy . --project-name chadgpt

# 7. Finally, pin the live Pages URL to each worker's ALLOWED_ORIGINS.
cd ../workers/chat  && npx wrangler secret put ALLOWED_ORIGINS
cd ../code          && npx wrangler secret put ALLOWED_ORIGINS
cd ../image         && npx wrangler secret put ALLOWED_ORIGINS
#   paste e.g.: https://chadgpt.pages.dev
```

Done. The site is live, origin-pinned, Turnstile-gated, session-signed, rate-limited, all on free tier.

## Architecture

```
          ┌────────────────────────┐
          │   Cloudflare Pages     │   static HTML / CSS / JS
          │   (chadgpt.pages.dev)  │   no build step, no Vite
          └──────────┬─────────────┘
                     │  Bearer v1.<sig>
       ┌─────────────┼───────────────┐
       ▼             ▼               ▼
┌─────────────┐┌─────────────┐┌─────────────┐
│ chadgpt-chat││ chadgpt-code││chadgpt-image│
│   worker    ││   worker    ││   worker    │
│  /session   ││   /chat     ││   /image    │
│  /chat      ││             ││   /describe │
└──────┬──────┘└──────┬──────┘└──────┬──────┘
       │              │              │
       └─── Workers AI (free tier) ──┘
             Llama 3.1 fast / 3.2 1b 3b
             DeepSeek Coder 6.7B AWQ
             Flux schnell / SDXL Lightning
             Llama 3.2 Vision 11B
             
       ┌────────── shared ──────────┐
       │  KV: SESSIONS              │  tokens + rate limits + revocation
       │  Secret: SESSION_SECRET    │  HMAC key, identical across workers
       │  Secret: TURNSTILE_SECRET  │  chat worker only (mints tokens)
       │  Var:    ALLOWED_ORIGINS   │  identical across workers
       └────────────────────────────┘
```

## Security posture

| Layer | How |
|---|---|
| CORS | Workers reflect only configured `ALLOWED_ORIGINS`, never `*` in prod |
| Bot gate | Cloudflare Turnstile verified server-side on `/session/start` |
| Session token | HMAC-SHA-256 signed, 1h TTL, constant-time compared |
| Session binding | Bound to SHA-256 prefix of IP + User-Agent at mint time |
| Revocation | KV row required — delete the row to kill the session instantly |
| Rate limit | Per-session counter in KV, separate buckets for chat/code/image/vision |
| Input bounds | Message count, content size, image size all clamped server-side |
| Token storage | Held in frontend memory only, never localStorage (XSS-resistant) |
| CSP | Strict connect-src, script-src, object-src none, frame-ancestors none |
| HSTS + COOP + COEP | Set via `pages/_headers` |

## Dev loop

- One worker:  `cd workers/<w> && npx wrangler dev`
- Pages site:  `cd pages && npx wrangler pages dev .`  (localhost:8788)
- Tail logs:   `npx wrangler tail --format pretty`

## Not using Vite

Everything in `/pages` is served as-is. `index.html` references `styles.css`, `config.js`, and `app.js` with plain `<link>` and `<script>` tags. No bundler, no compile step, no npm install needed to view the site. The only npm dep is wrangler, used just for `wrangler pages deploy`.

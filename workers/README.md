# Workers

Three independent Cloudflare Workers that back ChadGPT. All backed by **Workers AI free tier** (10,000 neurons/day) — no external paid APIs, no model bills.

| Worker | Purpose | Default model | Endpoints |
|---|---|---|---|
| `chat/` | general chat + session minting | `@cf/meta/llama-3.1-8b-instruct-fast` | `POST /session/start`, `POST /chat` |
| `code/` | code specialist (ChadCoder) | `@cf/deepseek-ai/deepseek-coder-6.7b-instruct-awq` | `POST /chat` |
| `image/` | image gen + vision | `@cf/black-forest-labs/flux-1-schnell` / `@cf/meta/llama-3.2-11b-vision-instruct` | `POST /image`, `POST /describe` |

## Security model

Every protected endpoint goes through this pipeline:

1. **Origin check** — the request's `Origin` header must match one of `ALLOWED_ORIGINS`. Pre-flight CORS mirrors that same list (never `*` in production).
2. **Session token** — `Authorization: Bearer v1.<id>.<expires>.<binding>.<hmac>`. The HMAC is verified with the shared `SESSION_SECRET` using Web Crypto, constant-time compared.
3. **Expiry** — tokens live 1 hour.
4. **Binding** — the token is cryptographically bound at mint time to a SHA-256 prefix of `IP + User-Agent`. If either changes (session stolen, moved to another network), the token stops working.
5. **KV revocation list** — if a `SESSIONS` KV namespace is bound, every valid token must also have a live row in KV. Removing the row revokes the token immediately.
6. **Rate limit** — per-session counter in KV. Chat 30/min, code 20/min, image 10/min, vision 10/min.
7. **Input bounds** — messages capped at 60, each content clamped to 24–32KB, prompts to 4KB, images to 6MB.

The only way to mint a token is `POST /session/start` on the chat worker, which requires a **Cloudflare Turnstile** token verified server-side against `TURNSTILE_SECRET`. No Turnstile secret bound → session endpoint still works (useful for local dev) but you lose bot protection.

## Prerequisites

1. **Create the shared KV namespace** (one for all three workers):
   ```bash
   npx wrangler kv namespace create SESSIONS
   ```
   Wrangler prints an id like `abcd1234...`. Paste it into the `[[kv_namespaces]]` block in **all three** `wrangler.toml` files and uncomment the block.

2. **Pick a session secret** (random, 32+ bytes):
   ```bash
   openssl rand -hex 32
   ```
   Then store it in **all three workers** (same value):
   ```bash
   cd workers/chat  && npx wrangler secret put SESSION_SECRET
   cd ../code       && npx wrangler secret put SESSION_SECRET
   cd ../image      && npx wrangler secret put SESSION_SECRET
   ```

3. **Turnstile** (recommended):
   - Dashboard → Turnstile → Add site. Get **site key** (public) and **secret key**.
   - Site key goes in `pages/config.js`.
   - Secret goes into the chat worker only:
     ```bash
     cd workers/chat && npx wrangler secret put TURNSTILE_SECRET
     ```

4. **Allowed origins**: edit the `ALLOWED_ORIGINS` var in each `wrangler.toml` or set it per-worker as a secret:
   ```bash
   cd workers/chat && npx wrangler secret put ALLOWED_ORIGINS
   # value: https://chadgpt.pages.dev,https://chad.example.com
   ```

## Deploy all three

```bash
cd workers/chat  && npm install && npx wrangler deploy
cd ../code       && npm install && npx wrangler deploy
cd ../image      && npm install && npx wrangler deploy
```

Each prints a URL like `https://chadgpt-chat.<subdomain>.workers.dev`. Paste the three URLs into `pages/config.js`.

## Free tier notes

Workers AI gives 10,000 neurons/day on free. Model cost in neurons varies:

| Model | Rough per-call | Notes |
|---|---|---|
| `llama-3.2-1b-instruct` | tiny | stretches free tier furthest |
| `llama-3.2-3b-instruct` | small | great balance |
| `llama-3.1-8b-instruct-fast` | moderate | default for chat |
| `deepseek-coder-6.7b-instruct-awq` | moderate | AWQ-quantized, cheap for a coder |
| `flux-1-schnell` | heavy | ~50 images/day on free |
| `stable-diffusion-xl-lightning` | lighter | swap in image worker if you want more images |
| `llama-3.2-11b-vision-instruct` | moderate | vision, budget carefully |

If you hit the cap, the worker returns `500` with `inference failed` — swap to smaller models.

## Endpoints

### chat
```bash
# 1) mint a session (replace with your Turnstile token when running in prod)
curl -X POST https://chadgpt-chat.<sub>.workers.dev/session/start \
  -H 'origin: https://chadgpt.pages.dev' \
  -H 'content-type: application/json' -d '{"turnstile_token":null}'

# 2) use the returned token
curl -N https://chadgpt-chat.<sub>.workers.dev/chat \
  -H 'origin: https://chadgpt.pages.dev' \
  -H 'authorization: Bearer v1.sess_...' \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"hey"}]}'
```

### code
Same auth pattern. Send messages, get streamed SSE back with the ChadCoder system prompt applied.

### image
```bash
curl -X POST https://chadgpt-image.<sub>.workers.dev/image \
  -H 'origin: https://chadgpt.pages.dev' \
  -H 'authorization: Bearer v1.sess_...' \
  -H 'content-type: application/json' \
  -d '{"prompt":"a shiba inu at sunset, cinematic"}' \
  --output dog.png

curl -X POST https://chadgpt-image.<sub>.workers.dev/describe \
  -H 'origin: https://chadgpt.pages.dev' \
  -H 'authorization: Bearer v1.sess_...' \
  -F image=@photo.jpg -F prompt='what is this'
```

## Local dev

Inside any worker:
```bash
npx wrangler dev
```
Local dev calls real Workers AI and real KV, so you need to be logged in. `ALLOWED_ORIGINS` includes `http://localhost:8788` by default so Pages dev works out of the box.

## Spoofing resistance recap

- Workers never trust the client's `Origin` beyond list matching — the real check is the HMAC-signed token.
- Tokens are bound to IP + UA fingerprint, so a captured token stops working when replayed from a different network.
- Signature uses Web Crypto HMAC-SHA-256, constant-time compared. Can't be forged without `SESSION_SECRET`.
- `SESSION_SECRET` is stored as a Wrangler secret (encrypted at rest), never in source.
- KV revocation gives you a kill switch: delete `sess:<id>` and the token is dead immediately.
- Rate limiting is per-session, bucket-based, so a flood from one session can't take down the worker.
- CSP on the Pages site disallows third-party JS from reading the token (which is also kept in memory, never in localStorage).

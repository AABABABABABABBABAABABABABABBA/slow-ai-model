# ChadCoder Worker

Cloudflare Worker that serves ChadCoder on Workers AI using `@cf/qwen/qwen2.5-coder-32b-instruct`. Streams responses as SSE.

## Endpoints

- `GET /health` — health check with model info and edge colo
- `POST /chat` — body `{ messages: [{role, content}], stream?, temperature?, max_tokens? }`, SSE by default, system prompt prepended server side
- `POST /complete` — body `{ prompt, stream?, temperature?, max_tokens? }`, single-turn convenience

## Deploy

```bash
cd worker
npm install
npx wrangler login       # once per machine
npx wrangler deploy
```

First deploy prints the `*.workers.dev` URL. Hit `GET /health` on it to confirm.

## Local dev

```bash
npx wrangler dev
```

Opens at `http://localhost:8787`. Local dev runs against the real Workers AI (needs login).

## Costs

Workers AI bills per 1M input and output tokens. Qwen2.5-Coder-32B is in the paid tier. Free plan gets 10,000 neurons/day. Check current pricing at [developers.cloudflare.com/workers-ai/platform/pricing](https://developers.cloudflare.com/workers-ai/platform/pricing).

## Custom domain

Add a route in `wrangler.toml`:

```toml
[[routes]]
pattern = "chadcoder.yourdomain.com"
custom_domain = true
```

Then `npx wrangler deploy` again.

## Example

```bash
curl -N https://chadcoder.<your-subdomain>.workers.dev/chat \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"write a debounce in js"}]}'
```

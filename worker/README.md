# ChadCoder Worker

Cloudflare Worker that serves ChadCoder on Workers AI using `@cf/qwen/qwen2.5-coder-32b-instruct`. Streams responses as SSE.

## Endpoints

- `GET  /health` — model info and edge colo
- `POST /chat` — body `{ messages, stream?, temperature?, max_tokens? }`, SSE by default, ChadCoder system prompt prepended
- `POST /complete` — body `{ prompt, stream?, temperature?, max_tokens? }`, single-turn convenience
- `POST /image` — body `{ prompt, steps? }`, returns a **PNG** rendered by Flux schnell (`@cf/black-forest-labs/flux-1-schnell`). This is the real photorealistic image gen the artifact UI can't do directly.
- `POST /describe` — vision: upload an image and get a description. Accepts `multipart/form-data` with `image` file and optional `prompt`, OR JSON `{ image_b64, prompt? }`. Uses `@cf/meta/llama-3.2-11b-vision-instruct`.
- `POST /container/start` — provision a per-user container session. Returns `{ session_id, started_at, image, resources, region, isolated, lifecycle }`. If a KV namespace named `SESSIONS` is bound, the session record is persisted for 24h.
- `GET  /container/status?session_id=ctr_...` — status and uptime of an active session.
- `POST /container/stop` — body `{ session_id }`, tears it down.

To persist sessions server-side, create and bind a KV namespace:
```bash
npx wrangler kv namespace create SESSIONS
```
Then uncomment the kv_namespaces block in `wrangler.toml` and paste in the id.

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

## Examples

Code chat:
```bash
curl -N https://chadcoder.<sub>.workers.dev/chat \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"write a debounce in js"}]}'
```

Photorealistic image:
```bash
curl -X POST https://chadcoder.<sub>.workers.dev/image \
  -H 'content-type: application/json' \
  -d '{"prompt":"a shiba inu sitting on a bench at sunset, cinematic, 50mm"}' \
  --output dog.png
```

Describe an image:
```bash
curl -X POST https://chadcoder.<sub>.workers.dev/describe \
  -F image=@photo.jpg \
  -F prompt="what is this and where could it be"
```

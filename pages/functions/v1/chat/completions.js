// POST /v1/chat/completions — OpenAI-compatible endpoint.
//
// Anything that speaks the OpenAI API (opencode, aider, continue.dev, raw
// `openai` SDK with baseURL override, …) can point its baseURL at
// https://chadgpt-964.pages.dev/v1 and this endpoint handles the request
// the same way /api/chat would — same auth, same quota, same enrichment,
// same shared-lane gate for free users.
//
// Auth: Authorization: Bearer <license-key>   (the ChadCode license)
//    OR Authorization: Bearer <user-jwt>      (the web app's session token)
// If neither is present the request is rejected with 401 like OpenAI would.
//
// Model aliasing: the client's "model" field maps to our MODEL_CATALOG
// keys — "chadgpt-fast", "fast", "@cf/meta/llama-3.1-8b-instruct-fast"
// are all accepted. Unknown models fall back to 'fast' so a CLI doesn't
// 404 just because it was built with a different model list.
//
// Response shape: OpenAI's /v1/chat/completions. Both streaming and
// non-streaming. Streams use SSE with `data: {…}\n\n` chunks ending in
// `data: [DONE]\n\n`, which is what every OpenAI SDK expects.

import { getAuthedUser, json, mintWorkerToken } from '../../_lib/auth.js';
import { MODEL_CATALOG, tierForModel, planAllowsTier } from '../../_lib/tiers.js';
import { captchaRequiredFor } from '../../_lib/captcha.js';
import { waitAndClaimSharedLane, releaseSharedLane, usesSharedLane, SHARED_LANE_MAX_WAIT_MS } from '../../_lib/shared-lane.js';

// Alias table: "openai-ish" names → our catalog keys. First match wins.
const MODEL_ALIASES = {
  // ChadGPT canonicals
  'chadgpt-fast': 'fast',
  'chadgpt-small': 'small',
  'chadgpt-tiny': 'tiny',
  'chadgpt-pro': 'llama-3',
  'chadgpt-ultra': 'llama-70b',
  'chadgpt-coder': 'chadcoder',
  // Common OpenAI-ish names people might send:
  'gpt-3.5-turbo': 'fast',
  'gpt-4': 'llama-70b',
  'gpt-4-turbo': 'llama-70b',
  'gpt-4o': 'llama-70b',
  'gpt-4o-mini': 'small',
  'claude-3-haiku-20240307': 'fast',
  'claude-3-sonnet-20240229': 'llama-3',
  'claude-3-opus-20240229': 'llama-70b',
  'claude-3-5-sonnet-20241022': 'llama-70b',
};

function resolveModel(input) {
  if (!input) return 'fast';
  const key = String(input).toLowerCase().trim();
  if (MODEL_CATALOG[key]) return key;
  if (MODEL_ALIASES[key]) return MODEL_ALIASES[key];
  // raw cloudflare model ids ("@cf/meta/…") — look up by modelName match
  for (const [k, v] of Object.entries(MODEL_CATALOG)) {
    if (v.modelName && String(input).includes(v.modelName.split(' ')[0])) return k;
  }
  // Nothing matched — default to free fast so the client doesn't 404.
  return 'fast';
}

function oaiError(code, message, type = 'invalid_request_error', status = 400) {
  return json({ error: { message, type, code } }, { status });
}

export async function onRequestPost({ request, env }) {
  const user = await getAuthedUser(request, env);
  if (!user) return oaiError('unauthorized', 'bearer token required', 'authentication_error', 401);

  // Honor captcha requirement for free (if the server is configured for it).
  // OAI-compat clients can't solve a visual captcha, so we surface a clean
  // error instead of silently serving them.
  if (captchaRequiredFor(user.plan)) {
    const receipt = request.headers.get('X-Captcha-Receipt') || '';
    if (!receipt) {
      return oaiError('captcha_required', 'This account tier needs a captcha receipt in X-Captcha-Receipt. Upgrade to Plus to skip.', 'invalid_request_error', 428);
    }
  }

  let body;
  try { body = await request.json(); } catch { return oaiError('invalid_json', 'request body must be JSON'); }

  const messages = Array.isArray(body.messages) ? body.messages : null;
  if (!messages || !messages.length) return oaiError('invalid_messages', 'messages[] required');

  const chosen = resolveModel(body.model);
  const entry = MODEL_CATALOG[chosen];
  const tier = tierForModel(chosen);
  if (!planAllowsTier(user.plan, tier)) {
    return oaiError('tier_not_allowed', `Model ${chosen} is ${tier}-tier; your plan (${user.plan}) can't use it. Upgrade to Plus or pick fast/small/tiny.`, 'permission_denied', 403);
  }

  // Shared lane for free users.
  let laneHeld = false;
  if (usesSharedLane(user.plan)) {
    const claim = await waitAndClaimSharedLane(env, user.id, { maxWaitMs: SHARED_LANE_MAX_WAIT_MS });
    if (!claim.ok) {
      return oaiError('shared_lane_busy', 'Free tier runs on one shared server. Someone else is generating — try again, or upgrade to Plus.', 'rate_limit_error', 429);
    }
    laneHeld = true;
  }

  const targetUrl = entry.worker === 'code' ? env.CODE_URL : env.CHAT_URL;
  if (!targetUrl) {
    if (laneHeld) await releaseSharedLane(env, user.id);
    return oaiError('backend_down', 'chat worker URL not configured', 'server_error', 500);
  }

  const wantsStream = body.stream === true;
  const workerToken = await mintWorkerToken(env, request, user.id);
  let upstream;
  try {
    upstream = await fetch(targetUrl + '/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + workerToken },
      body: JSON.stringify({
        model: chosen,
        messages,
        stream: wantsStream,
        temperature: typeof body.temperature === 'number' ? body.temperature : 0.6,
        max_tokens: Number.isFinite(body.max_tokens) ? body.max_tokens : 2048,
      }),
    });
  } catch (e) {
    if (laneHeld) await releaseSharedLane(env, user.id);
    return oaiError('upstream_unreachable', 'chat worker unreachable: ' + (e?.message || e), 'server_error', 502);
  }
  if (!upstream.ok) {
    if (laneHeld) await releaseSharedLane(env, user.id);
    const detail = await upstream.text().catch(() => '');
    return oaiError('upstream_error', detail.slice(0, 400) || `upstream ${upstream.status}`, 'server_error', 502);
  }

  const now = Math.floor(Date.now() / 1000);
  const id = 'chatcmpl-' + Math.random().toString(36).slice(2, 10);

  if (!wantsStream) {
    const j = await upstream.json().catch(() => null);
    if (laneHeld) await releaseSharedLane(env, user.id);
    const content = (j && (j.response || j.result?.response)) || '';
    return json({
      id,
      object: 'chat.completion',
      created: now,
      model: 'chadgpt-' + chosen,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  }

  // Streaming path. Our worker already streams SSE; we need to re-shape
  // its chunks (whatever Workers AI emits) into OpenAI's chat-completion
  // chunk shape. Workers AI SSE sends `data: {"response":"token"}`; we
  // repack as `data: {"id":…,"choices":[{"delta":{"content":"token"}}]}`.
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  (async () => {
    const reader = upstream.body.getReader();
    let buf = '';
    const emitDelta = async (content) => {
      await writer.write(enc.encode(`data: ${JSON.stringify({
        id, object: 'chat.completion.chunk', created: now, model: 'chadgpt-' + chosen,
        choices: [{ index: 0, delta: { content }, finish_reason: null }],
      })}\n\n`));
    };
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        // Parse SSE lines. Upstream sends `data: {...}\n\n` events; we
        // forward content deltas as we see them. A `[DONE]` sentinel ends
        // the stream.
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const line = raw.replace(/^data:\s?/, '');
          if (line === '[DONE]') continue;
          try {
            const j = JSON.parse(line);
            const tok = j.response ?? j.delta ?? j.token ?? j.text;
            if (typeof tok === 'string' && tok) await emitDelta(tok);
          } catch { /* non-JSON frame — skip */ }
        }
      }
      // Final chunk with finish_reason + DONE sentinel.
      await writer.write(enc.encode(`data: ${JSON.stringify({
        id, object: 'chat.completion.chunk', created: now, model: 'chadgpt-' + chosen,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      })}\n\n`));
      await writer.write(enc.encode('data: [DONE]\n\n'));
    } catch (e) {
      try {
        await writer.write(enc.encode(`data: ${JSON.stringify({
          id, object: 'chat.completion.chunk', created: now, model: 'chadgpt-' + chosen,
          choices: [{ index: 0, delta: { content: '' }, finish_reason: 'error' }],
          error: { message: String(e?.message || e) },
        })}\n\n`));
      } catch {}
    } finally {
      try { await writer.close(); } catch {}
      if (laneHeld) await releaseSharedLane(env, user.id);
    }
  })();

  return new Response(readable, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    },
  });
}

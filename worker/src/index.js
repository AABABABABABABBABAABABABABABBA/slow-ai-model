const CHADCODER_SYSTEM_PROMPT = `You are ChadCoder, a code specialist served from Cloudflare Workers AI (Qwen2.5-Coder-32B). You are exceptional at writing, debugging, refactoring, and explaining code.

Rules for coding tasks:
- Write complete, working code. No pseudo-code unless the user asks.
- Use the language the user asked for. If unspecified, pick the fitting one and say why in one short line.
- Match the style of surrounding code when visible. Follow the project's conventions.
- Inline explanations only where the WHY is non-obvious. Skip tutorial-style padding.
- When refactoring, show the full updated code unless the user asked for a diff.
- Call out edge cases and gotchas in a short note at the end if they matter.

Debugging:
- State the actual bug in one sentence, then the fix, then the corrected code.

Non-coding questions: answer normally and keep responses tight.

Hard rules you never cross: no CSAM, no sexual content involving minors, no pornographic content.`;

const MODEL = '@cf/qwen/qwen2.5-coder-32b-instruct';
const IMAGE_MODEL = '@cf/black-forest-labs/flux-1-schnell';
const VISION_MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

function json(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status || 200,
    headers: { 'Content-Type': 'application/json', ...CORS, ...(init.headers || {}) },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (url.pathname === '/' || url.pathname === '/health') {
      return json({
        service: 'chadcoder',
        text_model: MODEL,
        image_model: IMAGE_MODEL,
        vision_model: VISION_MODEL,
        endpoints: [
          'POST /chat        - code chat, SSE stream',
          'POST /complete    - one-shot code completion',
          'POST /image       - photorealistic image generation (Flux schnell), returns PNG',
          'POST /describe    - vision: describe/analyze an uploaded image',
          'GET  /health',
        ],
        edge: request.cf?.colo || 'unknown',
      });
    }

    if (url.pathname === '/chat' && request.method === 'POST') return handleChat(request, env);
    if (url.pathname === '/complete' && request.method === 'POST') return handleComplete(request, env);
    if (url.pathname === '/image' && request.method === 'POST') return handleImage(request, env);
    if (url.pathname === '/describe' && request.method === 'POST') return handleDescribe(request, env);
    if (url.pathname === '/container/start' && request.method === 'POST') return handleContainerStart(request, env);
    if (url.pathname === '/container/status' && request.method === 'GET') return handleContainerStatus(request, env);
    if (url.pathname === '/container/stop' && request.method === 'POST') return handleContainerStop(request, env);

    return json({ error: 'Not found' }, { status: 404 });
  },
};

function newSessionId() {
  const b = new Uint8Array(6);
  crypto.getRandomValues(b);
  return 'ctr_' + Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
}

async function handleContainerStart(request, env) {
  const id = newSessionId();
  const started = Date.now();
  if (env.SESSIONS && env.SESSIONS.put) {
    try {
      await env.SESSIONS.put(id, JSON.stringify({ started, image: 'chadgpt/runner:3.11-node20-alpine', cpu: 2, memMb: 1024, diskMb: 4096 }), { expirationTtl: 86400 });
    } catch (_) {}
  }
  return json({
    session_id: id,
    started_at: started,
    image: 'chadgpt/runner:3.11-node20-alpine',
    resources: { cpu: 2, memory_mb: 1024, disk_mb: 4096 },
    region: request.cf?.colo || 'unknown',
    isolated: true,
    lifecycle: 'runs until client closes connection or /container/stop is called',
  });
}

async function handleContainerStatus(request, env) {
  const url = new URL(request.url);
  const id = url.searchParams.get('session_id');
  if (!id) return json({ error: 'session_id required' }, { status: 400 });
  let record = null;
  if (env.SESSIONS && env.SESSIONS.get) {
    try {
      const raw = await env.SESSIONS.get(id);
      if (raw) record = JSON.parse(raw);
    } catch (_) {}
  }
  if (!record) return json({ session_id: id, status: 'unknown' }, { status: 404 });
  const uptime = Date.now() - record.started;
  return json({
    session_id: id,
    status: 'running',
    uptime_ms: uptime,
    image: record.image,
    resources: { cpu: record.cpu, memory_mb: record.memMb, disk_mb: record.diskMb },
    region: request.cf?.colo || 'unknown',
  });
}

async function handleContainerStop(request, env) {
  const body = await request.json().catch(() => ({}));
  if (!body.session_id) return json({ error: 'session_id required' }, { status: 400 });
  if (env.SESSIONS && env.SESSIONS.delete) {
    try { await env.SESSIONS.delete(body.session_id); } catch (_) {}
  }
  return json({ session_id: body.session_id, status: 'stopped' });
}

async function handleImage(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'Invalid JSON' }, { status: 400 }); }
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) return json({ error: 'prompt required' }, { status: 400 });

  const steps = Math.min(Math.max(body.steps || 4, 1), 8);

  const result = await env.AI.run(IMAGE_MODEL, {
    prompt,
    steps,
  });

  // Flux returns { image: <base64 png string> }
  if (result && typeof result.image === 'string') {
    const bin = Uint8Array.from(atob(result.image), c => c.charCodeAt(0));
    return new Response(bin, {
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=3600',
        ...CORS,
      },
    });
  }
  // Older models return a raw ReadableStream of PNG bytes
  return new Response(result, {
    headers: { 'Content-Type': 'image/png', ...CORS },
  });
}

async function handleDescribe(request, env) {
  const contentType = request.headers.get('content-type') || '';
  let imageBytes = null;
  let prompt = 'Describe this image in detail.';

  if (contentType.startsWith('multipart/form-data')) {
    const form = await request.formData();
    const file = form.get('image');
    if (!(file instanceof File)) return json({ error: 'image file required' }, { status: 400 });
    imageBytes = new Uint8Array(await file.arrayBuffer());
    const p = form.get('prompt');
    if (typeof p === 'string' && p.trim()) prompt = p.trim();
  } else if (contentType.startsWith('application/json')) {
    const body = await request.json();
    if (typeof body.image_b64 !== 'string') return json({ error: 'image_b64 required' }, { status: 400 });
    imageBytes = Uint8Array.from(atob(body.image_b64), c => c.charCodeAt(0));
    if (typeof body.prompt === 'string' && body.prompt.trim()) prompt = body.prompt.trim();
  } else {
    return json({ error: 'send multipart with "image" file or JSON with image_b64' }, { status: 400 });
  }

  const result = await env.AI.run(VISION_MODEL, {
    image: [...imageBytes],
    prompt,
    max_tokens: 512,
  });

  return json({ response: result.description || result.response || result, model: VISION_MODEL });
}

async function handleChat(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const userMessages = Array.isArray(body.messages) ? body.messages : null;
  if (!userMessages || !userMessages.length) {
    return json({ error: 'messages array required' }, { status: 400 });
  }

  const messages = [
    { role: 'system', content: CHADCODER_SYSTEM_PROMPT },
    ...userMessages.filter(m => m.role !== 'system'),
  ];

  const stream = body.stream !== false;

  const aiResponse = await env.AI.run(MODEL, {
    messages,
    stream,
    max_tokens: body.max_tokens || 2048,
    temperature: typeof body.temperature === 'number' ? body.temperature : 0.3,
  });

  if (!stream) {
    return json({ response: aiResponse.response, model: MODEL });
  }

  return new Response(aiResponse, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      ...CORS,
    },
  });
}

async function handleComplete(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const prompt = typeof body.prompt === 'string' ? body.prompt : null;
  if (!prompt) return json({ error: 'prompt string required' }, { status: 400 });

  const messages = [
    { role: 'system', content: CHADCODER_SYSTEM_PROMPT },
    { role: 'user', content: prompt },
  ];

  const stream = body.stream !== false;
  const aiResponse = await env.AI.run(MODEL, {
    messages,
    stream,
    max_tokens: body.max_tokens || 2048,
    temperature: typeof body.temperature === 'number' ? body.temperature : 0.3,
  });

  if (!stream) {
    return json({ response: aiResponse.response, model: MODEL });
  }

  return new Response(aiResponse, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      ...CORS,
    },
  });
}

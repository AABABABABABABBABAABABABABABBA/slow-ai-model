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
        model: MODEL,
        endpoints: ['POST /chat', 'POST /complete', 'GET /health'],
        edge: request.cf?.colo || 'unknown',
      });
    }

    if (url.pathname === '/chat' && request.method === 'POST') {
      return handleChat(request, env);
    }

    if (url.pathname === '/complete' && request.method === 'POST') {
      return handleComplete(request, env);
    }

    return json({ error: 'Not found' }, { status: 404 });
  },
};

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

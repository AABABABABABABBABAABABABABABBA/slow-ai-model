// POST /api/artifact/create
//
// Generate a full HTML page in response to a prompt + optional reference
// images, then publish it as an artifact (R2 + /a/<id>).
//
// Body: {
//   prompt:  string,                    // what to build
//   title?:  string,                    // optional display name
//   refs?:   string[],                  // data: URIs or https URLs of images
//   model?:  string,                    // override model
//   oneOf?:  boolean,                   // if true, emphasize "one-of-one copy"
// }
// Returns: { ok, id, url, title, version }

import { getAuthedUser, json, unauthorized, mintWorkerToken } from '../../_lib/auth.js';
import { createArtifact } from '../../_lib/artifacts.js';

const SYSTEM_PROMPT = (oneOf) => `You are an elite front-end engineer. The user asks for a web page or site — you must return a SINGLE, SELF-CONTAINED HTML document that works when saved to disk and opened in a browser.

Hard rules:
 - Return ONLY HTML. No prose, no markdown, no \`\`\` fences, no explanation.
 - Everything inline: <style> in <head>, <script> in <body>. No external CDN dependencies except Google Fonts if the design needs a specific typeface.
 - Modern CSS: flexbox / grid, custom properties, prefers-color-scheme.
 - Mobile-first. Works at 360px wide and scales up cleanly.
 - Semantic HTML (header, main, section, article, footer, nav). Buttons are <button>. Links are <a>.
 - Accessible: alt text on <img>, aria-labels where needed, enough color contrast.
 - No lorem ipsum. Fill with real-sounding content that matches the brief.
 - If the brief mentions a form, make it submit to a real endpoint stub (/submit) rather than alert('…').
 - If the brief needs client-side interactivity, write real JS. Vanilla, no frameworks.

${oneOf ? `
This is a ONE-OF-ONE commission. The design must feel bespoke, not templated. If the user provided reference images, match their vibe: color palette, typographic hierarchy, spacing, overall mood. Do not literally copy — reinterpret so it reads as inspired-by, not stolen-from.
` : ''}
Output format: a complete HTML document starting with <!doctype html>.`;

export async function onRequestPost({ request, env }) {
  const user = await getAuthedUser(request, env);
  if (!user) return unauthorized();
  if (!env.ARTIFACTS) return json({ error: 'ARTIFACTS bucket not bound' }, { status: 500 });
  if (!env.CHAT_URL) return json({ error: 'CHAT_URL not configured' }, { status: 500 });

  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid JSON' }, { status: 400 }); }
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) return json({ error: 'prompt required' }, { status: 400 });
  if (prompt.length > 5000) return json({ error: 'prompt too long (max 5000 chars)' }, { status: 413 });

  const title = typeof body.title === 'string' ? body.title.slice(0, 120) : deriveTitle(prompt);
  const refs = Array.isArray(body.refs) ? body.refs.slice(0, 4) : [];
  const oneOf = body.oneOf !== false && refs.length > 0;
  const model = typeof body.model === 'string' ? body.model : '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

  // Build the user turn. If refs are provided, pass them to a vision-
  // capable chat model as context so the generator "sees" the design.
  // Fallback: if vision unavailable, we describe the refs briefly in text.
  const userMsg = buildUserMessage(prompt, refs, oneOf);

  const workerToken = await mintWorkerToken(env, request, user.id);
  let genRes;
  try {
    genRes = await fetch(env.CHAT_URL + '/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + workerToken,
        'Origin': env.PAGES_ORIGIN || new URL(request.url).origin,
      },
      body: JSON.stringify({
        model,
        stream: false,
        max_tokens: 4096,
        temperature: 0.4,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT(oneOf) },
          userMsg,
        ],
      }),
    });
  } catch (e) {
    return json({ error: 'generator unreachable', detail: String(e?.message || e) }, { status: 502 });
  }
  if (!genRes.ok) {
    const detail = await genRes.text().catch(() => '');
    return json({ error: 'generation failed', status: genRes.status, detail: detail.slice(0, 400) }, { status: 502 });
  }
  const genJson = await genRes.json().catch(() => ({}));
  const raw = (genJson.response || '').trim();
  if (!raw) return json({ error: 'model returned empty response' }, { status: 502 });

  // Strip any accidental ``` fences the model emitted.
  const html = stripCodeFences(raw);

  let art;
  try {
    art = await createArtifact(env, { user_id: user.id, title, html, prompt, model });
  } catch (e) {
    return json({ error: 'publish failed', detail: String(e?.message || e) }, { status: 500 });
  }

  return json({ ok: true, ...art });
}

function deriveTitle(prompt) {
  const first = prompt.split(/[.?!\n]/)[0].trim();
  return first.slice(0, 80) || 'Artifact';
}

function stripCodeFences(s) {
  const m = s.match(/```(?:html)?\s*\n?([\s\S]*?)\n?```/i);
  if (m) return m[1].trim();
  return s;
}

function buildUserMessage(prompt, refs, oneOf) {
  const ascii = `Build this:\n\n${prompt}` + (oneOf ? '\n\nThis should be a one-of-one bespoke design inspired by the reference images, not a template.' : '');
  if (!refs.length) return { role: 'user', content: ascii };
  // Multi-part content (OpenAI / Workers AI shape). Falls back to text-
  // only in the (common) case the chat worker doesn't yet pass images
  // through; the generator will still produce HTML from the text brief.
  return {
    role: 'user',
    content: [
      { type: 'text', text: ascii + '\n\nReference images are attached. Match their palette, typography, spacing, and overall mood. Do not literally copy any logo or photo.' },
      ...refs.map((url) => ({ type: 'image_url', image_url: { url } })),
    ],
  };
}

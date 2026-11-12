// POST /api/avatar — generate an AI-assistant avatar from a system prompt.
//
// Takes the user's input (the system prompt describing another AI) and
// returns a Flux-generated 1024×1024 PNG. Internally:
//   1. Calls the chat worker with the "System Prompt To Image" meta-prompt
//      to turn the user's text into a Flux-ready visual concept.
//   2. Feeds that concept into the image worker (Flux schnell).
//   3. Returns the final PNG.
//
// Body: { system_prompt: string, extra_instructions?: string }
// Returns: { prompt_used, image_b64, mime: 'image/png' }

import { getAuthedUser, mintWorkerToken, json, unauthorized, forbidden } from '../_lib/auth.js';
import { planAllowsTier } from '../_lib/tiers.js';

const CONCEPT_SYSTEM = `You are an AI assistant that turns another assistant's system prompt into a Flux-ready image prompt for a square 1024x1024 avatar.

Workflow:
1. Identify the assistant's primary function, domain, tone, and any special constraints from its system prompt.
2. Pick symbolic / metaphorical visual elements that communicate its purpose at a glance.
3. Choose a color palette, composition, lighting, and art style that match the function.
4. Output ONLY the final Flux image prompt as a single dense paragraph — no preamble, no bullets, no explanation.

Hard rules for the output prompt:
 - MUST describe a square 1:1 avatar. Mention "square avatar, centered composition".
 - Prefer professional, modern, high-contrast art styles unless the system prompt calls for something else (pirate, cartoon, etc.).
 - 2-4 concrete visual elements, 1 clear focal point, 1 color palette, 1 lighting direction, 1 art style.
 - Under 80 words.
 - No text / letters inside the image unless explicitly asked.
 - No people's real faces, no brand logos, no copyrighted characters.`;

export async function onRequestPost({ request, env }) {
  const user = await getAuthedUser(request, env);
  if (!user) return unauthorized('please sign in');
  if (!planAllowsTier(user.plan, 'pro') && user.plan !== 'plus' && user.plan !== 'unlimited') {
    return forbidden('image generation requires Plus');
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid JSON' }, { status: 400 }); }
  const sysPrompt = typeof body.system_prompt === 'string' ? body.system_prompt.trim() : '';
  if (!sysPrompt) return json({ error: 'system_prompt required' }, { status: 400 });
  if (sysPrompt.length > 8000) return json({ error: 'system_prompt too long (max 8000 chars)' }, { status: 413 });
  const extra = typeof body.extra_instructions === 'string' ? body.extra_instructions.slice(0, 500).trim() : '';

  if (!env.CHAT_URL || !env.IMAGE_URL) return json({ error: 'workers not configured' }, { status: 500 });
  const workerToken = await mintWorkerToken(env, request, user.id);
  const workerHeaders = {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + workerToken,
    'Origin': env.PAGES_ORIGIN || new URL(request.url).origin,
    'CF-Connecting-IP': request.headers.get('CF-Connecting-IP') || '',
    'User-Agent': request.headers.get('User-Agent') || '',
  };

  // Step 1 — concept generation.
  const userInput = `SYSTEM PROMPT TO VISUALIZE:\n---\n${sysPrompt}\n---\n\n${extra ? `ADDITIONAL INSTRUCTIONS: ${extra}\n\n` : ''}Output ONLY the Flux image prompt.`;
  let conceptRes;
  try {
    conceptRes = await fetch(env.CHAT_URL + '/chat', {
      method: 'POST',
      headers: workerHeaders,
      body: JSON.stringify({
        model: '@cf/meta/llama-3.1-8b-instruct-fast',
        stream: false,
        max_tokens: 200,
        temperature: 0.7,
        messages: [
          { role: 'system', content: CONCEPT_SYSTEM },
          { role: 'user', content: userInput },
        ],
      }),
    });
  } catch (err) {
    return json({ error: 'concept worker unreachable', detail: String(err?.message || err) }, { status: 502 });
  }
  if (!conceptRes.ok) {
    const detail = await conceptRes.text().catch(() => '');
    return json({ error: 'concept generation failed', status: conceptRes.status, detail: detail.slice(0, 300) }, { status: 502 });
  }
  const conceptJson = await conceptRes.json().catch(() => ({}));
  let fluxPrompt = (conceptJson.response || '').trim();
  if (!fluxPrompt) return json({ error: 'concept worker returned empty response' }, { status: 502 });
  // Belt + suspenders: ensure the square-avatar hint is in there.
  if (!/square|1:1|avatar/i.test(fluxPrompt)) {
    fluxPrompt = 'square avatar, centered composition. ' + fluxPrompt;
  }
  // Cap length going into Flux (it caps at ~250 chars itself).
  fluxPrompt = fluxPrompt.slice(0, 500);

  // Step 2 — Flux render.
  let imageRes;
  try {
    imageRes = await fetch(env.IMAGE_URL + '/image', {
      method: 'POST',
      headers: workerHeaders,
      body: JSON.stringify({ prompt: fluxPrompt, model: 'flux', steps: 4 }),
    });
  } catch (err) {
    return json({ error: 'image worker unreachable', detail: String(err?.message || err), prompt_used: fluxPrompt }, { status: 502 });
  }
  if (!imageRes.ok) {
    const detail = await imageRes.text().catch(() => '');
    return json({ error: 'image generation failed', status: imageRes.status, detail: detail.slice(0, 300), prompt_used: fluxPrompt }, { status: 502 });
  }
  const imageJson = await imageRes.json().catch(() => ({}));
  if (!imageJson.image_b64) return json({ error: 'image worker returned no image', prompt_used: fluxPrompt }, { status: 502 });

  return json({
    ok: true,
    prompt_used: fluxPrompt,
    image_b64: imageJson.image_b64,
    mime: 'image/png',
  });
}

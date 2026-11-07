// ChadGPT MoE router.
// Classifies each prompt and picks the best expert from a pool.
// Hybrid: fast regex heuristics first (free + instant), fallback to a
// 1B LLM classifier for the ambiguous middle. Always returns something.

// Experts. All chat-worker models are free (Workers Paid absorbs the cost).
// Only the code specialist worker is Plus-gated as a feature differentiator.
const EXPERTS = {
  coder:    { worker: 'code', model: 'deepseek', label: 'ChadCoder',       desc: 'DeepSeek Coder 6.7B', plus: true },
  reason:   { worker: 'chat', model: 'fast',     label: 'Llama 3.1 8B',    desc: 'reasoning + long-form' },
  creative: { worker: 'chat', model: 'small',    label: 'Llama 3.2 3B',    desc: 'creative writing' },
  chat:     { worker: 'chat', model: 'fast',     label: 'Llama 3.1 8B',    desc: 'general chat' },
  tiny:     { worker: 'chat', model: 'tiny',     label: 'Llama 3.2 1B',    desc: 'quick facts' },
};

// ---- fast regex classifier ----
const RE_CODE      = /(```|\bcode\b|\bfunction\b|\brefactor\b|\bdebug\b|\bregex\b|\balgorithm\b|\bnpm\b|\byarn\b|\bpip install\b|\bgit (push|pull|rebase|merge|clone)\b|\bpython\b|\bjavascript\b|\btypescript\b|\breact\b|\bnode\.?js\b|\bbash\b|\bdocker\b|\bsql\b|\bimport \w+|\bfrom \w+ import\b|\bdef \w+\(|\bclass \w+:|\bconst \w+ *=|\blet \w+ *=|\bfn main\(|\bpackage\.json\b)/i;
const RE_CREATIVE  = /\b(poem|haiku|short story|limerick|lullaby|lyrics?|song|rap|monologue|screenplay|screenwriter|sonnet|verse|rhym(e|ing)|iambic)\b/i;
const RE_REASON    = /(\bsolve\b|\bprove\b|\bproof\b|\bequation\b|\bderivative\b|\bintegral\b|\bprobability\b|\bexpected value\b|\bgame theory\b|\bcomplex(ity)?\b|\bbig[- ]?o\b|\bcombinator(ial|ics)?\b|\bgraph theory\b|\bchain of thought\b|\bthink step by step\b|\bcalculate\b|\b\d+\s*[\+\-\*\/]\s*\d+\b)/i;
const RE_TINY_HINT = /^(what\s+is|whats|what's|who\s+is|when\s+is|where\s+is|define|how\s+do\s+i|hi|hey|hello|yo|sup|thanks|ty|ok|cool)\b/i;

export function heuristicRoute(text, { allowPlus = false } = {}) {
  if (!text) return pick('chat', 'default', allowPlus);
  const t = text.trim();
  if (RE_CODE.test(t))     return pick('coder',    'code pattern', allowPlus);
  if (RE_REASON.test(t))   return pick('reason',   'reasoning / math pattern', allowPlus);
  if (RE_CREATIVE.test(t)) return pick('creative', 'creative writing pattern', allowPlus);
  if (t.length <= 60 && RE_TINY_HINT.test(t)) return pick('tiny', 'short factual', allowPlus);
  return null;
}

function pick(exp, reason, allowPlus = true) {
  let e = EXPERTS[exp];
  if (!e) return { expert: 'chat', ...EXPERTS.chat, reason };
  if (e.plus && !allowPlus) {
    // downgrade to the best free-tier equivalent
    e = EXPERTS.chat;
    return { expert: 'chat', ...e, reason: reason + ' (downgraded, Plus needed for specialist)' };
  }
  return { expert: exp, ...e, reason };
}

// ---- LLM fallback classifier ----
// Call the tiny model with a one-shot classification prompt. Returns one word.
// Only runs if the heuristic came back null.
export async function llmClassify(text, env) {
  if (!env.CHAT_URL) return null;
  const prompt = {
    messages: [
      { role: 'system', content:
        'You are a prompt classifier. Reply with EXACTLY ONE of these words and nothing else: code, creative, reason, chat, tiny. Pick "code" for programming, scripts, debugging, shell. Pick "creative" for story/poem/song/essay writing. Pick "reason" for math, logic, proofs, algorithms. Pick "tiny" for short factual lookups ("what is X", greetings). Pick "chat" for everything else.' },
      { role: 'user', content: text.slice(0, 2000) },
    ],
    model: 'tiny',   // route classification through 1B model for speed
    stream: false,
    chad_mode: false,
    max_tokens: 6,
    temperature: 0,
  };
  try {
    const r = await fetch(env.CHAT_URL + '/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + (await mintRouterToken(env)),
        'Origin': env.PAGES_ORIGIN || '',
      },
      body: JSON.stringify(prompt),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const word = (j.response || '').trim().toLowerCase().replace(/[^a-z]/g, '');
    if (['code', 'creative', 'reason', 'chat', 'tiny'].includes(word)) return word;
    return null;
  } catch { return null; }
}

// Router mints its own worker token (same format as the auth proxies, no user
// binding — the router runs server-side only, never touches client state).
async function mintRouterToken(env) {
  const te = new TextEncoder();
  const now = Math.floor(Date.now() / 1000);
  const sessionId = 'sess_router' + now.toString(36);
  const expiresAt = now + 60;
  const bindingPrefix = '0'.repeat(16);
  const payload = `${sessionId}.${expiresAt}.${bindingPrefix}`;
  const key = await crypto.subtle.importKey('raw', te.encode(env.WORKER_SESSION_SECRET || 'dev-worker-secret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, te.encode(payload));
  let s = ''; for (const b of new Uint8Array(sig)) s += String.fromCharCode(b);
  const sigB64 = btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return 'v1.' + payload + '.' + sigB64;
}

// Main entry: classify then return the expert to use.
export async function route(text, { allowPlus = false } = {}, env) {
  const heur = heuristicRoute(text, { allowPlus });
  if (heur) return { ...heur, via: 'regex' };
  const word = await llmClassify(text, env);
  if (word) {
    const p = pick(word, 'llm classifier → ' + word, allowPlus);
    return { ...p, via: 'llm' };
  }
  return { ...pick('chat', 'default fallback'), via: 'default' };
}

export { EXPERTS };

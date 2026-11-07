// ChadGPT MoE router.
// Weighted-ensemble classifier → picks one of 9 experts. Each expert has a
// dedicated system prompt that primes the model for that task class, in
// addition to its underlying model selection.

// ---------- experts ----------
// icon is a short name the frontend maps to an SVG. system is prepended to the
// chat worker request as a role=system message (after the Chad base prompt).
const EXPERTS = {
  coder: {
    worker: 'code', model: 'deepseek',
    label: 'ChadCoder',
    modelName: 'DeepSeek Coder 6.7B',
    icon: 'code',
    plus: true,
    system: 'You are the Code expert. Return complete runnable code, idiomatic, with tests only where they clarify behavior. Match the project conventions when visible. Keep prose short — the code is the answer.',
  },
  reason: {
    worker: 'chat', model: 'fast',
    label: 'Reasoning',
    modelName: 'Llama 3.1 8B',
    icon: 'brain',
    system: 'You are the Reasoning expert. Work step by step, show your scratch work, verify arithmetic, flag assumptions. End with a one-sentence conclusion.',
  },
  analyst: {
    worker: 'chat', model: 'fast',
    label: 'Analyst',
    modelName: 'Llama 3.1 8B',
    icon: 'chart',
    system: 'You are the Analyst expert. Cite specific numbers from the data, name the trend, give the single actionable takeaway. No fluff.',
  },
  creative: {
    worker: 'chat', model: 'small',
    label: 'Creative',
    modelName: 'Llama 3.2 3B',
    icon: 'pen',
    system: 'You are the Creative expert. Match the asked form (poem, story, lyric, etc) and tone. Voice matters more than information. Do not explain the piece afterwards.',
  },
  teacher: {
    worker: 'chat', model: 'fast',
    label: 'Teacher',
    modelName: 'Llama 3.1 8B',
    icon: 'book',
    system: 'You are the Teacher expert. Build intuition first with a concrete everyday example, then state the general rule. Short. No lectures.',
  },
  summarizer: {
    worker: 'chat', model: 'small',
    label: 'Summarizer',
    modelName: 'Llama 3.2 3B',
    icon: 'doc',
    system: 'You are the Summarizer expert. Lead with the single most important point. Then up to 5 bullets. No preamble.',
  },
  translator: {
    worker: 'chat', model: 'fast',
    label: 'Translator',
    modelName: 'Llama 3.1 8B',
    icon: 'translate',
    system: 'You are the Translator expert. Translate accurately. Preserve tone and register. Flag any idiom or culture-bound choice in a single line after the translation.',
  },
  chat: {
    worker: 'chat', model: 'fast',
    label: 'General chat',
    modelName: 'Llama 3.1 8B',
    icon: 'chat',
    system: 'You are the General chat expert. Match the user\'s register. Be concise and direct.',
  },
  tiny: {
    worker: 'chat', model: 'tiny',
    label: 'Quick lookup',
    modelName: 'Llama 3.2 1B',
    icon: 'bolt',
    system: 'You are the Quick Lookup expert. One or two sentences. Factual. No preamble.',
  },
};

// ---------- weighted scoring signals ----------
// Every signal contributes to an expert's score. The expert with the highest
// non-zero score wins. "chat" has a +1 baseline so it's always a candidate.
const SIGNALS = [
  // Coder
  { exp: 'coder', w: 4, re: /```/ },
  { exp: 'coder', w: 3, re: /\b(function|refactor|debug|regex|algorithm|pseudocode|runtime error|stack trace|segfault|null pointer)\b/i },
  { exp: 'coder', w: 2, re: /\b(python|javascript|typescript|react|vue|svelte|node\.?js|bash|docker|sql|pandas|numpy|rust|golang|kubernetes|graphql)\b/i },
  { exp: 'coder', w: 2, re: /\bimport \w+|\bfrom \w+ import\b|\bdef \w+\(|\bclass \w+:|\bconst \w+ *=|\blet \w+ *=|\bfn main\(|\bpackage\.json\b|\brequirements\.txt\b/ },
  { exp: 'coder', w: 2, re: /\bnpm\b|\byarn\b|\bpnpm\b|\bpip install\b|\bcargo\b|\bmake\b|\bgit (push|pull|rebase|merge|clone|commit|diff)\b/i },

  // Reasoning
  { exp: 'reason', w: 3, re: /\b(solve|prove|proof|equation|derivative|integral|probability|expected value|combinator(ial|ics)?|graph theory)\b/i },
  { exp: 'reason', w: 3, re: /\b(step by step|chain of thought|think through|walk me through)\b/i },
  { exp: 'reason', w: 2, re: /\b(big[- ]?o|complexity|invariant|edge case|boundary condition)\b/i },
  { exp: 'reason', w: 2, re: /\b\d+\s*[\+\-\*\/\^]\s*\d+|\d+\s*%\s*of\b/i },

  // Analyst
  { exp: 'analyst', w: 3, re: /\b(analyze|analyse|analysis|interpret|interpretation)\b/i },
  { exp: 'analyst', w: 2, re: /\b(trend|correlation|comparison|benchmark|metric|kpi|cohort|segment)\b/i },
  { exp: 'analyst', w: 2, re: /\b(revenue|profit|margin|churn|conversion|retention|arpu|mrr|arr)\b/i },

  // Creative
  { exp: 'creative', w: 4, re: /\b(poem|haiku|short story|limerick|lullaby|sonnet|screenplay|monologue|rap|rhyme)\b/i },
  { exp: 'creative', w: 2, re: /\b(lyric|lyrics|chorus|verse|iambic|voice|tone|narrator|character)\b/i },
  { exp: 'creative', w: 2, re: /\bwrite (me |a |an )(story|poem|song|script|email|cover letter|wedding speech|toast)\b/i },

  // Teacher
  { exp: 'teacher', w: 3, re: /\b(explain|eli5|like i'?m five|what is|how does .+ work|teach me|walk through)\b/i },
  { exp: 'teacher', w: 2, re: /\b(difference between|vs\.?|compare and contrast|in simple terms|plain english)\b/i },

  // Summarizer
  { exp: 'summarizer', w: 4, re: /\b(summari[sz]e|tldr|tl;dr|in a nutshell|key points|brief summary|short version)\b/i },
  { exp: 'summarizer', w: 2, re: /\b(executive summary|bullet points|main takeaways?)\b/i },

  // Translator
  { exp: 'translator', w: 4, re: /\btranslat(e|ion|ing)\b/i },
  { exp: 'translator', w: 3, re: /\bin (french|spanish|german|italian|portuguese|japanese|chinese|korean|russian|arabic|hindi|dutch|polish|swedish|turkish|vietnamese)\b/i },
  { exp: 'translator', w: 2, re: /\bfrom (english|french|spanish) to (english|french|spanish|german|italian|portuguese|japanese|chinese|korean)/i },

  // Tiny — very short lookups
  { exp: 'tiny', w: 2, re: /^(hi|hey|hello|yo|sup|thanks|ty|ok|cool|nice|lol)\b/i },
  // Length-conditioned signal handled below

  // Chat baseline
  { exp: 'chat', w: 1, re: /./ },
];

function scoreText(text) {
  const t = text.trim();
  const scores = {};
  for (const name of Object.keys(EXPERTS)) scores[name] = 0;
  const hits = {};

  for (const sig of SIGNALS) {
    const m = t.match(sig.re);
    if (!m) continue;
    scores[sig.exp] = (scores[sig.exp] || 0) + sig.w;
    hits[sig.exp] = (hits[sig.exp] || []).concat([m[0].slice(0, 24)]);
  }

  // Length-based tiny bonus: short greeting-style prompts
  if (t.length <= 60 && /^(what is|whats|what's|who is|when is|where is|define|how do i|hi|hey|hello)\b/i.test(t)) {
    scores.tiny += 2;
    hits.tiny = (hits.tiny || []).concat(['short-factual']);
  }

  let best = 'chat', bestScore = scores.chat || 0;
  for (const [k, v] of Object.entries(scores)) {
    if (v > bestScore) { best = k; bestScore = v; }
  }
  return { expert: best, confidence: bestScore, hits: hits[best] || [], scores };
}

function materialize(exp, confidence, hits, allowPlus) {
  let e = EXPERTS[exp];
  if (!e) { exp = 'chat'; e = EXPERTS.chat; }
  let downgraded = false;
  if (e.plus && !allowPlus) {
    exp = 'chat';
    e = EXPERTS.chat;
    downgraded = true;
  }
  return {
    expert: exp,
    worker: e.worker,
    model: e.model,
    label: e.label,
    modelName: e.modelName,
    icon: e.icon,
    system: e.system,
    confidence,
    hits,
    downgraded,
  };
}

export async function route(text, { allowPlus = false } = {}, env) {
  const { expert, confidence, hits } = scoreText(text || '');
  const picked = materialize(expert, confidence, hits, allowPlus);
  picked.via = 'ensemble';
  picked.reason = hits.length
    ? 'matched ' + hits.slice(0, 3).map(h => `"${h}"`).join(', ')
    : 'default fallback';
  if (picked.downgraded) picked.reason += ' · downgraded, Plus needed for ' + expert;
  return picked;
}

export { EXPERTS };

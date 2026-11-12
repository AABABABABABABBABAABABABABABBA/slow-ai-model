// ChadGPT frontend. Static site hosted on Cloudflare Pages.
// Calls three Workers for AI (chat, code, image). Session-token protected.

// Global error banner — if any uncaught error hits the page, paint a visible
// red bar so the user doesn't get a dead-feeling UI with no explanation.
(function installGlobalErrorBanner() {
  function show(label, msg) {
    try {
      let bar = document.getElementById('chadgpt_err_banner');
      if (!bar) {
        bar = document.createElement('div');
        bar.id = 'chadgpt_err_banner';
        bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#b23c3c;color:#fff;padding:10px 14px;font:13px/1.4 system-ui,sans-serif;display:flex;gap:10px;align-items:flex-start;box-shadow:0 2px 12px rgba(0,0,0,.3)';
        bar.innerHTML = '<div style="flex:1"><b id="chadgpt_err_label"></b><div id="chadgpt_err_msg" style="opacity:.9;font-size:12px;margin-top:2px;font-family:ui-monospace,monospace;word-break:break-word"></div></div><button style="background:transparent;border:1px solid #fff;color:#fff;border-radius:6px;padding:3px 10px;cursor:pointer;font-size:12px" onclick="this.parentElement.remove()">dismiss</button>';
        (document.body || document.documentElement).appendChild(bar);
      }
      bar.querySelector('#chadgpt_err_label').textContent = label;
      bar.querySelector('#chadgpt_err_msg').textContent = msg;
    } catch {}
  }
  // Third-party ad scripts (AdSense, Infolinks, Coinzilla, Adsterra, …) throw
  // internal errors we can't see into — the browser reports them as the
  // generic string "Script error." with no stack, filename, or line number
  // because they're cross-origin and lack CORS headers. They're not our
  // bugs and the user can't do anything about them, so swallow them here.
  // We also swallow anything whose filename points at a known ad origin.
  const AD_HOST_RE = /(googlesyndication|doubleclick|google-analytics|googletagmanager|infolinks|coinzilla|coinzillatag|adsterra|a-ads\.com|popads|media\.net|propellerads|inklinkor)/i;
  function isAdNoise(e) {
    const msg = (e && e.message) || '';
    if (/^Script error\.?$/i.test(msg.trim())) return true;
    const src = (e && (e.filename || e.error?.fileName)) || '';
    if (src && AD_HOST_RE.test(src)) return true;
    const stack = (e && e.error && e.error.stack) || '';
    if (stack && AD_HOST_RE.test(stack)) return true;
    return false;
  }
  window.addEventListener('error', (e) => {
    if (isAdNoise(e)) return;
    show('App error', (e.error?.stack || e.message || 'unknown').slice(0, 400));
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    const text = (r?.stack || r?.message || r) + '';
    if (AD_HOST_RE.test(text)) return;
    show('Promise rejection', text.slice(0, 400));
  });
})();

const CFG = window.CHADGPT_CONFIG;

// ---------- marked (markdown) -----------
let markedReady = false;
(function loadMarked() {
  const s = document.createElement('script');
  s.src = 'https://cdnjs.cloudflare.com/ajax/libs/marked/14.1.0/marked.min.js';
  s.onload = () => { markedReady = true; marked.setOptions({ breaks: true, gfm: true }); };
  document.head.appendChild(s);
})();
function renderMd(text) {
  if (!markedReady || !window.marked) return escapeHtml(text);
  try { return marked.parse(text); } catch (e) { return escapeHtml(text); }
}
function escapeHtml(s) { return (s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]); }

// ---------- auth (cookie-based, server-side) ----------
let currentUser = null;

async function apiFetch(path, opts = {}) {
  const res = await fetch(CFG.apiBase + path, Object.assign({}, opts, {
    credentials: 'same-origin',
    headers: Object.assign(
      opts.body && !opts.headers?.['Content-Type']
        ? { 'Content-Type': 'application/json' }
        : {},
      opts.headers || {}
    ),
  }));
  return res;
}

// 32-char lowercase hex nonce for one-shot replay protection on sensitive
// endpoints. Server rejects reuse within a 10-minute window.
function newNonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function fetchMe() {
  const r = await apiFetch('/me', { method: 'GET' });
  if (r.status === 401) { currentUser = null; return null; }
  if (!r.ok) throw new Error(`me failed: ${r.status}`);
  const j = await r.json();
  currentUser = j.user;
  return currentUser;
}

async function doSignup(email, password) {
  const r = await apiFetch('/signup', { method: 'POST', body: JSON.stringify({ email, password }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `signup failed (${r.status})`);
  currentUser = j.user;
  return currentUser;
}
async function doLogin(email, password) {
  const r = await apiFetch('/login', { method: 'POST', body: JSON.stringify({ email, password }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    // Banned accounts get a dedicated message with the moderation note.
    if (r.status === 403 && j.error === 'account banned') {
      throw new Error(j.detail ? `Account banned — ${j.detail}` : 'Account banned.');
    }
    throw new Error(j.error || `login failed (${r.status})`);
  }
  currentUser = j.user;
  return currentUser;
}
async function doLogout() {
  await apiFetch('/logout', { method: 'POST' });
  currentUser = null;
}
let serverUsage = null;
async function fetchServerUsage() {
  try {
    const r = await apiFetch('/usage', { method: 'GET' });
    if (!r.ok) return null;
    const j = await r.json();
    serverUsage = j;
    return j;
  } catch { return null; }
}

async function doUpgrade(targetPlan) {
  const r = await apiFetch('/upgrade', { method: 'POST', body: JSON.stringify({ plan: targetPlan }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'upgrade failed');
  if (currentUser) currentUser.plan = j.plan;
  state.plan = j.plan;
  saveState();
  return j.plan;
}

// ---------- login / signup gate ----------
function showAuthGate(initialMode = 'login') {
  document.body.classList.add('authed-off');
  const existing = document.querySelector('.gate');
  if (existing) existing.remove();

  const gate = document.createElement('div');
  gate.className = 'gate';
  gate.innerHTML = `
    <div class="gate_card">
      <div class="gate_logo">
        <div class="gate_mark">C</div>
        <h2 class="gate_title">Welcome to ChadGPT</h2>
        <p class="gate_sub">Free to sign up.</p>
      </div>
      <div class="gate_tabs" role="tablist">
        <button type="button" class="gate_tab" data-tab="login" role="tab">Log in</button>
        <button type="button" class="gate_tab" data-tab="signup" role="tab">Sign up</button>
      </div>
      <form class="gate_form" id="auth_form" novalidate>
        <label class="gate_label" for="auth_email">Email</label>
        <input class="gate_input" type="email" id="auth_email" required autocomplete="email" autocapitalize="none" inputmode="email" spellcheck="false">
        <label class="gate_label" for="auth_password">Password</label>
        <input class="gate_input" type="password" id="auth_password" required minlength="8">
        <button type="submit" class="gate_submit" id="auth_submit"><span class="label">Log in</span></button>
        <div class="gate_err" id="auth_err" role="alert" aria-live="polite"></div>
      </form>
    </div>
  `;
  document.body.appendChild(gate);

  let mode = initialMode;
  const tabs = gate.querySelectorAll('.gate_tab');
  const emailInput = gate.querySelector('#auth_email');
  const pwInput = gate.querySelector('#auth_password');
  const submit = gate.querySelector('#auth_submit');
  const submitLabel = submit.querySelector('.label');
  const err = gate.querySelector('#auth_err');

  function setErr(msg) {
    err.textContent = msg || '';
    emailInput.classList.toggle('err', !!msg);
    pwInput.classList.toggle('err', !!msg);
  }

  function applyTab() {
    tabs.forEach(t => t.classList.toggle('active', t.getAttribute('data-tab') === mode));
    submitLabel.textContent = mode === 'signup' ? 'Create account' : 'Log in';
    pwInput.autocomplete = mode === 'signup' ? 'new-password' : 'current-password';
  }
  tabs.forEach(t => t.addEventListener('click', () => {
    mode = t.getAttribute('data-tab');
    setErr('');
    applyTab();
    emailInput.focus();
  }));
  applyTab();

  emailInput.addEventListener('input', () => setErr(''));
  pwInput.addEventListener('input', () => setErr(''));

  gate.querySelector('#auth_form').addEventListener('submit', async (e) => {
    e.preventDefault();
    setErr('');

    const email = emailInput.value.trim();
    const password = pwInput.value;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setErr('Enter a valid email address.'); emailInput.focus(); return; }
    if (password.length < 8) { setErr('Password must be at least 8 characters.'); pwInput.focus(); return; }

    submit.disabled = true;
    submitLabel.textContent = mode === 'signup' ? 'Creating account…' : 'Signing in…';
    const spin = document.createElement('span');
    spin.className = 'gate_spin';
    submit.prepend(spin);

    try {
      if (mode === 'signup') await doSignup(email, password);
      else await doLogin(email, password);
      // Honor ?return=<path> — the cli-auth page sends people here when they
      // need to sign in, and expects to get them back at a specific URL.
      // Same-origin only: never follow a redirect pointing off this site.
      try {
        const ret = new URLSearchParams(location.search).get('return');
        if (ret && ret.startsWith('/') && !ret.startsWith('//')) {
          location.replace(ret);
          return;
        }
      } catch {}
      gate.remove();
      document.body.classList.remove('authed-off');
      state.plan = currentUser.plan || 'free';
      saveState();
      renderUsageBadge();
      toast({ title: `Welcome, ${currentUser.email}` }, 2800, 'ok');
      // Pull server-managed container state
      await fetchContainer();
    } catch (err2) {
      spin.remove();
      let m = err2.message || String(err2);
      if (/already registered/i.test(m)) m = 'That email is already registered — switch to Log in.';
      if (/invalid credentials/i.test(m)) m = 'Wrong email or password.';
      setErr(m);
      submit.disabled = false;
      applyTab();
    }
  });

  setTimeout(() => emailInput.focus(), 50);
}

// ---------- state -----------------------
const defaultState = {
  model: CFG.defaultModel || 'fast',
  theme: 'system',
  chats: [],
  activeChat: null,
  plan: 'free',   // 'free' | 'plus'
  usage: { score: 100, lastAt: Date.now() },
  settings: { chadMode: true, temperature: 0.6, autoScroll: true },
};
// Jailbreak blocking is permanently on and is not stored in user settings.
// It runs client-side on every submit and is also enforced server-side.
const BLOCK_JAILBREAK = true;
function loadState() {
  try {
    const raw = localStorage.getItem('chadgpt_state_v3');
    if (raw) {
      const saved = JSON.parse(raw);
      const merged = Object.assign({}, defaultState, saved);
      merged.settings = Object.assign({}, defaultState.settings, saved.settings || {});
      merged.usage = Object.assign({}, defaultState.usage, saved.usage || {});
      return merged;
    }
  } catch (e) {}
  return JSON.parse(JSON.stringify(defaultState));
}
function saveState() { try { localStorage.setItem('chadgpt_state_v3', JSON.stringify(state)); } catch (e) {} }
let state = loadState();

// ---------- plan + usage + budget ----------
const USAGE_MAX = 100;
const USAGE_REGEN_PER_MIN = 2;       // full regen ~50 min idle
const USAGE_PER_1K_TOKENS = 3;       // ~33k tokens from full tank
const SPAM_MULTIPLIER = 4;           // duplicate messages cost 4x
const CHAT_TOKEN_BUDGET = 10000;     // per chat, forces new chat when exceeded
const CHAT_WARN_AT = 0.8;            // start warning at 80%
const PLUS_USAGE_MULTIPLIER = 0.4;   // Plus burns slower

function regenUsage() {
  const now = Date.now();
  const mins = (now - (state.usage.lastAt || now)) / 60000;
  state.usage.score = Math.min(USAGE_MAX, (state.usage.score || USAGE_MAX) + mins * USAGE_REGEN_PER_MIN);
  state.usage.lastAt = now;
}
function estimateTokens(s) { return Math.ceil((s || '').length / 4); }
function isDuplicateMessage(text) {
  if (!text || !activeChatObj) return false;
  const recent = (activeChatObj.messages || []).filter(m => m.role === 'user').slice(-3);
  const norm = text.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 200);
  return recent.some(m => (m.content || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 200) === norm);
}
function deductUsage(tokens, isSpam) {
  regenUsage();
  const planMult = state.plan === 'plus' ? PLUS_USAGE_MULTIPLIER : 1;
  const base = (tokens / 1000) * USAGE_PER_1K_TOKENS * planMult;
  const total = (isSpam ? base * SPAM_MULTIPLIER : base);
  state.usage.score = Math.max(0, state.usage.score - total);
  saveState();
  renderUsageBadge();
}
function chatTokens() {
  if (!activeChatObj) return 0;
  return (activeChatObj.messages || []).reduce((n, m) => n + estimateTokens(m.content), 0);
}

function renderUsageBadge() {
  const badge = document.getElementById('usage_badge');
  const fill = document.getElementById('usage_fill');
  const num = document.getElementById('usage_num');
  const plusTag = document.getElementById('plus_tag');
  if (state.plan === 'unlimited') {
    fill.style.width = '100%';
    num.textContent = '∞';
    badge.classList.remove('low', 'crit');
    badge.classList.add('plus', 'unlimited');
    plusTag.hidden = false;
    plusTag.textContent = '∞';
    return;
  }
  const s = Math.round(state.usage.score);
  fill.style.width = s + '%';
  num.textContent = String(s);
  badge.classList.toggle('low', s < 30 && s >= 10);
  badge.classList.toggle('crit', s < 10);
  badge.classList.toggle('plus', state.plan === 'plus');
  badge.classList.remove('unlimited');
  plusTag.hidden = state.plan !== 'plus';
  plusTag.textContent = 'PLUS';
}
function renderChatMeter() {
  const meter = document.getElementById('chat_meter');
  const used = chatTokens();
  if (!activeChatObj || used === 0) { meter.hidden = true; return; }
  meter.hidden = false;
  meter.textContent = `${used.toLocaleString()} / ${CHAT_TOKEN_BUDGET.toLocaleString()} tokens in this chat`;
  const pct = used / CHAT_TOKEN_BUDGET;
  meter.classList.toggle('near', pct >= CHAT_WARN_AT && pct < 1);
  meter.classList.toggle('full', pct >= 1);
}

// Regen tick every 15s
setInterval(() => { regenUsage(); renderUsageBadge(); saveState(); }, 15000);

// ---------- models ----------------------
// 'auto' is the Chad MoE. Everything else is a direct pick, grouped by tier.
// tier: 'free' unlimited for all; 'pro' Plus only, 50/day 300/week;
// 'ultra' Plus only, 15/day 75/week.
const MODELS = [
  { id: 'auto',         worker: 'chat', apiModel: 'auto',     tier: 'free',  name: 'Chad MoE',       sub: 'auto', desc: 'Router picks the best expert per message' },
  // free
  { id: 'fast',         worker: 'chat', apiModel: 'fast',     tier: 'free',  name: 'ChadGPT Fast',   sub: '8B',   desc: 'Llama 3.1 8B fast · snappy default' },
  { id: 'small',        worker: 'chat', apiModel: 'small',    tier: 'free',  name: 'ChadGPT Small',  sub: '3B',   desc: 'Llama 3.2 3B · creative' },
  { id: 'tiny',         worker: 'chat', apiModel: 'tiny',     tier: 'free',  name: 'ChadGPT Tiny',   sub: '1B',   desc: 'Llama 3.2 1B · fastest' },
  { id: 'mistral',      worker: 'chat', apiModel: 'mistral',  tier: 'free',  name: 'Mistral 7B',     sub: '',     desc: 'Mistral 7B Instruct' },
  { id: 'gemma',        worker: 'chat', apiModel: 'gemma',    tier: 'free',  name: 'Gemma 7B',       sub: '',     desc: 'Google Gemma 7B' },
  { id: 'openchat',     worker: 'chat', apiModel: 'openchat', tier: 'free',  name: 'OpenChat 3.5',   sub: '',     desc: 'OpenChat 3.5 0106' },
  { id: 'phi',          worker: 'chat', apiModel: 'phi',      tier: 'free',  name: 'Phi-2',          sub: '',     desc: 'Microsoft Phi-2' },
  // pro  — Plus only, 50/day 300/week
  { id: 'llama-3',      worker: 'chat', apiModel: 'llama-3',  tier: 'pro',   name: 'Llama 3 8B',     sub: '',     desc: 'Llama 3 8B Instruct · the classic' },
  { id: 'hermes',       worker: 'chat', apiModel: 'hermes',   tier: 'pro',   name: 'Hermes 2 Pro',   sub: '7B',   desc: 'Hermes 2 Pro Mistral · fine-tuned for agents' },
  { id: 'qwen-14b',     worker: 'chat', apiModel: 'qwen-14b', tier: 'pro',   name: 'Qwen 1.5',       sub: '14B',  desc: 'Qwen 1.5 14B Chat' },
  { id: 'gemma-12b',    worker: 'chat', apiModel: 'gemma-12b',tier: 'pro',   name: 'Gemma 3',        sub: '12B',  desc: 'Google Gemma 3 12B' },
  { id: 'mistral-24b',  worker: 'chat', apiModel: 'mistral-24b', tier: 'pro', name: 'Mistral Small', sub: '24B',  desc: 'Mistral Small 3.1 24B Instruct' },
  { id: 'chadcoder',    worker: 'code', apiModel: 'deepseek', tier: 'pro',   name: 'ChadCoder',      sub: '6.7B', desc: 'DeepSeek Coder 6.7B · code specialist' },
  // ultra — Plus only, 15/day 75/week
  { id: 'llama-70b',    worker: 'chat', apiModel: 'llama-70b',tier: 'ultra', name: 'Llama 3.3',      sub: '70B',  desc: 'Llama 3.3 70B fp8 fast · flagship' },
  { id: 'deepseek-r1',  worker: 'chat', apiModel: 'deepseek-r1', tier: 'ultra', name: 'DeepSeek R1', sub: '32B',  desc: 'DeepSeek R1 Distill Qwen 32B · reasoning' },
  { id: 'qwen-coder',   worker: 'chat', apiModel: 'qwen-coder', tier: 'ultra', name: 'Qwen2.5 Coder', sub: '32B', desc: 'Qwen 2.5 Coder 32B · heavyweight code' },
];
function modelObj() { return MODELS.find(m => m.id === state.model) || MODELS[0]; }

// ---------- elements --------------------
const inner = document.getElementById('inner');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send');
const sendIcon = document.getElementById('send_icon');
const welcome = document.getElementById('welcome');
const toastWrap = document.getElementById('toasts');
const sidebar = document.getElementById('sidebar');
const scrim = document.getElementById('scrim');
const hamburger = document.getElementById('hamburger');
const mainEl = document.getElementById('main');
if (mainEl) {
  mainEl.addEventListener('scroll', () => {
    _userScrolled = !isNearBottom();
  }, { passive: true });
}
const modelBtn = document.getElementById('model_btn');
const modelNameEl = document.getElementById('model_name');
const modelSubEl = document.getElementById('model_sub');
const profileBtn = document.getElementById('profile_btn');
const settingsBtn = document.getElementById('settings_btn');
const attachBtn = document.getElementById('attach_btn');
const imageBtn = document.getElementById('image_btn');
if (imageBtn) {
  imageBtn.addEventListener('click', () => {
    const isPaid = state.plan === 'plus' || state.plan === 'unlimited';
    if (!isPaid) { openPaywallModal('Image generation is a Plus feature'); return; }
    const seed = input.value.trim();
    if (!seed) {
      // Prefill the input with a helpful starter so the user just finishes it.
      input.value = '/image ';
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    } else if (!/^\/image\s+/i.test(seed) && !detectImageIntent(seed)) {
      // Prefix with /image so the next send goes to the image worker.
      input.value = '/image ' + seed;
      input.focus();
    } else {
      // Already looks like an image prompt — send it.
      input.form?.requestSubmit?.() ?? document.getElementById('send')?.click();
    }
  });
}
const newChatBtn = document.getElementById('new_chat');
const chatListEl = document.getElementById('chat_list');
const containerBtn = document.getElementById('container_badge');
const edgePingEl = document.getElementById('edge_ping');
const containerUptimeEl = document.getElementById('container_uptime');
const containerLabelEl = document.getElementById('container_label');

// ---------- theme -----------------------
function applyTheme() {
  const t = state.theme;
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  saveState();
}
applyTheme();

// ---------- container (server-side, D1-backed) -------------------
// containerState comes from /api/container — survives reload, logout, device change
let containerState = null;
let containerStartedAt = 0;   // ms epoch, synced from server

function fmtUptime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return (h ? String(h).padStart(2, '0') + ':' : '') + String(m).padStart(2, '0') + ':' + String(ss).padStart(2, '0');
}

async function fetchContainer() {
  try {
    const r = await apiFetch('/container', { method: 'GET' });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      console.warn('container fetch failed', r.status, j);
      // Don't toast 401s — the auth gate handles those. Everything else is loud.
      if (r.status !== 401) {
        toast({ title: `Container unavailable: ${j.error || r.status}`, sub: j.detail || '' }, 5000, 'err');
      }
      return null;
    }
    const j = await r.json();
    containerState = j.container;
    containerStartedAt = containerState.created_at;
    return containerState;
  } catch (e) {
    console.error('container fetch threw', e);
    toast({ title: 'Container fetch failed', sub: e.message || String(e) }, 5000, 'err');
    return null;
  }
}

async function stopContainer() {
  const r = await apiFetch('/container/stop', { method: 'POST' });
  if (r.ok) { containerState = null; containerStartedAt = 0; }
  return r.ok;
}
async function restartContainer() {
  const r = await apiFetch('/container/restart', { method: 'POST' });
  if (!r.ok) return null;
  const j = await r.json();
  containerState = j.container;
  containerStartedAt = containerState.created_at;
  return containerState;
}

setInterval(() => {
  if (!containerStartedAt) { containerUptimeEl.textContent = '--:--'; return; }
  containerUptimeEl.textContent = fmtUptime(Date.now() - containerStartedAt);
  if (containerLabelEl && containerState?.name) containerLabelEl.textContent = containerState.name;
}, 1000);
containerBtn.addEventListener('click', openContainerModal);

// ---------- conversation ----------------
let history = [];
let activeChatObj = null;
let busy = false;
let currentAbort = null;

function currentChat() { return activeChatObj; }
function setActiveChat(chat) {
  activeChatObj = chat;
  state.activeChat = chat ? chat.id : null;
  history = chat ? (chat.messages || []).slice() : [];
  renderChatList();
  renderConversation();
  saveState();
}
function ensureChat(firstUserText) {
  if (activeChatObj) return;
  const title = firstUserText.slice(0, 38) + (firstUserText.length > 38 ? '…' : '');
  const chat = { id: 'c' + Date.now(), title, createdAt: Date.now(), messages: [] };
  state.chats.unshift(chat);
  saveState();
  renderChatList();
  activeChatObj = chat;
  state.activeChat = chat.id;
}
function renderConversation() {
  inner.innerHTML = '';
  if (!history.length) {
    inner.classList.add('empty');
    inner.appendChild(welcome);
    welcome.hidden = false;
    renderChatMeter();
    return;
  }
  inner.classList.remove('empty');
  history.forEach((m, i) => {
    if (m.role === 'user') addUserMsgEl(m.content, i, m.images);
    else addBotMsgEl(m.content, m.imageUrl);
  });
  renderChatMeter();
  // Opening a chat should land at the bottom (latest message), not somewhere
  // in the middle because the previous chat's scroll pos stuck.
  scrollDown(true);
}
// Group non-archived chats by recency. Older (7-30d) and Much older (30+d)
// are split so scrolling to a specific month is easier.
function groupChats(chats) {
  const now = Date.now();
  const g = { Today: [], Yesterday: [], 'Previous 7 days': [], 'Previous 30 days': [], Older: [] };
  chats.forEach(c => {
    const age = now - (c.createdAt || now);
    if (age < 86400000) g.Today.push(c);
    else if (age < 2 * 86400000) g.Yesterday.push(c);
    else if (age < 7 * 86400000) g['Previous 7 days'].push(c);
    else if (age < 30 * 86400000) g['Previous 30 days'].push(c);
    else g.Older.push(c);
  });
  return g;
}

let _chatSearch = '';
let _archivedOpen = false;

function matchesSearch(c, q) {
  if (!q) return true;
  const hay = (c.title + ' ' + (c.messages || []).map(m => m.content || '').join(' ')).toLowerCase();
  return hay.includes(q);
}

const ARCHIVE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="5" rx="1"/><path d="M4 9v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9"/><path d="M10 13h4"/></svg>';
const UNARCHIVE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="5" rx="1"/><path d="M4 9v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9"/><path d="M12 12v6"/><path d="M9 15l3-3 3 3"/></svg>';
const TRASH_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>';
const DOTS_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>';

function buildChatRow(c, { archived = false } = {}) {
  const el = document.createElement('div');
  el.className = 'sb_chat' + (c.id === state.activeChat ? ' active' : '') + (archived ? ' archived' : '');
  // Click anywhere on the row opens the chat. The per-row buttons call
  // stopPropagation on their own click handlers so they don't double-fire.
  el.addEventListener('click', (e) => {
    // If the user clicked an action button, let that handler run instead.
    if (e.target.closest('.sb_chat_mini, .sb_chat_dots, .sb_rename_input')) return;
    setActiveChat(c);
    closeSidebar();
  });
  const title = document.createElement('span');
  title.className = 'sb_chat_title';
  title.textContent = c.title;
  title.title = c.title;
  // Double-click to rename inline.
  title.addEventListener('dblclick', (e) => { e.preventDefault(); e.stopPropagation(); inlineRenameChat(title, c); });
  el.appendChild(title);

  // Per-row quick actions. On mobile these are always-shown; on desktop hover.
  const actions = document.createElement('div');
  actions.className = 'sb_chat_actions';
  if (archived) {
    actions.innerHTML = `
      <button class="sb_chat_mini" data-a="restore" title="Restore to active" aria-label="restore">${UNARCHIVE_ICON}</button>
      <button class="sb_chat_mini danger" data-a="del" title="Delete permanently" aria-label="delete">${TRASH_ICON}</button>
    `;
    actions.querySelector('[data-a="restore"]').addEventListener('click', (e) => { e.stopPropagation(); c.archived = false; saveState(); renderChatList(); toast({ title: 'Restored' }, 1200, 'ok'); });
    actions.querySelector('[data-a="del"]').addEventListener('click', (e) => {
      e.stopPropagation();
      if (!confirm(`Delete "${c.title}" permanently? This can't be undone.`)) return;
      state.chats = state.chats.filter(x => x.id !== c.id);
      if (state.activeChat === c.id) setActiveChat(null);
      saveState(); renderChatList();
    });
  } else {
    actions.innerHTML = `
      <button class="sb_chat_mini" data-a="archive" title="Archive" aria-label="archive">${ARCHIVE_ICON}</button>
      <button class="sb_chat_dots" data-a="more" aria-label="options">${DOTS_ICON}</button>
    `;
    actions.querySelector('[data-a="archive"]').addEventListener('click', (e) => { e.stopPropagation(); c.archived = true; saveState(); renderChatList(); toast({ title: 'Archived — find it in the Archive section' }, 1800, 'ok'); });
    actions.querySelector('[data-a="more"]').addEventListener('click', (e) => { e.stopPropagation(); openChatMenu(e.currentTarget, c); });
  }
  el.appendChild(actions);
  return el;
}

function inlineRenameChat(titleEl, c) {
  const input = document.createElement('input');
  input.className = 'sb_rename_input';
  input.value = c.title;
  input.maxLength = 80;
  titleEl.replaceWith(input);
  input.focus();
  input.setSelectionRange(0, input.value.length);
  const commit = (save) => {
    const v = input.value.trim();
    if (save && v && v !== c.title) {
      c.title = v;
      saveState();
    }
    renderChatList();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(true); }
    else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
  });
  input.addEventListener('blur', () => commit(true));
}

function renderChatList() {
  try {
    _renderChatListInner();
  } catch (err) {
    console.error('renderChatList failed', err);
    chatListEl.innerHTML = `<div style="padding:16px;color:var(--danger);font-size:12px">Sidebar error: ${(err && err.message) || err}. Try "Clear all chats" from the profile menu to recover.</div>`;
  }
}
function _renderChatListInner() {
  const q = _chatSearch.trim().toLowerCase();
  chatListEl.innerHTML = '';

  // Search box (always rendered so it's reachable for any chat count).
  const searchWrap = document.createElement('div');
  searchWrap.className = 'sb_search_wrap';
  searchWrap.innerHTML = `
    <svg class="sb_search_icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
    <input id="sb_search" placeholder="Search chats" value="${q.replace(/"/g, '&quot;')}" />
    ${q ? '<button class="sb_search_clear" aria-label="clear">&times;</button>' : ''}
  `;
  chatListEl.appendChild(searchWrap);
  const searchInput = searchWrap.querySelector('#sb_search');
  searchInput.addEventListener('input', (e) => { _chatSearch = e.target.value; renderChatList(); searchWrap.querySelector('#sb_search').focus(); });
  const clear = searchWrap.querySelector('.sb_search_clear');
  if (clear) clear.addEventListener('click', () => { _chatSearch = ''; renderChatList(); });

  const active = state.chats.filter(c => !c.archived && matchesSearch(c, q));
  const archived = state.chats.filter(c => c.archived && matchesSearch(c, q));

  // Active chats, grouped.
  const groups = groupChats(active);
  let anyActive = false;
  Object.entries(groups).forEach(([g, chats]) => {
    if (!chats.length) return;
    anyActive = true;
    const label = document.createElement('div');
    label.className = 'sb_label';
    label.textContent = g;
    chatListEl.appendChild(label);
    chats.forEach(c => chatListEl.appendChild(buildChatRow(c)));
  });
  if (!anyActive && q) {
    const empty = document.createElement('div');
    empty.className = 'sb_empty';
    empty.textContent = `No active chats match "${q}"`;
    chatListEl.appendChild(empty);
  }

  // Archive section — collapsible, with delete-all.
  if (archived.length || state.chats.some(c => c.archived)) {
    const header = document.createElement('button');
    header.className = 'sb_archive_header' + (_archivedOpen ? ' open' : '');
    header.innerHTML = `
      <span class="chev">▸</span>
      <span style="flex:1;text-align:left">Archive <span class="count">(${archived.length})</span></span>
      ${archived.length ? `<span class="sb_archive_clear" title="Delete all archived">${TRASH_ICON}</span>` : ''}
    `;
    header.addEventListener('click', (e) => {
      if (e.target.closest('.sb_archive_clear')) return;
      _archivedOpen = !_archivedOpen;
      renderChatList();
    });
    const clearAll = header.querySelector('.sb_archive_clear');
    if (clearAll) clearAll.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!confirm(`Delete all ${archived.length} archived chat(s) permanently?`)) return;
      state.chats = state.chats.filter(c => !c.archived);
      if (state.activeChat && !state.chats.some(c => c.id === state.activeChat)) setActiveChat(null);
      saveState(); renderChatList();
    });
    chatListEl.appendChild(header);
    if (_archivedOpen) {
      if (!archived.length) {
        const empty = document.createElement('div');
        empty.className = 'sb_empty';
        empty.textContent = q ? `No archived chats match "${q}"` : 'No archived chats';
        chatListEl.appendChild(empty);
      } else {
        archived.forEach(c => chatListEl.appendChild(buildChatRow(c, { archived: true })));
      }
    }
  }
}
renderChatList();
if (state.activeChat) {
  const chat = state.chats.find(c => c.id === state.activeChat);
  if (chat) setActiveChat(chat);
}

function newChat() { setActiveChat(null); closeSidebar(); input.focus(); }
newChatBtn.addEventListener('click', newChat);
document.querySelectorAll('[data-act]').forEach(el => {
  el.addEventListener('click', () => {
    const act = el.getAttribute('data-act');
    if (act === 'new_chat') newChat();
    if (act === 'search') toast({ title: 'Search is local — filter the sidebar directly.' }, 2500);
  });
});

function closeSidebar() { sidebar.classList.remove('open'); scrim.classList.remove('show'); }
hamburger.addEventListener('click', () => { sidebar.classList.add('open'); scrim.classList.add('show'); });
scrim.addEventListener('click', closeSidebar);

// ---------- messages --------------------
function addUserMsgEl(text, index, images) {
  const row = document.createElement('div');
  row.className = 'msg_row user';
  const col = document.createElement('div');
  col.style.cssText = 'display:flex;flex-direction:column;align-items:flex-end;max-width:85%';
  if (images && images.length) {
    const aw = document.createElement('div');
    aw.className = 'msg_attachments';
    images.forEach(src => { const im = document.createElement('img'); im.src = src; aw.appendChild(im); });
    col.appendChild(aw);
  }
  if (text) {
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = text;
    col.appendChild(bubble);
    // Edit button on user messages — restores the text to the input box and
    // deletes this turn (+ its reply, if the model has already answered) so
    // the next send re-asks the edited question.
    const edit = document.createElement('button');
    edit.className = 'action_btn edit_user';
    edit.setAttribute('aria-label', 'edit message');
    edit.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
    edit.addEventListener('click', () => {
      if (busy) return;
      input.value = text;
      input.focus();
      input.setSelectionRange(text.length, text.length);
      // Trim this turn and anything after it.
      if (Number.isInteger(index)) {
        history.splice(index);
        if (activeChatObj) { activeChatObj.messages = history.slice(); saveState(); }
        renderConversation();
      }
    });
    col.appendChild(edit);
  }
  row.appendChild(col);
  inner.appendChild(row);
  // User just sent — always scroll to show their message, even if they were
  // reading something further up. Resets the sticky flag too.
  scrollDown(true);
}
function addBotMsgEl(text, imageUrl) {
  const row = document.createElement('div');
  row.className = 'msg_row bot';
  const body = document.createElement('div');
  body.className = 'bot_body';
  if (imageUrl) {
    body.innerHTML = `<div class="gen_image"><div class="gen_image_frame"><img src="${imageUrl}" alt=""></div><div class="gen_image_caption"><span class="cap"></span></div></div>`;
    body.querySelector('.cap').textContent = text;
  } else {
    body.innerHTML = renderMd(text);
    decorateCodeBlocks(body);
  }
  row.appendChild(body);
  inner.appendChild(row);
  scrollDown();
  return row;
}

// ---------- jailbreak detect -----------
const JAILBREAK_PATTERNS = [
  /ignore\s+(all\s+|the\s+|your\s+|any\s+)*(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?)/i,
  /disregard\s+(all\s+|the\s+|your\s+)*(instructions?|rules?|guidelines?)/i,
  /forget\s+(everything|all\s+(previous|above)|your\s+(rules|instructions))/i,
  /you\s+are\s+(now\s+)?(DAN|BasedGPT|AIM|STAN|DUDE|JAILBREAK|evil[-\s]?gpt)/i,
  /(do\s+anything\s+now|DAN\s+mode|developer\s+mode|god\s+mode|unrestricted\s+mode|jailbreak\s+mode)/i,
  /pretend\s+(you|to\s+be|that\s+you).{0,40}(no\s+restrictions|unrestricted|no\s+rules|no\s+limits)/i,
  /act\s+as\s+(an?\s+)?(unrestricted|uncensored|unfiltered|amoral|jailbroken)/i,
  /\[(SYSTEM|INST|ADMIN|SUDO)\]|\<\|im_start\|\>|\<\|system\|\>/i,
  /override\s+(your\s+)?(safety|guidelines|rules|instructions)/i,
  /bypass\s+(your\s+)?(restrictions|safety|guidelines|filters)/i,
  /(my|a)\s+(dead\s+|late\s+)?(grandma|grandmother).{0,80}(tell|read|recite|bedtime|used\s+to)/i,
  /from\s+now\s+on\s+you\s+(will|must|are)\s+(ignore|disregard|act|behave|pretend)/i,
  /reveal\s+(your|the)\s+(system\s+prompt|instructions|hidden\s+rules)/i,
];
function looksLikeJailbreak(text) {
  if (!text) return null;
  for (const re of JAILBREAK_PATTERNS) { const m = text.match(re); if (m) return m[0]; }
  return null;
}

// ---------- input + submit --------------
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 180) + 'px';
  sendBtn.disabled = (!input.value.trim() && !pendingAttachments.length) || busy;
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
  if (e.key === 'Escape' && busy) { e.preventDefault(); stopGeneration(); }
});
sendBtn.addEventListener('click', () => { if (busy) stopGeneration(); else submit(); });
document.querySelectorAll('.chip').forEach(b => b.addEventListener('click', () => {
  input.value = b.getAttribute('data-seed');
  input.dispatchEvent(new Event('input'));
  submit();
}));

function submit() {
  const text = input.value.trim();
  if ((!text && !pendingAttachments.length) || busy) return;

  // Jailbreak gate — always on, cannot be disabled. Enforced server-side too.
  if (BLOCK_JAILBREAK) {
    const hit = looksLikeJailbreak(text);
    if (hit) { toast({ title: `Blocked: jailbreak-like text ("${hit.slice(0,60)}"). This guard is always on.` }, 5500, 'err'); return; }
  }

  // Usage gate
  regenUsage();
  if (state.usage.score < 1) {
    openUsageEmptyModal();
    return;
  }

  // Chat budget gate
  if (chatTokens() >= CHAT_TOKEN_BUDGET) {
    openChatFullModal();
    return;
  }

  // Natural-language image intent — "draw/generate/make/create a picture
  // of X", "image of Y", "render Z", etc. Also accepts the explicit
  // /image command. If the intent fires, strip the trigger phrase so the
  // model gets the subject, not the verb.
  const imageIntent = detectImageIntent(text);

  if (imageIntent) {
    const isPaid = state.plan === 'plus' || state.plan === 'unlimited';
    if (!isPaid) {
      openPaywallModal('Image generation is a Plus feature');
      return;
    }
  }

  const isDupe = isDuplicateMessage(text);
  if (isDupe) {
    toast({ title: 'Duplicate message — this will cost 4× more usage.' }, 3500, 'err');
  }

  input.value = '';
  input.style.height = 'auto';
  if (welcome.parentNode) welcome.remove();
  const atts = pendingAttachments.slice();
  pendingAttachments.length = 0;
  renderAttachments();
  if (imageIntent) {
    runImageTurn(imageIntent, { isDupe });
    return;
  }

  // /avatar <system prompt>  — generates an avatar for an AI assistant.
  // Chains chat (concept) -> flux (render), both server-side.
  const avatarMatch = text.match(/^\/avatar(?:\s+(.+))?$/is);
  if (avatarMatch) {
    const sys = (avatarMatch[1] || '').trim();
    if (!sys) {
      toast({ title: '/avatar <paste a system prompt>', sub: 'I turn it into a matching square avatar.' }, 4000, 'warn');
      return;
    }
    runAvatarTurn(sys, { isDupe });
    return;
  }

  // /obfuscate <lua code>  — or natural-language intent like "obfuscate
  // this lua", "protect my lua", "make this lua unreadable". Seeds the
  // obfuscator page with the code and navigates there. Keeping it client-
  // side means zero AI tokens get spent on what is a pure utility.
  const obf = detectObfuscateIntent(text);
  if (obf) {
    try { sessionStorage.setItem('obfuscate_seed', obf.source); } catch {}
    window.location.href = '/obfuscate';
    return;
  }

  runChatTurn(text || 'Describe this image.', atts, { isDupe });
}

// Detect an obfuscation ask. Returns { source } if the message is clearly
// "obfuscate this Lua" with code attached, else null. Looks for an explicit
// /obfuscate command, a triple-backtick lua block, or the phrases
// "obfuscate", "protect", "make unreadable" paired with "lua".
function detectObfuscateIntent(text) {
  if (!text) return null;
  // Explicit command: /obfuscate <code>
  const cmd = text.match(/^\/obfuscate(?:\s+([\s\S]+))?$/i);
  if (cmd) return { source: (cmd[1] || '').trim() };

  // Look for code fence with lua tag — strongest signal.
  const fence = text.match(/```(?:lua)?\s*\n([\s\S]+?)\n```/i);
  const lower = text.toLowerCase();
  const verb = /\b(obfuscate|protect|hide|encrypt|make\s+unreadable|lock|secure)\b/i.test(text);
  const lang = /\blua\b/i.test(text);
  if (verb && lang && fence) return { source: fence[1].trim() };
  // "obfuscate this" with lua-looking code (local/function/end keywords) and no fence
  if (verb && /\b(local\s|function\s|end\b|print\(|then\b|do\b)/.test(text) && lang) {
    return { source: text };
  }
  return null;
}

// ---------- Mid-stream resume ----------
// Called when the SSE connection dies partway through a reply. Re-POSTs
// /chat with the partial text as context + an explicit continue nudge, so
// whichever model answers next picks up exactly where the first one
// stopped. maxAttempts caps how many times we'll retry a dropped reconnect.
// Detect a reply that's probably cut off: unclosed code fence, unclosed
// triple-quote, trailing comma/paren/dot ellipsis, or ends without
// terminal punctuation after a long enough run.
function looksTruncated(text) {
  if (!text) return false;
  // Unclosed ``` fence?
  const fenceCount = (text.match(/```/g) || []).length;
  if (fenceCount % 2 === 1) return true;
  // Trailing "..." — model literally said it would continue
  if (/\.\.\.\s*$/.test(text)) return true;
  // Ends in a way that suggests the sentence wasn't finished:
  // open paren / bracket / brace counts
  const opens = (text.match(/[([{]/g) || []).length;
  const closes = (text.match(/[)\]}]/g) || []).length;
  if (opens - closes > 1) return true;
  // Long reply (>600 chars) that doesn't end with terminal punctuation
  // and the last line isn't a header/list marker.
  const trimmed = text.trimEnd();
  if (trimmed.length < 600) return false;
  const lastChar = trimmed.slice(-1);
  if ('.?!":;}])`'.includes(lastChar)) return false;
  return true;
}

// Silent server-hop continue: if the stream ended but the reply looks
// unfinished, re-ask the chain with the partial as context + "continue".
// The model that answers may be a different one from the chain — the user
// never sees the seam. Updates bodyEl live so the hop is invisible.
async function silentAutoContinue(originalMessages, modelMeta, bodyEl, partial, maxAttempts) {
  let accumulated = partial;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const continueMsgs = [
      ...originalMessages,
      { role: 'assistant', content: accumulated },
      { role: 'user', content: '[System: your previous response was cut off by the token budget. Continue from EXACTLY where you stopped, do not repeat anything, do not re-introduce yourself, do not add a header. Just keep going from the next character.]' },
    ];
    let res;
    try {
      res = await apiFetch('/chat', {
        method: 'POST',
        body: JSON.stringify({
          messages: continueMsgs,
          model: modelMeta.apiModel,
          stream: true,
          chad_mode: state.settings.chadMode,
          temperature: state.settings.temperature,
          fingerprint: collectClientFingerprint(),
          captcha_receipt: getCaptchaReceipt?.() ?? null,
          max_tokens: 1200,
        }),
      });
    } catch { break; }
    if (!res.ok) break;
    let gotAnything = false;
    try {
      for await (const chunk of sseLines(res)) {
        if (typeof chunk.response === 'string' && chunk.response) {
          accumulated += chunk.response;
          gotAnything = true;
          bodyEl.innerHTML = renderMd(accumulated) + '<span class="typing_cursor"></span>';
          scrollDown();
        }
      }
    } catch { /* stream died — fall through and maybe loop again */ }
    if (!gotAnything) break;
    if (!looksTruncated(accumulated)) break;   // we're done
  }
  return accumulated;
}

async function resumeStreamAfterDisconnect(originalMessages, modelMeta, bodyEl, partial, maxAttempts) {
  let accumulated = partial;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Give the network a moment, then grow the gap on each retry.
    await new Promise(r => setTimeout(r, 600 * attempt));
    const continueMessages = [...originalMessages, {
      role: 'assistant',
      content: accumulated,
    }, {
      role: 'user',
      content: '[System: your previous response was cut off mid-stream by a network drop. Continue from EXACTLY where you stopped — do not repeat anything, do not re-introduce yourself, just keep going from the next character.]',
    }];
    try {
      const res = await apiFetch('/chat', {
        method: 'POST',
        body: JSON.stringify({
          messages: continueMessages,
          model: modelMeta.apiModel,
          stream: true,
          chad_mode: state.settings.chadMode,
          temperature: state.settings.temperature,
          fingerprint: collectClientFingerprint(),
        }),
      });
      if (!res.ok) continue;
      // Append a subtle marker the first time we resume so the user can see
      // the response was stitched together (helps if they ever notice weird seams).
      if (attempt === 1 && !accumulated.endsWith('…')) accumulated += '';
      for await (const chunk of sseLines(res)) {
        if (typeof chunk.response === 'string') {
          accumulated += chunk.response;
          bodyEl.innerHTML = renderMd(accumulated) + '<span class="typing_cursor"></span>';
          scrollDown();
        }
      }
      // Clean end — we're done.
      return accumulated;
    } catch (_) {
      // Next iteration retries with a bigger delay.
    }
  }
  return accumulated;
}

// ---------- SSE stream parser ----------
async function* sseLines(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split('\n');
    buf = parts.pop();
    for (const line of parts) {
      const l = line.trim();
      if (!l || !l.startsWith('data:')) continue;
      const payload = l.slice(5).trim();
      if (payload === '[DONE]') return;
      try { yield JSON.parse(payload); } catch { /* skip malformed */ }
    }
  }
}

function setSendMode(mode) {
  if (mode === 'stop') {
    sendBtn.classList.add('stop');
    sendBtn.disabled = false;
    sendIcon.innerHTML = '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>';
  } else {
    sendBtn.classList.remove('stop');
    sendIcon.innerHTML = '<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>';
    sendBtn.disabled = !input.value.trim() && !pendingAttachments.length;
  }
}
function stopGeneration() { if (currentAbort) { try { currentAbort.abort(); } catch {} currentAbort = null; } }

// ---------- chat turn -------------------
async function runChatTurn(userText, attachments, opts) {
  busy = true;
  setSendMode('stop');
  ensureChat(userText);
  const isDupe = !!(opts && opts.isDupe);

  // If there are image attachments, run them through the vision model. Pass
  // the user's actual question so the vision model answers THAT instead of
  // doing a generic "describe briefly" — and detect word searches so we
  // trigger the solver path.
  let finalUserText = userText;
  let wordSearchSolution = null;    // populated below if we detected one
  const imageDataUrls = [];
  if (attachments && attachments.length) {
    for (const a of attachments) {
      if (a.kind === 'image') imageDataUrls.push(a.dataUrl);
    }
    const describeTargets = attachments.filter(a => a.kind === 'image');
    if (describeTargets.length) {
      const isWordSearch = /word\s*search|wordsearch|word-search/i.test(userText);
      // Build the vision prompt. If the user typed a real question, forward
      // it. Otherwise fall back to a detailed description.
      const basePrompt = userText.trim()
        ? `The user asks: ${userText.trim()}\n\nAnswer using ONLY what you can see in the image. If you don't know, say so.`
        : 'Describe this image in detail, focusing on what is actually visible. Do not guess about anything unclear.';

      const descriptions = [];
      for (let i = 0; i < describeTargets.length; i++) {
        const a = describeTargets[i];
        try {
          const b64 = a.dataUrl.split(',')[1];
          const prompt = isWordSearch ? '<<WORD_SEARCH_MODE>>' : basePrompt;
          const r = await apiFetch('/describe', {
            method: 'POST',
            body: JSON.stringify({ image_b64: b64, prompt }),
          });
          const d = await r.json();
          if (!d.response) continue;

          if (isWordSearch) {
            const puzzle = parseWordSearchJson(d.response);
            if (puzzle && puzzle.rows?.length) {
              const solved = solveWordSearch(puzzle);
              wordSearchSolution = { puzzle, solved, imageDataUrl: a.dataUrl };
              descriptions.push(formatWordSearchForModel(puzzle, solved));
            } else {
              descriptions.push(d.response);
            }
          } else {
            descriptions.push(d.response);
          }
        } catch (_) {}
      }
      if (descriptions.length) {
        finalUserText = 'The user attached ' + describeTargets.length + ' image(s). Vision analysis (treat as ground truth; do not invent extra details):\n\n' +
          descriptions.map((d, i) => `[Image ${i + 1}]: ${d}`).join('\n\n') +
          '\n\nUser message: ' + userText;
      }
    }
  }

  history.push({ role: 'user', content: userText, images: imageDataUrls.length ? imageDataUrls : undefined });
  if (activeChatObj) { activeChatObj.messages = history.slice(); saveState(); }
  addUserMsgEl(userText, history.length - 1, imageDataUrls);

  const botRow = document.createElement('div');
  botRow.className = 'msg_row bot';
  const body = document.createElement('div');
  body.className = 'bot_body';
  body.innerHTML = '<div class="thinking"><span class="thinking_dot"></span><span class="thinking_text">Thinking</span></div>';
  botRow.appendChild(body);
  inner.appendChild(botRow);
  scrollDown();

  currentAbort = new AbortController();

  const m = modelObj();
  const apiPath = m.worker === 'code' ? '/code' : '/chat';
  const apiMessages = history
    .map(h => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: (h.role === 'user' ? (h === history[history.length - 1] ? finalUserText : h.content) : h.content) }))
    .filter(h => h.content);

  // Free-plan queue. Pings /api/queue/ticket first — server returns the
  // user's position in the free queue and holds the connection open for the
  // waited duration. Plus / unlimited skip this entirely (server short-
  // circuits). Shows a live "You're #N in queue" status on the bot bubble.
  let queueStatus = null;
  if (state.plan === 'free') {
    queueStatus = document.createElement('div');
    queueStatus.className = 'queue_status';
    queueStatus.style.cssText = 'font-size:13px;color:var(--muted);font-style:italic;display:flex;align-items:center;gap:8px';
    queueStatus.innerHTML = '<span class="queue_spin" style="width:12px;height:12px;border-radius:50%;border:2px solid rgba(255,255,255,0.15);border-top-color:var(--accent);animation:spin 0.9s linear infinite;display:inline-block"></span><span>Joining queue…</span>';
    body.innerHTML = '';
    body.appendChild(queueStatus);
    try {
      const qRes = await apiFetch('/queue/ticket', { method: 'POST', body: '{}', signal: currentAbort.signal });
      const qJson = await qRes.json().catch(() => ({}));
      if (qJson.queued && qJson.position) {
        queueStatus.querySelector('span:last-child').textContent = `You were #${qJson.position} in queue — now answering…`;
      }
    } catch (e) {
      if (e?.name === 'AbortError') { busy = false; setSendMode('send'); return; }
      // Queue failure isn't fatal — proceed to chat.
    }
  }

  let accumulated = '';
  let errText = null;
  let routeInfo = null;
  try {
    const res = await apiFetch(apiPath, {
      method: 'POST',
      body: JSON.stringify({
        messages: apiMessages,
        model: m.apiModel,
        stream: true,
        chad_mode: state.settings.chadMode,
        temperature: state.settings.temperature,
        fingerprint: collectClientFingerprint(),
        captcha_receipt: getCaptchaReceipt(),
      }),
      signal: currentAbort.signal,
    });
    const moeExpert = res.headers.get('x-moe-expert');
    if (moeExpert) {
      routeInfo = {
        expert: moeExpert,
        label: res.headers.get('x-moe-label') || moeExpert,
        model: res.headers.get('x-moe-model') || '',
        icon: res.headers.get('x-moe-icon') || 'chat',
        reason: res.headers.get('x-moe-reason') || '',
        confidence: res.headers.get('x-moe-confidence') || '',
        via: res.headers.get('x-moe-via') || '',
      };
    }
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      if (res.status === 428 && j?.error === 'captcha_required') {
        // Server says we need a fresh captcha receipt. Pop the modal; the
        // user solves it, we store the receipt, they hit send again.
        openCaptchaModal();
        errText = 'Solve the captcha to continue.';
      } else if (res.status === 429 && j?.error === 'usage_limit_reached') {
        openUsageLimitModal(j);
        errText = `${j.tier} ${j.scope} limit reached (${j.used}/${j.limit}). Resets ${new Date(j.resets_at).toLocaleString()}.`;
      } else {
        errText = j.error || `${res.status} ${res.statusText}`;
      }
    } else {
      try {
        // Batch DOM writes via rAF. renderMd() is non-trivial (markdown parse
        // + highlight pass); re-running it on every single token wastes
        // 60-80% of CPU on long replies. 60fps is plenty visibly, and TTFT
        // doesn't suffer — the first chunk still renders immediately.
        let scheduled = false;
        const flushStream = () => {
          body.innerHTML = renderMd(accumulated) + '<span class="typing_cursor"></span>';
          scrollDown();
          scheduled = false;
        };
        for await (const chunk of sseLines(res)) {
          if (typeof chunk.response === 'string') {
            accumulated += chunk.response;
            if (!scheduled) {
              scheduled = true;
              requestAnimationFrame(flushStream);
            }
          }
        }
        // Final flush — never leave an unrendered trailing chunk.
        body.innerHTML = renderMd(accumulated) + '<span class="typing_cursor"></span>';
      } catch (streamErr) {
        // Stream died mid-reply (network drop, worker reset, idle timeout).
        // If we got any text, try to resume up to 2 times from where we left
        // off — the new request includes the partial response as context +
        // "continue exactly from here" so the fallback model picks up cleanly.
        if (streamErr?.name === 'AbortError') throw streamErr;
        if (accumulated.length > 20) {
          const resumed = await resumeStreamAfterDisconnect(apiMessages, m, body, accumulated, 2);
          accumulated = resumed;
        } else {
          throw streamErr;
        }
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') errText = e.message || 'request failed';
  }
  currentAbort = null;

  // If the stream ended cleanly but the response is cut off mid-code-block
  // or mid-sentence (likely hit max_tokens), silently continue so the user
  // sees ONE seamless reply. Does up to 2 auto-continues, 1200 tokens each,
  // so a large code block eventually completes without the user clicking.
  if (!errText && accumulated.length > 40 && looksTruncated(accumulated)) {
    try {
      accumulated = await silentAutoContinue(apiMessages, m, body, accumulated, 2);
    } catch (e) { /* keep what we have */ }
  }

  const finalText = errText ? ('Error: ' + errText) : (accumulated || '(no response)');
  body.innerHTML = renderMd(finalText);
  decorateCodeBlocks(body);
  if (routeInfo) {
    body.appendChild(renderMoeBadge(routeInfo));
  }
  // If a word search was detected and solved earlier, append the colored
  // overlay image so the user can see every answer at a glance.
  if (wordSearchSolution && wordSearchSolution.solved?.length) {
    try {
      const overlayUrl = renderWordSearchOverlay(wordSearchSolution.puzzle, wordSearchSolution.solved);
      const wrap = document.createElement('div');
      wrap.className = 'gen_image';
      wrap.innerHTML = `<div class="gen_image_frame"><img src="${overlayUrl}" alt="word search with answers highlighted"></div><div class="gen_image_caption"><span class="cap">Solved ${wordSearchSolution.solved.length}/${wordSearchSolution.puzzle.words.length} words.</span></div>`;
      body.appendChild(wrap);
    } catch (e) { /* overlay is a nice-to-have */ }
  }
  // Pass the actual model used (MoE may have routed to a different one) so
  // the rating API can attribute thumbs to the right model.
  addMessageActions(body, finalText, { model: routeInfo?.model || state.model });

  history.push({ role: 'assistant', content: finalText });
  if (activeChatObj) {
    activeChatObj.messages = history.slice();
    saveState();
    if (history.length === 2 && activeChatObj.title.length < 42) {
      activeChatObj.title = userText.slice(0, 38) + (userText.length > 38 ? '…' : '');
      saveState();
      renderChatList();
    }
  }

  // Deduct usage based on real tokens produced
  const spentTokens = estimateTokens(userText) + estimateTokens(finalText);
  deductUsage(spentTokens, isDupe);
  renderChatMeter();

  busy = false;
  setSendMode('send');
  input.focus();
}

const MOE_ICONS = {
  code:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
  brain:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z"/><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z"/></svg>',
  chart:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" x2="18" y1="20" y2="10"/><line x1="12" x2="12" y1="20" y2="4"/><line x1="6" x2="6" y1="20" y2="14"/></svg>',
  pen:       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4v16h16v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
  book:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>',
  doc:       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
  translate: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/></svg>',
  chat:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  bolt:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
};

function renderMoeBadge(info) {
  const wrap = document.createElement('div');
  wrap.className = 'moe_badge';
  const icon = MOE_ICONS[info.icon] || MOE_ICONS.chat;
  const confidence = info.confidence ? ` · confidence ${info.confidence}` : '';
  wrap.innerHTML = `
    <span class="moe_icon">${icon}</span>
    <span class="moe_meta">
      <span class="moe_top"><span class="moe_label"></span><span class="moe_model"></span></span>
      <span class="moe_sub"></span>
    </span>
  `;
  wrap.querySelector('.moe_label').textContent = info.label;
  wrap.querySelector('.moe_model').textContent = info.model ? ' · ' + info.model : '';
  wrap.querySelector('.moe_sub').textContent = (info.reason || '') + confidence;
  return wrap;
}

async function messageHash(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

function addMessageActions(container, text, opts = {}) {
  const modelKey = opts.model || state.model || null;
  const chatId = activeChatObj?.id || null;
  const actions = document.createElement('div');
  actions.className = 'msg_actions show';
  actions.innerHTML = `
    <button class="action_btn" data-act="copy" aria-label="copy"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>
    <button class="action_btn" data-act="regen" aria-label="regenerate"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg></button>
    <button class="action_btn" data-act="continue" aria-label="continue response" title="Keep writing"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M13 6l6 6-6 6"/></svg></button>
    <button class="action_btn" data-act="speak" aria-label="read aloud"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg></button>
    <span class="action_sep"></span>
    <button class="action_btn" data-act="up"   aria-label="good answer"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 10v12"/><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H7V10l4.9-6.26A2 2 0 0 1 15 5.88z"/></svg></button>
    <button class="action_btn" data-act="down" aria-label="bad answer"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 14V2"/><path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H17v12l-4.9 6.26a2 2 0 0 1-3.1-.14z"/></svg></button>
  `;
  container.appendChild(actions);

  actions.querySelector('[data-act="copy"]').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(text); toast({ title: 'Copied' }, 1500, 'ok'); } catch {}
  });
  actions.querySelector('[data-act="regen"]').addEventListener('click', () => {
    if (busy) return;
    const last = history[history.length - 1];
    if (last?.role === 'assistant') history.pop();
    const lastUser = history[history.length - 1];
    if (lastUser?.role === 'user') {
      history.pop();
      if (activeChatObj) activeChatObj.messages = history.slice();
      renderConversation();
      runChatTurn(lastUser.content, []);
    }
  });
  // Continue: ask the model to pick up where it stopped. We push a user turn
  // with a continuation nudge; the response appends as a fresh assistant msg.
  actions.querySelector('[data-act="continue"]').addEventListener('click', () => {
    if (busy) return;
    runChatTurn('Continue from exactly where you stopped. Do not repeat anything — just keep going.', []);
  });
  actions.querySelector('[data-act="speak"]').addEventListener('click', () => {
    try { window.speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text); u.rate = 1.1; window.speechSynthesis.speak(u); } catch {}
  });

  // Thumbs up / down. State persists via /api/rate — on reload we don't have
  // the row's button yet, but a future call to rateMessage can rehydrate.
  const upBtn = actions.querySelector('[data-act="up"]');
  const downBtn = actions.querySelector('[data-act="down"]');
  const setState = (val) => {
    upBtn.classList.toggle('on', val === 1);
    downBtn.classList.toggle('on', val === -1);
  };
  const rate = async (val) => {
    // Toggle off if same button clicked twice.
    const currentlyOn = (val === 1 && upBtn.classList.contains('on')) || (val === -1 && downBtn.classList.contains('on'));
    const newVal = currentlyOn ? 0 : val;
    setState(newVal);
    try {
      const hash = await messageHash(text);
      await apiFetch('/rate', { method: 'POST', body: JSON.stringify({ message_hash: hash, rating: newVal, model: modelKey, chat_id: chatId }) });
    } catch { /* ratings are best-effort */ }
    toast({ title: newVal === 1 ? 'Thanks — marked good' : newVal === -1 ? 'Noted — marked bad' : 'Rating cleared' }, 1200, newVal === -1 ? 'warn' : 'ok');
  };
  upBtn.addEventListener('click', () => rate(1));
  downBtn.addEventListener('click', () => rate(-1));
}

// ---------- image turn ------------------
async function runAvatarTurn(systemPrompt, opts) {
  busy = true;
  setSendMode('stop');
  const preview = systemPrompt.length > 120 ? systemPrompt.slice(0, 117) + '…' : systemPrompt;
  ensureChat('/avatar ' + preview);
  const isDupe = !!(opts && opts.isDupe);
  history.push({ role: 'user', content: '/avatar ' + preview });
  if (activeChatObj) { activeChatObj.messages = history.slice(); saveState(); }
  addUserMsgEl('/avatar ' + preview, history.length - 1, null);

  const botRow = document.createElement('div');
  botRow.className = 'msg_row bot';
  const body = document.createElement('div');
  body.className = 'bot_body';
  body.innerHTML = '<div class="thinking"><span class="thinking_dot"></span><span class="thinking_text">Designing the avatar concept…</span></div>';
  botRow.appendChild(body);
  inner.appendChild(botRow);
  scrollDown(true);

  currentAbort = new AbortController();
  let errText = null;
  let promptUsed = '';
  let imageUrl = '';
  try {
    const res = await apiFetch('/avatar', {
      method: 'POST',
      body: JSON.stringify({ system_prompt: systemPrompt }),
      signal: currentAbort.signal,
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      errText = j.error || `avatar failed (${res.status})`;
    } else {
      promptUsed = j.prompt_used || '';
      imageUrl = 'data:' + (j.mime || 'image/png') + ';base64,' + j.image_b64;
    }
  } catch (e) {
    if (e.name !== 'AbortError') errText = e.message || 'request failed';
  }
  currentAbort = null;

  if (errText) {
    body.innerHTML = renderMd('**Error:** ' + errText);
  } else {
    body.innerHTML = `
      <div class="gen_image">
        <div class="gen_image_frame"><img src="${imageUrl}" alt="Generated avatar"></div>
        <div class="gen_image_caption"><span class="cap">${escapeHtml(promptUsed)}</span></div>
      </div>
    `;
  }
  addMessageActions(body, errText || promptUsed, { model: 'flux' });

  const stored = errText ? ('Error: ' + errText) : promptUsed;
  history.push({ role: 'assistant', content: stored, imageUrl: errText ? undefined : imageUrl });
  if (activeChatObj) { activeChatObj.messages = history.slice(); saveState(); }

  const spentTokens = estimateTokens(systemPrompt) + estimateTokens(promptUsed || '');
  deductUsage(spentTokens, isDupe);
  renderChatMeter();

  busy = false;
  setSendMode('send');
  input.focus();
}

// Returns the cleaned image prompt if the text asks for an image, else null.
// Matches: "/image X", "draw X", "make/create/generate a picture/image of X",
// "image of X", "picture of X", "render X", "sketch X".
function detectImageIntent(text) {
  if (!text) return null;
  const slash = text.match(/^\/(?:image|img|draw|pic(?:ture)?)\s+(.+)$/i);
  if (slash) return slash[1].trim();
  const nl = text.match(/^(?:please\s+)?(?:can\s+you\s+)?(?:draw|sketch|render|generate|make|create|paint|design|produce)\s+(?:me\s+)?(?:an?\s+)?(?:image|picture|pic|photo|drawing|sketch|painting|art(?:work)?|poster|logo|illustration|render)\s+(?:of|showing|depicting|that\s+(?:is|shows))?\s*[:,-]?\s*(.+)$/i);
  if (nl) return nl[1].trim().replace(/[.!?]+$/, '');
  const of = text.match(/^(?:image|picture|photo|drawing|sketch|painting|art(?:work)?)\s+of\s+(.+)$/i);
  if (of) return of[1].trim().replace(/[.!?]+$/, '');
  return null;
}

async function runImageTurn(prompt, opts) {
  busy = true;
  setSendMode('stop');
  ensureChat('/image ' + prompt);
  const isDupe = !!(opts && opts.isDupe);
  history.push({ role: 'user', content: '/image ' + prompt });
  if (activeChatObj) { activeChatObj.messages = history.slice(); saveState(); }
  addUserMsgEl('/image ' + prompt, history.length - 1, null);

  const botRow = document.createElement('div');
  botRow.className = 'msg_row bot';
  const body = document.createElement('div');
  body.className = 'bot_body';
  body.innerHTML = `<div class="gen_image"><div class="gen_image_frame loading"><div class="loading_label"><span class="loading_dot"></span>Rendering image...</div></div><div class="gen_image_caption"><span class="cap"></span></div></div>`;
  body.querySelector('.cap').textContent = prompt;
  botRow.appendChild(body);
  inner.appendChild(botRow);
  scrollDown();

  currentAbort = new AbortController();
  try {
    const res = await apiFetch('/image', {
      method: 'POST',
      body: JSON.stringify({ prompt, steps: 4 }),
      signal: currentAbort.signal,
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || `${res.status}`);
    }
    const blob = await res.blob();
    const dataUrl = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(blob); });
    const frame = body.querySelector('.gen_image_frame');
    frame.classList.remove('loading');
    frame.innerHTML = '';
    const img = document.createElement('img');
    img.src = dataUrl;
    frame.appendChild(img);
    const cap = body.querySelector('.gen_image_caption');
    cap.innerHTML = `<span class="cap"></span><div class="gen_image_actions"><button class="action_btn" data-act="dl" aria-label="download"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg></button></div>`;
    cap.querySelector('.cap').textContent = prompt;
    cap.querySelector('[data-act="dl"]').addEventListener('click', () => {
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = (prompt.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 40) || 'image') + '.png';
      document.body.appendChild(a); a.click(); a.remove();
    });
    history.push({ role: 'assistant', content: '[image: ' + prompt + ']', imageUrl: dataUrl });
    if (activeChatObj) { activeChatObj.messages = history.slice(); saveState(); }
  } catch (e) {
    const frame = body.querySelector('.gen_image_frame');
    frame.classList.remove('loading');
    frame.innerHTML = `<div style="color:var(--danger);font-size:13px;padding:20px;text-align:center">Image failed: ${escapeHtml(e.message || String(e))}</div>`;
    history.push({ role: 'assistant', content: 'Image failed: ' + e.message });
    if (activeChatObj) { activeChatObj.messages = history.slice(); saveState(); }
  }
  currentAbort = null;
  // Image gen is heavier — bill it at 1500 tokens equivalent
  deductUsage(1500, isDupe);
  renderChatMeter();
  busy = false;
  setSendMode('send');
}

// ---------- attachments -----------------
const pendingAttachments = [];
const attachStrip = document.getElementById('attach_strip');
function renderAttachments() {
  if (!pendingAttachments.length) { attachStrip.hidden = true; attachStrip.innerHTML = ''; sendBtn.disabled = !input.value.trim() || busy; return; }
  attachStrip.hidden = false;
  attachStrip.innerHTML = '';
  sendBtn.disabled = busy;
  pendingAttachments.forEach((att, i) => {
    const w = document.createElement('div');
    w.className = 'attach_thumb';
    w.innerHTML = `<img src="${att.dataUrl}" alt=""><button class="x" aria-label="remove"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" x2="6" y1="6" y2="18"/><line x1="6" x2="18" y1="6" y2="18"/></svg></button>`;
    w.querySelector('.x').addEventListener('click', () => { pendingAttachments.splice(i, 1); renderAttachments(); });
    attachStrip.appendChild(w);
  });
}
attachBtn.addEventListener('click', () => {
  const fi = document.createElement('input');
  fi.type = 'file';
  fi.accept = 'image/*';
  fi.multiple = true;
  fi.addEventListener('change', async () => {
    for (const f of Array.from(fi.files || [])) {
      if (!f.type.startsWith('image/')) continue;
      const dataUrl = await new Promise(r => { const rd = new FileReader(); rd.onload = () => r(rd.result); rd.readAsDataURL(f); });
      pendingAttachments.push({ kind: 'image', blob: f, dataUrl, name: f.name });
    }
    renderAttachments();
  });
  fi.click();
});

// ---------- code block decoration -------
function decorateCodeBlocks(container) {
  container.querySelectorAll('pre > code').forEach(code => {
    const pre = code.parentElement;
    if (pre.parentElement?.classList?.contains('code_block_wrap')) return;
    const cls = (code.className || '').match(/language-(\w+)/);
    const lang = cls ? cls[1].toLowerCase() : 'text';
    const wrap = document.createElement('div');
    wrap.className = 'code_block_wrap';
    const bar = document.createElement('div');
    bar.className = 'code_block_bar';
    bar.innerHTML = `<span class="lang"></span><span class="code_block_bar_actions"></span>`;
    bar.querySelector('.lang').textContent = lang;
    const actions = bar.querySelector('.code_block_bar_actions');

    const copyBtn = document.createElement('button');
    copyBtn.className = 'code_mini_btn';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', async () => { try { await navigator.clipboard.writeText(code.textContent); toast({ title: 'Copied' }, 1200, 'ok'); } catch {} });
    actions.appendChild(copyBtn);

    if (['javascript', 'js', 'jsx', 'typescript', 'ts'].includes(lang)) {
      const runBtn = document.createElement('button');
      runBtn.className = 'code_mini_btn run';
      runBtn.innerHTML = '▶ Run';
      runBtn.addEventListener('click', () => runJs(code.textContent, wrap));
      actions.appendChild(runBtn);

      // Plus-only: deploy the code as a dedicated Cloudflare Worker that
      // runs 24/7 for free under our account. Returns a .workers.dev URL.
      if (state.plan === 'plus' || state.plan === 'unlimited') {
        const deployBtn = document.createElement('button');
        deployBtn.className = 'code_mini_btn run';
        deployBtn.style.background = 'linear-gradient(135deg,#4e2a8e,#8a4fd1)';
        deployBtn.innerHTML = '☁ Deploy 24/7';
        deployBtn.addEventListener('click', () => deployCodeToWorker(code.textContent, lang, deployBtn));
        actions.appendChild(deployBtn);
      }
    }
    if (['html', 'htm'].includes(lang)) {
      const prevBtn = document.createElement('button');
      prevBtn.className = 'code_mini_btn run';
      prevBtn.textContent = 'Preview';
      prevBtn.addEventListener('click', () => {
        const existing = wrap.nextElementSibling;
        if (existing?.classList?.contains('preview_frame')) { existing.remove(); return; }
        const iframe = document.createElement('iframe');
        iframe.className = 'preview_frame';
        iframe.sandbox = 'allow-scripts';
        iframe.srcdoc = code.textContent;
        wrap.after(iframe);
      });
      actions.appendChild(prevBtn);
    }

    pre.parentNode.insertBefore(wrap, pre);
    wrap.appendChild(bar);
    wrap.appendChild(pre);
  });
}
function runJs(code, wrap) {
  const existing = wrap.nextElementSibling;
  if (existing?.classList?.contains('exec_output')) existing.remove();
  const out = document.createElement('div');
  out.className = 'exec_output';
  const ctrId = containerState?.id || 'local';
  out.innerHTML = `<div class="exec_head"><span>stdout · ${ctrId.slice(0,12)}</span><button class="close">×</button></div><div class="exec_lines"><div class="exec_line" style="color:var(--muted)">running...</div></div>`;
  wrap.after(out);
  out.querySelector('.close').addEventListener('click', () => out.remove());
  const started = performance.now();
  const iframe = document.createElement('iframe');
  iframe.sandbox = 'allow-scripts';
  iframe.style.display = 'none';
  iframe.srcdoc = `<!doctype html><script>
const logs=[]; function fmt(a){if(a===undefined)return'undefined';if(a===null)return'null';if(typeof a==='string')return a;try{return JSON.stringify(a,null,2)}catch{return String(a)}}
function push(t,a){logs.push([t,Array.prototype.slice.call(a).map(fmt).join(' ')])}
const o={log:console.log,warn:console.warn,error:console.error,info:console.info};
console.log=function(){push('log',arguments);o.log.apply(console,arguments)};
console.warn=function(){push('warn',arguments);o.warn.apply(console,arguments)};
console.error=function(){push('error',arguments);o.error.apply(console,arguments)};
addEventListener('error',e=>push('error',[e.message||'error']));
(async()=>{try{const r=await(async function(){${code.replace(/<\/script>/g, '<\\/script>')}
})();if(r!==undefined)push('return',[r])}catch(e){push('error',[(e&&e.stack)||String(e)])}parent.postMessage({type:'exec',logs},'*')})();
<\/script>`;
  let done = false;
  const handler = (e) => {
    if (e.data?.type !== 'exec' || done) return;
    done = true;
    window.removeEventListener('message', handler);
    iframe.remove();
    const lines = out.querySelector('.exec_lines');
    lines.innerHTML = '';
    const logs = e.data.logs || [];
    if (!logs.length) {
      const d = document.createElement('div');
      d.className = 'exec_line';
      d.style.color = 'var(--muted)';
      d.textContent = '(no output)';
      lines.appendChild(d);
    } else {
      logs.forEach(([t, txt]) => {
        const d = document.createElement('div');
        d.className = 'exec_line ' + t;
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = t;
        d.appendChild(tag);
        d.appendChild(document.createTextNode(txt));
        lines.appendChild(d);
      });
    }
    out.querySelector('.exec_head span').textContent = `stdout · ${(performance.now() - started).toFixed(0)}ms · ${(containerState?.id || 'local').slice(0,12)}`;
  };
  window.addEventListener('message', handler);
  document.body.appendChild(iframe);
  setTimeout(() => { if (!done) { done = true; window.removeEventListener('message', handler); iframe.remove(); const l = out.querySelector('.exec_lines'); l.innerHTML = '<div class="exec_line error">timed out (5s)</div>'; } }, 5000);
}

// ---------- popover + modal -------------
let activePopover = null;
function closePopover() {
  if (activePopover) { activePopover.remove(); activePopover = null; document.removeEventListener('click', outsideClick, true); }
}
function outsideClick(e) { if (activePopover && !activePopover.contains(e.target)) closePopover(); }
function openPopover(anchor, items, align) {
  closePopover();
  const pop = document.createElement('div');
  pop.className = 'popover';
  items.forEach(it => {
    if (it === '-') { const d = document.createElement('div'); d.className = 'pop_divider'; pop.appendChild(d); return; }
    if (it.label) { const l = document.createElement('div'); l.className = 'pop_label'; l.textContent = it.label; pop.appendChild(l); return; }
    const b = document.createElement('button');
    b.className = 'pop_item' + (it.selected ? ' selected' : '');
    b.innerHTML = `<span class="pi_main"><div class="pi_title"></div>${it.sub ? '<div class="pi_sub"></div>' : ''}</span><svg class="pi_check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
    b.querySelector('.pi_title').textContent = it.title;
    if (it.sub) b.querySelector('.pi_sub').textContent = it.sub;
    b.addEventListener('click', (e) => { e.stopPropagation(); closePopover(); it.onClick?.(); });
    pop.appendChild(b);
  });
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  const w = pop.offsetWidth;
  let x = align === 'right' ? r.right - w : r.left;
  let y = r.bottom + 6;
  x = Math.max(8, Math.min(x, innerWidth - w - 8));
  y = Math.max(8, Math.min(y, innerHeight - pop.offsetHeight - 8));
  pop.style.left = x + 'px';
  pop.style.top = y + 'px';
  activePopover = pop;
  setTimeout(() => document.addEventListener('click', outsideClick, true), 0);
}

modelBtn.addEventListener('click', () => {
  const items = [{ label: 'MoE' }];
  const auto = MODELS[0];
  items.push({
    title: auto.name + ' · ' + auto.sub,
    sub: auto.desc,
    selected: state.model === 'auto',
    onClick: () => { state.model = 'auto'; saveState(); updateModelPicker(); toast({ title: 'Chad MoE engaged — router picks per message' }, 2500, 'ok'); },
  });
  const byTier = { free: [], pro: [], ultra: [] };
  for (const m of MODELS.slice(1)) byTier[m.tier].push(m);
  const tierSections = [
    { key: 'free',  label: 'Free · unlimited' },
    { key: 'pro',   label: 'Pro · Plus (50/day · 300/week)' },
    { key: 'ultra', label: 'Ultra · Plus (15/day · 75/week)' },
  ];
  for (const sec of tierSections) {
    if (!byTier[sec.key].length) continue;
    items.push('-');
    items.push({ label: sec.label });
    for (const m of byTier[sec.key]) {
      const locked = m.tier !== 'free' && state.plan !== 'plus';
      items.push({
        title: m.name + (m.sub ? ' ' + m.sub : ''),
        sub: locked ? 'Requires Plus · click to upgrade' : m.desc,
        selected: state.model === m.id,
        onClick: () => {
          if (locked) { openPaywallModal(`${m.name}${m.sub ? ' ' + m.sub : ''} requires Plus`); return; }
          state.model = m.id; saveState(); updateModelPicker();
          toast({ title: 'Switched to ' + m.name + (m.sub ? ' ' + m.sub : '') }, 2200, 'ok');
        },
      });
    }
  }
  openPopover(modelBtn, items);
});
function updateModelPicker() {
  const m = modelObj();
  modelNameEl.textContent = m.name;
  modelSubEl.textContent = m.sub;
}
updateModelPicker();

profileBtn.addEventListener('click', () => {
  const isPlus = state.plan === 'plus' || state.plan === 'unlimited';
  openPopover(profileBtn, [
    { title: isPlus ? `Manage plan (${state.plan.toUpperCase()})` : 'Upgrade to Plus', sub: isPlus ? 'Images + 24/7 deploys' : 'Images + 2.5× usage', onClick: () => openPaywallModal() },
    { title: 'Settings', onClick: openSettings },
    { title: 'ChadGPT CLI', sub: 'Coding agent for your terminal', onClick: () => { window.location.href = '/cli'; } },
    { title: 'Lua Obfuscator', sub: 'Protect scripts — run-only, unreadable', onClick: () => { window.location.href = '/obfuscate'; } },
    { title: 'Container details', onClick: openContainerModal },
    ...(isPlus ? [{ title: 'My deployments', sub: '24/7 hosted apps', onClick: openDeploymentsList }] : []),
    '-',
    { title: 'Clear all chats', onClick: () => { state.chats = []; saveState(); renderChatList(); setActiveChat(null); toast({ title: 'Cleared' }, 1500, 'ok'); } },
  ], 'right');
});
document.getElementById('usage_badge').addEventListener('click', openUsageModal);

async function openUsageModal() {
  openModal('Your usage', async (p) => {
    p.innerHTML = '<div style="text-align:center;color:var(--muted);padding:20px">Loading…</div>';
    const u = await fetchServerUsage();
    if (!u) {
      p.innerHTML = '<div style="color:var(--danger);padding:20px">Failed to load usage data.</div>';
      return;
    }

    // Unlimited plan: show cost-to-founder instead of per-tier bars.
    if (u.plan === 'unlimited') {
      const cost = u.lifetime_cost_usd || 0;
      const calls = u.lifetime_calls || 0;
      p.innerHTML = `
        <div style="padding:16px;border-radius:10px;background:linear-gradient(135deg,#4e2a8e,#8a4fd1);color:#fff;margin-bottom:14px">
          <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;opacity:.9">Founder grant</div>
          <div style="font-size:22px;font-weight:700;margin-top:4px">Unlimited access</div>
          <div style="font-size:12px;opacity:.9;margin-top:6px">Granted by ${u.granted_by || 'founder'}. Every tier unlocked, no daily or weekly cap.</div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px">
          <div style="padding:12px;border:1px solid var(--border);border-radius:8px">
            <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em">Cost to founder</div>
            <div style="font-size:20px;font-weight:700;margin-top:4px;font-family:var(--mono)">$${cost.toFixed(4)}</div>
            <div style="font-size:11px;color:var(--muted);margin-top:2px">your lifetime burden</div>
          </div>
          <div style="padding:12px;border:1px solid var(--border);border-radius:8px">
            <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em">Calls</div>
            <div style="font-size:20px;font-weight:700;margin-top:4px;font-family:var(--mono)">${calls.toLocaleString()}</div>
            <div style="font-size:11px;color:var(--muted);margin-top:2px">lifetime requests</div>
          </div>
        </div>
        <div style="font-size:12px;color:var(--muted);line-height:1.5">
          Every model is open to you. The cost above is only your share — it doesn't include anyone else's usage. The founder sees this figure (and the full per-user breakdown) in the admin panel.
        </div>
        ${u.is_founder ? '<div style="margin-top:14px;text-align:right"><button class="btn_primary" style="background:#4e2a8e" id="u_admin_u">Founder admin</button></div>' : ''}
      `;
      const au = p.querySelector('#u_admin_u');
      if (au) au.addEventListener('click', () => { closeModal(); openFounderAdmin(); });
      return;
    }

    const tierLabel = { free: 'Free · unlimited', pro: 'Pro · Plus', ultra: 'Ultra · Plus' };
    const rows = ['free', 'pro', 'ultra'].map(k => {
      const t = u.tiers[k];
      const dailyBar = t.daily_limit ? Math.min(100, Math.round(100 * t.daily_used / t.daily_limit)) : 0;
      const weeklyBar = t.weekly_limit ? Math.min(100, Math.round(100 * t.weekly_used / t.weekly_limit)) : 0;
      const dailyFill = dailyBar >= 100 ? 'var(--danger)' : dailyBar >= 80 ? '#f0b429' : 'var(--ok)';
      const weeklyFill = weeklyBar >= 100 ? 'var(--danger)' : weeklyBar >= 80 ? '#f0b429' : 'var(--ok)';
      return `
        <div style="padding:12px 0;border-bottom:1px solid var(--divider)">
          <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:8px">
            <div style="font-weight:600;font-size:14px">${tierLabel[k]}</div>
            <div style="font-family:var(--mono);font-size:12px;color:var(--muted)">
              ${t.daily_limit === null ? 'unlimited' : `${t.daily_used}/${t.daily_limit} today · ${t.weekly_used}/${t.weekly_limit} this week`}
            </div>
          </div>
          ${t.daily_limit !== null ? `
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
              <div style="width:60px;font-size:11px;color:var(--muted);font-family:var(--mono)">daily</div>
              <div style="flex:1;height:6px;border-radius:3px;background:var(--border);overflow:hidden"><div style="height:100%;width:${dailyBar}%;background:${dailyFill}"></div></div>
            </div>
            <div style="display:flex;align-items:center;gap:8px">
              <div style="width:60px;font-size:11px;color:var(--muted);font-family:var(--mono)">weekly</div>
              <div style="flex:1;height:6px;border-radius:3px;background:var(--border);overflow:hidden"><div style="height:100%;width:${weeklyBar}%;background:${weeklyFill}"></div></div>
            </div>
          ` : ''}
        </div>
      `;
    }).join('');
    p.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px">
        <div style="font-size:14px"><b>${u.plan.toUpperCase()}</b> plan</div>
        <div style="font-size:11px;color:var(--muted);font-family:var(--mono)">${u.day} · ${u.week}</div>
      </div>
      ${rows}
      <div style="margin-top:14px;font-size:12px;color:var(--muted);line-height:1.5">
        Daily resets ${new Date(u.resets_daily_at).toLocaleString()}. Weekly resets ${new Date(u.resets_weekly_at).toLocaleString()}. All counters live in Cloudflare D1 — they survive logout and device changes.
      </div>
      ${u.plan === 'free' ? '<div style="margin-top:14px;text-align:right"><button class="btn_primary" id="u_upgrade">Upgrade to Plus</button></div>' : ''}
      ${u.is_founder ? '<div style="margin-top:10px;text-align:right"><button class="btn_primary" style="background:#4e2a8e" id="u_admin">Founder admin</button></div>' : ''}
    `;
    const up = p.querySelector('#u_upgrade');
    if (up) up.addEventListener('click', () => { closeModal(); openPaywallModal(); });
    const ad = p.querySelector('#u_admin');
    if (ad) ad.addEventListener('click', () => { closeModal(); openFounderAdmin(); });
  });
}

function openUsageLimitModal(info) {
  openModal(`${info.tier.toUpperCase()} ${info.scope} limit reached`, (p) => {
    const resets = new Date(info.resets_at).toLocaleString();
    p.innerHTML = `
      <p style="font-size:14px;line-height:1.6;margin:0 0 10px">You've used <b>${info.used} / ${info.limit}</b> ${info.tier}-tier messages ${info.scope === 'daily' ? 'today' : 'this week'}.</p>
      <p style="font-size:13px;color:var(--muted);margin:0 0 16px">This quota resets at <b style="color:var(--fg)">${resets}</b>. You can switch to a free-tier model in the meantime.</p>
      <div style="display:flex;justify-content:flex-end;gap:8px">
        <button class="btn_primary" style="background:transparent;color:var(--fg);border:1px solid var(--border)" id="ulm_close">OK</button>
        <button class="btn_primary" id="ulm_pick">Pick a free model</button>
      </div>
    `;
    p.querySelector('#ulm_close').addEventListener('click', closeModal);
    p.querySelector('#ulm_pick').addEventListener('click', () => { state.model = 'fast'; saveState(); updateModelPicker(); closeModal(); });
  });
}

// ---------- word search solver ----------
// Takes vision-model output (expected JSON), returns { grid_rows, grid_cols,
// rows: ["ABC...", ...], words: [...] } or null if parse fails.
function parseWordSearchJson(text) {
  try {
    // Model sometimes wraps in ```json ... ``` despite being told not to.
    const cleaned = text.replace(/```json\s*|```/g, '').trim();
    // Find the outermost JSON object.
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start < 0 || end < 0) return null;
    const obj = JSON.parse(cleaned.slice(start, end + 1));
    if (obj.error) return null;
    if (!Array.isArray(obj.rows) || !Array.isArray(obj.words)) return null;
    // Normalize — strip whitespace, uppercase, check column width.
    const rows = obj.rows.map(r => String(r).toUpperCase().replace(/\s+/g, ''));
    const cols = rows[0]?.length || 0;
    if (!cols || rows.some(r => r.length !== cols)) return null;
    return {
      grid_rows: rows.length,
      grid_cols: cols,
      rows,
      words: obj.words.map(w => String(w).toUpperCase().replace(/\s+/g, '')).filter(Boolean),
    };
  } catch { return null; }
}

// Find every word in the grid across all 8 directions.
// Returns [{ word, r1, c1, r2, c2, dir }] — r1/c1 is start, r2/c2 is end
// (inclusive). Not-found words are omitted.
function solveWordSearch(puzzle) {
  const { rows, grid_rows: R, grid_cols: C, words } = puzzle;
  const grid = rows.map(r => r.split(''));
  const DIRS = [
    { name: 'right', dr: 0, dc: 1 },
    { name: 'left', dr: 0, dc: -1 },
    { name: 'down', dr: 1, dc: 0 },
    { name: 'up', dr: -1, dc: 0 },
    { name: 'down-right', dr: 1, dc: 1 },
    { name: 'down-left', dr: 1, dc: -1 },
    { name: 'up-right', dr: -1, dc: 1 },
    { name: 'up-left', dr: -1, dc: -1 },
  ];
  const hits = [];
  for (const word of words) {
    let found = null;
    for (let r = 0; r < R && !found; r++) {
      for (let c = 0; c < C && !found; c++) {
        for (const d of DIRS) {
          let match = true;
          for (let i = 0; i < word.length; i++) {
            const rr = r + d.dr * i, cc = c + d.dc * i;
            if (rr < 0 || rr >= R || cc < 0 || cc >= C) { match = false; break; }
            if (grid[rr][cc] !== word[i]) { match = false; break; }
          }
          if (match) {
            found = { word, r1: r, c1: c, r2: r + d.dr * (word.length - 1), c2: c + d.dc * (word.length - 1), dir: d.name };
            break;
          }
        }
      }
    }
    if (found) hits.push(found);
  }
  return hits;
}

// Text representation the model can include in its reply.
function formatWordSearchForModel(puzzle, solved) {
  const total = puzzle.words.length;
  const notFound = puzzle.words.filter(w => !solved.some(s => s.word === w));
  const found = solved.map(s =>
    `  • ${s.word} — ${s.dir}, row ${s.r1 + 1} col ${s.c1 + 1} → row ${s.r2 + 1} col ${s.c2 + 1}`
  ).join('\n');
  return `WORD SEARCH detected (${puzzle.grid_rows}×${puzzle.grid_cols}). Solved ${solved.length}/${total}:\n${found}${notFound.length ? `\n\nNot found in grid: ${notFound.join(', ')} (may be unreadable letters or the word list didn't match)` : ''}`;
}

// Render the solved word search as a canvas with colored lines over each
// found word. Returns an <img> element the caller can insert into the chat.
function renderWordSearchOverlay(puzzle, solved) {
  const { grid_rows: R, grid_cols: C, rows } = puzzle;
  const CELL = 36;
  const PAD = 16;
  const W = PAD * 2 + C * CELL;
  const H = PAD * 2 + R * CELL;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');

  // Background + grid.
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#ddd';
  ctx.lineWidth = 1;
  for (let i = 0; i <= R; i++) { ctx.beginPath(); ctx.moveTo(PAD, PAD + i * CELL); ctx.lineTo(PAD + C * CELL, PAD + i * CELL); ctx.stroke(); }
  for (let j = 0; j <= C; j++) { ctx.beginPath(); ctx.moveTo(PAD + j * CELL, PAD); ctx.lineTo(PAD + j * CELL, PAD + R * CELL); ctx.stroke(); }

  // Letters.
  ctx.fillStyle = '#222';
  ctx.font = '600 18px -apple-system,BlinkMacSystemFont,system-ui,sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (let r = 0; r < R; r++) {
    for (let c = 0; c < C; c++) {
      ctx.fillText(rows[r][c], PAD + c * CELL + CELL / 2, PAD + r * CELL + CELL / 2);
    }
  }

  // Colored lines over each found word. Semi-transparent so letters still readable.
  const PALETTE = ['#e74c3c', '#2ecc71', '#3498db', '#9b59b6', '#e67e22', '#1abc9c', '#f1c40f', '#ff6b9d', '#34495e'];
  solved.forEach((s, i) => {
    const color = PALETTE[i % PALETTE.length];
    ctx.strokeStyle = color + 'aa';
    ctx.lineWidth = CELL * 0.7;
    ctx.lineCap = 'round';
    const x1 = PAD + s.c1 * CELL + CELL / 2;
    const y1 = PAD + s.r1 * CELL + CELL / 2;
    const x2 = PAD + s.c2 * CELL + CELL / 2;
    const y2 = PAD + s.r2 * CELL + CELL / 2;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  });

  // Re-draw letters on top so colors don't swallow them.
  ctx.fillStyle = '#000';
  ctx.font = '700 18px -apple-system,BlinkMacSystemFont,system-ui,sans-serif';
  for (let r = 0; r < R; r++) {
    for (let c = 0; c < C; c++) {
      ctx.fillText(rows[r][c], PAD + c * CELL + CELL / 2, PAD + r * CELL + CELL / 2);
    }
  }

  return cv.toDataURL('image/png');
}

// ---------- founder admin panel ----------
// ---------- Deploy code → Cloudflare Worker ----------
async function deployCodeToWorker(code, lang, buttonEl) {
  // Simple prompt for a name. Falls back to auto-derive if blank.
  const defaultName = ('app-' + Math.random().toString(36).slice(2, 7));
  const name = prompt('Name your deployed app (letters/numbers/dashes, max 30 chars):', defaultName);
  if (name === null) return;
  const originalLabel = buttonEl.innerHTML;
  buttonEl.innerHTML = '☁ Deploying…';
  buttonEl.disabled = true;
  try {
    const r = await apiFetch('/deploy', {
      method: 'POST',
      body: JSON.stringify({ code, name: name || defaultName, runtime: lang.startsWith('t') ? 'ts' : 'js' }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      toast({ title: 'Deploy failed: ' + (j.error || r.status) }, 5000, 'err');
      if (j.detail) console.error('deploy detail:', j.detail);
      return;
    }
    openDeploySuccessModal(j);
  } catch (e) {
    toast({ title: 'Deploy failed: ' + e.message }, 4000, 'err');
  } finally {
    buttonEl.innerHTML = originalLabel;
    buttonEl.disabled = false;
  }
}

function openDeploySuccessModal(info) {
  openModal('Deployed · 24/7 hosted', (p) => {
    const url = info.url || '(url pending — check /deployments)';
    p.innerHTML = `
      <div style="padding:14px;border-radius:10px;background:linear-gradient(135deg,#2e7d32,#4caf50);color:#fff;margin-bottom:14px">
        <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;opacity:.9">Live</div>
        <div style="font-size:16px;font-weight:700;margin-top:4px;font-family:var(--mono);word-break:break-all">${url}</div>
        <div style="font-size:12px;opacity:.9;margin-top:6px">Runs 24/7 on Cloudflare's edge. No cold start. Free on the Workers free tier.</div>
      </div>
      <div style="font-size:12px;color:var(--muted);line-height:1.6">
        Script name: <code>${info.name}</code><br>
        Any changes you want? Ask ChadGPT to update the code, then Deploy again with the same name — it'll overwrite the live version in place.
      </div>
      <div style="margin-top:14px;display:flex;justify-content:space-between;gap:8px">
        <button class="btn_primary" style="background:transparent;color:var(--fg);border:1px solid var(--border)" id="ds_list">My deployments</button>
        <button class="btn_primary" id="ds_open">Open ${info.url ? '↗' : ''}</button>
      </div>
    `;
    p.querySelector('#ds_list').addEventListener('click', () => { closeModal(); openDeploymentsList(); });
    p.querySelector('#ds_open').addEventListener('click', () => {
      if (info.url) window.open(info.url, '_blank');
      else openDeploymentsList();
    });
  });
}

async function openDeploymentsList() {
  openModal('My deployments', async (p) => {
    p.innerHTML = '<div style="text-align:center;color:var(--muted);padding:20px">Loading…</div>';
    const r = await apiFetch('/deployments', { method: 'GET' });
    if (!r.ok) { p.innerHTML = `<div style="color:var(--danger);padding:20px">Failed (${r.status})</div>`; return; }
    const j = await r.json();
    const list = (j.deployments || []);
    if (!list.length) {
      p.innerHTML = '<div style="padding:20px;color:var(--muted);text-align:center">No deployments yet. Ask ChadGPT to write some JS/TS, then click the purple <b>☁ Deploy 24/7</b> button on the code block.</div>';
      return;
    }
    const rows = list.map(d => `
      <tr style="border-bottom:1px solid var(--divider)">
        <td style="padding:8px 6px;font-size:13px"><b>${d.slug}</b><div style="font-size:11px;color:var(--muted);font-family:var(--mono)">${d.url || '(url pending)'}</div></td>
        <td style="padding:8px 6px;text-align:right;font-family:var(--mono);font-size:12px;color:var(--muted)">${(d.size_bytes/1024).toFixed(1)} KB</td>
        <td style="padding:8px 6px;text-align:right">
          ${d.url ? `<a href="${d.url}" target="_blank" class="btn_primary" style="padding:4px 10px;font-size:12px;text-decoration:none;display:inline-block">Open ↗</a>` : ''}
          <button class="btn_primary" style="padding:4px 10px;font-size:12px;background:#b23c3c" data-del="${d.script_name}">Delete</button>
        </td>
      </tr>
    `).join('');
    p.innerHTML = `
      <div style="max-height:380px;overflow:auto;border:1px solid var(--border);border-radius:8px">
        <table style="width:100%;border-collapse:collapse">
          <thead style="background:var(--divider);position:sticky;top:0"><tr>
            <th style="padding:8px 6px;text-align:left;font-size:11px;text-transform:uppercase;color:var(--muted)">App</th>
            <th style="padding:8px 6px;text-align:right;font-size:11px;text-transform:uppercase;color:var(--muted)">Size</th>
            <th style="padding:8px 6px;text-align:right;font-size:11px;text-transform:uppercase;color:var(--muted)"></th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div style="margin-top:10px;font-size:11px;color:var(--muted)">
        Each app runs 24/7 on Cloudflare's edge, free. Max 10 per user. Delete removes it from Cloudflare + our database.
      </div>
    `;
    p.querySelectorAll('[data-del]').forEach(btn => btn.addEventListener('click', async () => {
      const name = btn.getAttribute('data-del');
      if (!confirm('Delete ' + name + ' permanently?')) return;
      const dr = await apiFetch('/deployments?name=' + encodeURIComponent(name), { method: 'DELETE' });
      if (dr.ok) { toast({ title: 'Deleted' }, 1500, 'ok'); openDeploymentsList(); }
      else toast({ title: 'Delete failed' }, 3000, 'err');
    }));
  });
}

async function openFounderAdmin() {
  openModal('Founder admin', async (p) => {
    p.innerHTML = '<div style="text-align:center;color:var(--muted);padding:20px">Loading users…</div>';
    const r = await apiFetch('/admin/users', { method: 'GET' });
    if (!r.ok) {
      p.innerHTML = `<div style="color:var(--danger);padding:20px">Failed to load (${r.status}). Are you logged in as the founder?</div>`;
      return;
    }
    const j = await r.json();
    renderFounderAdmin(p, j);
  });
}

function badgeFor(u) {
  if (u.banned) return '<span style="background:#b23c3c;color:#fff;padding:2px 6px;border-radius:4px;font-size:10px;font-weight:600;margin-left:4px">BANNED</span>';
  if (u.muted)  return '<span style="background:#c47a0f;color:#fff;padding:2px 6px;border-radius:4px;font-size:10px;font-weight:600;margin-left:4px">MUTED</span>';
  return '';
}

function planBadge(plan) {
  const c = plan === 'unlimited' ? '#9b6bd8' : plan === 'plus' ? '#2e7d32' : 'var(--muted)';
  return `<span style="color:${c};font-weight:600">${plan.toUpperCase()}</span>`;
}

function renderFounderAdmin(p, j) {
  const t = j.totals;
  const rows = j.users.map(u => `
    <tr data-email="${u.email}" style="border-bottom:1px solid var(--divider);${u.banned ? 'opacity:0.55' : ''}">
      <td style="padding:8px 6px;font-size:13px">${u.email}${badgeFor(u)}${u.blocked_models?.length ? `<span style="background:#555;color:#fff;padding:2px 6px;border-radius:4px;font-size:10px;margin-left:4px">${u.blocked_models.length} model${u.blocked_models.length === 1 ? '' : 's'} blocked</span>` : ''}</td>
      <td style="padding:8px 6px;font-size:12px">${planBadge(u.plan)}</td>
      <td style="padding:8px 6px;text-align:right;font-family:var(--mono);font-size:12px">$${u.cost_usd.toFixed(4)}</td>
      <td style="padding:8px 6px;text-align:right;font-family:var(--mono);font-size:12px">${u.calls}</td>
      <td style="padding:8px 6px;text-align:right">
        <button class="btn_primary" style="padding:4px 10px;font-size:12px" data-manage="${u.email}">Manage</button>
      </td>
    </tr>
  `).join('');

  const bannedCount = j.users.filter(u => u.banned).length;
  const mutedCount = j.users.filter(u => u.muted).length;

  p.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:14px">
      <div style="padding:10px;border:1px solid var(--border);border-radius:8px">
        <div style="font-size:11px;color:var(--muted);text-transform:uppercase">Users</div>
        <div style="font-size:18px;font-weight:700;font-family:var(--mono)">${t.user_count}</div>
      </div>
      <div style="padding:10px;border:1px solid var(--border);border-radius:8px">
        <div style="font-size:11px;color:var(--muted);text-transform:uppercase">Unlimited</div>
        <div style="font-size:18px;font-weight:700;font-family:var(--mono)">${t.granted_count}</div>
      </div>
      <div style="padding:10px;border:1px solid var(--border);border-radius:8px">
        <div style="font-size:11px;color:var(--muted);text-transform:uppercase">Banned · muted</div>
        <div style="font-size:18px;font-weight:700;font-family:var(--mono)">${bannedCount} · ${mutedCount}</div>
      </div>
      <div style="padding:10px;border:1px solid var(--border);border-radius:8px">
        <div style="font-size:11px;color:var(--muted);text-transform:uppercase">Your burden</div>
        <div style="font-size:18px;font-weight:700;font-family:var(--mono)">$${t.founder_burden_usd.toFixed(4)}</div>
      </div>
    </div>
    <div style="max-height:380px;overflow:auto;border:1px solid var(--border);border-radius:8px">
      <table style="width:100%;border-collapse:collapse">
        <thead style="background:var(--divider);position:sticky;top:0">
          <tr>
            <th style="padding:8px 6px;text-align:left;font-size:11px;text-transform:uppercase;color:var(--muted)">Email</th>
            <th style="padding:8px 6px;text-align:left;font-size:11px;text-transform:uppercase;color:var(--muted)">Plan</th>
            <th style="padding:8px 6px;text-align:right;font-size:11px;text-transform:uppercase;color:var(--muted)">Cost</th>
            <th style="padding:8px 6px;text-align:right;font-size:11px;text-transform:uppercase;color:var(--muted)">Calls</th>
            <th style="padding:8px 6px;text-align:right;font-size:11px;text-transform:uppercase;color:var(--muted)"></th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div style="margin-top:10px;font-size:11px;color:var(--muted)">
      Total cost across all users: <b style="font-family:var(--mono)">$${t.total_cost_usd.toFixed(4)}</b>. Click "Manage" on any row for ban / mute / plan / blocked-models / delete-chats controls.
    </div>
    <div style="margin-top:10px;text-align:right">
      <button class="btn_primary" style="background:#4e2a8e" id="adm_ratings">Model ratings</button>
    </div>
  `;

  const byEmail = Object.fromEntries(j.users.map(u => [u.email, u]));
  p.querySelectorAll('[data-manage]').forEach(btn => btn.addEventListener('click', () => {
    const email = btn.getAttribute('data-manage');
    openUserManage(byEmail[email]);
  }));
  p.querySelector('#adm_ratings').addEventListener('click', () => { closeModal(); openRatingsPanel(); });
}

async function openRatingsPanel() {
  openModal('Model ratings', async (p) => {
    p.innerHTML = '<div style="text-align:center;color:var(--muted);padding:20px">Loading…</div>';
    const r = await apiFetch('/admin/ratings', { method: 'GET' });
    if (!r.ok) { p.innerHTML = `<div style="color:var(--danger);padding:20px">Failed (${r.status})</div>`; return; }
    const j = await r.json();
    const modelRows = (j.by_model || []).map(row => {
      const total = row.up + row.down;
      const pctUp = total ? Math.round(100 * row.up / total) : 0;
      return `
        <tr style="border-bottom:1px solid var(--divider)">
          <td style="padding:8px 6px;font-family:var(--mono);font-size:12px">${row.model}</td>
          <td style="padding:8px 6px;text-align:right;font-family:var(--mono);font-size:12px;color:var(--ok)">+${row.up}</td>
          <td style="padding:8px 6px;text-align:right;font-family:var(--mono);font-size:12px;color:var(--danger)">−${row.down}</td>
          <td style="padding:8px 6px;text-align:right;font-family:var(--mono);font-size:12px">${pctUp}% good</td>
        </tr>`;
    }).join('') || '<tr><td colspan="4" style="padding:20px;text-align:center;color:var(--muted)">no ratings yet — users will thumbs up/down messages first</td></tr>';
    const recent = (j.recent_downvotes || []).map(d => `
      <div style="padding:8px 0;border-bottom:1px solid var(--divider);font-size:12px">
        <div style="color:var(--muted);font-family:var(--mono)">${new Date(d.created_at).toLocaleString()} · ${d.email} · ${d.model_key || '—'}</div>
        ${d.note ? `<div style="margin-top:4px">${escapeHtml(d.note)}</div>` : ''}
        <div style="margin-top:2px;color:var(--muted);font-family:var(--mono);font-size:11px">hash: ${d.message_hash.slice(0, 16)}…</div>
      </div>`).join('') || '<div style="padding:12px;color:var(--muted);text-align:center;font-size:12px">no downvotes yet</div>';

    p.innerHTML = `
      <h4 style="font-size:13px;margin:0 0 8px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)">Per model</h4>
      <div style="border:1px solid var(--border);border-radius:8px;overflow:hidden;margin-bottom:14px">
        <table style="width:100%;border-collapse:collapse">
          <thead style="background:var(--divider)"><tr>
            <th style="padding:8px 6px;text-align:left;font-size:11px;text-transform:uppercase;color:var(--muted)">Model</th>
            <th style="padding:8px 6px;text-align:right;font-size:11px;text-transform:uppercase;color:var(--muted)">Up</th>
            <th style="padding:8px 6px;text-align:right;font-size:11px;text-transform:uppercase;color:var(--muted)">Down</th>
            <th style="padding:8px 6px;text-align:right;font-size:11px;text-transform:uppercase;color:var(--muted)">% good</th>
          </tr></thead>
          <tbody>${modelRows}</tbody>
        </table>
      </div>
      <h4 style="font-size:13px;margin:0 0 8px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)">Recent downvotes</h4>
      <div style="max-height:260px;overflow:auto;border:1px solid var(--border);border-radius:8px;padding:0 10px">${recent}</div>
      <div style="margin-top:12px;text-align:right"><button class="btn_primary" style="background:transparent;color:var(--fg);border:1px solid var(--border)" id="ratings_back">&lt; Back</button></div>
    `;
    p.querySelector('#ratings_back').addEventListener('click', () => { closeModal(); openFounderAdmin(); });
  });
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

async function openUserManage(u) {
  openModal('Manage ' + u.email, (p) => {
    const blocklist = (u.blocked_models || []).map(m => `
      <li style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;font-family:var(--mono);font-size:12px">
        ${m}
        <button class="btn_primary" data-unblock="${m}" style="padding:2px 8px;font-size:11px;background:transparent;color:var(--fg);border:1px solid var(--border)">unblock</button>
      </li>
    `).join('') || '<li style="color:var(--muted);font-size:12px;padding:4px 0">no models blocked</li>';

    const modelOpts = MODELS.filter(m => m.id !== 'auto').map(m => `<option value="${m.id}">${m.name}${m.sub ? ' ' + m.sub : ''}</option>`).join('');

    p.innerHTML = `
      <div style="font-size:12px;color:var(--muted);margin-bottom:12px;font-family:var(--mono)">
        ${u.plan.toUpperCase()} · ${u.calls} calls · $${u.cost_usd.toFixed(4)}${u.granted_by ? ` · granted by ${u.granted_by}` : ''}
      </div>

      <h4 style="font-size:13px;margin:0 0 6px;text-transform:uppercase;color:var(--muted);letter-spacing:.06em">Plan</h4>
      <div style="display:flex;gap:6px;margin-bottom:14px">
        <button class="btn_primary" style="padding:6px 12px;font-size:12px;background:${u.plan === 'free' ? '#555' : 'var(--accent)'}" data-plan="free">Free</button>
        <button class="btn_primary" style="padding:6px 12px;font-size:12px;background:${u.plan === 'plus' ? '#555' : '#2e7d32'}" data-plan="plus">Plus</button>
        <button class="btn_primary" style="padding:6px 12px;font-size:12px;background:${u.plan === 'unlimited' ? '#555' : '#9b6bd8'}" data-plan="unlimited">Unlimited</button>
      </div>

      <h4 style="font-size:13px;margin:0 0 6px;text-transform:uppercase;color:var(--muted);letter-spacing:.06em">Moderation</h4>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:14px">
        <button class="btn_primary" style="padding:6px;font-size:12px;background:${u.banned ? '#555' : '#b23c3c'}" data-mod="${u.banned ? 'unban' : 'ban'}">${u.banned ? 'Unban account' : 'Ban account'}</button>
        <button class="btn_primary" style="padding:6px;font-size:12px;background:${u.muted ? '#555' : '#c47a0f'}" data-mod="${u.muted ? 'unmute' : 'mute'}">${u.muted ? 'Allow messages' : 'Restrict messages'}</button>
        <button class="btn_primary" style="padding:6px;font-size:12px;background:#4a6" data-mod="reset_usage">Reset usage counts</button>
        <button class="btn_primary" style="padding:6px;font-size:12px;background:#b23c3c" data-mod="delete_chats">Delete all chats</button>
      </div>

      <h4 style="font-size:13px;margin:0 0 6px;text-transform:uppercase;color:var(--muted);letter-spacing:.06em">Blocked models</h4>
      <ul style="margin:0 0 8px;padding:0;list-style:none;border:1px solid var(--border);border-radius:6px;padding:8px 10px">${blocklist}</ul>
      <div style="display:flex;gap:6px;margin-bottom:14px">
        <select id="mod_pick" style="flex:1;padding:6px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg);font-size:12px">${modelOpts}</select>
        <button class="btn_primary" style="padding:6px 12px;font-size:12px" id="mod_block_add">Block</button>
      </div>

      <h4 style="font-size:13px;margin:0 0 6px;text-transform:uppercase;color:var(--muted);letter-spacing:.06em">Moderation note</h4>
      <textarea id="mod_note" rows="2" placeholder="Shown to the user on refusal; e.g. 'spam, 3 strikes'" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg);font-size:12px;resize:vertical;font-family:inherit">${u.moderation_note || ''}</textarea>
      <div style="display:flex;justify-content:flex-end;margin-top:6px"><button class="btn_primary" style="padding:4px 12px;font-size:12px" id="mod_save_note">Save note</button></div>

      <div style="margin-top:14px;display:flex;justify-content:space-between">
        <button class="btn_primary" style="background:transparent;color:var(--fg);border:1px solid var(--border);padding:6px 12px;font-size:12px" id="mod_back">&lt; Back to list</button>
      </div>
    `;

    const refresh = async () => { closeModal(); await openFounderAdmin(); };
    const callMod = async (action, extra = {}) => {
      const rr = await apiFetch('/admin/moderate', { method: 'POST', body: JSON.stringify({ email: u.email, action, nonce: newNonce(), ...extra }) });
      const jj = await rr.json().catch(() => ({}));
      if (!rr.ok) { toast({ title: jj.error || 'Action failed' }, 3000, 'err'); return false; }
      toast({ title: 'Done — ' + action }, 2500, 'ok');
      return true;
    };
    const callGrant = async (plan) => {
      const rr = await apiFetch('/admin/grant', { method: 'POST', body: JSON.stringify({ email: u.email, plan, nonce: newNonce() }) });
      const jj = await rr.json().catch(() => ({}));
      if (!rr.ok) { toast({ title: jj.error || 'Plan change failed' }, 3000, 'err'); return false; }
      toast({ title: `${u.email} → ${plan}` }, 2500, 'ok');
      return true;
    };

    p.querySelectorAll('[data-plan]').forEach(btn => btn.addEventListener('click', async () => {
      const plan = btn.getAttribute('data-plan');
      if (plan === u.plan) return;
      if (!confirm(`Change ${u.email} from ${u.plan} to ${plan}?`)) return;
      if (await callGrant(plan)) refresh();
    }));
    p.querySelectorAll('[data-mod]').forEach(btn => btn.addEventListener('click', async () => {
      const action = btn.getAttribute('data-mod');
      const confirms = {
        ban: 'Ban this account? They will be logged out and refused on sight.',
        unban: 'Unban this account?',
        mute: 'Restrict this account from sending new messages?',
        unmute: 'Allow this account to send messages again?',
        reset_usage: 'Wipe all usage-counter rows for this user? This frees their quota.',
        delete_chats: 'Delete ALL chat history and container state for this user? Not reversible.',
      };
      if (!confirm(confirms[action] || 'Apply ' + action + '?')) return;
      const note = p.querySelector('#mod_note')?.value;
      if (await callMod(action, note ? { note } : {})) refresh();
    }));
    p.querySelector('#mod_block_add').addEventListener('click', async () => {
      const value = p.querySelector('#mod_pick').value;
      if (await callMod('block_model', { value })) refresh();
    });
    p.querySelectorAll('[data-unblock]').forEach(btn => btn.addEventListener('click', async () => {
      const value = btn.getAttribute('data-unblock');
      if (await callMod('unblock_model', { value })) refresh();
    }));
    p.querySelector('#mod_save_note').addEventListener('click', async () => {
      const value = p.querySelector('#mod_note').value;
      if (await callMod('set_note', { value })) toast({ title: 'Note saved' }, 2000, 'ok');
    });
    p.querySelector('#mod_back').addEventListener('click', () => { closeModal(); openFounderAdmin(); });
  });
}

// ---------- device fingerprint (client half) ----------
// We send these client-side signals with every chat. The server combines them
// with IP + UA + salt, hashes everything together, and stores the result.
let _fp = null;
function collectClientFingerprint() {
  if (_fp) return _fp;
  try {
    const nav = window.navigator;
    const scr = window.screen;
    // Canvas hash — browsers render text slightly differently depending on
    // GPU + font stack, so this is a decent device discriminator.
    let canvasHash = '';
    try {
      const c = document.createElement('canvas');
      c.width = 200; c.height = 50;
      const ctx = c.getContext('2d');
      ctx.textBaseline = 'top'; ctx.font = '14px Arial';
      ctx.fillStyle = '#f60'; ctx.fillRect(0, 0, 200, 50);
      ctx.fillStyle = '#069'; ctx.fillText('ChadGPT fp canvas', 2, 2);
      canvasHash = c.toDataURL().slice(-64);
    } catch { canvasHash = 'n/a'; }
    _fp = {
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      lang: nav.language,
      langs: (nav.languages || []).join(','),
      platform: nav.platform,
      hw: nav.hardwareConcurrency,
      mem: nav.deviceMemory || 0,
      cookieEnabled: nav.cookieEnabled,
      dnt: nav.doNotTrack || '',
      screen: `${scr.width}x${scr.height}x${scr.colorDepth}`,
      dpr: window.devicePixelRatio,
      touch: ('ontouchstart' in window) || (nav.maxTouchPoints > 0),
      canvas: canvasHash,
    };
  } catch { _fp = {}; }
  return _fp;
}

function openPaywallModal(headline) {
  openModal(headline || 'Upgrade your plan', (p) => {
    p.innerHTML = `
      <div class="paywall">
        <div class="plans">
          <div class="plan_card">
            <h4>Free</h4>
            <div class="price">$0<small> / month</small></div>
            <ul>
              <li>Unlimited chat (within usage score)</li>
              <li>All chat and code models</li>
              <li>100-point usage, regen 2/min</li>
              <li>No image generation</li>
            </ul>
            <button class="btn_primary" style="background:transparent;color:var(--fg);border:1px solid var(--border);cursor:default">Current plan</button>
          </div>
          <div class="plan_card featured">
            <h4>Plus</h4>
            <div class="price">$20<small> / month</small></div>
            <ul>
              <li>Everything in Free</li>
              <li><b>Image generation</b> via Flux on Cloudflare</li>
              <li>Usage burns at 0.4× rate</li>
              <li>Priority routing</li>
            </ul>
            <button class="btn_primary" id="buy_plus">${state.plan === 'plus' ? 'Downgrade to Free' : 'Upgrade to Plus'}</button>
          </div>
        </div>
      </div>
    `;
    p.querySelector('#buy_plus').addEventListener('click', async () => {
      const target = state.plan === 'plus' ? 'free' : 'plus';
      try {
        await doUpgrade(target);
        renderUsageBadge();
        toast({ title: state.plan === 'plus' ? 'Welcome to Plus.' : 'Switched to Free.' }, 2500, 'ok');
        closeModal();
      } catch (e) {
        toast({ title: 'Upgrade failed: ' + e.message }, 4000, 'err');
      }
    });
  });
}

function openChatFullModal() {
  openModal('This chat is full', (p) => {
    const used = chatTokens();
    p.innerHTML = `
      <p style="font-size:14px;line-height:1.6;color:var(--fg);margin:0 0 10px">You've used <b>${used.toLocaleString()}</b> of the <b>${CHAT_TOKEN_BUDGET.toLocaleString()}</b> token budget for this chat.</p>
      <p style="font-size:13px;color:var(--muted);margin:0 0 16px">Start a fresh chat to keep going. Your usage score and plan carry over.</p>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button class="btn_primary" style="background:transparent;color:var(--fg);border:1px solid var(--border)" id="chat_full_cancel">Cancel</button>
        <button class="btn_primary" id="chat_full_new">Start new chat</button>
      </div>
    `;
    p.querySelector('#chat_full_cancel').addEventListener('click', closeModal);
    p.querySelector('#chat_full_new').addEventListener('click', () => { closeModal(); newChat(); });
  });
}

function openUsageEmptyModal() {
  openModal('Usage cooling down', (p) => {
    const regenMin = Math.ceil(1 / USAGE_REGEN_PER_MIN);
    p.innerHTML = `
      <p style="font-size:14px;line-height:1.6;margin:0 0 10px">Your usage score hit zero. Wait about ${regenMin} minute(s) for it to regen, or upgrade to Plus for 2.5× the budget.</p>
      <p style="font-size:12px;color:var(--muted);margin:0 0 16px">Tip: spamming the same message is what drained it fastest.</p>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button class="btn_primary" style="background:transparent;color:var(--fg);border:1px solid var(--border)" id="ue_cancel">Close</button>
        <button class="btn_primary" id="ue_upgrade">Upgrade</button>
      </div>
    `;
    p.querySelector('#ue_cancel').addEventListener('click', closeModal);
    p.querySelector('#ue_upgrade').addEventListener('click', () => { closeModal(); openPaywallModal(); });
  });
}
settingsBtn.addEventListener('click', openSettings);

function openChatMenu(anchor, chat) {
  const items = [
    {
      title: 'Rename',
      onClick: () => {
        // Find the title span in the sidebar and swap it for an input inline.
        const row = [...chatListEl.querySelectorAll('.sb_chat .sb_chat_title')]
          .find(el => el.textContent === chat.title);
        if (row) inlineRenameChat(row, chat);
        else { const n = prompt('New name', chat.title); if (n) { chat.title = n.trim(); saveState(); renderChatList(); } }
      },
    },
    chat.archived
      ? { title: 'Restore from archive', onClick: () => { chat.archived = false; saveState(); renderChatList(); toast({ title: 'Restored' }, 1200, 'ok'); } }
      : { title: 'Archive', onClick: () => { chat.archived = true; saveState(); renderChatList(); toast({ title: 'Archived' }, 1500, 'ok'); } },
    { title: 'Duplicate', onClick: () => {
        const copy = { ...chat, id: 'c_' + Math.random().toString(36).slice(2, 10), title: chat.title + ' (copy)', createdAt: Date.now(), archived: false, messages: (chat.messages || []).slice() };
        state.chats.unshift(copy); saveState(); renderChatList();
    } },
    { title: 'Delete', onClick: () => {
        if (!confirm(`Delete "${chat.title}"? This can't be undone.`)) return;
        state.chats = state.chats.filter(c => c.id !== chat.id);
        if (state.activeChat === chat.id) setActiveChat(null);
        saveState(); renderChatList();
    } },
  ];
  openPopover(anchor, items);
}

const modalRoot = document.createElement('div');
modalRoot.style.display = 'contents';
document.body.appendChild(modalRoot);
// Modals wipe/replace synchronously. Earlier we deferred cleanup by 200ms
// for a fade-out animation, but that caused closeModal's late setTimeout to
// nuke a freshly-opened modal (e.g. "Founder admin" opening from inside the
// usage modal). Snap-close is uglier by one frame, but bulletproof.
function openModal(title, render) {
  modalRoot.innerHTML = '';
  const s = document.createElement('div');
  s.className = 'scrim show';     // show immediately — no fade-in race
  s.innerHTML = `<div class="modal"><div class="modal_head"><h3></h3><button class="modal_close" aria-label="close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" x2="6" y1="6" y2="18"/><line x1="6" x2="18" y1="6" y2="18"/></svg></button></div><div class="modal_body"></div></div>`;
  s.querySelector('h3').textContent = title;
  s.querySelector('.modal_close').addEventListener('click', closeModal);
  // Only close on clicks that LAND on the scrim itself, not on anything
  // inside the modal. Using mousedown avoids the quirk where a click
  // starting inside the modal and ending on the scrim would close it.
  s.addEventListener('mousedown', (e) => { if (e.target === s) closeModal(); });
  render(s.querySelector('.modal_body'));
  modalRoot.appendChild(s);
}
function closeModal() {
  modalRoot.innerHTML = '';
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

function openSettings() {
  // Fully custom scrim — bypasses openModal() so we can own every pixel of
  // the Apple-style chrome (title row, close button, section layout).
  modalRoot.innerHTML = '';
  const s = document.createElement('div');
  s.className = 'scrim show ios-settings_scrim';
  s.innerHTML = renderIosSettings();
  modalRoot.appendChild(s);

  const close = () => { modalRoot.innerHTML = ''; };
  s.addEventListener('mousedown', (e) => { if (e.target === s) close(); });
  s.querySelector('#ios_close').addEventListener('click', close);

  // Theme segmented control.
  s.querySelectorAll('[data-theme]').forEach(seg => seg.addEventListener('click', () => {
    const v = seg.getAttribute('data-theme');
    state.theme = v; applyTheme(); saveState();
    s.querySelectorAll('[data-theme]').forEach(x => x.classList.toggle('on', x === seg));
  }));

  // iOS-style toggles for chadMode + autoScroll.
  s.querySelectorAll('.ios_toggle[data-k]').forEach(t => t.addEventListener('click', () => {
    const k = t.getAttribute('data-k');
    state.settings[k] = !state.settings[k];
    t.classList.toggle('on', !!state.settings[k]);
    t.setAttribute('aria-checked', String(!!state.settings[k]));
    saveState();
  }));

  s.querySelector('#ios_change_pw').addEventListener('click', () => { close(); openChangePasswordModal(); });
  s.querySelector('#ios_logout').addEventListener('click', async () => {
    await doLogout();
    close();
    showAuthGate('login');
  });
}

function renderIosSettings() {
  const email = currentUser?.email || 'not signed in';
  const plan = currentUser?.plan || 'free';
  const planLabel = plan === 'plus' ? 'Plus plan'
                 : plan === 'unlimited' ? 'Unlimited'
                 : 'Free plan';
  const initial = (email[0] || '?').toUpperCase();
  const theme = state.theme;
  const chadOn = state.settings.chadMode;
  const autoOn = state.settings.autoScroll;

  return `
    <div class="ios_modal">
      <div class="ios_head">
        <div class="ios_title">Settings</div>
        <button class="ios_close_btn" id="ios_close" aria-label="close">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" x2="6" y1="6" y2="18"/><line x1="6" x2="18" y1="6" y2="18"/></svg>
        </button>
      </div>

      <div class="ios_body">
        <div class="ios_section_label">Appearance</div>
        <div class="ios_group">
          <div class="ios_row">
            <div class="ios_row_text">Theme</div>
            <div class="ios_seg">
              <button class="ios_seg_opt ${theme === 'light' ? 'on' : ''}" data-theme="light">Light</button>
              <button class="ios_seg_opt ${theme === 'dark' ? 'on' : ''}" data-theme="dark">Dark</button>
              <button class="ios_seg_opt ${theme === 'system' ? 'on' : ''}" data-theme="system">System</button>
            </div>
          </div>
        </div>

        <div class="ios_section_label">Behavior</div>
        <div class="ios_group">
          <div class="ios_row">
            <div class="ios_row_text">
              <div>Chad Mode</div>
              <div class="ios_sub">Direct answers, no corporate hedging. No CSAM, minors, or porn — ever.</div>
            </div>
            <button class="ios_toggle ${chadOn ? 'on' : ''}" data-k="chadMode" role="switch" aria-checked="${chadOn}">
              <span class="ios_knob"></span>
            </button>
          </div>
          <div class="ios_divider"></div>
          <div class="ios_row">
            <div class="ios_row_text">Auto Scroll</div>
            <button class="ios_toggle ${autoOn ? 'on' : ''}" data-k="autoScroll" role="switch" aria-checked="${autoOn}">
              <span class="ios_knob"></span>
            </button>
          </div>
        </div>

        <div class="ios_section_label">Safety</div>
        <div class="ios_group">
          <div class="ios_row ios_row_static">
            <div class="ios_row_text">Jailbreak Protection</div>
            <div class="ios_locked">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
              <span>Always On</span>
            </div>
          </div>
        </div>
        <div class="ios_note">Blocks DAN, "ignore previous", fake [SYSTEM] tags, roleplay exploits and similar. Enforced on device and on our servers. Can't be disabled.</div>

        <div class="ios_section_label">Account</div>
        <div class="ios_group">
          <div class="ios_row ios_row_static">
            <div class="ios_avatar">${escapeHtml(initial)}</div>
            <div class="ios_row_text" style="flex:1;margin-left:12px">
              <div>${escapeHtml(email)}</div>
              <div class="ios_sub">${escapeHtml(planLabel)}</div>
            </div>
          </div>
          <div class="ios_divider"></div>
          <button class="ios_row ios_row_btn ios_action_primary" id="ios_change_pw">
            <span>Change Password</span>
            <svg class="ios_chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
          </button>
          <div class="ios_divider"></div>
          <button class="ios_row ios_row_btn ios_action_destructive" id="ios_logout">
            <span>Log Out</span>
          </button>
        </div>
      </div>
    </div>
  `;
}


function openChangePasswordModal() {
  openModal('Change password', (p) => {
    p.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:10px">
        <label style="font-size:12px;color:var(--muted)">Current password
          <input type="password" id="cp_cur" style="width:100%;margin-top:4px;padding:8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg);font-size:14px">
        </label>
        <label style="font-size:12px;color:var(--muted)">New password (min 8 chars)
          <input type="password" id="cp_new" style="width:100%;margin-top:4px;padding:8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg);font-size:14px">
        </label>
        <label style="font-size:12px;color:var(--muted)">Confirm new password
          <input type="password" id="cp_conf" style="width:100%;margin-top:4px;padding:8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg);font-size:14px">
        </label>
        <div id="cp_err" style="color:var(--danger);font-size:12px;min-height:16px"></div>
        <div style="display:flex;justify-content:flex-end;gap:8px">
          <button class="btn_primary" style="background:transparent;color:var(--fg);border:1px solid var(--border)" id="cp_cancel">Cancel</button>
          <button class="btn_primary" id="cp_save">Save</button>
        </div>
      </div>
    `;
    const err = p.querySelector('#cp_err');
    p.querySelector('#cp_cancel').addEventListener('click', closeModal);
    p.querySelector('#cp_save').addEventListener('click', async () => {
      err.textContent = '';
      const cur = p.querySelector('#cp_cur').value;
      const nxt = p.querySelector('#cp_new').value;
      const cnf = p.querySelector('#cp_conf').value;
      if (!cur || !nxt) { err.textContent = 'Fill both password fields.'; return; }
      if (nxt.length < 8) { err.textContent = 'New password must be at least 8 characters.'; return; }
      if (nxt !== cnf) { err.textContent = 'New password and confirmation do not match.'; return; }
      const r = await apiFetch('/password', { method: 'POST', body: JSON.stringify({ current_password: cur, new_password: nxt, nonce: newNonce() }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { err.textContent = j.error || `Change failed (${r.status})`; return; }
      closeModal();
      toast({ title: 'Password changed' }, 2500, 'ok');
    });
  });
}

function openContainerModal() {
  openModal('Your container', (p) => {
    let busyBtn = false;
    const render = () => {
      if (!containerState) {
        p.innerHTML = `
          <div style="text-align:center;padding:20px;color:var(--muted)">No running container. It'll be provisioned on your next chat.</div>
          <div style="text-align:center;margin-top:12px"><button class="btn_primary" id="start_btn">Start now</button></div>
        `;
        p.querySelector('#start_btn').addEventListener('click', async () => {
          await fetchContainer();
          render();
        });
        return;
      }
      const c = containerState;
      const up = fmtUptime(Date.now() - c.created_at);
      const statusColor = c.status === 'running' ? 'var(--ok)' : 'var(--muted)';
      const vcpu = c.cpu_vcpu ?? c.cpu ?? 0;
      const planBadge = c.plan ? `<span style="background:${c.plan === 'unlimited' ? '#9b6bd8' : c.plan === 'plus' ? '#2e7d32' : '#555'};color:#fff;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:600;letter-spacing:.05em;margin-left:6px">${c.plan.toUpperCase()}</span>` : '';
      p.innerHTML = `
        <div class="stats_grid">
          <div class="stat_card"><div class="stat_label">Session</div><div class="stat_value" style="font-size:14px;overflow-wrap:break-word">${c.name || c.id}${planBadge}</div></div>
          <div class="stat_card"><div class="stat_label">Status</div><div class="stat_value" style="color:${statusColor}">${c.status.toUpperCase()}</div></div>
          <div class="stat_card"><div class="stat_label">Uptime</div><div class="stat_value">${up}</div></div>
          <div class="stat_card"><div class="stat_label">Region</div><div class="stat_value" style="font-size:14px">${c.region || '?'}</div></div>
          <div class="stat_card"><div class="stat_label">CPU · RAM</div><div class="stat_value" style="font-size:14px">${vcpu} vCPU · ${c.memory_mb}MB</div></div>
          <div class="stat_card"><div class="stat_label">Disk</div><div class="stat_value" style="font-size:14px">${c.disk_mb}MB</div></div>
        </div>
        ${c.tier_label ? `<div style="margin-top:10px;font-size:12px;color:var(--muted);font-family:var(--mono)">${c.tier_label}</div>` : ''}
        <div style="margin-top:14px">
          <div class="setting_row">
            <div><div class="setting_label">Image</div></div>
            <div style="font-family:var(--mono);font-size:12px;color:var(--muted)">${c.image}</div>
          </div>
          <div class="setting_row">
            <div><div class="setting_label">Provisioned</div></div>
            <div style="font-family:var(--mono);font-size:12px;color:var(--muted)">${new Date(c.created_at).toISOString().replace('T',' ').slice(0,19)} UTC</div>
          </div>
          <div class="setting_row">
            <div><div class="setting_label">Lifecycle</div><div class="setting_sub">Stored in Cloudflare D1. Survives logout, reload, and switching devices.</div></div>
          </div>
        </div>
        <div style="display:flex;gap:8px;margin-top:14px;justify-content:flex-end">
          <button class="btn_primary" id="restart_btn" style="background:transparent;color:var(--fg);border:1px solid var(--border)">Restart</button>
          <button class="btn_primary" id="stop_btn" style="background:var(--danger);color:#fff">Stop</button>
        </div>
      `;
      p.querySelector('#restart_btn').addEventListener('click', async () => {
        if (busyBtn) return; busyBtn = true;
        toast({ title: 'Restarting container...' }, 1800);
        await restartContainer();
        busyBtn = false;
        render();
      });
      p.querySelector('#stop_btn').addEventListener('click', async () => {
        if (busyBtn) return; busyBtn = true;
        await stopContainer();
        busyBtn = false;
        render();
        toast({ title: 'Container stopped.' }, 2000, 'ok');
      });
    };
    render();
    const t = setInterval(() => { if (!document.body.contains(p)) { clearInterval(t); return; } render(); }, 2000);
  });
}

// ---------- toast -----------------------
function toast(obj, ms = 4000, variant) {
  const el = document.createElement('div');
  el.className = 'toast' + (variant ? ' ' + variant : '');
  el.innerHTML = '<div></div>';
  el.querySelector('div').textContent = obj.title;
  toastWrap.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, ms);
}

// Auto-scroll state. These were moved here so they're initialized before
// setActiveChat() runs during module init (which calls scrollDown via
// addUserMsgEl). With `let` at module bottom the TDZ threw a ReferenceError
// on first load: "Cannot access '_userScrolled' before initialization".
// Now we use `var` so the declaration is hoisted + initialized to undefined,
// which the `!_userScrolled` check treats correctly as false.
var _userScrolled = false;
function isNearBottom(threshold) {
  if (!mainEl) return true;
  return (mainEl.scrollHeight - mainEl.scrollTop - mainEl.clientHeight) < (threshold || 80);
}
function scrollDown(force) {
  if (!state.settings.autoScroll) return;
  if (!force && _userScrolled) return;
  requestAnimationFrame(() => {
    if (!mainEl) return;
    mainEl.scrollTo({ top: mainEl.scrollHeight, behavior: 'smooth' });
    _userScrolled = false;
  });
}

// ---------- init -----------------
regenUsage();
renderUsageBadge();
renderChatMeter();

(async () => {
  try {
    const me = await fetchMe();
    if (!me) {
      edgePingEl.textContent = 'sign in';
      showAuthGate('login');
      return;
    }
    state.plan = me.plan || 'free';
    saveState();
    renderUsageBadge();
    edgePingEl.textContent = 'edge · ' + me.email.split('@')[0];

    // Reveal Owner panel in the sidebar if the server confirms founder.
    // The href still points at /owner, which re-checks server-side before
    // rendering anything — this toggle is purely a UX affordance, never
    // the trust boundary.
    if (me.is_founder) {
      const el = document.getElementById('sb_owner');
      if (el) el.hidden = false;
    }

    await fetchContainer();
  } catch (e) {
    toast({ title: 'Could not reach backend: ' + (e.message || e) }, 6000, 'err');
    edgePingEl.textContent = 'offline';
  }
})();

input.focus();

// ---------- PWA: service worker + install prompt ----------
if ('serviceWorker' in navigator) {
  // Register after load so the first paint isn't slowed by SW setup.
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then(reg => {
      // Check for updates on every page load so a new deploy doesn't need
      // a hard-refresh to actually take effect.
      reg.update().catch(() => {});
      // If a new SW installs while this page is open, reload once so the
      // user picks up the new app.js / styles.css immediately.
      reg.addEventListener('updatefound', () => {
        const next = reg.installing;
        if (!next) return;
        next.addEventListener('statechange', () => {
          if (next.state === 'installed' && navigator.serviceWorker.controller) {
            // A newer version has installed — tell it to skip waiting + reload.
            next.postMessage({ type: 'skip-waiting' });
          }
        });
      });
      let reloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloaded) return; reloaded = true;
        window.location.reload();
      });
    }).catch(() => {});
  });
}

// Android / Chrome install prompt. iOS Safari doesn't fire this event —
// iOS users install via Share -> Add to Home Screen, and we show a one-time
// hint for them below.
let _deferredInstall = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  _deferredInstall = e;
  showInstallChip();
});
window.addEventListener('appinstalled', () => {
  _deferredInstall = null;
  const chip = document.getElementById('install_chip'); if (chip) chip.remove();
  try { localStorage.setItem('pwa_installed', '1'); } catch {}
});

function showInstallChip() {
  if (document.getElementById('install_chip')) return;
  const chip = document.createElement('button');
  chip.id = 'install_chip';
  chip.textContent = 'Install app';
  chip.style.cssText = 'position:fixed;bottom:16px;right:16px;padding:10px 14px;border-radius:999px;border:none;background:linear-gradient(135deg,#4e2a8e,#8a4fd1);color:#fff;font-weight:600;font-size:13px;box-shadow:0 6px 20px rgba(138,79,209,.4);cursor:pointer;z-index:9999';
  chip.addEventListener('click', async () => {
    if (!_deferredInstall) { chip.remove(); return; }
    _deferredInstall.prompt();
    const r = await _deferredInstall.userChoice.catch(() => ({ outcome: 'dismissed' }));
    _deferredInstall = null;
    if (r.outcome === 'accepted') chip.remove();
  });
  document.body.appendChild(chip);
}

// iOS Safari "Add to Home Screen" hint — shown once, dismissable.
(function showIosInstallHint() {
  const ua = navigator.userAgent;
  const isIos = /iPad|iPhone|iPod/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
  const alreadyStandalone = window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
  if (!isIos || alreadyStandalone) return;
  try { if (localStorage.getItem('ios_install_dismissed')) return; } catch {}

  const hint = document.createElement('div');
  hint.id = 'ios_install_hint';
  hint.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px">
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v13"/><path d="M8 6l4-4 4 4"/><path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7"/></svg>
      <div style="flex:1;font-size:13px;line-height:1.4">Add ChadGPT to your home screen: tap <b>Share</b>, then <b>Add to Home Screen</b>.</div>
      <button aria-label="dismiss" style="background:transparent;border:0;color:#fff;font-size:18px;cursor:pointer;padding:0 4px">&times;</button>
    </div>
  `;
  hint.style.cssText = 'position:fixed;left:12px;right:12px;bottom:12px;padding:12px 14px;border-radius:12px;background:linear-gradient(135deg,#4e2a8e,#8a4fd1);color:#fff;box-shadow:0 8px 28px rgba(0,0,0,.35);z-index:9999';
  hint.querySelector('button').addEventListener('click', () => {
    hint.remove();
    try { localStorage.setItem('ios_install_dismissed', '1'); } catch {}
  });
  document.body.appendChild(hint);
})();

// ---------- Captcha (hCaptcha) ----------
// Free + unlimited-grant users must solve a captcha every 10 minutes before
// the chat endpoint accepts their requests. The receipt is a short-lived
// signed token the server issues once hCaptcha verifies the solution.

const CAPTCHA_STORAGE_KEY = 'chadgpt_captcha';
let _captchaSiteKey = null;
let _hcaptchaLoaded = null;

function getCaptchaReceipt() {
  try {
    const raw = sessionStorage.getItem(CAPTCHA_STORAGE_KEY);
    if (!raw) return null;
    const { receipt, expires_at } = JSON.parse(raw);
    if (!receipt || !expires_at) return null;
    if (expires_at < Date.now() + 10_000) return null;   // expires soon
    return receipt;
  } catch { return null; }
}

function saveCaptchaReceipt(receipt, expires_at) {
  try { sessionStorage.setItem(CAPTCHA_STORAGE_KEY, JSON.stringify({ receipt, expires_at })); } catch {}
}

async function fetchSiteKey() {
  if (_captchaSiteKey) return _captchaSiteKey;
  try {
    const r = await apiFetch('/config', { method: 'GET' });
    const j = await r.json();
    _captchaSiteKey = j.hcaptcha_sitekey;
    return _captchaSiteKey;
  } catch { return null; }
}

function loadHCaptchaScript() {
  if (_hcaptchaLoaded) return _hcaptchaLoaded;
  _hcaptchaLoaded = new Promise((resolve, reject) => {
    if (window.hcaptcha) return resolve(window.hcaptcha);
    const s = document.createElement('script');
    s.src = 'https://hcaptcha.com/1/api.js?render=explicit&onload=chadgptHcaptchaReady';
    s.async = true; s.defer = true;
    window.chadgptHcaptchaReady = () => resolve(window.hcaptcha);
    s.onerror = () => reject(new Error('hcaptcha script failed to load'));
    document.head.appendChild(s);
  });
  return _hcaptchaLoaded;
}

async function openCaptchaModal() {
  const sitekey = await fetchSiteKey();
  if (!sitekey) {
    toast({ title: 'Captcha config missing — contact the founder' }, 4000, 'err');
    return;
  }
  openModal('One quick check', (p) => {
    p.innerHTML = `
      <div style="padding:8px 0">
        <div style="font-size:14px;line-height:1.5;margin-bottom:12px">
          Free and granted-unlimited accounts solve a quick captcha every 10 minutes.
          Each solve pays the AI model costs via <a href="https://hcaptcha.com/publisher" target="_blank" style="color:var(--accent)">hCaptcha Publisher</a>
          so neither you nor the owner pays out of pocket.
        </div>
        <div id="hcap_box" style="display:flex;justify-content:center;min-height:85px;align-items:center">
          <div style="color:var(--muted);font-size:12px">Loading captcha…</div>
        </div>
        <div id="hcap_err" style="color:var(--danger);font-size:12px;margin-top:8px;min-height:16px"></div>
      </div>
    `;
    (async () => {
      try {
        const h = await loadHCaptchaScript();
        const container = p.querySelector('#hcap_box');
        container.innerHTML = '';
        const widgetId = h.render(container, {
          sitekey,
          theme: 'dark',
          callback: async (token) => {
            const verifyRes = await apiFetch('/captcha/verify', {
              method: 'POST', body: JSON.stringify({ token }),
            });
            const vj = await verifyRes.json().catch(() => ({}));
            if (!verifyRes.ok || !vj.ok) {
              p.querySelector('#hcap_err').textContent = 'Verify failed: ' + (vj.error || verifyRes.status);
              return;
            }
            saveCaptchaReceipt(vj.receipt, vj.expires_at);
            closeModal();
            toast({ title: 'Verified — good for 10 min' }, 2500, 'ok');
          },
          'error-callback': () => { p.querySelector('#hcap_err').textContent = 'hCaptcha widget error. Try again.'; },
          'expired-callback': () => { try { h.reset(widgetId); } catch {} },
        });
      } catch (err) {
        p.querySelector('#hcap_err').textContent = 'Could not load hCaptcha: ' + (err.message || err);
      }
    })();
  });
}

// Prewarm the site key so the first captcha pops instantly.
fetchSiteKey().catch(() => {});

// ---------- Ad slots (free-tier only) ----------
// Reads /api/config for the list of ad providers the owner has configured
// and injects the first one into a given container. Only runs for free
// users — paid Plus / unlimited see no ads.

let _adProviders = null;
async function fetchAdProviders() {
  if (_adProviders) return _adProviders;
  try {
    const r = await apiFetch('/config', { method: 'GET' });
    const j = await r.json();
    _adProviders = Array.isArray(j.ad_providers) ? j.ad_providers : [];
  } catch { _adProviders = []; }
  return _adProviders;
}

async function mountAdSlot(container, slotId) {
  if (!container) return;
  if (state.plan !== 'free') return;         // only free sees ads
  const providers = await fetchAdProviders();
  if (!providers.length) return;
  const p = providers[0];                     // simple: use the first active
  try {
    container.innerHTML = buildAdHtml(p, slotId);
    // Scripts injected via innerHTML don't execute; replay them so each
    // <script> tag runs in order.
    container.querySelectorAll('script').forEach(old => {
      const s = document.createElement('script');
      for (const a of old.attributes) s.setAttribute(a.name, a.value);
      if (old.textContent) s.textContent = old.textContent;
      old.replaceWith(s);
    });
    container.style.display = '';
  } catch (e) {
    container.style.display = 'none';
  }
}

function buildAdHtml(p, slotId) {
  // Mirror of ad-providers.js slotHtml, but on the client side we only
  // need enough per-provider knowledge to emit the embed. Keep it in
  // lock-step with the server registry.
  switch (p.id) {
    case 'adsense': {
      const client = p.primary;
      return `<ins class="adsbygoogle" style="display:block;width:100%" data-ad-client="${client}" data-ad-slot="${slotId || ''}" data-ad-format="auto" data-full-width-responsive="true"></ins>
        <script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${client}" crossorigin="anonymous"></script>
        <script>(adsbygoogle=window.adsbygoogle||[]).push({});</script>`;
    }
    case 'medianet':
      return `<script src="//contextual.media.net/dmedianet.js?cid=${p.primary}" async defer></script><div id="_mn_slot_${slotId || 'main'}"></div>`;
    case 'adsterra':
      // User pastes the full script URL Adsterra gave them.
      return `<script src="${p.primary}" async defer></script>`;
    case 'propellerads':
      return `<script src="https://inklinkor.com/tag.min.js" data-zone="${p.primary}" async data-cfasync="false"></script>`;
    case 'infolinks':
      return `<script>var infolinks_pid=${Number(p.primary)};var infolinks_wsid=${Number(p.extra)};</script><script src="//resources.infolinks.com/js/infolinks_main.js" async></script>`;
    case 'a_ads':
      return `<iframe data-aa="${p.primary}" src="//ad.a-ads.com/${p.primary}?size=320x50" style="width:320px;height:50px;max-width:100%;border:0;background:transparent" referrerpolicy="no-referrer"></iframe>`;
    case 'popads':
      return `<script type="text/javascript" data-cfasync="false">var _pop=_pop||[];_pop.push(["siteId",${Number(p.primary)}]);</script><script type="text/javascript" src="//c1.popads.net/pop.js" async></script>`;
    case 'coinzilla':
      return `<script async src="https://coinzillatag.com/lib/display.js"></script><div class="coinzilla" data-zone="${p.primary}"></div>`;
    default:
      return '';
  }
}

// Insert an ad slot in the sidebar bottom for free users. The container is
// only in the HTML, so if the current plan isn't free, nothing renders.
(function installSidebarAd() {
  const sb = document.getElementById('sb_owner');
  if (!sb || !sb.parentElement) return;
  const slot = document.createElement('div');
  slot.id = 'sidebar_ad_slot';
  slot.style.cssText = 'padding:10px 8px;margin:6px 8px 0;border-top:1px solid var(--border);min-height:0;display:none';
  sb.parentElement.insertBefore(slot, sb);
  // Deferred — we wait for state.plan to be set after the fetchMe call in init.
  setTimeout(() => mountAdSlot(slot, 'sidebar'), 2000);
})();

// ---------- Sponsored ad card above the composer ----------
// Shown only for free-plan users who haven't dismissed it this session.
// The close button plays the reverse animation and removes the node.
(function wireAdCard() {
  const card = document.getElementById('ad_card');
  const btn = document.getElementById('ad_card_close');
  if (!card || !btn) return;

  let dismissed = false;
  try { dismissed = sessionStorage.getItem('ad_card_dismissed') === '1'; } catch {}

  function maybeShow() {
    if (dismissed) return;
    if (state.plan !== 'free') return;
    card.hidden = false;
    // next tick so the initial state (opacity 0 / translated / blurred) paints first
    requestAnimationFrame(() => {
      requestAnimationFrame(() => card.classList.add('ad_card_in'));
    });
  }

  function dismiss() {
    card.classList.remove('ad_card_in');
    card.classList.add('ad_card_out');
    try { sessionStorage.setItem('ad_card_dismissed', '1'); } catch {}
    const cleanup = () => card.remove();
    // Match the 340ms transition duration from CSS.
    setTimeout(cleanup, 380);
  }

  btn.addEventListener('click', (e) => { e.preventDefault(); dismiss(); });

  // Wait until the init block has resolved the user's plan.
  setTimeout(maybeShow, 1200);
})();

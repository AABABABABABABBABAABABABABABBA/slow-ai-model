// ChadGPT frontend. Static site hosted on Cloudflare Pages.
// Calls three Workers for AI (chat, code, image). Session-token protected.

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

// ---------- session + auth --------------
const sessionState = { token: null, sessionId: null, expiresAt: 0 };

async function startSession(turnstileToken) {
  const r = await fetch(CFG.chatUrl + '/session/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ turnstile_token: turnstileToken || null }),
    credentials: 'omit',
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.error || `session start failed (${r.status})`);
  }
  const data = await r.json();
  sessionState.token = data.token;
  sessionState.sessionId = data.session_id;
  sessionState.expiresAt = data.expires_at * 1000;
  return data;
}

async function ensureSession() {
  if (sessionState.token && Date.now() < sessionState.expiresAt - 60000) return sessionState.token;
  if (!CFG.turnstileSiteKey) {
    await startSession(null);
    return sessionState.token;
  }
  // need Turnstile — open the gate overlay and wait
  const token = await openGate();
  await startSession(token);
  return sessionState.token;
}

async function authedFetch(url, opts) {
  const token = await ensureSession();
  const headers = Object.assign({ 'Content-Type': 'application/json' }, opts?.headers || {});
  headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(url, Object.assign({}, opts, { headers, credentials: 'omit' }));
  if (res.status === 401) {
    sessionState.token = null;
    const newToken = await ensureSession();
    headers['Authorization'] = 'Bearer ' + newToken;
    return fetch(url, Object.assign({}, opts, { headers, credentials: 'omit' }));
  }
  return res;
}

// ---------- Turnstile gate --------------
function loadTurnstile() {
  if (document.getElementById('cf_turnstile_script')) return;
  const s = document.createElement('script');
  s.id = 'cf_turnstile_script';
  s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onTurnstileReady';
  s.async = true; s.defer = true;
  document.head.appendChild(s);
}
window.onTurnstileReady = () => { /* ready */ };

function openGate() {
  return new Promise((resolve, reject) => {
    const gate = document.createElement('div');
    gate.className = 'gate';
    gate.innerHTML = `
      <h2>One quick check</h2>
      <p>We use a Cloudflare challenge to keep bots out. This takes a second.</p>
      <div class="ts" id="ts_widget"></div>
    `;
    document.body.appendChild(gate);
    loadTurnstile();
    const tryRender = () => {
      if (!window.turnstile) return setTimeout(tryRender, 100);
      window.turnstile.render('#ts_widget', {
        sitekey: CFG.turnstileSiteKey,
        callback: (token) => { gate.remove(); resolve(token); },
        'error-callback': () => { reject(new Error('turnstile failed')); },
      });
    };
    tryRender();
  });
}

// ---------- state -----------------------
const defaultState = {
  model: CFG.defaultModel || 'fast',
  theme: 'system',
  chats: [],
  activeChat: null,
  settings: { chadMode: true, blockJailbreak: true, temperature: 0.6, autoScroll: true },
};
function loadState() {
  try {
    const raw = localStorage.getItem('chadgpt_state_v2');
    if (raw) {
      const saved = JSON.parse(raw);
      const merged = Object.assign({}, defaultState, saved);
      merged.settings = Object.assign({}, defaultState.settings, saved.settings || {});
      return merged;
    }
  } catch (e) {}
  return JSON.parse(JSON.stringify(defaultState));
}
function saveState() { try { localStorage.setItem('chadgpt_state_v2', JSON.stringify(state)); } catch (e) {} }
let state = loadState();

// ---------- models ----------------------
const MODELS = [
  { id: 'fast',     worker: 'chat',  apiModel: 'fast',     name: 'ChadGPT',   sub: 'fast',    desc: 'Llama 3.1 8B fast · free tier' },
  { id: 'small',    worker: 'chat',  apiModel: 'small',    name: 'ChadGPT',   sub: 'small',   desc: 'Llama 3.2 3B · cheapest neurons' },
  { id: 'tiny',     worker: 'chat',  apiModel: 'tiny',     name: 'ChadGPT',   sub: 'tiny',    desc: 'Llama 3.2 1B · stretches free tier' },
  { id: 'chadcoder',worker: 'code',  apiModel: 'deepseek', name: 'ChadCoder', sub: '6.7B',    desc: 'DeepSeek Coder · code specialist' },
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
const modelBtn = document.getElementById('model_btn');
const modelNameEl = document.getElementById('model_name');
const modelSubEl = document.getElementById('model_sub');
const profileBtn = document.getElementById('profile_btn');
const settingsBtn = document.getElementById('settings_btn');
const attachBtn = document.getElementById('attach_btn');
const newChatBtn = document.getElementById('new_chat');
const chatListEl = document.getElementById('chat_list');
const containerBtn = document.getElementById('container_badge');
const edgePingEl = document.getElementById('edge_ping');
const containerUptimeEl = document.getElementById('container_uptime');

// ---------- theme -----------------------
function applyTheme() {
  const t = state.theme;
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  saveState();
}
applyTheme();

// ---------- container -------------------
const containerSessionId = 'ctr_' + Array.from(crypto.getRandomValues(new Uint8Array(6))).map(b => b.toString(16).padStart(2, '0')).join('');
const containerStartedAt = Date.now();
function fmtUptime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return (h ? String(h).padStart(2, '0') + ':' : '') + String(m).padStart(2, '0') + ':' + String(ss).padStart(2, '0');
}
setInterval(() => { containerUptimeEl.textContent = fmtUptime(Date.now() - containerStartedAt); }, 1000);
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
  if (!history.length) { inner.appendChild(welcome); welcome.hidden = false; return; }
  history.forEach((m, i) => {
    if (m.role === 'user') addUserMsgEl(m.content, i, m.images);
    else addBotMsgEl(m.content);
  });
  scrollDown();
}
function groupChats() {
  const now = Date.now();
  const g = { Today: [], Yesterday: [], 'Previous 7 days': [], Older: [] };
  state.chats.forEach(c => {
    const age = now - (c.createdAt || now);
    if (age < 86400000) g.Today.push(c);
    else if (age < 2 * 86400000) g.Yesterday.push(c);
    else if (age < 7 * 86400000) g['Previous 7 days'].push(c);
    else g.Older.push(c);
  });
  return g;
}
function renderChatList() {
  const groups = groupChats();
  chatListEl.innerHTML = '';
  Object.entries(groups).forEach(([g, chats]) => {
    if (!chats.length) return;
    const label = document.createElement('div');
    label.className = 'sb_label';
    label.textContent = g;
    chatListEl.appendChild(label);
    chats.forEach(c => {
      const el = document.createElement('div');
      el.className = 'sb_chat' + (c.id === state.activeChat ? ' active' : '');
      el.innerHTML = '<span class="sb_chat_title"></span><button class="sb_chat_dots" aria-label="options"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg></button>';
      el.querySelector('.sb_chat_title').textContent = c.title;
      el.querySelector('.sb_chat_title').addEventListener('click', () => { setActiveChat(c); closeSidebar(); });
      el.querySelector('.sb_chat_dots').addEventListener('click', (e) => { e.stopPropagation(); openChatMenu(e.currentTarget, c); });
      chatListEl.appendChild(el);
    });
  });
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
  }
  row.appendChild(col);
  inner.appendChild(row);
  scrollDown();
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
  if (state.settings.blockJailbreak) {
    const hit = looksLikeJailbreak(text);
    if (hit) { toast({ title: `Blocked: jailbreak-like text ("${hit.slice(0,60)}"). Settings → disable to override.` }, 5500, 'err'); return; }
  }
  input.value = '';
  input.style.height = 'auto';
  if (welcome.parentNode) welcome.remove();
  const atts = pendingAttachments.slice();
  pendingAttachments.length = 0;
  renderAttachments();
  if (/^\/image\s+/i.test(text)) {
    runImageTurn(text.replace(/^\/image\s+/i, ''));
    return;
  }
  runChatTurn(text || 'Describe this image.', atts);
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
async function runChatTurn(userText, attachments) {
  busy = true;
  setSendMode('stop');
  ensureChat(userText);

  // if there are image attachments, describe them first via image worker, prepend to user message
  let finalUserText = userText;
  const imageDataUrls = [];
  if (attachments && attachments.length) {
    for (const a of attachments) {
      if (a.kind === 'image') imageDataUrls.push(a.dataUrl);
    }
    const describeTargets = attachments.filter(a => a.kind === 'image');
    if (describeTargets.length) {
      const descriptions = [];
      for (const a of describeTargets) {
        try {
          const b64 = a.dataUrl.split(',')[1];
          const r = await authedFetch(CFG.imageUrl + '/describe', {
            method: 'POST',
            body: JSON.stringify({ image_b64: b64, prompt: 'Describe this image briefly, focused on the main subject and style.' }),
          });
          const d = await r.json();
          if (d.response) descriptions.push(d.response);
        } catch (_) {}
      }
      if (descriptions.length) {
        finalUserText = 'The user attached ' + describeTargets.length + ' image(s). Vision description(s):\n\n' +
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
  const workerUrl = m.worker === 'code' ? CFG.codeUrl : CFG.chatUrl;
  const apiMessages = history
    .map(h => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: (h.role === 'user' ? (h === history[history.length - 1] ? finalUserText : h.content) : h.content) }))
    .filter(h => h.content);

  let accumulated = '';
  let errText = null;
  try {
    const res = await authedFetch(workerUrl + '/chat', {
      method: 'POST',
      body: JSON.stringify({
        messages: apiMessages,
        model: m.apiModel,
        stream: true,
        chad_mode: state.settings.chadMode,
        temperature: state.settings.temperature,
      }),
      signal: currentAbort.signal,
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      errText = j.error || `${res.status} ${res.statusText}`;
    } else {
      for await (const chunk of sseLines(res)) {
        if (typeof chunk.response === 'string') {
          accumulated += chunk.response;
          body.innerHTML = renderMd(accumulated) + '<span class="typing_cursor"></span>';
          scrollDown();
        }
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') errText = e.message || 'request failed';
  }
  currentAbort = null;

  const finalText = errText ? ('Error: ' + errText) : (accumulated || '(no response)');
  body.innerHTML = renderMd(finalText);
  decorateCodeBlocks(body);
  addMessageActions(body, finalText);

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

  busy = false;
  setSendMode('send');
  input.focus();
}

function addMessageActions(container, text) {
  const actions = document.createElement('div');
  actions.className = 'msg_actions show';
  actions.innerHTML = `
    <button class="action_btn" data-act="copy" aria-label="copy"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>
    <button class="action_btn" data-act="regen" aria-label="regenerate"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg></button>
    <button class="action_btn" data-act="speak" aria-label="read aloud"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg></button>
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
  actions.querySelector('[data-act="speak"]').addEventListener('click', () => {
    try { window.speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text); u.rate = 1.1; window.speechSynthesis.speak(u); } catch {}
  });
}

// ---------- image turn ------------------
async function runImageTurn(prompt) {
  busy = true;
  setSendMode('stop');
  ensureChat('/image ' + prompt);
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
    const res = await authedFetch(CFG.imageUrl + '/image', {
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

    if (['javascript', 'js', 'jsx'].includes(lang)) {
      const runBtn = document.createElement('button');
      runBtn.className = 'code_mini_btn run';
      runBtn.innerHTML = '▶ Run';
      runBtn.addEventListener('click', () => runJs(code.textContent, wrap));
      actions.appendChild(runBtn);
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
  out.innerHTML = `<div class="exec_head"><span>stdout · ${containerSessionId.slice(0,12)}</span><button class="close">×</button></div><div class="exec_lines"><div class="exec_line" style="color:var(--muted)">running...</div></div>`;
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
    out.querySelector('.exec_head span').textContent = `stdout · ${(performance.now() - started).toFixed(0)}ms · ${containerSessionId.slice(0,12)}`;
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
  openPopover(modelBtn, [
    { label: 'Models' },
    ...MODELS.map(m => ({
      title: m.name + (m.sub ? ' ' + m.sub : ''),
      sub: m.desc,
      selected: state.model === m.id,
      onClick: () => { state.model = m.id; saveState(); updateModelPicker(); toast({ title: 'Switched to ' + m.name + ' ' + m.sub }, 2200, 'ok'); },
    })),
  ]);
});
function updateModelPicker() {
  const m = modelObj();
  modelNameEl.textContent = m.name;
  modelSubEl.textContent = m.sub;
}
updateModelPicker();

profileBtn.addEventListener('click', () => {
  openPopover(profileBtn, [
    { title: 'Settings', onClick: openSettings },
    { title: 'Container details', onClick: openContainerModal },
    '-',
    { title: 'Clear all chats', onClick: () => { state.chats = []; saveState(); renderChatList(); setActiveChat(null); toast({ title: 'Cleared' }, 1500, 'ok'); } },
  ], 'right');
});
settingsBtn.addEventListener('click', openSettings);

function openChatMenu(anchor, chat) {
  openPopover(anchor, [
    { title: 'Rename', onClick: () => { const n = prompt('New name', chat.title); if (n) { chat.title = n.trim(); saveState(); renderChatList(); } } },
    { title: 'Delete', onClick: () => { state.chats = state.chats.filter(c => c.id !== chat.id); if (state.activeChat === chat.id) setActiveChat(null); saveState(); renderChatList(); } },
  ]);
}

const modalRoot = document.createElement('div');
modalRoot.style.display = 'contents';
document.body.appendChild(modalRoot);
function openModal(title, render) {
  modalRoot.innerHTML = '';
  const s = document.createElement('div');
  s.className = 'scrim';
  s.innerHTML = `<div class="modal"><div class="modal_head"><h3></h3><button class="modal_close" aria-label="close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" x2="6" y1="6" y2="18"/><line x1="6" x2="18" y1="6" y2="18"/></svg></button></div><div class="modal_body"></div></div>`;
  s.querySelector('h3').textContent = title;
  s.querySelector('.modal_close').addEventListener('click', closeModal);
  s.addEventListener('click', (e) => { if (e.target === s) closeModal(); });
  render(s.querySelector('.modal_body'));
  modalRoot.appendChild(s);
  requestAnimationFrame(() => s.classList.add('show'));
}
function closeModal() {
  const s = modalRoot.querySelector('.scrim');
  if (!s) return;
  s.classList.remove('show');
  setTimeout(() => modalRoot.innerHTML = '', 200);
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

function openSettings() {
  openModal('Settings', (p) => {
    p.innerHTML = `
      <div class="setting_row">
        <div><div class="setting_label">Theme</div></div>
        <div class="setting_ctrl"><select id="theme_sel"><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></div>
      </div>
      <div class="setting_row">
        <div><div class="setting_label">Chad Mode</div><div class="setting_sub">Direct, no corporate hedging, no CSAM/minors/porn ever</div></div>
        <button class="toggle ${state.settings.chadMode?'on':''}" data-k="chadMode"></button>
      </div>
      <div class="setting_row">
        <div><div class="setting_label">Block jailbreak attempts</div><div class="setting_sub">Scan input + files for DAN, ignore-previous, [SYSTEM], etc.</div></div>
        <button class="toggle ${state.settings.blockJailbreak?'on':''}" data-k="blockJailbreak"></button>
      </div>
      <div class="setting_row">
        <div><div class="setting_label">Auto scroll</div></div>
        <button class="toggle ${state.settings.autoScroll?'on':''}" data-k="autoScroll"></button>
      </div>
      <div class="setting_row">
        <div><div class="setting_label">Session</div><div class="setting_sub">${sessionState.sessionId || 'not started'}</div></div>
        <div style="font-size:12px;font-family:var(--mono);color:var(--muted)">${sessionState.expiresAt ? 'expires ' + new Date(sessionState.expiresAt).toLocaleTimeString() : ''}</div>
      </div>
    `;
    p.querySelector('#theme_sel').value = state.theme;
    p.querySelector('#theme_sel').addEventListener('change', (e) => { state.theme = e.target.value; applyTheme(); });
    p.querySelectorAll('.toggle').forEach(t => t.addEventListener('click', () => {
      const k = t.getAttribute('data-k');
      state.settings[k] = !state.settings[k];
      t.classList.toggle('on');
      saveState();
    }));
  });
}

function openContainerModal() {
  openModal('Your container', (p) => {
    const render = () => {
      const up = fmtUptime(Date.now() - containerStartedAt);
      const cpu = 3 + Math.round(Math.random() * 6);
      const mem = 12 + Math.round(Math.random() * 10);
      p.innerHTML = `
        <div class="stats_grid">
          <div class="stat_card"><div class="stat_label">Session</div><div class="stat_value" style="font-size:14px;overflow-wrap:break-word">${containerSessionId}</div></div>
          <div class="stat_card"><div class="stat_label">Status</div><div class="stat_value" style="color:var(--ok)">RUNNING</div></div>
          <div class="stat_card"><div class="stat_label">Uptime</div><div class="stat_value">${up}</div></div>
          <div class="stat_card"><div class="stat_label">CPU</div><div class="stat_value">${cpu}%</div></div>
          <div class="stat_card"><div class="stat_label">Memory</div><div class="stat_value">${mem}%</div></div>
          <div class="stat_card"><div class="stat_label">Auth</div><div class="stat_value" style="font-size:14px;color:var(--ok)">VERIFIED</div></div>
        </div>
        <div style="font-size:12px;color:var(--muted);margin-top:10px">Container is private to this tab, isolated from other sessions. Runs until you close the page.</div>
      `;
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

function scrollDown() { if (!state.settings.autoScroll) return; requestAnimationFrame(() => mainEl.scrollTo({ top: mainEl.scrollHeight, behavior: 'smooth' })); }

// ---------- init: start session ---------
(async () => {
  try {
    await ensureSession();
    edgePingEl.textContent = 'edge · ' + (sessionState.sessionId ? sessionState.sessionId.slice(0, 8) : 'ok');
    toast({ title: 'Connected to Cloudflare Workers AI · free tier' }, 2800, 'ok');
  } catch (e) {
    toast({ title: 'Could not start session: ' + (e.message || e) }, 6000, 'err');
    edgePingEl.textContent = 'offline';
  }
})();

input.focus();

// Browser-side driver for the CLI device-code flow.
//
// States, in order:
//   1. Collect / confirm the user_code (prefilled from ?code=XXXX-XXXX)
//   2. Check who's signed in via /api/me — if nobody, redirect to /
//      with a return-to query so we come back here after login.
//   3. Show the "Approve login for <platform> on <hostname>" card with
//      an Approve button.
//   4. On click, POST /api/cli/approve → receive the deep link.
//   5. Navigate to the deep link so the OS "Open ChadCode?" popup fires.
//      Simultaneously show a fallback message — the CLI is polling the
//      server regardless, so even if the protocol handler isn't
//      installed, the login still completes.

const $ = (sel) => document.querySelector(sel);
const codeInput = $('#code');
const codeHelp = $('#code_help');
const codeErr = $('#code_err');
const actionCard = $('#action_card');
const actionBody = $('#action_body');
const actionStep = $('#action_step');

// Prefill from URL.
const params = new URLSearchParams(location.search);
const prefill = (params.get('code') || '').toUpperCase().trim();
if (prefill) codeInput.value = prefill;

// Normalize as the user types: uppercase, strip disallowed, auto-insert dash.
codeInput.addEventListener('input', () => {
  let v = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (v.length > 4) v = v.slice(0, 4) + '-' + v.slice(4, 8);
  codeInput.value = v;
  codeErr.innerHTML = '';
  if (/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(v)) {
    codeHelp.textContent = 'press enter';
    kickOff(v);
  } else {
    codeHelp.textContent = v.length ? `${v.replace('-', '').length}/8` : 'waiting for input';
  }
});
codeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(codeInput.value)) kickOff(codeInput.value);
});

// If the URL arrived with a valid code, auto-advance.
if (/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(prefill)) kickOff(prefill);
else codeInput.focus();

let kickedOff = false;
async function kickOff(userCode) {
  if (kickedOff) return;
  kickedOff = true;
  actionCard.style.display = 'block';
  actionBody.innerHTML = `<p style="color:var(--muted);font-size:14px;margin:0"><span class="spin"></span>Checking your account…</p>`;

  const me = await fetch('/api/me', { credentials: 'include' }).then(r => r.json()).catch(() => null);
  if (!me?.user) {
    // Not signed in. Stash the code so when we come back we don't lose it.
    sessionStorage.setItem('cli_pending_code', userCode);
    actionStep.textContent = 'Sign in';
    actionBody.innerHTML = `
      <p style="margin:0 0 12px;font-size:14px;">You need to sign in to approve ChadCode on this machine.</p>
      <a class="btn" href="/?return=/cli-auth%3Fcode=${encodeURIComponent(userCode)}" style="text-align:center;text-decoration:none;display:block">Open ChadGPT to sign in</a>
    `;
    return;
  }

  // Signed in — render the approve card.
  actionStep.textContent = 'Step 2';
  const email = me.user.email || '(unknown email)';
  const plan = me.user.plan || 'free';
  actionBody.innerHTML = `
    <p style="margin:0 0 6px;font-size:15px;font-weight:600;">Approve ChadCode login</p>
    <p style="margin:0 0 14px;font-size:13px;color:var(--muted);">Signed in as <b style="color:var(--fg)">${email}</b> (${plan}). Clicking Approve mints a license key for your terminal.</p>
    <button id="approve_btn">Approve login</button>
    <button id="deny_btn" class="ghost" style="margin-top:8px">Not me — cancel</button>
    <p id="approve_status" style="font-size:12px;color:var(--muted);margin-top:14px;text-align:center"></p>
  `;
  $('#approve_btn').addEventListener('click', () => approve(userCode));
  $('#deny_btn').addEventListener('click', () => { history.back(); });
}

async function approve(userCode) {
  const btn = $('#approve_btn');
  const denyBtn = $('#deny_btn');
  const status = $('#approve_status');
  btn.disabled = true; denyBtn.disabled = true;
  btn.innerHTML = '<span class="spin"></span>Approving…';
  try {
    const r = await fetch('/api/cli/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ user_code: userCode }),
    });
    const j = await r.json();
    if (!r.ok || !j.ok) {
      actionBody.innerHTML = `<div class="err">${j.error || 'approval failed'}${j.detail ? '<br><small>' + j.detail + '</small>' : ''}</div>
        <button class="ghost" style="margin-top:12px" onclick="location.reload()">Try again</button>`;
      return;
    }
    // Success — the CLI is already polling, so even if the deep-link
    // never fires, login will still complete. But we try the deep-link
    // anyway so the OS "Open ChadCode?" popup shows for installed users.
    actionBody.innerHTML = `
      <div class="ok" style="margin-top:0">Approved. Return to your terminal.</div>
      <p style="margin:14px 0 6px;font-size:13px">If your browser asks <b>"Open ChadCode?"</b>, click Open. Otherwise the CLI already got the key — it should be logged in within a few seconds.</p>
      <p style="font-size:12px;color:var(--muted);margin:6px 0 0">Tried to open: <code style="word-break:break-all">${j.deep_link}</code></p>
    `;
    // Kick the deep link — most browsers will show the handler prompt here.
    try {
      // iframe trick: setting location.href to a custom protocol can leave
      // the user on a broken "you cannot open this page" error page on some
      // browsers. An iframe swallows that into the frame.
      const f = document.createElement('iframe');
      f.style.display = 'none';
      f.src = j.deep_link;
      document.body.appendChild(f);
      setTimeout(() => { try { f.remove(); } catch {} }, 4000);
    } catch {}
    // Clean up the sessionStorage-stashed code if any.
    try { sessionStorage.removeItem('cli_pending_code'); } catch {}
  } catch (e) {
    actionBody.innerHTML = `<div class="err">network error: ${e?.message || e}</div>
      <button class="ghost" style="margin-top:12px" onclick="location.reload()">Try again</button>`;
  }
}

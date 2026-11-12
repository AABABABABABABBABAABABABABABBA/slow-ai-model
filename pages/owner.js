async function api(path, opts) {
  const r = await fetch('/api' + path, { credentials: 'include', headers: { 'Content-Type': 'application/json' }, ...opts });
  const data = (r.headers.get('content-type') || '').includes('application/json') ? await r.json().catch(() => ({})) : null;
  return { ok: r.ok, status: r.status, data };
}
function newNonce() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

(async function gate() {
  const meRes = await api('/me', { method: 'GET' });
  const gate = document.getElementById('gate');
  const msg = document.getElementById('gate_msg');
  const spin = document.getElementById('gate_spin');

  if (!meRes.ok) {
    msg.innerHTML = 'Not signed in. <a href="/">Sign in</a> first.';
    spin.style.display = 'none';
    return;
  }
  if (!meRes.data.user?.is_founder) {
    msg.innerHTML = 'This panel is restricted to the account owner.';
    spin.style.display = 'none';
    return;
  }

  // Second check — ask an admin-only endpoint. 403 means client-side
  // is_founder was lying (shouldn't happen but belt + suspenders).
  const probe = await api('/admin/users', { method: 'GET' });
  if (!probe.ok) {
    msg.innerHTML = `Server refused owner access (${probe.status}). Check FOUNDER_EMAIL.`;
    spin.style.display = 'none';
    return;
  }

  gate.style.display = 'none';
  document.getElementById('app').hidden = false;
  document.getElementById('who').textContent = meRes.data.user.email;
  wireTabs(probe.data);
})();

let usersCache = null;

function wireTabs(initialUsers) {
  usersCache = initialUsers;
  document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    load(b.dataset.tab);
  }));
  load('users');
}

async function load(tab) {
  const pane = document.getElementById('pane');
  pane.innerHTML = '<div class="section">Loading…</div>';
  if (tab === 'users') return renderUsers(pane, usersCache || (await api('/admin/users')).data);
  if (tab === 'bypass') {
    const r = await api('/admin/bypass');
    if (!r.ok) { pane.innerHTML = '<div class="section" style="color:var(--danger)">Failed.</div>'; return; }
    return renderBypass(pane, r.data);
  }
  if (tab === 'ratings') {
    const r = await api('/admin/ratings');
    if (!r.ok) { pane.innerHTML = '<div class="section" style="color:var(--danger)">Failed.</div>'; return; }
    return renderRatings(pane, r.data);
  }
}

function planBadge(plan) {
  return `<span class="badge plan-${plan}">${plan.toUpperCase()}</span>`;
}

function renderUsers(pane, j) {
  const t = j.totals;
  const banned = j.users.filter(u => u.banned).length;
  const muted = j.users.filter(u => u.muted).length;
  const rows = j.users.map(u => `
    <tr class="${u.banned ? 'banned' : ''}">
      <td>${esc(u.email)}${u.banned ? '<span class="badge banned">BANNED</span>' : ''}${u.muted ? '<span class="badge muted">MUTED</span>' : ''}</td>
      <td>${planBadge(u.plan)}</td>
      <td class="right" style="font-family:var(--mono);font-size:12px">$${u.cost_usd.toFixed(4)}</td>
      <td class="right" style="font-family:var(--mono);font-size:12px">${u.calls}</td>
      <td class="right"><button class="btn" data-manage="${esc(u.email)}">Manage</button></td>
    </tr>
  `).join('');
  pane.innerHTML = `
    <div class="stats">
      <div class="stat"><div class="lbl">Users</div><div class="val">${t.user_count}</div></div>
      <div class="stat"><div class="lbl">Unlimited</div><div class="val">${t.granted_count}</div></div>
      <div class="stat"><div class="lbl">Banned · muted</div><div class="val">${banned} · ${muted}</div></div>
      <div class="stat"><div class="lbl">Total cost</div><div class="val">$${t.total_cost_usd.toFixed(4)}</div></div>
      <div class="stat"><div class="lbl">Your burden</div><div class="val">$${t.founder_burden_usd.toFixed(4)}</div></div>
    </div>
    <table>
      <thead><tr><th>Email</th><th>Plan</th><th class="right">Cost</th><th class="right">Calls</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
  pane.querySelectorAll('[data-manage]').forEach(btn => btn.addEventListener('click', () => {
    const email = btn.dataset.manage;
    const u = j.users.find(x => x.email === email);
    if (u) openManage(u);
  }));
}

function renderBypass(pane, j) {
  const fps = j.shared_fingerprints.length
    ? j.shared_fingerprints.map(f => `
      <div class="fp_row">
        <div><code>${esc(f.fp_hash.slice(0, 16))}…</code><div style="color:var(--muted);margin-top:2px">${esc(f.emails.join(', '))} · ${f.user_count} accounts</div></div>
        <button class="btn danger" data-block="${esc(f.fp_hash)}">Block</button>
      </div>`).join('')
    : '<div style="color:var(--muted);font-size:12px">none detected.</div>';
  const burstList = j.recent_signups_last_hour.length
    ? j.recent_signups_last_hour.map(u => `<div class="fp_row"><span>${esc(u.email)}</span><span style="color:var(--muted);font-family:var(--mono);font-size:11px">${new Date(u.created_at).toLocaleTimeString()}</span></div>`).join('')
    : '<div style="color:var(--muted);font-size:12px">none.</div>';
  const multi = j.multi_device_users.length
    ? j.multi_device_users.map(u => `<div class="fp_row"><span>${esc(u.email)}</span><span style="font-family:var(--mono);font-size:11px;color:var(--muted)">${u.devices} devices</span></div>`).join('')
    : '<div style="color:var(--muted);font-size:12px">none.</div>';
  const heavy = j.heaviest_today.length
    ? j.heaviest_today.map(u => `<div class="fp_row"><span>${esc(u.email)} ${planBadge(u.plan)}</span><span style="font-family:var(--mono);font-size:11px;color:var(--muted)">${u.calls} calls · ${(u.tokens/1000).toFixed(1)}k tokens</span></div>`).join('')
    : '<div style="color:var(--muted);font-size:12px">quiet so far.</div>';
  pane.innerHTML = `
    <div class="section"><h3>Shared fingerprints — account farming</h3>${fps}</div>
    <div class="section"><h3>Recent signups (last hour)</h3>${burstList}</div>
    <div class="section"><h3>Multi-device users (3+ fingerprints)</h3>${multi}</div>
    <div class="section"><h3>Heaviest today</h3>${heavy}</div>
  `;
  pane.querySelectorAll('[data-block]').forEach(btn => btn.addEventListener('click', async () => {
    const fp_hash = btn.dataset.block;
    if (!confirm('Block fingerprint ' + fp_hash.slice(0, 12) + '…?')) return;
    const r = await api('/admin/block-device', { method: 'POST', body: JSON.stringify({ fp_hash }) });
    if (r.ok) load('bypass'); else alert('failed: ' + r.status);
  }));
}

function renderRatings(pane, j) {
  const rows = (j.by_model || []).map(r => {
    const total = r.up + r.down;
    const pct = total ? Math.round((100 * r.up) / total) : 0;
    return `<tr><td><code>${esc(r.model)}</code></td><td class="right" style="color:var(--ok);font-family:var(--mono);font-size:12px">+${r.up}</td><td class="right" style="color:var(--danger);font-family:var(--mono);font-size:12px">−${r.down}</td><td class="right" style="font-family:var(--mono);font-size:12px">${pct}% good</td></tr>`;
  }).join('') || '<tr><td colspan="4" style="padding:16px;text-align:center;color:var(--muted)">no ratings yet</td></tr>';
  const recent = (j.recent_downvotes || []).map(d => `
    <div class="fp_row"><div><div style="color:var(--muted);font-family:var(--mono);font-size:11px">${new Date(d.created_at).toLocaleString()} · ${esc(d.email)} · ${esc(d.model_key || '—')}</div>${d.note ? `<div style="margin-top:3px">${esc(d.note)}</div>` : ''}</div></div>`).join('') || '<div style="color:var(--muted);font-size:12px;padding:8px">no downvotes yet.</div>';
  pane.innerHTML = `
    <div class="section"><h3>Per-model</h3><table><thead><tr><th>Model</th><th class="right">Up</th><th class="right">Down</th><th class="right">% good</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="section"><h3>Recent downvotes</h3>${recent}</div>
  `;
}

function openManage(u) {
  const slot = document.getElementById('sheet_slot');
  slot.innerHTML = `
    <div class="sheet"><div class="sheet_card">
      <div style="font-size:13px;font-weight:600">${esc(u.email)}</div>
      <div style="font-size:11px;color:var(--muted);font-family:var(--mono);margin-top:3px">${planBadge(u.plan)} · ${u.calls} calls · $${u.cost_usd.toFixed(4)}${u.granted_by ? ' · granted by ' + esc(u.granted_by) : ''}</div>
      <div class="lbl2">Plan</div>
      <div class="row">
        <button class="btn ${u.plan === 'free' ? 'ghost' : ''}" data-plan="free">Free</button>
        <button class="btn ${u.plan === 'plus' ? 'ghost' : ''}" data-plan="plus" style="background:#2e7d32">Plus</button>
        <button class="btn ${u.plan === 'unlimited' ? 'ghost' : ''}" data-plan="unlimited" style="background:#9b6bd8">Unlimited</button>
      </div>
      <div class="lbl2">Moderation</div>
      <div class="row">
        <button class="btn danger" data-mod="${u.banned ? 'unban' : 'ban'}">${u.banned ? 'Unban' : 'Ban'}</button>
        <button class="btn ghost" data-mod="${u.muted ? 'unmute' : 'mute'}">${u.muted ? 'Unmute' : 'Mute'}</button>
        <button class="btn ghost" data-mod="reset_usage">Reset usage</button>
        <button class="btn danger" data-mod="delete_chats">Delete chats</button>
      </div>
      <div class="lbl2">Moderation note</div>
      <textarea id="mod_note" rows="2" placeholder="Shown to user on refusal">${esc(u.moderation_note || '')}</textarea>
      <div style="display:flex;justify-content:space-between;margin-top:10px">
        <button class="btn ghost" id="save_note">Save note</button>
        <button class="btn" id="close_sheet">Close</button>
      </div>
    </div></div>`;
  const close = () => slot.innerHTML = '';
  slot.querySelector('#close_sheet').addEventListener('click', close);
  slot.querySelector('.sheet').addEventListener('click', e => { if (e.target.classList.contains('sheet')) close(); });
  slot.querySelectorAll('[data-plan]').forEach(b => b.addEventListener('click', async () => {
    const plan = b.dataset.plan;
    if (plan === u.plan) return;
    if (!confirm(`Change ${u.email} from ${u.plan} to ${plan}?`)) return;
    const r = await api('/admin/grant', { method: 'POST', body: JSON.stringify({ email: u.email, plan, nonce: newNonce() }) });
    if (r.ok) { close(); refreshUsers(); } else alert('failed: ' + r.status);
  }));
  slot.querySelectorAll('[data-mod]').forEach(b => b.addEventListener('click', async () => {
    const action = b.dataset.mod;
    const confirms = { ban: 'Ban account?', unban: 'Unban?', mute: 'Mute (block messages)?', unmute: 'Unmute?', reset_usage: 'Wipe usage counters?', delete_chats: 'Delete ALL chats + container?' };
    if (!confirm(confirms[action] || 'Apply ' + action + '?')) return;
    const note = slot.querySelector('#mod_note').value;
    const r = await api('/admin/moderate', { method: 'POST', body: JSON.stringify({ email: u.email, action, nonce: newNonce(), note }) });
    if (r.ok) { close(); refreshUsers(); } else alert('failed: ' + r.status);
  }));
  slot.querySelector('#save_note').addEventListener('click', async () => {
    const value = slot.querySelector('#mod_note').value;
    const r = await api('/admin/moderate', { method: 'POST', body: JSON.stringify({ email: u.email, action: 'set_note', value, nonce: newNonce() }) });
    if (r.ok) alert('saved'); else alert('failed');
  });
}

async function refreshUsers() {
  const r = await api('/admin/users');
  if (r.ok) { usersCache = r.data; renderUsers(document.getElementById('pane'), r.data); }
}

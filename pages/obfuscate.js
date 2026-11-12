// obfuscate page client — wires the level picker, go button, copy, download,
// and byte counters. Hands the source to /api/obfuscate.

const $ = (sel) => document.querySelector(sel);
const inputEl = $('#input');
const outputEl = $('#output');
const inCount = $('#in_count');
const outCount = $('#out_count');
const statsRow = $('#stats_row');
const notesRow = $('#notes_row');
const errBox = $('#err_box');
const goBtn = $('#go_btn');
const clearBtn = $('#clear_btn');
const copyBtn = $('#copy_btn');
const downloadBtn = $('#download_btn');

let currentLevel = 'extreme';

// If the user navigated here from chat with code pre-filled, pick it up.
try {
  const seed = sessionStorage.getItem('obfuscate_seed');
  if (seed) { inputEl.value = seed; sessionStorage.removeItem('obfuscate_seed'); }
} catch {}

function fmtBytes(n) {
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function setCounts() {
  inCount.textContent = fmtBytes(new Blob([inputEl.value]).size);
  outCount.textContent = fmtBytes(new Blob([outputEl.value]).size);
}

function setError(msg) {
  errBox.innerHTML = msg ? `<div class="err">${msg}</div>` : '';
}

inputEl.addEventListener('input', setCounts);

for (const opt of document.querySelectorAll('.seg_opt')) {
  opt.addEventListener('click', () => {
    document.querySelectorAll('.seg_opt').forEach(x => x.classList.remove('on'));
    opt.classList.add('on');
    currentLevel = opt.dataset.level;
  });
}

clearBtn.addEventListener('click', () => {
  inputEl.value = '';
  outputEl.value = '';
  statsRow.innerHTML = '';
  notesRow.style.display = 'none';
  setError('');
  copyBtn.disabled = true;
  downloadBtn.disabled = true;
  setCounts();
  inputEl.focus();
});

goBtn.addEventListener('click', async () => {
  const source = inputEl.value;
  if (!source.trim()) { setError('paste some Lua first'); return; }
  setError('');
  goBtn.disabled = true;
  goBtn.textContent = 'working...';
  try {
    const r = await fetch('/api/obfuscate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lang: 'lua', source, level: currentLevel }),
    });
    const j = await r.json();
    if (!r.ok || !j.ok) {
      if (r.status === 401) {
        setError('please <a href="/" style="color:#b58cff">sign in</a> first — this endpoint is gated to accounts');
      } else {
        setError(j.error || `server returned ${r.status}`);
      }
      outputEl.value = '';
      return;
    }
    outputEl.value = j.code;
    copyBtn.disabled = false;
    downloadBtn.disabled = false;
    statsRow.innerHTML = Object.entries(j.stats || {}).map(([k, v]) =>
      `<span class="stat">${k.replace(/_/g, ' ')}: ${v}</span>`
    ).join('');
    if (Array.isArray(j.notes) && j.notes.length) {
      notesRow.style.display = 'block';
      notesRow.innerHTML = j.notes.map(n => `<div>• ${n}</div>`).join('');
    } else {
      notesRow.style.display = 'none';
    }
    setCounts();
  } catch (err) {
    setError('network error: ' + (err?.message || err));
  } finally {
    goBtn.disabled = false;
    goBtn.textContent = 'Obfuscate';
  }
});

copyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(outputEl.value);
    copyBtn.textContent = 'Copied';
    setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1200);
  } catch {
    outputEl.select();
    document.execCommand('copy');
  }
});

downloadBtn.addEventListener('click', () => {
  const blob = new Blob([outputEl.value], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `obfuscated-${currentLevel}.lua`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
});

setCounts();

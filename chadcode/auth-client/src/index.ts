// ChadCode device-code login client.
//
// What the CLI prints on first run:
//
//   Welcome to ChadCode.
//
//   Sign in to continue. Either:
//     1) Open this URL in your browser (already signed in? one click):
//        https://chadgpt-964.pages.dev/cli-auth?code=ABCD-EFGH
//     2) Paste a license key directly:
//     >
//
// The CLI then:
//   - reads a line from stdin in the background; if the user types a key,
//     resolve with that key immediately
//   - polls /api/cli/poll every `interval` seconds until approved, expired,
//     or the URL race aborts because the user pasted a key
//
// When the browser deep-links back via chadcode://login?key=…, the installed
// protocol handler re-invokes the binary with --url, which can short-circuit
// the poll by writing the key to a well-known pipe or restarting with the
// env var set. (That transport is OS-specific; the polling path works
// everywhere and is the real source of truth.)

import * as readline from 'node:readline';

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export interface LoginResult {
  key: string;
  user_id?: string;
  email?: string;
  plan?: string;
  via: 'device-code' | 'manual';
}

export interface LoginOpts {
  apiBase: string;                                    // e.g. https://chadgpt-964.pages.dev
  platform?: string;                                   // e.g. darwin-arm64 — purely diagnostic
  version?: string;                                    // CLI version string — diagnostic
  hostname?: string;                                   // machine hostname — diagnostic
  tryOpenBrowser?: boolean;                            // default true
  print?: (line: string) => void;                      // default console.log
}

// Fallback cross-platform URL opener. The host can replace this if it wants
// to centralize OS-detection somewhere else.
async function openBrowser(url: string): Promise<void> {
  const cp = await import('node:child_process');
  const plat = process.platform;
  try {
    if (plat === 'darwin') cp.spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    else if (plat === 'win32') cp.spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    else cp.spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  } catch { /* opening the browser is best-effort */ }
}

export async function login(opts: LoginOpts): Promise<LoginResult> {
  const print = opts.print || ((s: string) => { process.stderr.write(s + '\n'); });
  const base = opts.apiBase.replace(/\/+$/, '');

  // 1) Mint the device code.
  const dcRes = await fetch(`${base}/api/cli/device-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      platform: opts.platform || process.platform,
      version:  opts.version  || '0.0.0',
      hostname: opts.hostname || '',
    }),
  });
  if (!dcRes.ok) throw new Error(`device-code mint failed: HTTP ${dcRes.status}`);
  const dc = (await dcRes.json()) as DeviceCodeResponse;

  // 2) Print the two options.
  print('');
  print('Welcome to ChadCode.');
  print('');
  print('Sign in to continue. Either:');
  print('');
  print('  1) Open this URL in your browser:');
  print(`     \x1b[36m${dc.verification_uri_complete}\x1b[0m`);
  print('     (code: ' + dc.user_code + ' — paste it if the auto-fill fails)');
  print('');
  print('  2) Paste a license key directly:');
  print('     > (type the key and press enter)');
  print('');

  if (opts.tryOpenBrowser !== false) openBrowser(dc.verification_uri_complete);

  // 3) Race: polling vs. a typed license key on stdin.
  const abort = new AbortController();

  const pollPromise = pollForApproval(base, dc, abort.signal).then((r) => {
    abort.abort();
    return { ...r, via: 'device-code' as const };
  });

  const stdinPromise: Promise<LoginResult> = readKeyFromStdin(abort.signal).then((key) => {
    abort.abort();
    return { key, via: 'manual' as const };
  });

  // First to resolve wins. If one rejects, we fall back to the other.
  return await raceSettled(pollPromise, stdinPromise);
}

async function raceSettled<T>(a: Promise<T>, b: Promise<T>): Promise<T> {
  // Resolve on the first that resolves; if the first REJECTS, wait on the other.
  return new Promise((resolve, reject) => {
    let settled = false;
    let rejections = 0;
    const onResolve = (v: T) => { if (!settled) { settled = true; resolve(v); } };
    const onReject = (e: unknown) => { rejections++; if (rejections >= 2 && !settled) { settled = true; reject(e); } };
    a.then(onResolve, onReject);
    b.then(onResolve, onReject);
  });
}

async function pollForApproval(
  base: string,
  dc: DeviceCodeResponse,
  signal: AbortSignal,
): Promise<{ key: string; user_id?: string; email?: string; plan?: string }> {
  const intervalMs = Math.max(1500, dc.interval * 1000);
  const deadline = Date.now() + dc.expires_in * 1000;
  while (!signal.aborted) {
    if (Date.now() > deadline) throw new Error('device code expired — restart and try again');
    await sleep(intervalMs, signal);
    if (signal.aborted) throw new Error('aborted');
    const r = await fetch(`${base}/api/cli/poll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_code: dc.device_code }),
      signal,
    }).catch(() => null);
    if (!r) continue;
    if (r.status === 404) throw new Error('device code not found on server');
    const j = (await r.json().catch(() => null)) as { status?: string; key?: string; email?: string; user_id?: string; plan?: string } | null;
    if (!j) continue;
    if (j.status === 'approved' && j.key) return { key: j.key, email: j.email, user_id: j.user_id, plan: j.plan };
    if (j.status === 'expired') throw new Error('device code expired — restart and try again');
    // else pending — loop
  }
  throw new Error('aborted');
}

function readKeyFromStdin(signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) { reject(new Error('no tty for manual key entry')); return; }
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    rl.setPrompt('license key> ');
    rl.prompt(true);
    const onLine = (line: string) => {
      const t = line.trim();
      if (!t) { rl.prompt(true); return; }
      // Rough shape check — "chad-xxxxx-xxxxx-xxxxx-xxxxx-xxxxx-xxxxx"
      if (!/^chad-[0-9a-f]{10}(-[0-9a-f]{10}){5}$/.test(t)) {
        process.stderr.write("that doesn't look like a chad-… key. Try again:\n");
        rl.prompt(true);
        return;
      }
      rl.close();
      resolve(t);
    };
    rl.on('line', onLine);
    signal.addEventListener('abort', () => { try { rl.close(); } catch {}; reject(new Error('aborted')); });
  });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); });
  });
}

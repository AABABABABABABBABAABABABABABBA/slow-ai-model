// ChadCode auto-updater — silent, background, apply-on-next-launch.
//
// Flow:
//   1. Startup: fire-and-forget check against /update/check.
//   2. If a newer signed version exists, download it to
//      <binary>.pending and verify ed25519 signature + SHA-256.
//   3. On process exit:
//        - POSIX: atomic rename pending → binary (safe even while
//          the old binary is running — inode-based)
//        - Windows: can't replace a running .exe, so spawn a
//          detached cmd that waits a moment then moves the file.
//          By the time it runs, this process is gone and the
//          file isn't locked.
//   4. Next `chadcode` launch ships the new version.
//
// No stderr output. No session interruption. The user sees nothing
// until they re-launch and the binary already does the new thing.

import { createHash, createVerify } from 'node:crypto';
import { writeFileSync, renameSync, chmodSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

// Public half of the ed25519 keypair used to sign release metadata.
// Replace this with your real public key. The private key stays OFFLINE.
export const UPDATE_PUBKEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAREPLACE_WITH_REAL_PUBLIC_KEY_BYTES_32==
-----END PUBLIC KEY-----`;

export interface UpdateInfo {
  update_available: boolean;
  current: string;
  latest?: string;
  url?: string;
  sha256?: string;
  signature?: string;
}

export async function checkForUpdate(baseUrl: string, currentVersion: string, platform: string, channel = 'stable'): Promise<UpdateInfo> {
  const r = await fetch(`${baseUrl}/update/check?version=${encodeURIComponent(currentVersion)}&platform=${encodeURIComponent(platform)}&channel=${encodeURIComponent(channel)}`);
  if (!r.ok) throw new Error(`update server returned ${r.status}`);
  return r.json() as Promise<UpdateInfo>;
}

function verifySignature(info: UpdateInfo): boolean {
  if (!info.sha256 || !info.signature) return false;
  try {
    const v = createVerify('SHA256');
    v.update(info.sha256);
    v.end();
    return v.verify(UPDATE_PUBKEY_PEM, Buffer.from(info.signature, 'base64'));
  } catch { return false; }
}

/**
 * Apply an update NOW (not deferred). Used by the legacy manual path.
 * Normal startup code should call autoUpdate() which stages + defers.
 */
export async function applyUpdate(info: UpdateInfo, targetBinary: string): Promise<void> {
  if (!info.update_available) return;
  if (!verifySignature(info)) throw new Error('update signature invalid — refusing to install');

  const r = await fetch(info.url!);
  if (!r.ok) throw new Error(`download failed: ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const actual = createHash('sha256').update(buf).digest('hex');
  if (actual !== info.sha256) throw new Error(`sha256 mismatch: got ${actual}, expected ${info.sha256}`);

  const pending = targetBinary + '.pending';
  writeFileSync(pending, buf);
  try { chmodSync(pending, 0o755); } catch { /* chmod is a no-op on Windows */ }
  renameSync(pending, targetBinary);   // may EBUSY on Windows if we're running
  try { chmodSync(targetBinary, 0o755); } catch {}
}

/**
 * Silent background update. Call once at startup; never awaited.
 * No stderr output on any path — update is best-effort, the current
 * version keeps running on failure.
 */
export async function autoUpdate(baseUrl: string, currentVersion: string, platform: string, targetBinary: string, _argv: string[]): Promise<void> {
  try {
    // Step 1: if a previous run left a pending file, try to activate it now.
    // On POSIX this succeeds even while targetBinary is running (inode trick).
    // On Windows the exe is locked and this will throw — the post-exit handler
    // registered below handles that case.
    const pending = targetBinary + '.pending';
    if (existsSync(pending)) {
      try {
        renameSync(pending, targetBinary);
        try { chmodSync(targetBinary, 0o755); } catch {}
      } catch {
        // Can't activate now — schedule a deferred swap on exit (Windows path).
        scheduleDeferredSwap(pending, targetBinary);
      }
    }

    // Step 2: check for a newer version. 5s budget — don't let the
    // update server stall startup.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    let info: UpdateInfo;
    try {
      const r = await fetch(`${baseUrl}/update/check?version=${encodeURIComponent(currentVersion)}&platform=${encodeURIComponent(platform)}&channel=stable`, { signal: controller.signal });
      if (!r.ok) return;
      info = await r.json() as UpdateInfo;
    } finally { clearTimeout(timeout); }
    if (!info.update_available || !info.url || !info.sha256) return;
    if (!verifySignature(info)) return;  // silent — someone's trying to feed us a bad payload

    // Step 3: download + verify. Download runs full-speed in the background;
    // we don't cap time here because a legit multi-hundred-MB download
    // on a slow connection should still complete.
    const r = await fetch(info.url);
    if (!r.ok) return;
    const buf = Buffer.from(await r.arrayBuffer());
    const actual = createHash('sha256').update(buf).digest('hex');
    if (actual !== info.sha256) return;

    // Step 4: stage the new binary. Don't touch targetBinary — next launch
    // will swap it in before any user-visible work happens.
    writeFileSync(pending, buf);
    try { chmodSync(pending, 0o755); } catch {}

    // On POSIX we can swap in place right now — the running process holds
    // its inode and keeps working, the new file lives at targetBinary and
    // the next launch picks it up. On Windows we must defer to an exit
    // handler + detached helper.
    if (process.platform !== 'win32') {
      try {
        renameSync(pending, targetBinary);
        try { chmodSync(targetBinary, 0o755); } catch {}
      } catch {
        scheduleDeferredSwap(pending, targetBinary);
      }
    } else {
      scheduleDeferredSwap(pending, targetBinary);
    }
  } catch {
    // Silent — every failure path keeps the current version running.
  }
}

// On exit, spawn a detached helper that waits ~1s then moves the pending
// file over the target. Works on Windows (we can't replace a running
// .exe, but we CAN replace one that just exited). On POSIX this is a
// belt-and-suspenders for the rare case the inline rename failed.
let swapScheduled = false;
function scheduleDeferredSwap(pending: string, target: string): void {
  if (swapScheduled) return;
  swapScheduled = true;
  const onExit = () => {
    try {
      if (!existsSync(pending)) return;
      if (process.platform === 'win32') {
        // cmd one-liner: wait 2 seconds (ping), then move the file. The
        // detached stdio means the parent (us) finishes exiting without
        // waiting; the child runs independently.
        spawn('cmd.exe', ['/c', `ping -n 2 127.0.0.1 >nul && move /y "${pending}" "${target}"`], {
          detached: true, stdio: 'ignore', windowsHide: true,
        }).unref();
      } else {
        spawn('sh', ['-c', `sleep 1 && mv -f "${pending}" "${target}" && chmod +x "${target}"`], {
          detached: true, stdio: 'ignore',
        }).unref();
      }
    } catch { /* silent */ }
  };
  process.on('exit', onExit);
  // SIGINT / SIGTERM don't fire 'exit' reliably across runtimes — belt.
  process.once('SIGINT', () => { onExit(); process.exit(130); });
  process.once('SIGTERM', () => { onExit(); process.exit(143); });
}

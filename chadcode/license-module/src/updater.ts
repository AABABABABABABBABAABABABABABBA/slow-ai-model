// ChadCode auto-updater — called on startup and once a day.
//
// Verifies the signature using an ed25519 public key compiled into the
// binary, downloads the payload, SHA-256-checks it, swaps the executable
// atomically, and restarts.

import { createHash, createVerify } from 'node:crypto';
import { writeFileSync, renameSync, chmodSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

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

export async function applyUpdate(info: UpdateInfo, targetBinary: string): Promise<void> {
  if (!info.update_available) return;
  if (!verifySignature(info)) throw new Error('update signature invalid — refusing to install');

  const r = await fetch(info.url!);
  if (!r.ok) throw new Error(`download failed: ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());

  const actual = createHash('sha256').update(buf).digest('hex');
  if (actual !== info.sha256) throw new Error(`sha256 mismatch: got ${actual}, expected ${info.sha256}`);

  const stage = mkdtempSync(join(tmpdir(), 'chadcode-update-'));
  const tmpPath = join(stage, 'chadcode.new');
  writeFileSync(tmpPath, buf);
  chmodSync(tmpPath, 0o755);
  if (!existsSync(targetBinary)) throw new Error(`target binary missing: ${targetBinary}`);
  renameSync(tmpPath, targetBinary);
}

// Fire-and-forget: check, apply, then re-exec. The caller passes argv so the
// current CLI command is retried under the new binary.
export async function autoUpdate(baseUrl: string, currentVersion: string, platform: string, targetBinary: string, argv: string[]): Promise<void> {
  try {
    const info = await checkForUpdate(baseUrl, currentVersion, platform);
    if (!info.update_available) return;
    await applyUpdate(info, targetBinary);
    // Re-exec with the new binary. execFileSync returns only after the child
    // dies, so we exit with its status.
    const status = execFileSync(targetBinary, argv, { stdio: 'inherit' });
    process.exit(0);
    void status;
  } catch (err) {
    // Non-fatal — the app keeps running on the old version.
    process.stderr.write(`[update] ${(err as Error).message}\n`);
  }
}

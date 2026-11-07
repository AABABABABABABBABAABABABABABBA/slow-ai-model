// Hardware fingerprint for ChadCode license binding.
//
// We combine stable OS-level identifiers so that moving the license to a
// different machine requires re-activation. Not forensic-grade — a skilled
// attacker can spoof any of these — but good enough to stop the "one key,
// unlimited installs" problem.

import { createHash } from 'node:crypto';
import { hostname, platform, arch, cpus, networkInterfaces, totalmem, userInfo } from 'node:os';
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

function safe<T>(fn: () => T, fallback: T): T {
  try { return fn(); } catch { return fallback; }
}

// Machine-ID from the OS. Different file per platform.
function machineId(): string {
  const p = platform();
  if (p === 'linux') {
    for (const f of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
      if (existsSync(f)) return safe(() => readFileSync(f, 'utf8').trim(), '');
    }
    return '';
  }
  if (p === 'darwin') {
    return safe(() =>
      execSync('ioreg -rd1 -c IOPlatformExpertDevice', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        .match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)?.[1] || '', '');
  }
  if (p === 'win32') {
    return safe(() =>
      execSync('reg query HKLM\\SOFTWARE\\Microsoft\\Cryptography /v MachineGuid', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        .match(/MachineGuid\s+REG_SZ\s+([\w-]+)/)?.[1] || '', '');
  }
  return '';
}

// MAC address of the first non-loopback, non-virtual interface.
function stableMac(): string {
  const ifs = safe(() => networkInterfaces(), {} as ReturnType<typeof networkInterfaces>);
  for (const name of Object.keys(ifs)) {
    if (/^(lo|docker|veth|br-|vmnet|vbox|tap|tun)/i.test(name)) continue;
    const addrs = ifs[name] || [];
    for (const a of addrs) {
      if (a.mac && a.mac !== '00:00:00:00:00:00') return a.mac;
    }
  }
  return '';
}

export interface Fingerprint {
  hash: string;              // 64-char hex
  machine_id: string;
  mac: string;
  hostname: string;
  platform: string;
  arch: string;
  cpu_model: string;
  cpu_count: number;
  total_mem_gb: number;
  user: string;
}

export function collectFingerprint(): Fingerprint {
  const mid = machineId();
  const mac = stableMac();
  const host = safe(() => hostname(), '');
  const plat = platform();
  const a = arch();
  const cs = safe(() => cpus(), []);
  const model = cs[0]?.model || '';
  const user = safe(() => userInfo().username, '');
  const memGb = Math.round(safe(() => totalmem(), 0) / (1024 ** 3));

  const material = [mid, mac, plat, a, model, String(cs.length), String(memGb)].join('|');
  const hash = createHash('sha256').update(material).digest('hex');

  return {
    hash,
    machine_id: mid,
    mac,
    hostname: host,
    platform: plat,
    arch: a,
    cpu_model: model,
    cpu_count: cs.length,
    total_mem_gb: memGb,
    user,
  };
}

// Short printable label the UI can show, e.g. "mac-arm64 · 8 cores · ••••a1b2".
export function fingerprintLabel(fp: Fingerprint): string {
  const short = fp.hash.slice(-6);
  return `${fp.platform}-${fp.arch} · ${fp.cpu_count} cores · ••••${short}`;
}

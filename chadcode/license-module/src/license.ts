// ChadCode license client — call once on startup, re-check every 6h.
//
// Flow:
//   1. Read license key from env, config file, or prompt user.
//   2. Collect hardware fingerprint.
//   3. POST /license/activate on first run (binds key -> fingerprint).
//   4. POST /license/verify periodically; cache the signed token for offline.
//   5. On startup refuse to run if no valid token (online verify failed AND
//      cached token is missing or expired).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { collectFingerprint, type Fingerprint } from './fingerprint.js';

const CACHE_DIR = join(homedir(), '.chadcode');
const CACHE_FILE = join(CACHE_DIR, 'license.json');

export interface LicenseServerConfig {
  baseUrl: string;             // e.g. https://chadcode-license.corbyiscool.workers.dev
  key: string;                 // the user's license key
}

export interface CachedLicense {
  token: string;
  plan: string;
  expires_at: number;
  fingerprint_hash: string;
  cached_at: number;
}

function ensureCacheDir() {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
}

function readCache(): CachedLicense | null {
  try {
    if (!existsSync(CACHE_FILE)) return null;
    return JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
  } catch { return null; }
}

function writeCache(c: CachedLicense): void {
  ensureCacheDir();
  writeFileSync(CACHE_FILE, JSON.stringify(c, null, 2), { mode: 0o600 });
}

async function callServer(cfg: LicenseServerConfig, path: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(cfg.baseUrl + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export interface LicenseResult {
  ok: boolean;
  reason?: string;
  plan?: string;
  token?: string;
  expires_at?: number;
  fingerprint: Fingerprint;
  source: 'server' | 'cache' | 'none';
}

export async function activate(cfg: LicenseServerConfig): Promise<LicenseResult> {
  const fp = collectFingerprint();
  const r = await callServer(cfg, '/license/activate', {
    key: cfg.key,
    fingerprint: fp.hash,
    hostname: fp.hostname,
    platform: `${fp.platform}-${fp.arch}`,
  });
  const j = await r.json().catch(() => ({})) as Record<string, unknown>;
  if (!r.ok) return { ok: false, reason: String(j.error || r.statusText), fingerprint: fp, source: 'server' };
  return { ok: true, plan: String(j.plan || 'pro'), expires_at: j.expires_at as number | undefined, fingerprint: fp, source: 'server' };
}

export async function verify(cfg: LicenseServerConfig): Promise<LicenseResult> {
  const fp = collectFingerprint();
  try {
    const r = await callServer(cfg, '/license/verify', { key: cfg.key, fingerprint: fp.hash });
    const j = await r.json().catch(() => ({})) as Record<string, unknown>;
    if (r.ok && j.valid) {
      const cached: CachedLicense = {
        token: String(j.token),
        plan: String(j.plan || 'pro'),
        expires_at: Number(j.expires_at || Date.now() + 86400000),
        fingerprint_hash: fp.hash,
        cached_at: Date.now(),
      };
      writeCache(cached);
      return { ok: true, plan: cached.plan, token: cached.token, expires_at: cached.expires_at, fingerprint: fp, source: 'server' };
    }
    if (r.status === 403 && j.reason === 'revoked') {
      // Blow the cache so the user can't just stay offline forever.
      try { writeFileSync(CACHE_FILE, '{}'); } catch {}
      return { ok: false, reason: 'revoked', fingerprint: fp, source: 'server' };
    }
    // Fall through to cache check.
  } catch { /* network error — fall through */ }

  const cached = readCache();
  if (cached?.token && cached.fingerprint_hash === fp.hash && cached.expires_at > Date.now()) {
    return { ok: true, plan: cached.plan, token: cached.token, expires_at: cached.expires_at, fingerprint: fp, source: 'cache' };
  }
  return { ok: false, reason: 'server unreachable and no valid cache', fingerprint: fp, source: 'none' };
}

// Gate for the CLI entrypoint. Returns the plan or throws with the reason.
export async function requireValidLicense(cfg: LicenseServerConfig): Promise<{ plan: string; fingerprint: Fingerprint }> {
  let res = await verify(cfg);
  if (!res.ok && res.source !== 'cache') {
    // Try activating; maybe this is first run on a new machine.
    const act = await activate(cfg);
    if (!act.ok) throw new Error(`License refused: ${act.reason}`);
    res = await verify(cfg);
  }
  if (!res.ok) throw new Error(`License invalid: ${res.reason}`);
  return { plan: res.plan!, fingerprint: res.fingerprint };
}

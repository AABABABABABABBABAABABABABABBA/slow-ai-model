// Public surface of the ChadCode license module.
//
// Drop-in usage from the forked CLI entrypoint:
//
//   import { bootstrap } from '@chadcode/license';
//   await bootstrap({
//     licenseServer: 'https://chadcode-license.corbyiscool.workers.dev',
//     version: '1.0.0',
//     binary: process.execPath,
//   });
//
// `bootstrap` throws if the license is bad. A valid license lets the rest of
// the CLI run normally.

import { collectFingerprint, fingerprintLabel } from './fingerprint.js';
import { requireValidLicense, type LicenseServerConfig } from './license.js';
import { autoUpdate } from './updater.js';
import { printBanner, DEFAULT_API_BASE } from './banner.js';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export { collectFingerprint, fingerprintLabel };
export { activate, verify, requireValidLicense } from './license.js';
export { checkForUpdate, applyUpdate, autoUpdate } from './updater.js';
export { BANNER, DEFAULT_API_BASE, printBanner } from './banner.js';
export type { Fingerprint } from './fingerprint.js';
export type { LicenseServerConfig, CachedLicense, LicenseResult } from './license.js';
export type { UpdateInfo } from './updater.js';

export interface BootstrapOpts {
  licenseServer: string;
  licenseKey?: string;              // if omitted, read from CHADCODE_LICENSE env
  version: string;                  // current app version (semver)
  binary: string;                   // path to replace on update
  skipUpdate?: boolean;
  skipLicense?: boolean;            // only for local dev — never ship true
  apiBase?: string;                 // override the single ChadGPT API base
}

export async function bootstrap(opts: BootstrapOpts): Promise<{ plan: string; apiBase: string }> {
  // License key lookup order:
  //   1. explicit opts.licenseKey
  //   2. CHADCODE_LICENSE env var
  //   3. ~/.config/chadcode/license.key   (mac/Linux)
  //      or %APPDATA%\ChadCode\license.key (Windows)
  //
  // The disk fallback matters because setting a shell env var with
  // `$env:X=...` on Windows doesn't persist to new terminals — users
  // kept hitting "No ChadCode license key" after reopening PowerShell.
  let key = opts.licenseKey || process.env.CHADCODE_LICENSE;
  if (!key) {
    try {
      const diskKey = (await fs.readFile(licenseKeyPath(), 'utf8')).trim();
      if (diskKey) {
        key = diskKey;
        process.env.CHADCODE_LICENSE = diskKey;  // make it visible to the rest of the process
      }
    } catch { /* no file — fine, we'll surface the error below */ }
  }

  // Hardcode every ChadCode network hop to ONE host. Backends stay hidden
  // behind the dispatcher so running `strings` on the binary doesn't leak
  // our chat/image/license worker URLs individually.
  const apiBase = opts.apiBase || process.env.CHADGPT_API_BASE || DEFAULT_API_BASE;
  process.env.CHADGPT_API_BASE = apiBase;
  process.env.OPENCODE_API_BASE = apiBase;   // compat for any upstream opencode code still looking for this

  if (!opts.skipLicense) {
    if (!key) {
      throw new Error(
        'No ChadCode license key. Either:\n' +
        '  1. set CHADCODE_LICENSE in your shell env, or\n' +
        '  2. run `chadcode login` to pair this terminal, or\n' +
        `  3. save your key to ${licenseKeyPath()} (one line, no quotes).`
      );
    }
    const cfg: LicenseServerConfig = { baseUrl: opts.licenseServer, key };
    const { plan, fingerprint } = await requireValidLicense(cfg);
    process.env.CHADCODE_PLAN = plan;
    process.env.CHADCODE_FP = fingerprint.hash;
    printBanner(opts.version, plan, fingerprintLabel(fingerprint));
    if (!opts.skipUpdate) {
      const platform = `${fingerprint.platform}-${fingerprint.arch}`;
      autoUpdate(opts.licenseServer, opts.version, platform, opts.binary, process.argv.slice(1)).catch(() => {});
    }
    return { plan, apiBase };
  }
  // Dev-mode banner so you can see it's actually the ChadGPT fork at runtime.
  printBanner(opts.version, 'dev', 'license-check skipped');
  return { plan: 'dev', apiBase };
}

/**
 * Where we store the user's license key on disk.
 * - Windows: %APPDATA%\ChadCode\license.key
 * - mac/Linux: ~/.config/chadcode/license.key
 */
export function licenseKeyPath(): string {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'ChadCode', 'license.key');
  }
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(xdg, 'chadcode', 'license.key');
}

/**
 * Save a license key to disk so future runs find it without needing the
 * env var. Mode 0600 so other users on the machine can't read it.
 * Call this from `chadcode login` after a successful device-code pair.
 */
export async function persistLicenseKey(key: string): Promise<string> {
  const p = licenseKeyPath();
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, key.trim() + '\n', { mode: 0o600 });
  return p;
}

/** Delete the stored key (for `chadcode logout`). */
export async function clearLicenseKey(): Promise<void> {
  try { await fs.unlink(licenseKeyPath()); } catch { /* already gone */ }
}

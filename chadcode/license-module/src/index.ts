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

export { collectFingerprint, fingerprintLabel };
export { activate, verify, requireValidLicense } from './license.js';
export { checkForUpdate, applyUpdate, autoUpdate } from './updater.js';
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
}

export async function bootstrap(opts: BootstrapOpts): Promise<{ plan: string }> {
  const key = opts.licenseKey || process.env.CHADCODE_LICENSE;
  if (!opts.skipLicense) {
    if (!key) throw new Error('No ChadCode license key. Set CHADCODE_LICENSE or pass licenseKey.');
    const cfg: LicenseServerConfig = { baseUrl: opts.licenseServer, key };
    const { plan, fingerprint } = await requireValidLicense(cfg);
    process.env.CHADCODE_PLAN = plan;
    process.env.CHADCODE_FP = fingerprint.hash;
    // Print once at startup so people can see what machine is bound.
    process.stderr.write(`chadcode ${opts.version} · plan ${plan} · ${fingerprintLabel(fingerprint)}\n`);
    if (!opts.skipUpdate) {
      // Fire-and-forget — do not block app startup on the update check.
      const platform = `${fingerprint.platform}-${fingerprint.arch}`;
      autoUpdate(opts.licenseServer, opts.version, platform, opts.binary, process.argv.slice(1)).catch(() => {});
    }
    return { plan };
  }
  return { plan: 'dev' };
}

// ChadCode license + auto-update worker.
// Backs the forked OpenCode distribution. Every running client calls this
// on startup to prove it has a valid license bound to its hardware, and
// periodically to pick up signed updates.
//
// Endpoints
//   POST /license/activate  — bind a key to a fingerprint (first run only)
//   POST /license/verify    — check key is valid + bound to this fingerprint
//   POST /license/revoke    — founder-only
//   GET  /update/check      — returns { latest, url, signature } per platform
//   POST /update/publish    — founder-only; publishes a new build
//
// Storage is Cloudflare D1 (LIC_DB). Builds live in R2 (BUILDS). Config in KV
// (LIC_KV) for release channel + update signing key fingerprint.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    try {
      if (url.pathname === '/license/activate' && request.method === 'POST')  return activate(request, env);
      if (url.pathname === '/license/verify'   && request.method === 'POST')  return verify(request, env);
      if (url.pathname === '/license/revoke'   && request.method === 'POST')  return revoke(request, env);
      if (url.pathname === '/license/create'   && request.method === 'POST')  return createLicense(request, env);
      if (url.pathname === '/license/list'     && request.method === 'GET')   return listLicenses(request, env);
      if (url.pathname === '/download'         && request.method === 'GET')   return downloadBinary(request, env);
      if (url.pathname === '/install.ps1'      && request.method === 'GET')   return installPs1(request, env);
      if (url.pathname === '/install.sh'       && request.method === 'GET')   return installSh(request, env);
      if (url.pathname === '/opencode-config.jsonc' && request.method === 'GET') return opencodeConfig(request, env);
      if (url.pathname === '/update/check'     && request.method === 'GET')   return updateCheck(request, env);
      if (url.pathname === '/update/publish'   && request.method === 'POST')  return updatePublish(request, env);
      if (url.pathname === '/health')                                          return j({ ok: true, service: 'chadcode-license', ts: Date.now() });
      return j({ error: 'not found' }, 404);
    } catch (err) {
      return j({ error: 'server error', detail: err?.message || String(err) }, 500);
    }
  },
};

function j(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function founderAuth(request, env) {
  const got = request.headers.get('Authorization') || '';
  const want = 'Bearer ' + (env.FOUNDER_TOKEN || '');
  // constant-time-ish compare
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0 && !!env.FOUNDER_TOKEN;
}

// ---------- /license/activate ----------
// Body: { key, fingerprint, hostname?, platform? }
// On first call: bind key to fingerprint. Second call with a different
// fingerprint: reject (unless the key is marked transferable).
async function activate(request, env) {
  const body = await request.json().catch(() => null);
  if (!body?.key || !body?.fingerprint) return j({ error: 'key and fingerprint required' }, 400);
  if (!env.LIC_DB) return j({ error: 'LIC_DB not bound' }, 500);

  const keyHash = await sha256Hex(body.key);
  const row = await env.LIC_DB.prepare(
    'SELECT id, plan, max_devices, expires_at, revoked, transferable FROM licenses WHERE key_hash = ?'
  ).bind(keyHash).first();
  if (!row) return j({ error: 'invalid license key' }, 404);
  if (row.revoked) return j({ error: 'license revoked' }, 403);
  if (row.expires_at && row.expires_at < Date.now()) return j({ error: 'license expired', expires_at: row.expires_at }, 403);

  // Count devices already bound.
  const devs = await env.LIC_DB.prepare(
    'SELECT fingerprint FROM license_devices WHERE license_id = ?'
  ).bind(row.id).all();
  const bound = (devs.results || []).map(r => r.fingerprint);
  if (bound.includes(body.fingerprint)) {
    await env.LIC_DB.prepare(
      'UPDATE license_devices SET last_seen_at = ?, hostname = ?, platform = ? WHERE license_id = ? AND fingerprint = ?'
    ).bind(Date.now(), body.hostname || '', body.platform || '', row.id, body.fingerprint).run();
    return j({ ok: true, plan: row.plan, expires_at: row.expires_at, fingerprint: body.fingerprint, newly_bound: false });
  }
  if (bound.length >= row.max_devices && !row.transferable) {
    return j({ error: 'license device limit reached', max_devices: row.max_devices, bound: bound.length }, 403);
  }
  await env.LIC_DB.prepare(
    'INSERT INTO license_devices (license_id, fingerprint, hostname, platform, bound_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(row.id, body.fingerprint, body.hostname || '', body.platform || '', Date.now(), Date.now()).run();

  return j({ ok: true, plan: row.plan, expires_at: row.expires_at, fingerprint: body.fingerprint, newly_bound: true });
}

// ---------- /license/verify ----------
// Called on every client startup + every few hours during runtime.
// Returns a short-lived signed token the client caches; if the client
// can't reach us, it falls back to the cached token until it expires.
async function verify(request, env) {
  const body = await request.json().catch(() => null);
  if (!body?.key || !body?.fingerprint) return j({ error: 'key and fingerprint required' }, 400);
  if (!env.LIC_DB) return j({ error: 'LIC_DB not bound' }, 500);

  const keyHash = await sha256Hex(body.key);
  const row = await env.LIC_DB.prepare(
    'SELECT l.id, l.plan, l.expires_at, l.revoked FROM licenses l WHERE l.key_hash = ?'
  ).bind(keyHash).first();
  if (!row) return j({ valid: false, reason: 'unknown key' }, 404);
  if (row.revoked) return j({ valid: false, reason: 'revoked' }, 403);
  if (row.expires_at && row.expires_at < Date.now()) return j({ valid: false, reason: 'expired' }, 403);

  const bound = await env.LIC_DB.prepare(
    'SELECT 1 AS yes FROM license_devices WHERE license_id = ? AND fingerprint = ? LIMIT 1'
  ).bind(row.id, body.fingerprint).first();
  if (!bound) return j({ valid: false, reason: 'fingerprint not bound — run activate first' }, 403);

  await env.LIC_DB.prepare(
    'UPDATE license_devices SET last_seen_at = ? WHERE license_id = ? AND fingerprint = ?'
  ).bind(Date.now(), row.id, body.fingerprint).run();

  // Signed verification token the client caches for offline use.
  const token = await signToken(env, {
    plan: row.plan,
    exp: Date.now() + 24 * 60 * 60 * 1000,   // 24h ceiling for offline runs
    fp: body.fingerprint,
    lic: row.id,
  });
  return j({ valid: true, plan: row.plan, expires_at: row.expires_at, token });
}

async function signToken(env, payload) {
  const secret = env.TOKEN_SECRET || 'chadcode-dev-secret';
  const header = { alg: 'HS256', typ: 'LIC' };
  const b64 = (o) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  const body = `${b64(header)}.${b64(payload)}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${body}.${sigB64}`;
}

// ---------- /license/create ----------
// Founder-only (via FOUNDER_TOKEN). Issues a license row from a pre-hashed
// key — the Pages API computes the SHA-256 on the raw key so we never see
// the plaintext here. Body: { id, key_hash, plan, owner_email, max_devices, note? }
async function createLicense(request, env) {
  if (!founderAuth(request, env)) return j({ error: 'founder only' }, 403);
  const b = await request.json().catch(() => null);
  for (const k of ['id', 'key_hash', 'plan', 'owner_email', 'max_devices']) {
    if (b?.[k] === undefined || b?.[k] === null) return j({ error: `${k} required` }, 400);
  }
  if (!/^[0-9a-f]{64}$/i.test(b.key_hash)) return j({ error: 'key_hash must be 64-char hex' }, 400);
  if (!['free', 'pro', 'team', 'founder-grant'].includes(b.plan)) return j({ error: 'plan must be free/pro/team/founder-grant' }, 400);
  await env.LIC_DB.prepare(
    'INSERT INTO licenses (id, key_hash, plan, owner_email, max_devices, transferable, issued_at, expires_at, revoked, notes) VALUES (?, ?, ?, ?, ?, 0, ?, NULL, 0, ?)'
  ).bind(b.id, b.key_hash, b.plan, b.owner_email, b.max_devices, Date.now(), b.note || null).run();
  return j({ ok: true, id: b.id });
}

// ---------- /license/list ----------
// Founder-only. Returns metadata for an owner's licenses (no raw keys ever).
async function listLicenses(request, env) {
  if (!founderAuth(request, env)) return j({ error: 'founder only' }, 403);
  const url = new URL(request.url);
  const owner = url.searchParams.get('owner_email');
  if (!owner) return j({ error: 'owner_email required' }, 400);
  const rows = await env.LIC_DB.prepare(
    'SELECT id, plan, max_devices, issued_at, expires_at, revoked, notes FROM licenses WHERE owner_email = ? ORDER BY issued_at DESC'
  ).bind(owner).all();
  const withCounts = [];
  for (const row of (rows.results || [])) {
    const dev = await env.LIC_DB.prepare(
      'SELECT COUNT(*) AS n FROM license_devices WHERE license_id = ?'
    ).bind(row.id).first();
    withCounts.push({ ...row, bound_devices: Number(dev?.n || 0) });
  }
  return j({ licenses: withCounts });
}

// ---------- /download ----------
// GET /download?platform=darwin-arm64  with Authorization: Bearer <license-key>
// Streams the matching binary from R2 after verifying the license is active.
// Platforms map 1:1 to the folder names in the build output
// (darwin-arm64, darwin-x64, linux-x64, linux-arm64, windows-x64, windows-arm64).
async function downloadBinary(request, env) {
  if (!env.BINARIES) return j({ error: 'binary bucket not bound' }, 503);
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) return j({ error: 'bearer license key required' }, 401);

  const keyHash = await sha256Hex(token);
  const row = await env.LIC_DB.prepare(
    'SELECT id, plan, expires_at, revoked FROM licenses WHERE key_hash = ?'
  ).bind(keyHash).first();
  if (!row) return j({ error: 'invalid license' }, 403);
  if (row.revoked) return j({ error: 'license revoked' }, 403);
  if (row.expires_at && row.expires_at < Date.now()) return j({ error: 'license expired' }, 403);

  const url = new URL(request.url);
  const platform = (url.searchParams.get('platform') || '').toLowerCase();
  if (!/^(darwin|linux|windows)-(arm64|x64)(-baseline)?(-musl)?$/.test(platform)) {
    return j({ error: 'invalid platform', expected: 'darwin-arm64 | darwin-x64 | linux-x64 | linux-arm64 | windows-x64 | windows-arm64' }, 400);
  }
  const ext = platform.startsWith('windows') ? '.exe' : '';
  const key = `chadcode/${platform}/chadcode${ext}`;

  const obj = await env.BINARIES.get(key);
  if (!obj) return j({ error: 'binary not found in R2', key }, 404);

  return new Response(obj.body, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="chadcode${ext}"`,
      'Content-Length': String(obj.size),
      'X-License-Plan': row.plan,
    },
  });
}

// ---------- /install.ps1 ----------
// GET /install.ps1 — returns a PowerShell installer that fetches the signed
// Windows binary from /download using the CHADCODE_LICENSE env var the
// user sets before piping to `iex`, writes it to %LOCALAPPDATA%\ChadCode
// and adds that folder to the user PATH. The script never embeds a license
// key — the user carries it in the env var.
function installPs1(request, env) {
  const self = new URL(request.url).origin;
  const script = [
    `# ChadCode PowerShell installer.`,
    `# Usage:`,
    `#   $env:CHADCODE_LICENSE='<your-key>'; $env:CHADCODE_PLATFORM='windows-x64';`,
    `#   iwr -useb ${self}/install.ps1 | iex`,
    `#`,
    `# Platforms: windows-x64, windows-arm64. Falls back to the current arch`,
    `# if CHADCODE_PLATFORM is unset.`,
    ``,
    `$ErrorActionPreference = 'Stop'`,
    ``,
    `if (-not $env:CHADCODE_LICENSE) {`,
    `  Write-Host 'ERROR: set $env:CHADCODE_LICENSE=<key> before running the installer.' -ForegroundColor Red`,
    `  Write-Host 'Get your key at https://chadgpt-964.pages.dev/cli' -ForegroundColor Yellow`,
    `  exit 1`,
    `}`,
    ``,
    `# Persist the license key to the USER environment so every future`,
    `# PowerShell / cmd session sees it, not just the one running this`,
    `# installer. Without this, chadcode throws "No ChadCode license key."`,
    `# the next time the user opens a new terminal.`,
    `[Environment]::SetEnvironmentVariable('CHADCODE_LICENSE', $env:CHADCODE_LICENSE, 'User')`,
    `Write-Host 'Saved CHADCODE_LICENSE to your user environment.' -ForegroundColor Green`,
    ``,
    `$plat = $env:CHADCODE_PLATFORM`,
    `if (-not $plat) {`,
    `  $arch = $env:PROCESSOR_ARCHITECTURE`,
    `  if ($arch -eq 'ARM64') { $plat = 'windows-arm64' } else { $plat = 'windows-x64' }`,
    `}`,
    ``,
    `$installDir = Join-Path $env:LOCALAPPDATA 'ChadCode'`,
    `$binary = Join-Path $installDir 'chadcode.exe'`,
    `New-Item -ItemType Directory -Force -Path $installDir | Out-Null`,
    ``,
    `Write-Host "Downloading $plat binary..." -ForegroundColor Cyan`,
    `$headers = @{ Authorization = "Bearer $env:CHADCODE_LICENSE" }`,
    `try {`,
    `  Invoke-WebRequest -UseBasicParsing -Headers $headers -Uri "${self}/download?platform=$plat" -OutFile $binary`,
    `} catch {`,
    `  Write-Host "Download failed. If the server returned 404 the binary for $plat hasn't been uploaded yet — tell the founder." -ForegroundColor Red`,
    `  Write-Host $_.Exception.Message -ForegroundColor Red`,
    `  exit 1`,
    `}`,
    ``,
    `# Verify the download is actually a Windows PE and matches this box's`,
    `# architecture. The last incident: someone chose CHADCODE_PLATFORM=`,
    `# windows-arm64 while running x64 Windows — the binary ran straight`,
    `# into "not a valid application for this OS platform". Catch that here`,
    `# instead of leaving a broken exe on disk.`,
    `$head = [System.IO.File]::ReadAllBytes($binary) | Select-Object -First 512`,
    `$fileLen = (Get-Item $binary).Length`,
    `if ($head.Length -lt 64 -or $head[0] -ne 0x4D -or $head[1] -ne 0x5A) {`,
    `  Write-Host "Downloaded file is NOT a Windows executable ($fileLen bytes, first 2 bytes not MZ)." -ForegroundColor Red`,
    `  Write-Host "Likely the server returned an error body. Check your license key or that the $plat build is uploaded to R2." -ForegroundColor Yellow`,
    `  Remove-Item $binary -Force`,
    `  exit 1`,
    `}`,
    `$peOff = [BitConverter]::ToUInt32($head, 0x3C)`,
    `if ($peOff -gt 0 -and $peOff + 6 -lt $head.Length -and $head[$peOff] -eq 0x50 -and $head[$peOff+1] -eq 0x45) {`,
    `  $machine = [BitConverter]::ToUInt16($head, $peOff + 4)`,
    `  $arch = $env:PROCESSOR_ARCHITECTURE`,
    `  $wantMachine = if ($arch -eq 'ARM64') { 0xAA64 } elseif ($arch -eq 'AMD64' -or $arch -eq 'x64') { 0x8664 } else { 0 }`,
    `  if ($wantMachine -ne 0 -and $machine -ne $wantMachine) {`,
    `    $machineName = switch ($machine) { 0x014c {'x86 32-bit'} 0x8664 {'AMD64 (windows-x64)'} 0xAA64 {'ARM64 (windows-arm64)'} default {'unknown 0x' + $machine.ToString('X4')} }`,
    `    Write-Host "Architecture mismatch: your CPU is $arch but the downloaded binary targets $machineName." -ForegroundColor Red`,
    `    $wantPlat = if ($arch -eq 'ARM64') { 'windows-arm64' } else { 'windows-x64' }`,
    `    Write-Host ('Re-run with:  $env:CHADCODE_PLATFORM=''' + $wantPlat + ''' then try the installer again.') -ForegroundColor Yellow`,
    `    Remove-Item $binary -Force`,
    `    exit 1`,
    `  }`,
    `}`,
    ``,
    `# Add to user PATH if not already there, and refresh the CURRENT`,
    `# session's $env:Path so 'chadcode' works right away without restart.`,
    `$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')`,
    `if ($userPath -notlike "*$installDir*") {`,
    `  [Environment]::SetEnvironmentVariable('Path', "$userPath;$installDir", 'User')`,
    `  Write-Host "Added $installDir to your user PATH." -ForegroundColor Green`,
    `}`,
    `# Refresh this session's PATH so the new binary is callable right now.`,
    `$machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')`,
    `$userPathNow = [Environment]::GetEnvironmentVariable('Path', 'User')`,
    `$env:Path = "$machinePath;$userPathNow"`,
    ``,
    ``,
    `# Register the chadcode:// protocol handler so the browser "Open ChadCode?"`,
    `# popup works after /cli-auth approves a device-code login. Scoped to`,
    `# HKCU so no admin is needed; CLI picks up deep-link args via -- url.`,
    `$proto = 'HKCU:Software\\Classes\\chadcode'`,
    `New-Item -Path $proto -Force | Out-Null`,
    `Set-ItemProperty -Path $proto -Name '(Default)' -Value 'URL:ChadCode Protocol'`,
    `Set-ItemProperty -Path $proto -Name 'URL Protocol' -Value ''`,
    `New-Item -Path (Join-Path $proto 'shell\\open\\command') -Force | Out-Null`,
    `Set-ItemProperty -Path (Join-Path $proto 'shell\\open\\command') -Name '(Default)' -Value ('\"' + $binary + '\" login --url \"%1\"')`,
    `Write-Host 'Registered chadcode:// URL handler.' -ForegroundColor Green`,
    ``,
    ``,
    `# First-run config: drop ChadGPT provider definition if the user`,
    `# doesn't already have an opencode.jsonc. Never overwrite.`,
    `$configDir = Join-Path $env:APPDATA 'opencode'`,
    `$configFile = Join-Path $configDir 'opencode.jsonc'`,
    `if (-not (Test-Path $configFile)) {`,
    `  New-Item -ItemType Directory -Force -Path $configDir | Out-Null`,
    `  try {`,
    `    Invoke-WebRequest -UseBasicParsing -Uri '${self}/opencode-config.jsonc' -OutFile $configFile`,
    `    Write-Host "Installed default ChadGPT config at $configFile" -ForegroundColor Green`,
    `  } catch {`,
    `    Write-Host "Could not fetch default config — chadcode will still run but models may be missing." -ForegroundColor DarkYellow`,
    `  }`,
    `}`,
    ``,
    `Write-Host ""`,
    `Write-Host "Installed: $binary" -ForegroundColor Green`,
    `Write-Host "Run:   chadcode" -ForegroundColor Green`,
    `Write-Host "       (or use the full path: & '$binary' — in case PATH refresh didn't take)" -ForegroundColor DarkGray`,
    ``,
  ].join("\r\n");
  return new Response(script, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      ...CORS,
    },
  });
}

// ---------- /install.sh ----------
// macOS + Linux companion so the Windows button isn't the only
// command-based install path. Same contract — CHADCODE_LICENSE in env,
// optional CHADCODE_PLATFORM override.
function installSh(request, env) {
  const self = new URL(request.url).origin;
  const script = [
    `#!/usr/bin/env bash`,
    `# ChadCode installer for macOS + Linux.`,
    `# Usage:`,
    `#   CHADCODE_LICENSE=<key> bash -c "$(curl -fsSL ${self}/install.sh)"`,
    ``,
    `set -euo pipefail`,
    ``,
    `if [ -z "\${CHADCODE_LICENSE:-}" ]; then`,
    `  echo "ERROR: set CHADCODE_LICENSE=<key> before running the installer." >&2`,
    `  echo "Get your key at https://chadgpt-964.pages.dev/cli" >&2`,
    `  exit 1`,
    `fi`,
    ``,
    `# Persist the license key for future shells by appending an export`,
    `# line to the user's shell rc. We pick the first rc file that exists`,
    `# and only add the export if it isn't already there. Users with a`,
    `# different shell can of course set it themselves; this covers 95%.`,
    `rc=""`,
    `for cand in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.profile"; do`,
    `  if [ -f "$cand" ]; then rc="$cand"; break; fi`,
    `done`,
    `[ -z "$rc" ] && rc="$HOME/.profile" && : > "$rc"`,
    `if ! grep -q "CHADCODE_LICENSE=" "$rc" 2>/dev/null; then`,
    `  echo "" >> "$rc"`,
    `  echo "# ChadCode license (added by installer)" >> "$rc"`,
    `  echo "export CHADCODE_LICENSE='$CHADCODE_LICENSE'" >> "$rc"`,
    `  echo "Saved CHADCODE_LICENSE to $rc — new shells will pick it up automatically."`,
    `fi`,
    ``,
    `plat="\${CHADCODE_PLATFORM:-}"`,
    `if [ -z "$plat" ]; then`,
    `  os="$(uname -s | tr '[:upper:]' '[:lower:]')"`,
    `  arch="$(uname -m)"`,
    `  case "$os" in darwin) os=darwin ;; linux) os=linux ;; *) echo "unsupported OS: $os" >&2; exit 1 ;; esac`,
    `  case "$arch" in x86_64|amd64) arch=x64 ;; arm64|aarch64) arch=arm64 ;; *) echo "unsupported arch: $arch" >&2; exit 1 ;; esac`,
    `  plat="$os-$arch"`,
    `fi`,
    ``,
    `install_dir="$HOME/.local/bin"`,
    `mkdir -p "$install_dir"`,
    `binary="$install_dir/chadcode"`,
    ``,
    `echo "Downloading $plat binary..."`,
    `if ! curl -fsSL -H "Authorization: Bearer $CHADCODE_LICENSE" "${self}/download?platform=$plat" -o "$binary"; then`,
    `  echo "Download failed. If the server returned 404 the binary for $plat hasn't been uploaded yet — tell the founder." >&2`,
    `  exit 1`,
    `fi`,
    `chmod +x "$binary"`,
    ``,
    `echo "Installed: $binary"`,
    `case ":$PATH:" in`,
    `  *":$install_dir:"*) ;;`,
    `  *) echo "NOTE: $install_dir is not on your PATH yet. Add this to your shell rc:" ; echo "  export PATH=\\\"$install_dir:\\$PATH\\\"" ;;`,
    `esac`,
    ``,
    `# Register the chadcode:// URL handler so the browser "Open ChadCode?"`,
    `# popup works after /cli-auth approves a device-code login.`,
    `case "$(uname -s)" in`,
    `  Darwin)`,
    `    plist="$HOME/Library/LaunchAgents/com.chadcode.handler.plist"`,
    `    # On macOS a proper URL handler needs an .app bundle; we install a`,
    `    # minimal one that just shells out to the binary. Skip if unavailable.`,
    `    app="$HOME/Applications/ChadCode.app"`,
    `    mkdir -p "$app/Contents/MacOS"`,
    `    cat > "$app/Contents/Info.plist" <<PLIST`,
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0"><dict>`,
    `  <key>CFBundleIdentifier</key><string>com.chadcode.cli</string>`,
    `  <key>CFBundleName</key><string>ChadCode</string>`,
    `  <key>CFBundleExecutable</key><string>launcher</string>`,
    `  <key>CFBundleURLTypes</key><array><dict>`,
    `    <key>CFBundleURLName</key><string>ChadCode</string>`,
    `    <key>CFBundleURLSchemes</key><array><string>chadcode</string></array>`,
    `  </dict></array>`,
    `</dict></plist>`,
    `PLIST`,
    `    cat > "$app/Contents/MacOS/launcher" <<LAUNCH`,
    `#!/bin/sh`,
    `exec "$binary" login --url "\\$1"`,
    `LAUNCH`,
    `    chmod +x "$app/Contents/MacOS/launcher"`,
    `    # Touch to register with Launch Services (best-effort).`,
    `    /usr/bin/touch "$app"`,
    `    echo "Registered chadcode:// URL handler (macOS)."`,
    `    ;;`,
    `  Linux)`,
    `    desktop="$HOME/.local/share/applications/chadcode.desktop"`,
    `    mkdir -p "$(dirname "$desktop")"`,
    `    cat > "$desktop" <<DESK`,
    `[Desktop Entry]`,
    `Name=ChadCode`,
    `Exec=$binary login --url %u`,
    `Type=Application`,
    `MimeType=x-scheme-handler/chadcode;`,
    `NoDisplay=true`,
    `DESK`,
    `    if command -v xdg-mime >/dev/null; then`,
    `      xdg-mime default chadcode.desktop x-scheme-handler/chadcode 2>/dev/null || true`,
    `      echo "Registered chadcode:// URL handler (Linux)."`,
    `    else`,
    `      echo "NOTE: install xdg-utils so the chadcode:// URL handler is picked up by your desktop."`,
    `    fi`,
    `    ;;`,
    `esac`,
    ``,
    `# First-run config: drop ChadGPT provider definition if missing.`,
    `config_dir="$HOME/.config/opencode"`,
    `config_file="$config_dir/opencode.jsonc"`,
    `if [ ! -f "$config_file" ]; then`,
    `  mkdir -p "$config_dir"`,
    `  if curl -fsSL "${self}/opencode-config.jsonc" -o "$config_file"; then`,
    `    echo "Installed default ChadGPT config at $config_file"`,
    `  else`,
    `    echo "NOTE: could not fetch default config — chadcode will still run but models may be missing."`,
    `  fi`,
    `fi`,
    ``,
    `echo "Run: chadcode"`,
    ``,
  ].join("\n");
  return new Response(script, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      ...CORS,
    },
  });
}

// ---------- /opencode-config.jsonc ----------
// Serves the ChadCode-flavored opencode config so installers can write it
// to the user's config dir without bundling the full JSON in the install
// script. Kept here because this worker already serves install.ps1/sh.
function opencodeConfig(request, env) {
  const body = `// ChadCode default config. Replace with your own at:
//   Linux/mac: ~/.config/opencode/opencode.jsonc
//   Windows:   %APPDATA%\\opencode\\opencode.jsonc
// Only ChadGPT provider is registered — third-party providers are
// intentionally excluded in this build.
{
  "$schema": "https://opencode.ai/config.json",
  "theme": "chadcode",
  "autoshare": false,
  "autoupdate": false,
  "provider": {
    "chadgpt": {
      "name": "ChadGPT",
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "https://chadgpt-964.pages.dev/v1",
        "apiKey": "{env:CHADCODE_LICENSE}"
      },
      "models": {
        "chadgpt-fast":   { "name": "ChadGPT Fast (free)",   "limit": { "context": 8192,  "output": 4096 }, "tool_call": true },
        "chadgpt-small":  { "name": "ChadGPT Small (free)",  "limit": { "context": 8192,  "output": 4096 }, "tool_call": true },
        "chadgpt-tiny":   { "name": "ChadGPT Tiny (free)",   "limit": { "context": 4096,  "output": 2048 }, "tool_call": true },
        "chadgpt-pro":    { "name": "ChadGPT Pro (Plus)",    "limit": { "context": 8192,  "output": 4096 }, "tool_call": true },
        "chadgpt-coder":  { "name": "ChadCoder (Plus)",      "limit": { "context": 16384, "output": 8192 }, "tool_call": true },
        "chadgpt-ultra":  { "name": "ChadGPT Ultra (Plus)",  "limit": { "context": 32768, "output": 8192 }, "tool_call": true }
      }
    }
  },
  "model": "chadgpt/chadgpt-fast",
  "small_model": "chadgpt/chadgpt-small"
}
`;
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'application/jsonc; charset=utf-8', 'Cache-Control': 'no-store', ...CORS },
  });
}

// ---------- /license/revoke ----------
async function revoke(request, env) {
  if (!founderAuth(request, env)) return j({ error: 'founder only' }, 403);
  const body = await request.json().catch(() => null);
  if (!body?.key) return j({ error: 'key required' }, 400);
  const keyHash = await sha256Hex(body.key);
  const r = await env.LIC_DB.prepare('UPDATE licenses SET revoked = 1 WHERE key_hash = ?').bind(keyHash).run();
  return j({ ok: true, changes: r.meta?.changes || 0 });
}

// ---------- /update/check ----------
async function updateCheck(request, env) {
  const url = new URL(request.url);
  const current = url.searchParams.get('version') || '0.0.0';
  const platform = url.searchParams.get('platform') || 'unknown';
  const channel = url.searchParams.get('channel') || 'stable';
  if (!env.LIC_DB) return j({ error: 'LIC_DB not bound' }, 500);

  const row = await env.LIC_DB.prepare(
    'SELECT version, platform, url, sha256, signature, published_at FROM releases WHERE channel = ? AND platform = ? ORDER BY published_at DESC LIMIT 1'
  ).bind(channel, platform).first();
  if (!row) return j({ update_available: false, current, reason: 'no release for platform' });
  if (semverCompare(row.version, current) <= 0) {
    return j({ update_available: false, current, latest: row.version });
  }
  return j({
    update_available: true,
    current,
    latest: row.version,
    url: row.url,
    sha256: row.sha256,
    signature: row.signature,
    published_at: row.published_at,
  });
}

function semverCompare(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

// ---------- /update/publish ----------
// Founder-only. Body: { channel, version, platform, url, sha256, signature }
async function updatePublish(request, env) {
  if (!founderAuth(request, env)) return j({ error: 'founder only' }, 403);
  const b = await request.json().catch(() => null);
  const need = ['channel', 'version', 'platform', 'url', 'sha256', 'signature'];
  for (const k of need) if (!b?.[k]) return j({ error: `${k} required` }, 400);
  await env.LIC_DB.prepare(
    'INSERT INTO releases (channel, version, platform, url, sha256, signature, published_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(b.channel, b.version, b.platform, b.url, b.sha256, b.signature, Date.now()).run();
  return j({ ok: true });
}

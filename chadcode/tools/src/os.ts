// OS-control tools: clipboard, open file/URL in default app, screenshot,
// OS info, env, notify.
//
// Everything that needs a native capability (clipboard, screenshot,
// notification) shells out to the platform's built-in CLI — no native
// Node bindings. This keeps the tools package pure JS and installable
// without a C toolchain.

import { exec, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { ToolDef, ToolResult, ToolContext } from './types.js';

const execP = promisify(exec);

function platform(): 'darwin' | 'linux' | 'win32' | 'other' {
  if (process.platform === 'darwin') return 'darwin';
  if (process.platform === 'linux') return 'linux';
  if (process.platform === 'win32') return 'win32';
  return 'other';
}

// ---------- clipboard_read ----------
export const clipboardRead: ToolDef<Record<string, never>> = {
  name: 'clipboard_read',
  description: 'Read the user\'s system clipboard. Returns text. Supported on macOS (pbpaste), Linux (xclip / xsel / wl-paste), Windows (PowerShell Get-Clipboard).',
  risk: 'medium',
  parameters: { type: 'object', properties: {} },
  async execute(_input, ctx) {
    const okd = await ctx.confirm({ tool: 'clipboard_read', action: 'read system clipboard', risk: 'medium' });
    if (!okd) return { ok: false, error: 'user denied' };
    try {
      const p = platform();
      let cmd: string;
      if (p === 'darwin') cmd = 'pbpaste';
      else if (p === 'win32') cmd = 'powershell -NoProfile -Command "Get-Clipboard"';
      else if (p === 'linux') {
        // Prefer wl-paste for Wayland; fall back to xclip, xsel.
        cmd = 'command -v wl-paste >/dev/null && wl-paste || (command -v xclip >/dev/null && xclip -selection clipboard -o) || xsel --clipboard --output';
      } else return { ok: false, error: `clipboard not supported on ${p}` };
      const { stdout } = await execP(cmd);
      return { ok: true, content: stdout };
    } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
  },
};

// ---------- clipboard_write ----------
export const clipboardWrite: ToolDef<{ text: string }> = {
  name: 'clipboard_write',
  description: 'Replace the user\'s system clipboard contents with text. Supported on macOS, Linux (xclip / wl-copy), Windows.',
  risk: 'medium',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
  async execute(input, ctx) {
    const okd = await ctx.confirm({
      tool: 'clipboard_write',
      action: `write ${input.text.length} chars to clipboard`,
      risk: 'medium',
      preview: input.text.slice(0, 200),
    });
    if (!okd) return { ok: false, error: 'user denied' };
    return new Promise((resolve) => {
      const p = platform();
      let cmd: string, args: string[];
      if (p === 'darwin') { cmd = 'pbcopy'; args = []; }
      else if (p === 'win32') { cmd = 'clip'; args = []; }
      else if (p === 'linux') {
        // Try wl-copy first, then xclip.
        cmd = 'sh'; args = ['-c', 'if command -v wl-copy >/dev/null; then wl-copy; else xclip -selection clipboard; fi'];
      }
      else return resolve({ ok: false, error: `clipboard not supported on ${p}` });
      const child = spawn(cmd, args);
      child.on('error', (e) => resolve({ ok: false, error: e.message }));
      child.on('exit', (code) => {
        resolve(code === 0 ? { ok: true, content: `clipboard set (${input.text.length} chars)` } : { ok: false, error: `${cmd} exit ${code}` });
      });
      child.stdin.write(input.text);
      child.stdin.end();
    });
  },
};

// ---------- open_url ----------
export const openUrl: ToolDef<{ url: string }> = {
  name: 'open_url',
  description: 'Open a URL in the user\'s default browser.',
  risk: 'medium',
  parameters: {
    type: 'object',
    properties: { url: { type: 'string' } },
    required: ['url'],
  },
  async execute(input, ctx) {
    try { new URL(input.url); } catch { return { ok: false, error: `invalid URL: ${input.url}` }; }
    const okd = await ctx.confirm({ tool: 'open_url', action: `open in browser: ${input.url}`, risk: 'medium' });
    if (!okd) return { ok: false, error: 'user denied' };
    return openWithOs(input.url);
  },
};

// ---------- open_file ----------
export const openFile: ToolDef<{ path: string }> = {
  name: 'open_file',
  description: 'Open a file with the user\'s default application for its type (same as double-clicking it).',
  risk: 'medium',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
  async execute(input, ctx) {
    const abs = path.resolve(ctx.cwd, input.path);
    try { await fs.access(abs); } catch { return { ok: false, error: `no such file: ${abs}` }; }
    const okd = await ctx.confirm({ tool: 'open_file', action: `open in default app: ${abs}`, risk: 'medium' });
    if (!okd) return { ok: false, error: 'user denied' };
    return openWithOs(abs);
  },
};

function openWithOs(target: string): Promise<ToolResult> {
  return new Promise((resolve) => {
    const p = platform();
    let cmd: string, args: string[];
    if (p === 'darwin') { cmd = 'open'; args = [target]; }
    else if (p === 'win32') { cmd = 'cmd.exe'; args = ['/c', 'start', '', target]; }
    else if (p === 'linux') { cmd = 'xdg-open'; args = [target]; }
    else return resolve({ ok: false, error: `open not supported on ${p}` });
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', (e) => resolve({ ok: false, error: e.message }));
    child.unref();
    // No reliable exit — spawning is the whole operation.
    resolve({ ok: true, content: `opened ${target}` });
  });
}

// ---------- screenshot ----------
export const screenshot: ToolDef<{ out_path?: string; display_number?: number }> = {
  name: 'screenshot',
  description: 'Take a screenshot of the user\'s screen and save to out_path (default: ./screenshot-<timestamp>.png). Returns the path. Supported on macOS (screencapture), Linux (grim / gnome-screenshot / import), Windows (PowerShell).',
  risk: 'high',
  parameters: {
    type: 'object',
    properties: {
      out_path: { type: 'string', description: 'Where to save the PNG. Default: screenshot-<ts>.png in cwd.' },
      display_number: { type: 'integer', description: 'Display index on macOS/Linux (optional).' },
    },
  },
  async execute(input, ctx) {
    const ts = Date.now();
    const out = path.resolve(ctx.cwd, input.out_path || `screenshot-${ts}.png`);
    const okd = await ctx.confirm({
      tool: 'screenshot',
      action: `capture screen → ${out}`,
      risk: 'high',
      preview: 'this captures the visible screen and saves a PNG — the model will NOT see the image unless the host surfaces it.',
    });
    if (!okd) return { ok: false, error: 'user denied' };
    try {
      await fs.mkdir(path.dirname(out), { recursive: true });
      const p = platform();
      if (p === 'darwin') {
        const args = ['-x']; // no sound
        if (input.display_number !== undefined) args.push(`-D${input.display_number + 1}`);
        args.push(out);
        await execCmd('screencapture', args);
      } else if (p === 'linux') {
        // Try grim (wayland), then gnome-screenshot, then imagemagick's `import`.
        if (await which('grim')) await execCmd('grim', [out]);
        else if (await which('gnome-screenshot')) await execCmd('gnome-screenshot', ['-f', out]);
        else if (await which('import')) await execCmd('import', ['-window', 'root', out]);
        else return { ok: false, error: 'install one of: grim, gnome-screenshot, imagemagick' };
      } else if (p === 'win32') {
        const ps = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; $g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); $bmp.Save('${out.replace(/'/g, "''")}','Png')`;
        await execCmd('powershell', ['-NoProfile', '-Command', ps]);
      } else return { ok: false, error: `screenshot not supported on ${p}` };
      const stat = await fs.stat(out);
      return { ok: true, content: `saved ${out} (${stat.size} bytes)`, extra: { path: out, bytes: stat.size } };
    } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
  },
};

// ---------- os_info ----------
export const osInfo: ToolDef<Record<string, never>> = {
  name: 'os_info',
  description: 'Return basic info about the host: platform, arch, cpu model, total/free memory, uptime, hostname, user, shell, node version.',
  risk: 'low',
  parameters: { type: 'object', properties: {} },
  async execute() {
    const info = {
      platform: process.platform,
      release: os.release(),
      arch: os.arch(),
      cpu: os.cpus()?.[0]?.model || 'unknown',
      cores: os.cpus()?.length || 0,
      mem_total_mb: Math.round(os.totalmem() / 1024 / 1024),
      mem_free_mb: Math.round(os.freemem() / 1024 / 1024),
      uptime_s: Math.round(os.uptime()),
      hostname: os.hostname(),
      user: os.userInfo().username,
      shell: process.env.SHELL || process.env.COMSPEC || 'unknown',
      node: process.version,
      cwd: process.cwd(),
    };
    return { ok: true, content: JSON.stringify(info, null, 2), extra: info };
  },
};

// ---------- env_get ----------
export const envGet: ToolDef<{ name: string }> = {
  name: 'env_get',
  description: 'Read one environment variable. Use env_list to see names first. Variables commonly containing secrets (TOKEN, KEY, SECRET, PASSWORD) require approval.',
  risk: 'medium',
  parameters: {
    type: 'object',
    properties: { name: { type: 'string' } },
    required: ['name'],
  },
  async execute(input, ctx) {
    const secretLike = /(TOKEN|KEY|SECRET|PASSWORD|PRIVATE|CREDENTIAL|SESSION)/i.test(input.name);
    if (secretLike) {
      const okd = await ctx.confirm({
        tool: 'env_get',
        action: `read env ${input.name} (looks like a secret)`,
        risk: 'high',
      });
      if (!okd) return { ok: false, error: 'user denied' };
    }
    const v = process.env[input.name];
    if (v === undefined) return { ok: false, error: `${input.name} is not set` };
    return { ok: true, content: v };
  },
};

// ---------- env_list ----------
export const envList: ToolDef<{ pattern?: string }> = {
  name: 'env_list',
  description: 'List names of environment variables (NOT values). Optional pattern filters the list.',
  risk: 'low',
  parameters: {
    type: 'object',
    properties: { pattern: { type: 'string', description: 'Case-insensitive substring filter.' } },
  },
  async execute(input) {
    const pat = (input.pattern || '').toLowerCase();
    const names = Object.keys(process.env).filter((n) => !pat || n.toLowerCase().includes(pat)).sort();
    return { ok: true, content: names.join('\n') || '(no matches)' };
  },
};

// ---------- notify ----------
export const notify: ToolDef<{ title: string; body?: string }> = {
  name: 'notify',
  description: 'Show a desktop notification. macOS: osascript display notification. Linux: notify-send. Windows: PowerShell BurntToast if available, else a MessageBox.',
  risk: 'low',
  parameters: {
    type: 'object',
    properties: { title: { type: 'string' }, body: { type: 'string' } },
    required: ['title'],
  },
  async execute(input) {
    const p = platform();
    const title = input.title.replace(/"/g, '\\"');
    const body = (input.body || '').replace(/"/g, '\\"');
    try {
      if (p === 'darwin') {
        await execCmd('osascript', ['-e', `display notification "${body}" with title "${title}"`]);
      } else if (p === 'linux') {
        if (!(await which('notify-send'))) return { ok: false, error: 'install libnotify (notify-send)' };
        await execCmd('notify-send', [input.title, input.body || '']);
      } else if (p === 'win32') {
        await execCmd('powershell', ['-NoProfile', '-Command',
          `Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show("${body}","${title}") | Out-Null`]);
      } else return { ok: false, error: `notify not supported on ${p}` };
      return { ok: true, content: 'notification shown' };
    } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
  },
};

// ---------- helpers ----------
function execCmd(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args);
    let out = '', err = '';
    c.stdout.on('data', (b) => { out += b.toString('utf8'); });
    c.stderr.on('data', (b) => { err += b.toString('utf8'); });
    c.on('error', reject);
    c.on('exit', (code) => code === 0 ? resolve(out) : reject(new Error(err.trim() || `${cmd} exit ${code}`)));
  });
}
async function which(name: string): Promise<boolean> {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'command -v';
    await execP(`${cmd} ${name}`);
    return true;
  } catch { return false; }
}

export const osTools = { clipboardRead, clipboardWrite, openUrl, openFile, screenshot, osInfo, envGet, envList, notify };

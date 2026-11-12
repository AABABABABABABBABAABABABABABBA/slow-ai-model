// Search tools: ripgrep-backed grep, glob, fuzzy file search.
//
// Relies on the `rg` binary being on PATH. We check once at startup and
// cache the result; if it's missing the tool returns a clear error asking
// the user to install ripgrep. No native dependency required.

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ToolDef, ToolResult, ToolContext } from './types.js';
import { resolvePath, describePath } from './paths.js';

const MAX_GREP_MATCHES = 50;
const MAX_GLOB_RESULTS = 200;

function ok(content: string, extra?: Record<string, unknown>): ToolResult { return { ok: true, content, extra }; }
function err(msg: string): ToolResult { return { ok: false, error: msg }; }

let rgChecked = false;
let rgPresent = false;

async function hasRg(): Promise<boolean> {
  if (rgChecked) return rgPresent;
  rgChecked = true;
  rgPresent = await new Promise((resolve) => {
    const p = spawn('rg', ['--version'], { stdio: ['ignore', 'ignore', 'ignore'] });
    p.on('error', () => resolve(false));
    p.on('exit', (code) => resolve(code === 0));
  });
  return rgPresent;
}

// ---------- grep_search ----------
export const grepSearch: ToolDef<{ query: string; include_pattern?: string; exclude_pattern?: string; case_sensitive?: boolean }> = {
  name: 'grep_search',
  description: 'Fast exact / regex search using ripgrep. Capped at 50 matches. Use for known symbols, function names, strings.',
  risk: 'low',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Regex pattern. Escape ( ) [ ] { } + * ? ^ $ | . \\\\ when searching literally.' },
      include_pattern: { type: 'string', description: 'Glob to include, e.g. "*.ts".' },
      exclude_pattern: { type: 'string', description: 'Glob to exclude, e.g. "**/dist/**".' },
      case_sensitive: { type: 'boolean' },
    },
    required: ['query'],
  },
  async execute(input, ctx) {
    if (!(await hasRg())) return err('ripgrep (rg) not installed — install from https://github.com/BurntSushi/ripgrep');
    const args = ['--no-heading', '--line-number', '--color=never'];
    if (!input.case_sensitive) args.push('--smart-case');
    args.push('--max-count', String(MAX_GREP_MATCHES));
    if (input.include_pattern) args.push('--glob', input.include_pattern);
    if (input.exclude_pattern) args.push('--glob', `!${input.exclude_pattern}`);
    args.push('--', input.query, '.');
    return runCmd('rg', args, ctx, { maxLines: MAX_GREP_MATCHES });
  },
};

// ---------- file_search (fuzzy by basename) ----------
export const fileSearch: ToolDef<{ query: string; limit?: number }> = {
  name: 'file_search',
  description: 'Find files whose path contains the query substring (case-insensitive). Up to 10 hits. Use when you know part of a filename.',
  risk: 'low',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      limit: { type: 'integer', description: 'Max results. Default 10, cap 100.' },
    },
    required: ['query'],
  },
  async execute(input, ctx) {
    const limit = Math.min(input.limit || 10, 100);
    const q = input.query.toLowerCase();
    const hits: string[] = [];
    try {
      await walk(ctx.cwd, (rel) => {
        if (rel.toLowerCase().includes(q)) { hits.push(rel); }
        return hits.length >= limit * 5; // stop when we have enough to rank
      });
      // Rank: substring match in basename wins over match deeper in path.
      hits.sort((a, b) => {
        const ba = path.basename(a).toLowerCase(), bb = path.basename(b).toLowerCase();
        const sa = ba.includes(q) ? 0 : 1, sb = bb.includes(q) ? 0 : 1;
        if (sa !== sb) return sa - sb;
        return a.length - b.length;
      });
      const top = hits.slice(0, limit);
      return ok(top.length ? top.join('\n') : `no files matching "${input.query}"`);
    } catch (e: any) { return err(e?.message || String(e)); }
  },
};

// ---------- glob ----------
export const glob: ToolDef<{ pattern: string }> = {
  name: 'glob',
  description: 'List files matching a glob pattern (e.g. "src/**/*.ts"). Uses Node internal matcher — no external dependency.',
  risk: 'low',
  parameters: {
    type: 'object',
    properties: { pattern: { type: 'string' } },
    required: ['pattern'],
  },
  async execute(input, ctx) {
    const re = globToRegex(input.pattern);
    const hits: string[] = [];
    try {
      await walk(ctx.cwd, (rel) => {
        if (re.test(rel)) hits.push(rel);
        return hits.length >= MAX_GLOB_RESULTS;
      });
      return ok(hits.length ? hits.join('\n') : `no matches for ${input.pattern}`);
    } catch (e: any) { return err(e?.message || String(e)); }
  },
};

// ---------- shared helpers ----------
async function walk(root: string, visit: (rel: string) => boolean | void): Promise<void> {
  const stack: string[] = [root];
  const skip = new Set(['.git', 'node_modules', 'dist', '.turbo', '.next', 'build', 'target', '.venv', '__pycache__']);
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: any[];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (skip.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs);
      if (e.isDirectory()) { stack.push(abs); continue; }
      if (visit(rel) === true) return;
    }
  }
}

function globToRegex(pat: string): RegExp {
  let re = '^';
  let i = 0;
  while (i < pat.length) {
    const c = pat[i];
    if (c === '*') {
      if (pat[i + 1] === '*') { re += '.*'; i += 2; if (pat[i] === '/') i++; }
      else { re += '[^/]*'; i++; }
    } else if (c === '?') { re += '[^/]'; i++; }
    else if ('.()+|^$'.includes(c)) { re += '\\' + c; i++; }
    else { re += c; i++; }
  }
  re += '$';
  return new RegExp(re);
}

function runCmd(cmd: string, args: string[], ctx: ToolContext, limits: { maxLines: number }): Promise<ToolResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: ctx.cwd });
    let out = '';
    let lines = 0;
    child.stdout.on('data', (b) => {
      if (lines > limits.maxLines) return;
      out += b.toString('utf8');
      lines = out.split('\n').length;
    });
    let err = '';
    child.stderr.on('data', (b) => { err += b.toString('utf8'); });
    child.on('error', (e) => resolve({ ok: false, error: e.message }));
    child.on('exit', (code) => {
      const trimmed = out.split('\n').slice(0, limits.maxLines).join('\n');
      if (code === 0 || code === 1) {
        resolve({ ok: true, content: trimmed || '(no matches)' });
      } else {
        resolve({ ok: false, error: err.trim() || `exit ${code}` });
      }
    });
    if (ctx.signal) ctx.signal.addEventListener('abort', () => child.kill());
  });
}

export const searchTools = { grepSearch, fileSearch, glob };

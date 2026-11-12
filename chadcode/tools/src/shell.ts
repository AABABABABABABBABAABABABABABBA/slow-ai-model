// Shell tools: run a command, run a background process, list, kill.
//
// Every run_command call hits the approval prompt. The preview shows the
// exact command, its cwd, and (when relevant) a short description of what
// will happen on this OS.
//
// Background processes get a per-session pid registry in ctx.session.bgPids
// so list_processes and kill_process can act on them without touching
// unrelated OS processes.

import { spawn, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import type { ToolDef, ToolResult, ToolContext } from './types.js';

const MAX_OUTPUT_BYTES = 200_000;
const DEFAULT_TIMEOUT_MS = 60_000;

type BgEntry = { pid: number; cmd: string; started: number; child: ChildProcess; output: string[] };

function getBgRegistry(ctx: ToolContext): Map<number, BgEntry> {
  const key = '__chadcode_bg';
  let reg = ctx.session[key] as Map<number, BgEntry> | undefined;
  if (!reg) { reg = new Map(); ctx.session[key] = reg; }
  return reg;
}

function pickShell(): { shell: string; flag: string } {
  if (process.platform === 'win32') {
    return { shell: process.env.COMSPEC || 'cmd.exe', flag: '/d /s /c' };
  }
  return { shell: process.env.SHELL || '/bin/sh', flag: '-c' };
}

// ---------- run_command ----------
export const runCommand: ToolDef<{ command: string; is_background?: boolean; timeout_ms?: number; explanation?: string }> = {
  name: 'run_command',
  description: 'Run a shell command in the user\'s current working directory. Prompts for approval unless in yolo mode. For long-running processes (servers, watchers), set is_background: true and the call returns a pid.',
  risk: 'high',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Full shell command. Quote arguments correctly.' },
      is_background: { type: 'boolean', description: 'Spawn and return a pid without waiting for exit.' },
      timeout_ms: { type: 'integer', description: 'Max runtime in ms for foreground commands. Default 60000.' },
      explanation: { type: 'string', description: 'One sentence describing why.' },
    },
    required: ['command'],
  },
  async execute(input, ctx) {
    const risk = isDestructive(input.command) ? 'high' : 'medium';
    const okd = await ctx.confirm({
      tool: 'run_command',
      action: `run${input.is_background ? ' (bg)' : ''}: ${truncate(input.command, 80)}`,
      risk,
      preview: `${input.command}\ncwd: ${ctx.cwd}\nos: ${process.platform} ${os.arch()}${input.explanation ? `\nwhy: ${input.explanation}` : ''}`,
    });
    if (!okd) return { ok: false, error: 'user denied' };

    const { shell, flag } = pickShell();
    const flags = flag.split(' ');

    if (input.is_background) {
      const child = spawn(shell, [...flags, input.command], {
        cwd: ctx.cwd,
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const entry: BgEntry = { pid: child.pid || -1, cmd: input.command, started: Date.now(), child, output: [] };
      child.stdout?.on('data', (b) => { if (entry.output.length < 500) entry.output.push(b.toString('utf8')); });
      child.stderr?.on('data', (b) => { if (entry.output.length < 500) entry.output.push(b.toString('utf8')); });
      child.on('exit', () => { /* leave entry in registry so logs are still visible */ });
      if (entry.pid > 0) getBgRegistry(ctx).set(entry.pid, entry);
      return { ok: true, content: `started pid ${entry.pid}: ${input.command}`, extra: { pid: entry.pid } };
    }

    return new Promise<ToolResult>((resolve) => {
      const child = spawn(shell, [...flags, input.command], { cwd: ctx.cwd });
      let out = '';
      let truncated = false;
      const pushChunk = (b: Buffer) => {
        if (truncated) return;
        out += b.toString('utf8');
        if (out.length > MAX_OUTPUT_BYTES) {
          out = out.slice(0, MAX_OUTPUT_BYTES);
          truncated = true;
        }
      };
      child.stdout.on('data', pushChunk);
      child.stderr.on('data', pushChunk);
      const timeout = setTimeout(() => { child.kill('SIGKILL'); }, input.timeout_ms || DEFAULT_TIMEOUT_MS);
      child.on('error', (e) => { clearTimeout(timeout); resolve({ ok: false, error: e.message }); });
      child.on('exit', (code, sig) => {
        clearTimeout(timeout);
        const suffix = truncated ? `\n[output truncated at ${MAX_OUTPUT_BYTES} bytes]` : '';
        const tag = `[exit ${code}${sig ? ` (${sig})` : ''}]`;
        resolve({ ok: code === 0, content: `${out}${suffix}\n${tag}`, extra: { code, signal: sig } });
      });
      if (ctx.signal) ctx.signal.addEventListener('abort', () => child.kill('SIGTERM'));
    });
  },
};

// ---------- list_processes ----------
export const listProcesses: ToolDef<Record<string, never>> = {
  name: 'list_processes',
  description: 'List background processes started by run_command in this session (not every process on the system).',
  risk: 'low',
  parameters: { type: 'object', properties: {} },
  async execute(_input, ctx) {
    const reg = getBgRegistry(ctx);
    if (!reg.size) return { ok: true, content: '(no background processes)' };
    const rows = [...reg.values()].map((e) => {
      const alive = e.child.exitCode === null && e.child.signalCode === null;
      const age = ((Date.now() - e.started) / 1000).toFixed(1);
      return `pid ${e.pid}  ${alive ? 'running' : `exited(${e.child.exitCode ?? e.child.signalCode})`}  ${age}s  ${truncate(e.cmd, 60)}`;
    });
    return { ok: true, content: rows.join('\n') };
  },
};

// ---------- read_process_output ----------
export const readProcessOutput: ToolDef<{ pid: number; tail_lines?: number }> = {
  name: 'read_process_output',
  description: 'Read captured stdout/stderr of a background process started in this session. Returns the last N lines (default 200).',
  risk: 'low',
  parameters: {
    type: 'object',
    properties: {
      pid: { type: 'integer' },
      tail_lines: { type: 'integer' },
    },
    required: ['pid'],
  },
  async execute(input, ctx) {
    const reg = getBgRegistry(ctx);
    const e = reg.get(input.pid);
    if (!e) return { ok: false, error: `pid ${input.pid} is not a session background process` };
    const tail = input.tail_lines ?? 200;
    const joined = e.output.join('');
    const lines = joined.split('\n');
    return { ok: true, content: lines.slice(-tail).join('\n') || '(no output yet)' };
  },
};

// ---------- kill_process ----------
export const killProcess: ToolDef<{ pid: number; signal?: string }> = {
  name: 'kill_process',
  description: 'Send a signal to a background process started in this session (only session-tracked pids — not arbitrary OS pids).',
  risk: 'medium',
  parameters: {
    type: 'object',
    properties: {
      pid: { type: 'integer' },
      signal: { type: 'string', description: 'POSIX signal name (SIGTERM, SIGKILL, …). Default SIGTERM. Ignored on Windows.' },
    },
    required: ['pid'],
  },
  async execute(input, ctx) {
    const reg = getBgRegistry(ctx);
    const e = reg.get(input.pid);
    if (!e) return { ok: false, error: `pid ${input.pid} is not a session background process` };
    const sig = (input.signal as NodeJS.Signals) || 'SIGTERM';
    const okd = await ctx.confirm({
      tool: 'kill_process',
      action: `${sig} pid ${input.pid}: ${truncate(e.cmd, 60)}`,
      risk: 'medium',
    });
    if (!okd) return { ok: false, error: 'user denied' };
    try {
      e.child.kill(sig);
      return { ok: true, content: `sent ${sig} to pid ${input.pid}` };
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) };
    }
  },
};

// ---------- helpers ----------
function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

// Rough guess at whether a command is destructive — purely for the risk
// label on the approval prompt. We never *block* on this — the user sees
// the full command and decides.
function isDestructive(cmd: string): boolean {
  return /\b(rm\s+-r|rm\s+-rf|mkfs|dd\s+if=|sudo\s+rm|git\s+push\s+-f|git\s+reset\s+--hard|docker\s+system\s+prune|drop\s+table|truncate\s+)/i.test(cmd);
}

export const shellTools = { runCommand, listProcesses, readProcessOutput, killProcess };

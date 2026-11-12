// Slash-command registry. Every command is a small record the host can
// dispatch through parse(input) + run(cmd, ctx).
//
// Design notes:
//   - Handlers NEVER mutate the process directly (no process.exit, no
//     process.chdir). They call context hooks the host implements, so
//     tests can stub them and the TUI can intercept.
//   - Any command that touches the filesystem or network goes through
//     ctx.tools (the @chadcode/tools registry), not Node builtins, so
//     the approval policy applies uniformly.
//   - Commands return a CommandResult the host may act on (status line
//     refresh, chained input, exit).

import type { SlashCommand, CommandRegistry, CommandContext, CommandResult } from './types.js';

function ok(note?: string, more: Partial<CommandResult> = {}): CommandResult {
  return { note, ...more };
}

// ---------------- session group ----------------
const clearCmd: SlashCommand = {
  name: 'clear', aliases: ['cls', 'wipe'], group: 'session',
  description: 'Clear this conversation and the screen. Keeps you signed in.',
  async handler(_args, ctx) {
    await ctx.resetSession();
    ctx.io.clearScreen();
    return ok('new session.');
  },
};

const newCmd: SlashCommand = {
  name: 'new', aliases: ['restart'], group: 'session',
  description: 'Start a fresh conversation (same as /clear, kept for muscle memory).',
  handler: (_a, ctx) => clearCmd.handler('', ctx),
};

const resumeCmd: SlashCommand = {
  name: 'resume', aliases: ['continue'], group: 'session',
  description: 'List recent sessions and jump back into one.',
  async handler(args, ctx) {
    const list = await ctx.listSessions();
    if (!list.length) { ctx.io.print('(no saved sessions)'); return; }
    if (args.trim()) {
      const picked = list.find((s) => s.id === args.trim() || s.title.toLowerCase().includes(args.trim().toLowerCase()));
      if (!picked) { ctx.io.error(`no session matching "${args.trim()}"`); return; }
      await ctx.loadSession(picked.id);
      return ok(`resumed: ${picked.title}`, { statusChanged: true });
    }
    for (let i = 0; i < Math.min(list.length, 15); i++) {
      const s = list[i];
      const when = new Date(s.updated).toLocaleString();
      ctx.io.print(`  ${String(i + 1).padStart(2)}. ${s.title.slice(0, 60)}   (${when})`);
    }
    const choice = await ctx.io.prompt('resume #? ');
    const idx = parseInt(choice, 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= list.length) return ok('cancelled.');
    await ctx.loadSession(list[idx].id);
    return ok(`resumed: ${list[idx].title}`, { statusChanged: true });
  },
};

const historyCmd: SlashCommand = {
  name: 'history', group: 'session',
  description: 'Print turn-by-turn history of the current conversation.',
  handler(_a, ctx) {
    ctx.io.print(`${ctx.session.turns} turns in this session.`);
    if (ctx.session.lastUser)      ctx.io.print(`  last user:      ${truncate(ctx.session.lastUser, 120)}`);
    if (ctx.session.lastAssistant) ctx.io.print(`  last assistant: ${truncate(ctx.session.lastAssistant, 120)}`);
  },
};

const compactCmd: SlashCommand = {
  name: 'compact', aliases: ['summarize'], group: 'session',
  description: 'Summarize long history into one short memo so the context fits again.',
  async handler(_a, ctx) {
    const { before, after } = await ctx.compactHistory();
    return ok(`compacted ${before}→${after} tokens.`);
  },
};

// ---------------- input group ----------------
const retryCmd: SlashCommand = {
  name: 'retry', aliases: ['again'], group: 'input',
  description: 'Resend your last message to the model (useful after a flaky stream).',
  async handler(_a, ctx) {
    if (!ctx.session.lastUser) { ctx.io.error('no previous user message.'); return; }
    await ctx.sendMessage(ctx.session.lastUser);
  },
};

const editCmd: SlashCommand = {
  name: 'edit', aliases: ['rewrite'], group: 'input',
  description: 'Rewrite your last message and resend (replaces the previous turn).',
  async handler(args, ctx) {
    const next = args.trim() || await ctx.io.prompt('rewrite> ');
    if (!next) return;
    await ctx.editLast(next);
  },
};

const copyCmd: SlashCommand = {
  name: 'copy', group: 'input',
  description: 'Copy the assistant\'s last reply to your system clipboard.',
  async handler(_a, ctx) {
    if (!ctx.session.lastAssistant) { ctx.io.error('nothing to copy yet.'); return; }
    const clip = ctx.tools?.clipboard_write;
    if (!clip) { ctx.io.error('clipboard tool unavailable.'); return; }
    const r = await clip.execute({ text: ctx.session.lastAssistant }, { ...toolCtx(ctx) });
    if (!r?.ok) ctx.io.error(r?.error || 'copy failed.');
    else return ok('copied last reply.');
  },
};

const pasteCmd: SlashCommand = {
  name: 'paste', group: 'input',
  description: 'Paste your clipboard as the next user message.',
  async handler(_a, ctx) {
    const clip = ctx.tools?.clipboard_read;
    if (!clip) { ctx.io.error('clipboard tool unavailable.'); return; }
    const r = await clip.execute({}, { ...toolCtx(ctx) });
    if (!r?.ok || !r.content) { ctx.io.error(r?.error || 'clipboard is empty'); return; }
    return ok('pasted.', { nextInput: r.content });
  },
};

const imageCmd: SlashCommand = {
  name: 'image', aliases: ['img', 'attach'], group: 'input',
  description: 'Attach an image file to the NEXT message. /image path/to/pic.png',
  async handler(args, ctx) {
    const p = args.trim();
    if (!p) { ctx.io.error('usage: /image <path>'); return; }
    ctx.session.attachments.push({ kind: 'image', name: p.split('/').pop() || p, path: p });
    return ok(`attached: ${p}`);
  },
};

const screenshotCmd: SlashCommand = {
  name: 'screenshot', aliases: ['ss', 'shot'], group: 'input',
  description: 'Take a screenshot and attach it to the next message.',
  async handler(_a, ctx) {
    const tool = ctx.tools?.screenshot;
    if (!tool) { ctx.io.error('screenshot tool unavailable.'); return; }
    const r = await tool.execute({}, { ...toolCtx(ctx) });
    if (!r?.ok) { ctx.io.error(r?.error || 'screenshot failed.'); return; }
    const p = (r.extra as { path?: string } | undefined)?.path || '';
    if (p) ctx.session.attachments.push({ kind: 'image', name: 'screenshot.png', path: p });
    return ok(`attached screenshot: ${p}`);
  },
};

// ---------------- system group ----------------
const modelCmd: SlashCommand = {
  name: 'model', group: 'system',
  description: 'Switch the active model. /model fast | /model plus-pro | /model (interactive)',
  async handler(args, ctx) {
    const options = ['fast', 'small', 'tiny', 'auto', 'plus-pro'];
    let next = args.trim();
    if (!next) {
      ctx.io.print('models: ' + options.join('  '));
      next = await ctx.io.prompt(`model [${ctx.session.model}]> `);
      if (!next) return ok('unchanged.');
    }
    if (!options.includes(next)) { ctx.io.error(`unknown model: ${next}`); return; }
    ctx.session.model = next;
    return ok(`model → ${next}`, { statusChanged: true });
  },
};

const modeCmd: SlashCommand = {
  name: 'mode', group: 'system',
  description: 'Switch between chat / agent / plan mode.',
  async handler(args, ctx) {
    const options = ['chat', 'agent', 'plan'] as const;
    let next = args.trim() as typeof options[number];
    if (!next) {
      ctx.io.print('modes: ' + options.join('  '));
      next = (await ctx.io.prompt(`mode [${ctx.session.mode}]> `)) as typeof options[number];
      if (!next) return ok('unchanged.');
    }
    if (!options.includes(next as typeof options[number])) { ctx.io.error(`unknown mode: ${next}`); return; }
    ctx.session.mode = next;
    return ok(`mode → ${next}`, { statusChanged: true });
  },
};

const planCmd: SlashCommand = {
  name: 'plan', group: 'system',
  description: 'Enter plan mode — model proposes a plan without executing any tools.',
  handler: (_a, ctx) => { ctx.session.mode = 'plan'; return ok('plan mode — no tool execution until you confirm.', { statusChanged: true }); },
};

const thinkCmd: SlashCommand = {
  name: 'think', aliases: ['extended'], group: 'system',
  description: 'Toggle extended thinking on the next turn.',
  handler(_a, ctx) {
    // Host reads session.extendedThinking; keep flag here, host wires it in.
    (ctx.session as unknown as { extendedThinking?: boolean }).extendedThinking =
      !((ctx.session as unknown as { extendedThinking?: boolean }).extendedThinking);
    const on = (ctx.session as unknown as { extendedThinking?: boolean }).extendedThinking;
    return ok(`extended thinking ${on ? 'ON' : 'off'}.`);
  },
};

const approveCmd: SlashCommand = {
  name: 'approval', aliases: ['approve', 'safety'], group: 'system',
  description: 'Set tool approval policy. /approval auto | yolo | strict',
  async handler(args, ctx) {
    const options = ['auto', 'yolo', 'strict'] as const;
    let next = args.trim() as typeof options[number];
    if (!next) {
      ctx.io.print('auto   — approve reads, prompt for writes/shell/os');
      ctx.io.print('yolo   — approve everything, silently (dangerous)');
      ctx.io.print('strict — prompt for every tool call');
      next = (await ctx.io.prompt(`approval [${ctx.session.approval}]> `)) as typeof options[number];
      if (!next) return ok('unchanged.');
    }
    if (!options.includes(next)) { ctx.io.error(`unknown mode: ${next}`); return; }
    ctx.session.approval = next;
    return ok(`approval → ${next}`, { statusChanged: true });
  },
};

const cwdCmd: SlashCommand = {
  name: 'cwd', aliases: ['cd'], group: 'system',
  description: 'Print or change the working directory. /cwd (print)  /cwd <path> (change)',
  async handler(args, ctx) {
    const p = args.trim();
    if (!p) { ctx.io.print(ctx.session.cwd); return; }
    try {
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      const abs = path.resolve(ctx.session.cwd, p);
      const stat = await fs.stat(abs);
      if (!stat.isDirectory()) { ctx.io.error('not a directory.'); return; }
      ctx.session.cwd = abs;
      return ok(`cwd → ${abs}`, { statusChanged: true });
    } catch (e) {
      ctx.io.error((e as Error)?.message || 'chdir failed.');
    }
  },
};

const toolsCmd: SlashCommand = {
  name: 'tools', group: 'system',
  description: 'List tools the model can call this session.',
  handler(_a, ctx) {
    const names = ctx.tools ? Object.keys(ctx.tools) : [];
    if (!names.length) { ctx.io.print('(no tools registered)'); return; }
    for (const n of names.sort()) ctx.io.print(`  ${n}`);
    ctx.io.print(`(${names.length} tools)`);
  },
};

const costCmd: SlashCommand = {
  name: 'cost', aliases: ['usage'], group: 'system',
  description: 'Show tokens used + plan quota for this session.',
  async handler(_a, ctx) {
    // Host populates session.usage; fall back gracefully.
    const u = (ctx.session as unknown as { usage?: { in: number; out: number; cap?: number } }).usage;
    if (!u) { ctx.io.print('(no usage yet)'); return; }
    ctx.io.print(`tokens — in ${u.in}  out ${u.out}  total ${u.in + u.out}${u.cap ? ` / ${u.cap}` : ''}`);
  },
};

const shareCmd: SlashCommand = {
  name: 'share', group: 'system',
  description: 'Export the current session to a shareable URL (opens in your browser).',
  async handler(_a, ctx) {
    if (!ctx.session.id) { ctx.io.error('no session id — save or send a turn first.'); return; }
    const url = `https://chadgpt-964.pages.dev/s/${encodeURIComponent(ctx.session.id)}`;
    ctx.io.success(`share: ${url}`);
    const open = ctx.tools?.open_url;
    if (open) await open.execute({ url }, { ...toolCtx(ctx) }).catch(() => {});
    return ok(`copied to clipboard if available.`);
  },
};

const saveCmd: SlashCommand = {
  name: 'save', aliases: ['export'], group: 'system',
  description: 'Save this conversation to a JSON file. /save path.json',
  async handler(args, ctx) {
    const target = args.trim() || `chadcode-session-${Date.now()}.json`;
    const write = ctx.tools?.write_file;
    if (!write) { ctx.io.error('write_file tool unavailable.'); return; }
    const payload = JSON.stringify({
      saved_at: Date.now(),
      model: ctx.session.model,
      mode: ctx.session.mode,
      turns: ctx.session.turns,
      last_user: ctx.session.lastUser,
      last_assistant: ctx.session.lastAssistant,
    }, null, 2);
    const r = await write.execute({ target_file: target, content: payload }, { ...toolCtx(ctx) });
    if (!r?.ok) ctx.io.error(r?.error || 'save failed.');
    else return ok(`saved → ${target}`);
  },
};

const helpCmd: SlashCommand = {
  name: 'help', aliases: ['?', 'h'], group: 'system',
  description: 'Show this list.',
  handler(args, ctx) {
    const filter = args.trim().toLowerCase();
    const groups = ['session', 'input', 'tools', 'web', 'voice', 'system'] as const;
    for (const g of groups) {
      // Iterate the canonical list, not the registry — registry has one
      // entry per alias and would print the same command multiple times.
      const inGroup = commands.filter((c) => c.group === g);
      if (!inGroup.length) continue;
      if (filter && !inGroup.some((c) => c.name.includes(filter) || c.description.toLowerCase().includes(filter))) continue;
      ctx.io.print('');
      ctx.io.print(g.toUpperCase());
      for (const c of inGroup) {
        if (filter && !c.name.includes(filter) && !c.description.toLowerCase().includes(filter)) continue;
        const aliases = c.aliases?.length ? ` (${c.aliases.map((a) => '/' + a).join(', ')})` : '';
        ctx.io.print(`  /${c.name}${aliases}  —  ${c.description}`);
      }
    }
  },
};

const exitCmd: SlashCommand = {
  name: 'exit', aliases: ['quit', 'q'], group: 'system',
  description: 'Exit ChadCode.',
  handler(_a, ctx) { ctx.exit(0); return { halt: true }; },
};

// ---------------- voice group ----------------
const voiceCmd: SlashCommand = {
  name: 'voice', group: 'voice',
  description: 'Toggle voice input (speech → text) and voice output (text → speech).',
  async handler(args, ctx) {
    const sub = args.trim().toLowerCase();
    if (sub === 'in' || sub === 'input')   ctx.session.voice.input  = !ctx.session.voice.input;
    else if (sub === 'out' || sub === 'output') ctx.session.voice.output = !ctx.session.voice.output;
    else { ctx.session.voice.input = !ctx.session.voice.input; ctx.session.voice.output = ctx.session.voice.input; }
    return ok(`voice  in:${ctx.session.voice.input ? 'ON' : 'off'}  out:${ctx.session.voice.output ? 'ON' : 'off'}`, { statusChanged: true });
  },
};

const speakCmd: SlashCommand = {
  name: 'speak', aliases: ['say'], group: 'voice',
  description: 'Speak the assistant\'s last reply through your speakers (OS TTS).',
  async handler(_a, ctx) {
    if (!ctx.session.lastAssistant) { ctx.io.error('nothing to speak yet.'); return; }
    const text = ctx.session.lastAssistant.replace(/[`*_>#]/g, '').slice(0, 2000);
    const run = ctx.tools?.run_command;
    if (!run) { ctx.io.error('run_command unavailable.'); return; }
    const cmd = process.platform === 'darwin'
      ? `say ${JSON.stringify(text)}`
      : process.platform === 'win32'
        ? `powershell -NoProfile -Command "Add-Type -AssemblyName System.Speech;(New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak(${JSON.stringify(text)})"`
        : `command -v espeak >/dev/null && espeak ${JSON.stringify(text)} || command -v spd-say >/dev/null && spd-say ${JSON.stringify(text)} || echo 'install espeak or speech-dispatcher'`;
    await run.execute({ command: cmd }, { ...toolCtx(ctx) });
  },
};

// ---------------- web group ----------------
const webCmd: SlashCommand = {
  name: 'web', aliases: ['search'], group: 'web',
  description: 'Search the web. /web <query>',
  async handler(args, ctx) {
    const q = args.trim();
    if (!q) { ctx.io.error('usage: /web <query>'); return; }
    const tool = ctx.tools?.web_search;
    if (!tool) { ctx.io.error('web_search tool unavailable.'); return; }
    const r = await tool.execute({ search_term: q, num: 8 }, { ...toolCtx(ctx) });
    if (!r?.ok) { ctx.io.error(r?.error || 'search failed.'); return; }
    ctx.io.print(r.content || '(no results)');
  },
};

const openCmd: SlashCommand = {
  name: 'open', group: 'web',
  description: 'Open a URL or file in your default app. /open https://… or /open ./file.md',
  async handler(args, ctx) {
    const target = args.trim();
    if (!target) { ctx.io.error('usage: /open <url-or-path>'); return; }
    const isUrl = /^https?:\/\//.test(target);
    const tool = isUrl ? ctx.tools?.open_url : ctx.tools?.open_file;
    if (!tool) { ctx.io.error('open tool unavailable.'); return; }
    const r = await tool.execute(isUrl ? { url: target } : { path: target }, { ...toolCtx(ctx) });
    if (!r?.ok) ctx.io.error(r?.error || 'open failed.');
  },
};

const fetchCmd: SlashCommand = {
  name: 'fetch', aliases: ['curl'], group: 'web',
  description: 'Fetch a URL and show the body. /fetch <url>',
  async handler(args, ctx) {
    const u = args.trim();
    if (!u) { ctx.io.error('usage: /fetch <url>'); return; }
    const tool = ctx.tools?.web_fetch;
    if (!tool) { ctx.io.error('web_fetch unavailable.'); return; }
    const r = await tool.execute({ url: u, as: 'markdown' }, { ...toolCtx(ctx) });
    if (!r?.ok) { ctx.io.error(r?.error || 'fetch failed.'); return; }
    ctx.io.print(r.content || '');
  },
};

// ---------------- tools group (invoke a single tool manually) ----------------
const initCmd: SlashCommand = {
  name: 'init', group: 'tools',
  description: 'Create CHADCODE.md in the current directory with project notes.',
  async handler(_a, ctx) {
    const write = ctx.tools?.write_file;
    if (!write) { ctx.io.error('write_file unavailable.'); return; }
    const existing = ctx.tools?.read_file;
    const existingText = existing
      ? await existing.execute({ target_file: 'CHADCODE.md', should_read_entire_file: true }, { ...toolCtx(ctx) }).catch(() => null)
      : null;
    if (existingText?.ok) { ctx.io.error('CHADCODE.md already exists — move or delete it first.'); return; }
    const template = `# ChadCode project notes

Tell the assistant how this codebase works so it stops re-discovering it.

## Build & run

(describe how to install deps + run tests)

## Conventions

(short style rules; what imports to prefer; what to avoid)

## Layout

(top-level dirs and what lives where)
`;
    const r = await write.execute({ target_file: 'CHADCODE.md', content: template }, { ...toolCtx(ctx) });
    if (!r?.ok) ctx.io.error(r?.error || 'init failed.');
    else return ok('wrote CHADCODE.md — edit it so the model has context.');
  },
};

const diffCmd: SlashCommand = {
  name: 'diff', group: 'tools',
  description: 'Show uncommitted git diff in the current workspace.',
  async handler(args, ctx) {
    const run = ctx.tools?.run_command;
    if (!run) { ctx.io.error('run_command unavailable.'); return; }
    const scope = args.trim() || '';
    const r = await run.execute({ command: `git diff --color ${scope}`.trim() }, { ...toolCtx(ctx) });
    ctx.io.print(r?.content || '');
  },
};

const statusCmd: SlashCommand = {
  name: 'status', aliases: ['st'], group: 'tools',
  description: 'git status + session summary.',
  async handler(_a, ctx) {
    ctx.io.print(`turns ${ctx.session.turns}  ·  model ${ctx.session.model}  ·  mode ${ctx.session.mode}  ·  approval ${ctx.session.approval}`);
    const run = ctx.tools?.run_command;
    if (!run) return;
    const r = await run.execute({ command: 'git status --short --branch' }, { ...toolCtx(ctx) });
    if (r?.ok) ctx.io.print(r.content || '');
  },
};

const undoCmd: SlashCommand = {
  name: 'undo', group: 'tools',
  description: 'Revert the most recent write / edit / delete by the assistant (if git-tracked).',
  async handler(_a, ctx) {
    const run = ctx.tools?.run_command;
    if (!run) { ctx.io.error('run_command unavailable.'); return; }
    const confirmed = await ctx.io.confirm('this restores HEAD and nukes any staged changes — proceed? ');
    if (!confirmed) return ok('cancelled.');
    const r = await run.execute({ command: 'git restore --staged . && git restore .' }, { ...toolCtx(ctx) });
    if (!r?.ok) ctx.io.error(r?.error || 'undo failed.');
    else return ok('working tree restored to HEAD.');
  },
};

// ---------------- auth ----------------
const loginCmd: SlashCommand = {
  name: 'login', group: 'system',
  description: 'Re-pair this terminal with your account (device-code flow).',
  async handler(_a, ctx) {
    ctx.io.print('Open: https://chadgpt-964.pages.dev/cli-auth');
    ctx.io.print('(follow the in-binary device-code prompt — this is a reminder for a fresh pairing)');
  },
};

const logoutCmd: SlashCommand = {
  name: 'logout', group: 'system',
  description: 'Clear the stored license from this machine.',
  async handler(_a, ctx) {
    const sure = await ctx.io.confirm('delete the stored license? you\'ll need to re-pair. ');
    if (!sure) return ok('cancelled.');
    // Host owns persistence; expose a hook the CLI binds.
    const hook = (ctx as unknown as { clearLicense?: () => Promise<void> }).clearLicense;
    if (hook) await hook();
    return ok('logged out. run chadcode to pair again.');
  },
};

// ---------------- helpers ----------------
function truncate(s: string, n: number): string { return s.length <= n ? s : s.slice(0, n - 1) + '…'; }

// Build a minimal ToolContext from our CommandContext for tool invocations.
// The host passes the tools in, but tools expect their own context shape;
// bridge the two here so command handlers don't repeat themselves.
function toolCtx(ctx: CommandContext): {
  cwd: string;
  confirm: (req: unknown) => Promise<boolean>;
  log: (line: string) => void;
  mode: 'auto' | 'yolo';
  session: Record<string, unknown>;
} {
  return {
    cwd: ctx.session.cwd,
    confirm: async (req: unknown) => {
      // If the ambient approval is yolo, pass through silently.
      if (ctx.session.approval === 'yolo') return true;
      const r = req as { tool: string; action: string; risk: string };
      return ctx.io.confirm(`[${r.risk}] ${r.tool}: ${r.action} — ok? `);
    },
    log: ctx.io.print,
    mode: ctx.session.approval === 'yolo' ? 'yolo' : 'auto',
    session: {},
  };
}

// ---------------- registry ----------------
const all: SlashCommand[] = [
  // session
  clearCmd, newCmd, resumeCmd, historyCmd, compactCmd,
  // input
  retryCmd, editCmd, copyCmd, pasteCmd, imageCmd, screenshotCmd,
  // system
  modelCmd, modeCmd, planCmd, thinkCmd, approveCmd, cwdCmd, toolsCmd, costCmd, shareCmd, saveCmd,
  helpCmd, loginCmd, logoutCmd, exitCmd,
  // voice
  voiceCmd, speakCmd,
  // web
  webCmd, openCmd, fetchCmd,
  // tools
  initCmd, diffCmd, statusCmd, undoCmd,
];

export const registry: CommandRegistry = Object.freeze(Object.fromEntries(
  all.flatMap((c) => [[c.name, c], ...(c.aliases || []).map((a) => [a, c] as const)]),
)) as CommandRegistry;

export const commands = Object.freeze(all);

// Parse an input line into { name, args }, or null if it isn't a slash
// command. Accepts leading whitespace, splits on first whitespace.
export function parse(input: string): { name: string; args: string } | null {
  if (!input) return null;
  const m = input.trim().match(/^\/([A-Za-z_?][A-Za-z0-9_-]*)(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  return { name: m[1].toLowerCase(), args: (m[2] || '').trim() };
}

export async function run(input: string, ctx: CommandContext): Promise<CommandResult | 'not_a_command' | 'unknown'> {
  const p = parse(input);
  if (!p) return 'not_a_command';
  const cmd = registry[p.name];
  if (!cmd) return 'unknown';
  const result = await cmd.handler(p.args, ctx);
  return result || {};
}

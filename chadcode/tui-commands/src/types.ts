// Shared types for the ChadCode TUI slash-command pack.
//
// The TUI parses a line that starts with "/" into { name, args } and looks
// name up in the registry. If found, it calls the handler with the raw arg
// string and a CommandContext the host has built — session, model, mode,
// IO helpers. The handler returns a CommandResult the host renders.
//
// The registry is intentionally dumb: every command is a value, so a TUI
// can filter them, reorder them, add its own, or disable some.

export type ApprovalMode = 'auto' | 'yolo' | 'strict';

export interface Session {
  // Zero-indexed turn count the host updates as the conversation advances.
  turns: number;
  // Current working directory of the CLI (mutable via /cwd).
  cwd: string;
  // Active model id (short tag, e.g. "fast", "small", "plus-pro").
  model: string;
  // Agent mode: 'chat' vs. 'agent' vs. 'plan'.
  mode: 'chat' | 'agent' | 'plan';
  // Approval mode for tool calls (threaded through the tools pack).
  approval: ApprovalMode;
  // Last user message (for /retry, /edit).
  lastUser?: string;
  // Last assistant message (for /copy).
  lastAssistant?: string;
  // Voice toggles.
  voice: { input: boolean; output: boolean };
  // Pending attachments the next turn will send (images, screenshots, pasted text).
  attachments: Array<{ kind: 'image' | 'text' | 'file'; name: string; path?: string }>;
  // Session id — host-assigned, used by /resume and /share.
  id?: string;
}

export interface CommandIO {
  // Print a line to the user. The host decides color / line wrapping.
  print: (line: string) => void;
  // Ask the user a line. Resolves to the string they typed (empty on cancel).
  prompt: (question: string) => Promise<string>;
  // Yes / no confirmation.
  confirm: (question: string) => Promise<boolean>;
  // Signal error (host renders red / with an icon).
  error: (line: string) => void;
  // Signal success.
  success: (line: string) => void;
  // Clear the terminal (not just chat history — pure screen clear).
  clearScreen: () => void;
}

// Things the host hands the command — the command never touches global state.
export interface CommandContext {
  session: Session;
  io: CommandIO;
  // Hooks the host implements. The command issues a *request*, the host
  // decides whether to honor it. Keeps the registry pure.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools?: Record<string, any>;              // chadcode tools registry
  resetSession: () => Promise<void>;        // /clear, /new
  loadSession:  (id: string) => Promise<void>;  // /resume
  listSessions: () => Promise<Array<{ id: string; title: string; updated: number }>>;
  sendMessage:  (text: string) => Promise<void>;     // for /retry
  editLast:     (text: string) => Promise<void>;     // for /edit
  compactHistory: () => Promise<{ before: number; after: number }>;
  exit: (code?: number) => void;
}

export interface CommandResult {
  // A command can:
  //   - ask the host to re-render the status line (model/mode/mode changed)
  //   - set a new message to send after this (chaining)
  //   - signal that no further input should be read this turn (e.g. /exit)
  statusChanged?: boolean;
  nextInput?: string;
  halt?: boolean;
  // Optional one-liner the host may echo (e.g. "model switched to plus-pro").
  note?: string;
}

export interface SlashCommand {
  name: string;                       // "clear"
  aliases?: string[];                 // ["cls", "wipe"]
  description: string;                // for /help listing
  group: 'session' | 'input' | 'tools' | 'system' | 'web' | 'voice';
  // When true, suggest this command even when no args were typed yet.
  autocomplete?: boolean;
  handler: (args: string, ctx: CommandContext) => Promise<CommandResult | void> | CommandResult | void;
}

export type CommandRegistry = Record<string, SlashCommand>;

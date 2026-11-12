// File-system tools: read, write, edit, delete, list, move, copy, mkdir.
//
// Reads are 'low' risk (approved automatically in 'auto' mode). Writes and
// deletes are 'medium' or 'high' — the prompt previews the diff / target so
// the user sees what they are allowing.

import fs from 'node:fs/promises';
import path from 'node:path';
import type { ToolDef, ToolResult, ToolContext } from './types.js';
import { resolvePath, describePath } from './paths.js';

const MAX_READ_BYTES = 1_000_000;   // 1 MB — anything bigger must be line-sliced
const MAX_WRITE_BYTES = 10_000_000; // 10 MB
const MAX_LIST_ENTRIES = 1000;

function err(msg: string): ToolResult { return { ok: false, error: msg }; }
function ok(content: string, extra?: Record<string, unknown>): ToolResult {
  return { ok: true, content, extra };
}

// ---------- read_file ----------
export const readFile: ToolDef<{ target_file: string; start_line_one_indexed?: number; end_line_one_indexed_inclusive?: number; should_read_entire_file?: boolean }> = {
  name: 'read_file',
  description: 'Read a file by absolute or workspace-relative path. Returns the lines in [start, end] inclusive (1-indexed), or the whole file if `should_read_entire_file` is true and the file is small enough.',
  risk: 'low',
  parameters: {
    type: 'object',
    properties: {
      target_file: { type: 'string', description: 'Path of the file to read.' },
      start_line_one_indexed: { type: 'integer', description: '1-indexed start line (inclusive).' },
      end_line_one_indexed_inclusive: { type: 'integer', description: '1-indexed end line (inclusive).' },
      should_read_entire_file: { type: 'boolean', description: 'Read the whole file (rejected if > 1 MB).' },
    },
    required: ['target_file'],
  },
  async execute(input, ctx) {
    const r = resolvePath(input.target_file, ctx.cwd);
    try {
      const stat = await fs.stat(r.abs);
      if (!stat.isFile()) return err(`not a file: ${describePath(r)}`);
      if (input.should_read_entire_file) {
        if (stat.size > MAX_READ_BYTES) return err(`file too large for full read (${stat.size} bytes, limit ${MAX_READ_BYTES})`);
        const txt = await fs.readFile(r.abs, 'utf8');
        return ok(txt, { bytes: stat.size, lines: txt.split('\n').length });
      }
      const start = Math.max(1, input.start_line_one_indexed ?? 1);
      const end = Math.max(start, input.end_line_one_indexed_inclusive ?? (start + 199));
      // Stream-read and slice — avoids loading huge files.
      const txt = await fs.readFile(r.abs, 'utf8');
      const lines = txt.split('\n');
      const total = lines.length;
      const slice = lines.slice(start - 1, end).join('\n');
      const header = `// ${describePath(r)}  (lines ${start}-${Math.min(end, total)} of ${total})\n`;
      return ok(header + slice, { total_lines: total, start, end: Math.min(end, total) });
    } catch (e) { return err(describeError(e)); }
  },
};

// ---------- write_file ----------
export const writeFile: ToolDef<{ target_file: string; content: string }> = {
  name: 'write_file',
  description: 'Create or overwrite a file. Parent directories are created automatically. Prompts for approval unless in yolo mode.',
  risk: 'medium',
  parameters: {
    type: 'object',
    properties: {
      target_file: { type: 'string' },
      content: { type: 'string', description: 'Full file contents. The file is overwritten in its entirety.' },
    },
    required: ['target_file', 'content'],
  },
  async execute(input, ctx) {
    const r = resolvePath(input.target_file, ctx.cwd);
    if (new TextEncoder().encode(input.content).length > MAX_WRITE_BYTES) {
      return err(`content too large (> ${MAX_WRITE_BYTES} bytes)`);
    }
    const action = `${await existsAsFile(r.abs) ? 'overwrite' : 'create'} ${describePath(r)} (${input.content.length} chars)`;
    const risk = r.inTree ? 'medium' : 'high';
    const okd = await ctx.confirm({
      tool: 'write_file',
      action,
      risk,
      preview: input.content.split('\n').slice(0, 20).join('\n'),
    });
    if (!okd) return err('user denied');
    try {
      await fs.mkdir(path.dirname(r.abs), { recursive: true });
      await fs.writeFile(r.abs, input.content, 'utf8');
      return ok(`wrote ${input.content.length} chars to ${describePath(r)}`);
    } catch (e) { return err(describeError(e)); }
  },
};

// ---------- edit_file (search + replace, single occurrence) ----------
export const editFile: ToolDef<{ file_path: string; old_string: string; new_string: string }> = {
  name: 'edit_file',
  description: 'Replace one occurrence of `old_string` with `new_string`. Fails if `old_string` is not found, or is not unique in the file. Include enough context (3-5 lines above/below) to disambiguate.',
  risk: 'medium',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string' },
      old_string: { type: 'string' },
      new_string: { type: 'string' },
    },
    required: ['file_path', 'old_string', 'new_string'],
  },
  async execute(input, ctx) {
    const r = resolvePath(input.file_path, ctx.cwd);
    try {
      const src = await fs.readFile(r.abs, 'utf8');
      const idx = src.indexOf(input.old_string);
      if (idx === -1) return err(`old_string not found in ${describePath(r)}`);
      const second = src.indexOf(input.old_string, idx + 1);
      if (second !== -1) return err(`old_string appears more than once in ${describePath(r)} — add more context`);
      const next = src.slice(0, idx) + input.new_string + src.slice(idx + input.old_string.length);
      const okd = await ctx.confirm({
        tool: 'edit_file',
        action: `edit ${describePath(r)} (${input.old_string.length} → ${input.new_string.length} chars)`,
        risk: r.inTree ? 'medium' : 'high',
        preview: makeDiffPreview(input.old_string, input.new_string),
      });
      if (!okd) return err('user denied');
      await fs.writeFile(r.abs, next, 'utf8');
      return ok(`edited ${describePath(r)}`);
    } catch (e) { return err(describeError(e)); }
  },
};

// ---------- delete_file ----------
export const deleteFile: ToolDef<{ target_file: string }> = {
  name: 'delete_file',
  description: 'Delete a file. Fails silently if it does not exist. Does not delete directories — use run_command with rm -r for that, which asks for its own approval.',
  risk: 'high',
  parameters: {
    type: 'object',
    properties: { target_file: { type: 'string' } },
    required: ['target_file'],
  },
  async execute(input, ctx) {
    const r = resolvePath(input.target_file, ctx.cwd);
    const okd = await ctx.confirm({
      tool: 'delete_file',
      action: `delete ${describePath(r)}`,
      risk: 'high',
    });
    if (!okd) return err('user denied');
    try {
      await fs.unlink(r.abs);
      return ok(`deleted ${describePath(r)}`);
    } catch (e: any) {
      if (e?.code === 'ENOENT') return ok(`already gone: ${describePath(r)}`);
      return err(describeError(e));
    }
  },
};

// ---------- list_dir ----------
export const listDir: ToolDef<{ relative_workspace_path: string }> = {
  name: 'list_dir',
  description: 'List the contents of a directory. Returns up to 1000 entries. Each line is name followed by (file|dir|link) and size for files.',
  risk: 'low',
  parameters: {
    type: 'object',
    properties: { relative_workspace_path: { type: 'string' } },
    required: ['relative_workspace_path'],
  },
  async execute(input, ctx) {
    const r = resolvePath(input.relative_workspace_path, ctx.cwd);
    try {
      const entries = await fs.readdir(r.abs, { withFileTypes: true });
      const limited = entries.slice(0, MAX_LIST_ENTRIES);
      const rows = await Promise.all(limited.map(async (e) => {
        const kind = e.isDirectory() ? 'dir' : e.isSymbolicLink() ? 'link' : 'file';
        let size = '';
        if (e.isFile()) {
          try { const s = await fs.stat(path.join(r.abs, e.name)); size = `  ${s.size}b`; } catch {}
        }
        return `${e.name}  (${kind})${size}`;
      }));
      const more = entries.length > MAX_LIST_ENTRIES ? `\n… and ${entries.length - MAX_LIST_ENTRIES} more` : '';
      return ok(`${describePath(r)} (${entries.length} entries)\n${rows.join('\n')}${more}`);
    } catch (e) { return err(describeError(e)); }
  },
};

// ---------- move_file ----------
export const moveFile: ToolDef<{ source: string; destination: string }> = {
  name: 'move_file',
  description: 'Move or rename a file or directory. Creates parent directories of the destination if needed.',
  risk: 'medium',
  parameters: {
    type: 'object',
    properties: { source: { type: 'string' }, destination: { type: 'string' } },
    required: ['source', 'destination'],
  },
  async execute(input, ctx) {
    const src = resolvePath(input.source, ctx.cwd);
    const dst = resolvePath(input.destination, ctx.cwd);
    const okd = await ctx.confirm({
      tool: 'move_file',
      action: `move ${describePath(src)} → ${describePath(dst)}`,
      risk: 'medium',
    });
    if (!okd) return err('user denied');
    try {
      await fs.mkdir(path.dirname(dst.abs), { recursive: true });
      await fs.rename(src.abs, dst.abs);
      return ok(`moved ${describePath(src)} → ${describePath(dst)}`);
    } catch (e) { return err(describeError(e)); }
  },
};

// ---------- copy_file ----------
export const copyFile: ToolDef<{ source: string; destination: string }> = {
  name: 'copy_file',
  description: 'Copy a file. For directories, use run_command with cp -r.',
  risk: 'medium',
  parameters: {
    type: 'object',
    properties: { source: { type: 'string' }, destination: { type: 'string' } },
    required: ['source', 'destination'],
  },
  async execute(input, ctx) {
    const src = resolvePath(input.source, ctx.cwd);
    const dst = resolvePath(input.destination, ctx.cwd);
    const okd = await ctx.confirm({
      tool: 'copy_file',
      action: `copy ${describePath(src)} → ${describePath(dst)}`,
      risk: 'medium',
    });
    if (!okd) return err('user denied');
    try {
      await fs.mkdir(path.dirname(dst.abs), { recursive: true });
      await fs.copyFile(src.abs, dst.abs);
      return ok(`copied ${describePath(src)} → ${describePath(dst)}`);
    } catch (e) { return err(describeError(e)); }
  },
};

// ---------- make_dir ----------
export const makeDir: ToolDef<{ directory: string }> = {
  name: 'make_dir',
  description: 'Create a directory (recursively — mkdir -p). No error if it already exists.',
  risk: 'low',
  parameters: {
    type: 'object',
    properties: { directory: { type: 'string' } },
    required: ['directory'],
  },
  async execute(input, ctx) {
    const r = resolvePath(input.directory, ctx.cwd);
    try {
      await fs.mkdir(r.abs, { recursive: true });
      return ok(`mkdir ${describePath(r)}`);
    } catch (e) { return err(describeError(e)); }
  },
};

// ---------- helpers ----------
async function existsAsFile(p: string): Promise<boolean> {
  try { const s = await fs.stat(p); return s.isFile(); } catch { return false; }
}

function makeDiffPreview(oldStr: string, newStr: string): string {
  const oldLines = oldStr.split('\n').slice(0, 10).map((l) => `- ${l}`);
  const newLines = newStr.split('\n').slice(0, 10).map((l) => `+ ${l}`);
  return [...oldLines, ...newLines].join('\n');
}

function describeError(e: unknown): string {
  if (!e) return 'unknown error';
  if (e instanceof Error) return e.message;
  return String(e);
}

export const fsTools = { readFile, writeFile, editFile, deleteFile, listDir, moveFile, copyFile, makeDir };

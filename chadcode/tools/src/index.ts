// Public surface of @chadcode/tools.
//
// Usage from the forked CLI entrypoint:
//
//   import { createRegistry, makeDefaultConfirm } from '@chadcode/tools';
//
//   const session: Record<string, unknown> = {};
//   const registry = createRegistry();
//   const confirm = makeDefaultConfirm({ mode: 'auto' });
//   const ctx: ToolContext = { cwd: process.cwd(), confirm, log: console.error, mode: 'auto', session };
//
//   // model asks for a tool:
//   const def = registry['read_file'];
//   const result = await def.execute({ target_file: 'package.json', should_read_entire_file: true }, ctx);
//
// Every tool is a ToolDef — see ./types.ts. The registry is just a plain
// object so the host can filter, extend, or wrap tools without the pack
// needing to know about the host runtime.

import { fsTools } from './fs.js';
import { searchTools } from './search.js';
import { shellTools } from './shell.js';
import { webTools } from './web.js';
import { osTools } from './os.js';
import type { AnyToolDef, ToolRegistry } from './types.js';

export * from './types.js';
export { makeDefaultConfirm } from './approval.js';
export { resolvePath, describePath } from './paths.js';

export const allTools: AnyToolDef[] = [
  ...Object.values(fsTools),
  ...Object.values(searchTools),
  ...Object.values(shellTools),
  ...Object.values(webTools),
  ...Object.values(osTools),
];

export function createRegistry(include?: string[]): ToolRegistry {
  const out: ToolRegistry = {};
  for (const t of allTools) {
    if (include && !include.includes(t.name)) continue;
    out[t.name] = t;
  }
  return out;
}

// JSON-Schema definitions for the whole pack — hand this to the model as
// the tool catalogue when you set up the conversation. It matches the
// agent-tools.json spec surface and adds the OS/web/shell additions.
export function toolsSchema(): Array<{ name: string; description: string; parameters: unknown }> {
  return allTools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
}

// Shared types for the ChadCode tool pack.
//
// Every tool is a self-describing record: a JSON-schema parameter block the
// model sees, plus an execute() the host calls. ApprovalMode decides whether
// a tool runs straight away or has to prompt first — reads are safe, writes
// and anything that touches the OS or the network are not.

export type JsonSchema = Record<string, unknown>;

export type ApprovalMode = 'auto' | 'approve' | 'yolo';

export interface ToolContext {
  // Absolute working directory this run operates in. Every relative path a
  // tool sees is resolved against this, and anything outside the tree is
  // treated as suspect — approval policy may still let it through, but it
  // will be flagged in the prompt.
  cwd: string;

  // Shared approval policy for the whole session. Tools don't ask the user
  // directly; they call ctx.confirm(…) and let the host render the prompt.
  confirm: (req: ApprovalRequest) => Promise<boolean>;

  // Where human-readable progress goes. Tools call ctx.log('something
  // short') and the host decides whether to show it.
  log: (line: string) => void;

  // Optional signal for aborting long-running work (streams, HTTP, child
  // processes). Tools should respect it if they take more than a few
  // hundred ms.
  signal?: AbortSignal;

  // The user's current approval mode. Tools can read this to short-circuit
  // the confirm() prompt in 'yolo' mode.
  mode: ApprovalMode;

  // Opaque per-session store for tools that need to track state between
  // calls (e.g. background processes keep a pid registry).
  session: Record<string, unknown>;
}

export interface ApprovalRequest {
  tool: string;                 // tool name e.g. 'write_file'
  action: string;               // short human sentence e.g. 'write 324 bytes to app.js'
  risk: 'low' | 'medium' | 'high';
  preview?: string;             // optional multi-line preview (diff, command, URL body)
}

export interface ToolResult {
  ok: boolean;
  content?: string;             // text payload the model should see next
  error?: string;               // on failure — one-line reason
  // Structured data the host may render separately from content (e.g.
  // screenshot path, process pid). Model sees content; host sees extra.
  extra?: Record<string, unknown>;
}

export interface ToolDef<I = unknown> {
  name: string;
  description: string;
  parameters: JsonSchema;       // JSON-Schema the model uses to build the call
  risk: 'low' | 'medium' | 'high';
  // Pre-flight: inspect the args and decide whether to ask. Called before
  // execute(). Return false to decline (tool will not run).
  needsApproval?: (input: I, ctx: ToolContext) => boolean;
  execute: (input: I, ctx: ToolContext) => Promise<ToolResult>;
}

// The registry holds tools with different input shapes; each caller
// narrows to its own I via the tool's own .execute signature.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolDef = ToolDef<any>;
export type ToolRegistry = Record<string, AnyToolDef>;

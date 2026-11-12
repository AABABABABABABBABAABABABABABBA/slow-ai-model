// Default approval UI for a terminal. The host (CLI entrypoint) can swap
// this out — pass your own `confirm` into ctx. This default renders a tight
// y/N prompt with the action and risk, and in 'yolo' mode auto-approves.

import readline from 'node:readline';
import type { ApprovalRequest, ApprovalMode } from './types.js';

export interface MakeConfirmOpts {
  mode: ApprovalMode;
  // Called whenever a prompt is shown or auto-decided, so a UI layer can
  // echo it into the status log. Optional — stderr is the fallback.
  onDecision?: (req: ApprovalRequest, approved: boolean, reason: 'auto' | 'yolo' | 'user') => void;
}

const COLOR = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  bold: '\x1b[1m',
};

function riskColor(r: ApprovalRequest['risk']): string {
  return r === 'high' ? COLOR.red : r === 'medium' ? COLOR.yellow : COLOR.green;
}

export function makeDefaultConfirm(opts: MakeConfirmOpts): (req: ApprovalRequest) => Promise<boolean> {
  const { mode, onDecision } = opts;
  return async (req) => {
    // 'yolo' — approve everything silently. The user asked for this; respect it.
    if (mode === 'yolo') {
      onDecision?.(req, true, 'yolo');
      return true;
    }
    // 'auto' — approve low-risk, prompt for medium/high.
    if (mode === 'auto' && req.risk === 'low') {
      onDecision?.(req, true, 'auto');
      return true;
    }

    // Render prompt.
    const tag = `${riskColor(req.risk)}${req.risk.toUpperCase()}${COLOR.reset}`;
    process.stderr.write(`\n${COLOR.bold}${req.tool}${COLOR.reset} [${tag}]  ${req.action}\n`);
    if (req.preview) {
      const lines = req.preview.split('\n').slice(0, 24);
      for (const l of lines) process.stderr.write(`  ${COLOR.dim}${l}${COLOR.reset}\n`);
      if (req.preview.split('\n').length > 24) process.stderr.write(`  ${COLOR.dim}…${COLOR.reset}\n`);
    }
    const answer = await ask('allow? [y/N] ');
    const yes = /^y(es)?$/i.test(answer.trim());
    onDecision?.(req, yes, 'user');
    return yes;
  };
}

function ask(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(prompt, (a) => { rl.close(); resolve(a); });
  });
}

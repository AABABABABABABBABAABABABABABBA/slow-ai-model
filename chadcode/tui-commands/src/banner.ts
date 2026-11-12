// ASCII banner for the TUI. Matches the spirit of OpenCode's startup
// (clean figlet-small lettering, short status line underneath) but with
// ChadCode's brand palette — purple-magenta gradient on gradient-capable
// terminals, flat white where ANSI is disabled.
//
// The host prints banner() exactly once, at launch, after the license
// check but before the first prompt. For color, we respect:
//   NO_COLOR          — any value disables color (per no-color.org)
//   FORCE_COLOR       — "0" disables; "1"/"2"/"3" force on
//   process.stdout.isTTY — off by default when piped
//
// Width: 56 columns for the main art, fits in an 80-col terminal with
// room for a side info panel. Falls back to a one-line tag on narrow
// terminals.

export interface BannerInfo {
  version?: string;        // "0.3.1"
  model?: string;          // "fast", "plus-pro", …
  mode?: string;           // "agent", "chat", "plan"
  email?: string;          // signed-in user email
  cwd?: string;            // short cwd, host-truncated
}

const LETTERS = [
  // CHADCODE — thick block style using half-blocks so it reads bold in any
  // terminal font. 3 rows, 8 letter cells, uniform width.
  '  █▀▀ █ █ █▀█ █▀▄ █▀▀ █▀█ █▀▄ █▀▀',
  '  █   █▀█ █▀█ █ █ █   █ █ █ █ █▀▀',
  '  ▀▀▀ ▀ ▀ ▀ ▀ ▀▀  ▀▀▀ ▀▀▀ ▀▀  ▀▀▀',
];

// Six-step purple→magenta gradient for ANSI 24-bit terminals.
const GRADIENT: Array<[number, number, number]> = [
  [ 78,  42, 142],
  [102,  48, 170],
  [138,  65, 209],
  [173,  83, 236],
  [205, 104, 234],
  [226, 130, 220],
];

function colorEnabled(): boolean {
  if (process.env.NO_COLOR) return false;
  const f = process.env.FORCE_COLOR;
  if (f === '0') return false;
  if (f && f !== '0') return true;
  return !!process.stdout && !!process.stdout.isTTY;
}

function paint(line: string): string {
  if (!colorEnabled()) return line;
  // Apply the gradient column by column — each glyph gets a pinned color
  // so the whole banner reads as one continuous wash.
  let out = '';
  for (let i = 0; i < line.length; i++) {
    const t = Math.min(line.length - 1, 1) === 0 ? 0 : i / (line.length - 1);
    const idx = Math.min(GRADIENT.length - 1, Math.floor(t * (GRADIENT.length - 1)));
    const [r, g, b] = GRADIENT[idx];
    out += `\x1b[38;2;${r};${g};${b}m${line[i]}`;
  }
  return out + '\x1b[0m';
}

function dim(s: string): string {
  return colorEnabled() ? `\x1b[2m${s}\x1b[0m` : s;
}
function bold(s: string): string {
  return colorEnabled() ? `\x1b[1m${s}\x1b[0m` : s;
}

export function banner(info: BannerInfo = {}): string {
  const cols = process.stdout?.columns || 80;
  const v = info.version || '0.0.0';
  const m = info.model   || 'fast';
  const md = info.mode   || 'agent';
  const em = info.email  || '';
  const cwd = info.cwd   || '';

  // One-liner fallback for terminals too narrow for the block art.
  // The 3-row banner is 34 cols wide; add a 20-col info panel and leave
  // a small gutter so anything under ~56 drops to the compact form.
  if (cols < 56) {
    return `${bold('ChadCode')} ${dim('v' + v)}  ${m}  ${md}\n`;
  }

  const lines = LETTERS.map(paint);
  // Right-side info column aligned with the middle banner row.
  const info1 = dim(`v${v}`);
  const info2 = `${bold(m)}  ${dim('·')}  ${bold(md)}`;
  const info3 = em ? dim(em) : (cwd ? dim(cwd) : '');

  const pad = (left: string, right: string) => {
    // ANSI escape counts don't contribute to visible width — strip them.
    const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
    const leftW = strip(left).length;
    const padW = Math.max(2, cols - leftW - strip(right).length);
    return `${left}${' '.repeat(padW)}${right}`;
  };

  return [
    '',
    pad(lines[0], info1),
    pad(lines[1], info2),
    pad(lines[2], info3),
    '',
  ].join('\n');
}

// Short one-liner used after /clear so the user still sees the brand.
export function miniBanner(info: BannerInfo = {}): string {
  const v = info.version || '0.0.0';
  const m = info.model   || 'fast';
  const md = info.mode   || 'agent';
  return `${bold('⚡ ChadCode')} ${dim('v' + v)}  ${dim('·')}  ${m}  ${dim('·')}  ${md}\n`;
}

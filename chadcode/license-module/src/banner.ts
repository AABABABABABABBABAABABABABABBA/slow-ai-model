// ChadGPT ASCII banner — printed once at startup from bootstrap().
// Keep it under 80 cols so it doesn't wrap on narrow terminals.

export const BANNER = `
   ██████╗██╗  ██╗ █████╗ ██████╗  ██████╗ ██████╗ ████████╗
  ██╔════╝██║  ██║██╔══██╗██╔══██╗██╔════╝ ██╔══██╗╚══██╔══╝
  ██║     ███████║███████║██║  ██║██║  ███╗██████╔╝   ██║
  ██║     ██╔══██║██╔══██║██║  ██║██║   ██║██╔═══╝    ██║
  ╚██████╗██║  ██║██║  ██║██████╔╝╚██████╔╝██║        ██║
   ╚═════╝╚═╝  ╚═╝╚═╝  ╚═╝╚═════╝  ╚═════╝ ╚═╝        ╚═╝
                        c o d e
`;

// Single API host every ChadCode client points at. One subdomain, no
// scattered worker URLs leaking from the CLI to anyone who runs strings on it.
export const DEFAULT_API_BASE = 'https://chadgpt-api.corbyiscool.workers.dev';

export function printBanner(version: string, plan: string, fpLabel: string) {
  const C = {
    purple: '\x1b[35m',
    gray: '\x1b[90m',
    reset: '\x1b[0m',
    bold: '\x1b[1m',
  };
  process.stderr.write(`${C.purple}${BANNER}${C.reset}`);
  process.stderr.write(`${C.bold}chadcode${C.reset} ${version} · plan ${plan} · ${C.gray}${fpLabel}${C.reset}\n`);
  process.stderr.write(`${C.gray}API: ${DEFAULT_API_BASE}${C.reset}\n\n`);
}

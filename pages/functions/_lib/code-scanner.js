// Pattern-based code scanner. Blocks deploy of files that look like
// C2/RAT, DDoS tools, torrent clients, Discord self-bots, crypto miners,
// credential grabbers, and other obvious abuse categories.
//
// Honest limits:
//   - This is signature/pattern matching, NOT real malware analysis.
//     Obfuscated / packed payloads will slip through. If you need
//     actual malware scanning, wire in VirusTotal or ClamAV.
//   - Any pattern-based scanner has false positives. A legitimate
//     integration test for a security tool might match a RAT signature.
//     We err on the side of blocking — the Plus-tier user can email to
//     request an exception if they're building something legit.
//   - npm package names are matched both in `require(…)` / `import …`
//     statements AND in the dependency sections of embedded package.json.
//
// Categories:
//   c2         Command-and-control framework signatures (Cobalt Strike,
//              Metasploit, njRAT, AsyncRAT, Quasar, NanoCore, etc.)
//   ddos       Flood / stress / reflection tools (LOIC-style loops,
//              amplification, SYN flood, Slowloris)
//   selfbot    Discord self-bot libs (which violate Discord TOS and
//              get chat sent from user accounts)
//   torrent    WebTorrent / bittorrent client embeds
//   miner      Crypto miners (xmrig, CoinIMP, CryptoLoot, CoinHive…)
//   infostealer Credential grabbers (token grabbers, clipboard
//              hijackers, cookie exfiltrators)
//   revshell   Reverse shells / command execution over sockets
//   abuse      Spam / mass-mail / phone-number harvesters

const BLOCKED_NPM_PACKAGES = [
  // Discord self-bots and token manipulation
  'discord.js-selfbot-v13',
  'discord.js-selfbot',
  'discord-selfbot-v14',
  'discord-selfbot-ws',
  'discord-self',
  'selfcord',
  'selfcord.js',
  // Known bittorrent client libs (deploying these to a worker is
  // always a tracker / seeding use)
  'webtorrent',
  'bittorrent-dht',
  'bittorrent-tracker',
  'torrent-stream',
  // Crypto miners
  'coinimp',
  'coinhive',
  'cryptonight',
  'xmrig-nodejs',
  // Known malware package families
  'discord-nitrogen',
  'tokentool',
  'nitro-generator',
];

const RULES = [
  // ── Command-and-control / RAT frameworks ─────────────────────────────
  { cat: 'c2', re: /\bcobalt[-_ ]?strike\b/i, why: 'mentions Cobalt Strike' },
  { cat: 'c2', re: /\bmeterpreter\b/i, why: 'Meterpreter payload reference' },
  { cat: 'c2', re: /\bmetasploit\b/i, why: 'Metasploit module reference' },
  { cat: 'c2', re: /\bnjRAT\b|\bnj-rat\b/i, why: 'njRAT signature' },
  // Note: must say the word "RAT" nearby — or use the specific signature
  // names like "AsyncRAT" / "QuasarRAT" — so the plain word "async" in
  // modern JS doesn't trip the whole scanner.
  { cat: 'c2', re: /\b(?:asyncRAT|quasarRAT|nanocore\s*rat|darkcomet|xtremerat|revenge[-\s]?rat|poisonivy[-\s]?rat)\b/i, why: 'known RAT family name' },
  { cat: 'c2', re: /\b(?:async|quasar|nanocore)\s*\(?\s*rat\s*\)?/i, why: 'RAT family reference' },
  { cat: 'c2', re: /beaconconfig|beacon_http_config|rsrc[\s"\.]+msc_\w+/i, why: 'C2 beacon configuration pattern' },
  { cat: 'c2', re: /\bmimikatz\b|\bsekurlsa\b|\blsadump\b/i, why: 'credential dumping tool' },

  // ── Reverse shells / unauth RCE ──────────────────────────────────────
  { cat: 'revshell', re: /(?:bash|sh|cmd|powershell)\s+-[ic]\s+[\'"][^'"]*(?:\/dev\/tcp\/|socat\s+tcp|nc\s+-[eln]+)/i, why: 'inline reverse-shell command' },
  { cat: 'revshell', re: /\b(?:exec|eval|system|popen|subprocess\.(?:Popen|call))\s*\([^)]{0,80}(?:bash|sh|cmd|powershell|nc |netcat)/i, why: 'shell exec of nc/bash/powershell' },
  { cat: 'revshell', re: /\/dev\/tcp\/\d+\.\d+\.\d+\.\d+\/\d+/i, why: '/dev/tcp reverse-shell path' },

  // ── DDoS / flood tools ───────────────────────────────────────────────
  { cat: 'ddos', re: /\bslowloris\b/i, why: 'Slowloris DoS tool reference' },
  { cat: 'ddos', re: /\bhulk\.py\b|\bLOIC\b|\bHOIC\b|\bXOIC\b/i, why: 'named DDoS tool (LOIC/HOIC/XOIC/HULK)' },
  { cat: 'ddos', re: /\bsyn[-_ ]?flood\b|\budp[-_ ]?flood\b|\bhttp[-_ ]?flood\b|\bicmp[-_ ]?flood\b/i, why: 'flood attack reference' },
  { cat: 'ddos', re: /dns[-_ ]?amplif|ntp[-_ ]?amplif|memcached[-_ ]?reflect/i, why: 'reflection/amplification DDoS' },
  // Infinite-rate HTTP hammer loop pointed at an external host — the
  // tell is a while(true) / setInterval with a fetch inside and no await.
  { cat: 'ddos', re: /while\s*\(\s*(?:true|1)\s*\)\s*{[^}]*fetch\s*\(/i, why: 'unthrottled HTTP flood loop' },
  { cat: 'ddos', re: /setInterval\s*\(\s*(?:async\s*)?\(?\s*\)?\s*=>\s*{\s*fetch\s*\(.*\)\s*}\s*,\s*[0-9]\s*\)/i, why: 'per-millisecond fetch loop' },

  // ── Crypto miners ────────────────────────────────────────────────────
  { cat: 'miner', re: /\bxmrig\b/i, why: 'xmrig CPU miner' },
  { cat: 'miner', re: /\bcoinhive\b|\bcoinimp\b|\bcryptoloot\b|\bcoin-have\b/i, why: 'browser mining library' },
  { cat: 'miner', re: /\bminero\.cc\b|\bwebminer\.cc\b|\bminexmr\b/i, why: 'mining pool / service host' },
  { cat: 'miner', re: /stratum\+tcp:\/\//i, why: 'stratum mining pool URL' },

  // ── Discord self-bots / token tooling ────────────────────────────────
  { cat: 'selfbot', re: /\bdiscord\.py-self\b|\bdiscord\.js-selfbot\b|\bselfcord\b/i, why: 'Discord self-bot library (ToS violation)' },
  { cat: 'selfbot', re: /\btoken[-_]?grab(?:ber)?\b|\bdiscord[-_ ]?token[-_ ]?stealer\b/i, why: 'Discord token grabber' },
  { cat: 'selfbot', re: /LocalStorage.*\/discord\/Local\s*Storage|Discord\/Local\s*Storage\/leveldb/i, why: 'reading Discord local credentials' },

  // ── Torrent clients ──────────────────────────────────────────────────
  { cat: 'torrent', re: /\bwebtorrent\b|\bbittorrent[-_ ](?:dht|tracker|client)\b/i, why: 'BitTorrent library' },
  { cat: 'torrent', re: /magnet:\?xt=urn:btih:/i, why: 'embedded magnet link' },

  // ── Credential / info stealers ──────────────────────────────────────
  { cat: 'infostealer', re: /\b(?:cookie|password|credential)[-_ ]?(?:grab|steal|harvest)/i, why: 'credential grabber language' },
  { cat: 'infostealer', re: /chrome[\\/]User\s*Data[\\/]Default[\\/]Login\s*Data/i, why: 'Chrome password DB path' },
  { cat: 'infostealer', re: /roaming[\\/](?:Discord|Chrome|Firefox|Opera)[\\/](?:Local\s*Storage|Cookies|Login\s*Data)/i, why: 'reading browser credential stores' },
  { cat: 'infostealer', re: /\bwallet\.dat\b|\.keystore\b/i, why: 'crypto wallet file access' },

  // ── Spam / abuse ────────────────────────────────────────────────────
  { cat: 'abuse', re: /(?:sms|email)[-_ ]?bomber?\b/i, why: 'SMS/email bomber' },
  { cat: 'abuse', re: /mass[-_ ]?(?:mailer|dm|follow|spam)/i, why: 'mass spam tool' },
  { cat: 'abuse', re: /phishing[-_ ]?(?:kit|page|template)/i, why: 'phishing kit' },
];

/**
 * Scan a code string for abuse signatures.
 * @param {string} content - the code / file contents
 * @param {string} [filename] - optional filename, used for a few file-name heuristics
 * @returns {{ok: true} | {ok: false, category: string, rule: string, why: string, snippet: string}}
 */
export function scanCode(content, filename) {
  if (!content || typeof content !== 'string') return { ok: true };

  // npm package hits (require / import / package.json dependencies)
  for (const pkg of BLOCKED_NPM_PACKAGES) {
    const esc = pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?:require\\s*\\(\\s*['"]${esc}['"]\\s*\\)|from\\s+['"]${esc}['"]|"${esc}"\\s*:|'${esc}'\\s*:)`, 'i');
    if (re.test(content)) {
      return {
        ok: false,
        category: 'blocked_package',
        rule: 'npm_blocklist',
        why: `blocked npm package: ${pkg}`,
        snippet: firstMatch(content, re, 120),
      };
    }
  }

  // Pattern rules
  for (const r of RULES) {
    if (r.re.test(content)) {
      return {
        ok: false,
        category: r.cat,
        rule: r.re.source.slice(0, 80),
        why: r.why,
        snippet: firstMatch(content, r.re, 120),
      };
    }
  }

  // Filename-based soft signals (only fail on strong ones).
  if (filename) {
    const fn = filename.toLowerCase();
    if (/(^|[_\-.])(rat|stealer|grabber|bomber|flooder|slowloris|cobalt|phishing|keylogger|exploit[-_]?kit)([_\-.]|$)/i.test(fn)) {
      return {
        ok: false,
        category: 'abuse',
        rule: 'filename_signal',
        why: `filename "${filename}" matches abuse pattern`,
        snippet: '',
      };
    }
  }

  return { ok: true };
}

function firstMatch(content, re, maxChars) {
  const m = content.match(re);
  if (!m) return '';
  const start = Math.max(0, m.index - 30);
  const end = Math.min(content.length, (m.index || 0) + m[0].length + 30);
  return content.slice(start, end).replace(/\s+/g, ' ').slice(0, maxChars);
}

// Exported so admin tooling / tests can introspect what's blocked.
export const SCANNER_RULES = {
  blocked_npm_packages: BLOCKED_NPM_PACKAGES.slice(),
  pattern_rules: RULES.map((r) => ({ category: r.cat, why: r.why })),
};

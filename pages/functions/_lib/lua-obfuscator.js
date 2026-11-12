// Lua obfuscator — multi-pass source transform that runs entirely inside a
// Cloudflare Worker (no shelling out to LuaJIT or Prometheus).
//
// Passes (in order):
//   1. Tokenize + extract strings and comments into placeholders so later
//      passes don't touch their contents.
//   2. Strip comments entirely.
//   3. Rename `local` variables and function parameters to `_0x<hex>` so the
//      author's names are gone. Globals and stdlib calls (print, pairs,
//      string.format, table.insert, ...) are left alone — renaming them
//      would break the program.
//   4. Encrypt string literals: each literal becomes a call to a per-build
//      decoder function _D("<hex>") that XOR-decrypts at runtime.
//   5. Encode numeric literals as arithmetic / hex expressions so grep
//      stops working.
//   6. Insert dead code — opaque predicate blocks that never execute but
//      pad the source with meaningless computation.
//   7. Final wrap: the already-mangled source gets XOR+hex encoded into a
//      string, bootstrap decodes it at runtime, then calls Lua's load()
//      on the result. Reading the output file shows only the bootstrap
//      and a long opaque hex blob.
//
// Honest caveats this module can't hide from the caller:
//   - Any determined attacker with a Lua interpreter can log the decoded
//     source: `hook load` and dump the arg. True protection needs a
//     custom VM or bytecode-only distribution.
//   - Renaming is scope-naive: it's a whole-file substitution for every
//     `local` name. Files that reuse the same local name in two
//     non-overlapping scopes still obfuscate correctly because both
//     occurrences go to the same mangled name.
//
// API: obfuscateLua(source, { level }) -> { code, stats }
//   level: 'light' | 'heavy' | 'extreme' (default extreme)

const LUA_KEYWORDS = new Set([
  'and','break','do','else','elseif','end','false','for','function','goto',
  'if','in','local','nil','not','or','repeat','return','then','true','until','while',
]);

// Globals and common stdlib tables we must NEVER rename because the program
// resolves them at the global level. Expand freely — false negatives here
// just mean we fail to mangle a user's own local that shadows a builtin,
// which is safe.
const LUA_GLOBALS = new Set([
  '_G','_ENV','_VERSION','print','ipairs','pairs','next','select','type','tostring','tonumber',
  'pcall','xpcall','error','assert','rawget','rawset','rawequal','rawlen','setmetatable','getmetatable',
  'require','dofile','load','loadstring','loadfile','collectgarbage','unpack','gcinfo',
  'string','table','math','io','os','debug','coroutine','package','bit','bit32','utf8',
  // Roblox / Love2D / FiveM — still safe to leave alone even if not loaded.
  'game','workspace','script','Instance','Vector3','Vector2','CFrame','UDim','UDim2','Color3',
  'Enum','wait','spawn','delay','tick','typeof','newproxy',
  'love','_init','_update','_draw',
  'Citizen','GetPlayerName','RegisterCommand','AddEventHandler','TriggerEvent','TriggerServerEvent','TriggerClientEvent',
]);

function hex(n) { return n.toString(16).toUpperCase().padStart(2, '0'); }
function rng(seed) {
  // xorshift32 — deterministic-ish name generator seeded from source hash
  let x = seed | 0; if (!x) x = 0x9E3779B1;
  return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return x >>> 0; };
}

// Small, portable name generator. Pattern: _0x<4-8 hex chars>.
function makeNameGen(seed) {
  const r = rng(seed);
  const used = new Set();
  return () => {
    let name;
    do {
      const n = r();
      name = '_0x' + n.toString(16).toUpperCase().padStart(6, '0').slice(0, 6 + (n & 3));
    } while (used.has(name));
    used.add(name);
    return name;
  };
}

// ---------------- Pass 1: tokenize strings + comments into placeholders ----------------
// Replace every string / long-string / comment with a unique placeholder
// token so later regex passes don't accidentally rewrite their contents.

function tokenizeStringsAndComments(src) {
  const placeholders = [];
  let out = '';
  let i = 0;
  const N = src.length;

  // Convert numeric id to a letter-only tag so the later number-encoding pass
  // can't rewrite digits inside the placeholder (bug: `S:0` was being eaten
  // by the integer regex).
  const toLetters = (n) => {
    let s = '';
    do { s = String.fromCharCode(97 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
    return s;
  };

  const push = (kind, value) => {
    const id = placeholders.length;
    placeholders.push({ kind, value });
    return `\x01${kind}${toLetters(id)}\x02`;
  };

  while (i < N) {
    const c = src[i];
    const c2 = src[i + 1];

    // Short comment: -- ... \n
    if (c === '-' && c2 === '-') {
      // Long comment --[[ ... ]] or --[=*[ ... ]=*]
      if (src[i + 2] === '[') {
        let eq = 0;
        let j = i + 3;
        while (src[j] === '=') { eq++; j++; }
        if (src[j] === '[') {
          const closer = ']' + '='.repeat(eq) + ']';
          const end = src.indexOf(closer, j + 1);
          if (end !== -1) {
            out += push('C', src.slice(i, end + closer.length));
            i = end + closer.length;
            continue;
          }
        }
      }
      // Short comment to EOL
      const eol = src.indexOf('\n', i);
      const end = eol === -1 ? N : eol;
      out += push('C', src.slice(i, end));
      i = end;
      continue;
    }

    // Short string: " or '
    if (c === '"' || c === "'") {
      const quote = c;
      let j = i + 1;
      while (j < N && src[j] !== quote) {
        if (src[j] === '\\') j += 2;
        else if (src[j] === '\n') break;
        else j++;
      }
      const end = j < N ? j + 1 : j;
      out += push('S', src.slice(i, end));
      i = end;
      continue;
    }

    // Long string: [[ ... ]] or [=*[ ... ]=*]
    if (c === '[') {
      let eq = 0;
      let j = i + 1;
      while (src[j] === '=') { eq++; j++; }
      if (src[j] === '[') {
        const closer = ']' + '='.repeat(eq) + ']';
        const end = src.indexOf(closer, j + 1);
        if (end !== -1) {
          out += push('L', src.slice(i, end + closer.length));
          i = end + closer.length;
          continue;
        }
      }
    }

    out += c;
    i++;
  }

  return { stripped: out, placeholders };
}

function lettersToId(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 97) + (i > 0 ? 1 : 0);
  return n;
}

function restorePlaceholders(src, placeholders) {
  return src.replace(/\x01([CSL])([a-z]+)\x02/g, (_, kind, id) => placeholders[lettersToId(id)].value);
}

// ---------------- Pass 2: strip comments ----------------
function stripComments(src) {
  return src.replace(/\x01C[a-z]+\x02/g, '');
}

// ---------------- Pass 3: rename locals + params ----------------
// Parse for `local a, b = ...` and `function f(a, b)` / `function f.g(a, b)` /
// `function(a, b)` and `for i = ...` / `for a, b in ...`. Collect every name,
// generate a mangled replacement, then whole-file substitute.
function collectLocals(src) {
  const names = new Set();
  // local foo, bar = ...   or just  local foo
  for (const m of src.matchAll(/\blocal\s+(?!function\b)([A-Za-z_][A-Za-z0-9_, \t]*)/g)) {
    for (const name of m[1].split(',')) {
      const n = name.trim();
      if (n && !LUA_KEYWORDS.has(n)) names.add(n);
    }
  }
  // local function foo(...) — the name is a local
  for (const m of src.matchAll(/\blocal\s+function\s+([A-Za-z_][A-Za-z0-9_]*)/g)) {
    names.add(m[1]);
  }
  // function foo(a, b, c) / function(a, b) / function M.f(a, b)
  for (const m of src.matchAll(/\bfunction\b[^(]*\(([^)]*)\)/g)) {
    for (const name of m[1].split(',')) {
      const n = name.trim();
      if (n && n !== '...' && !LUA_KEYWORDS.has(n)) names.add(n);
    }
  }
  // for i = 1, 10  — i is local
  for (const m of src.matchAll(/\bfor\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/g)) {
    names.add(m[1]);
  }
  // for k, v in pairs(...) — both local
  for (const m of src.matchAll(/\bfor\s+([A-Za-z_][A-Za-z0-9_, \t]*)\s+in\b/g)) {
    for (const name of m[1].split(',')) {
      const n = name.trim();
      if (n && !LUA_KEYWORDS.has(n)) names.add(n);
    }
  }
  // Scrub anything that's a keyword, global, or starts with underscore-digit (ours).
  for (const n of [...names]) {
    if (LUA_KEYWORDS.has(n) || LUA_GLOBALS.has(n) || /^_0x/i.test(n)) names.delete(n);
  }
  return [...names];
}

function renameLocals(src, nameMap) {
  // Build one big regex with word boundaries. Keep order by descending length
  // so longer names aren't eaten by shorter overlaps.
  const sorted = Object.keys(nameMap).sort((a, b) => b.length - a.length);
  if (!sorted.length) return src;
  const alt = sorted.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const re = new RegExp(`(?<![A-Za-z0-9_.])(${alt})(?![A-Za-z0-9_])`, 'g');
  return src.replace(re, (_, name) => nameMap[name]);
}

// ---------------- Pass 4: encrypt strings ----------------
// Each string literal placeholder gets re-emitted as a call to the runtime
// decoder: _D("<hex>"). The decoder prepended to the output XOR-decrypts with
// a per-build key.
function encryptStrings(placeholders, key, decoderName) {
  for (let i = 0; i < placeholders.length; i++) {
    const p = placeholders[i];
    if (p.kind !== 'S' && p.kind !== 'L') continue;
    // Pull the contents (minus quotes / long brackets).
    let body;
    if (p.kind === 'S') {
      // Short string "..." or '...' — strip quotes, interpret escapes conservatively.
      const raw = p.value.slice(1, -1);
      body = decodeLuaShortString(raw);
    } else {
      // Long string [[...]] or [=[...]=]
      const match = /^\[(=*)\[([\s\S]*)\](=*)\]$/.exec(p.value);
      body = match ? match[2].replace(/^\n/, '') : p.value;
    }
    // XOR encrypt + hex.
    let out = '';
    for (let j = 0; j < body.length; j++) {
      const b = (body.charCodeAt(j) ^ (key + j * 7 + ((key >> 4) & 0xFF))) & 0xFF;
      out += hex(b);
    }
    p.value = `${decoderName}("${out}")`;
  }
}

function decodeLuaShortString(raw) {
  // Handle the subset of escapes a user would realistically write.
  return raw.replace(/\\(x[0-9A-Fa-f]{2}|\d{1,3}|[abfnrtv\\"'\n])/g, (m, esc) => {
    if (esc.startsWith('x')) return String.fromCharCode(parseInt(esc.slice(1), 16));
    if (/^\d/.test(esc)) return String.fromCharCode(parseInt(esc, 10));
    switch (esc) {
      case 'a': return '\x07'; case 'b': return '\b'; case 'f': return '\f';
      case 'n': return '\n'; case 'r': return '\r'; case 't': return '\t'; case 'v': return '\v';
      case '\\': return '\\'; case '"': return '"'; case "'": return "'"; case '\n': return '\n';
    }
    return m;
  });
}

// ---------------- Pass 5: encode numbers ----------------
// `42` → `(0x59-0x2F)` with random pairs that always arithmetic back to the
// original. Operates on the SOURCE with placeholders in place so string
// contents are never touched.
function encodeNumbers(src, seed) {
  const r = rng(seed ^ 0xC0FFEE);
  // Match standalone integers (no leading alnum / underscore / dot to avoid
  // names, hex, decimals).
  return src.replace(/(?<![A-Za-z0-9_.\x01])(\d{1,8})(?![A-Za-z0-9_.])/g, (whole, n) => {
    const v = parseInt(n, 10);
    if (isNaN(v) || v > 999999) return whole;
    // Pick a random offset ≤ 0xFF
    const off = r() & 0xFF;
    const a = v + off;
    return `(0x${a.toString(16).toUpperCase()}-0x${off.toString(16).toUpperCase()})`;
  });
}

// ---------------- Pass 6: dead-code injection (heavy+extreme only) ----------------
function injectDeadCode(src, seed, count) {
  const r = rng(seed ^ 0xDEAD);
  // Opaque predicate that is provably false but looks computed.
  // Insert at start of chunk only — mid-body insertion risks landing between
  // tokens we rely on (e.g. splitting `local x = 1` into two halves).
  const junk = [];
  for (let i = 0; i < count; i++) {
    const a = r() & 0xFFFF; const b = r() & 0xFFFF;
    junk.push(`if (${a} * ${a} + ${b}) < 0 then local _${hex(r() & 0xFF)} = "${hex(r() & 0xFF)}" end`);
  }
  return junk.join('\n') + '\n' + src;
}

// ---------------- Pass 7: final wrap (extreme only) ----------------
// XOR+hex the whole mangled source, emit a bootstrap that decodes and calls
// Lua's load() on it. Reading the output file now shows only the loader plus
// a long hex blob.
function finalWrap(mangled, outerKey) {
  // XOR each byte with a stream derived from outerKey.
  let payload = '';
  for (let i = 0; i < mangled.length; i++) {
    const k = (outerKey + i * 11 + ((outerKey >> 3) & 0xFF)) & 0xFF;
    const b = mangled.charCodeAt(i) & 0xFF;
    payload += hex(b ^ k);
  }
  // Decoder is pure-Lua, no bitwise operators — works on 5.1, LuaJIT, 5.2, 5.3+.
  // Inline XOR via the arithmetic trick used by _X above.
  return `local _P="${payload}"local _K=${outerKey} local function _XR(a,b)local r,m=0,1 for i=0,7 do local x,y=a%2,b%2 if x~=y then r=r+m end a=(a-x)/2 b=(b-y)/2 m=m*2 end return r end local function _U(s,k)local o,n={},#s/2 for i=1,n do local b=tonumber(s:sub(i*2-1,i*2),16)local kk=(k+(i-1)*11+math.floor(k/8))%256 o[i]=string.char(_XR(b,kk))end return table.concat(o)end local _F=load or loadstring return _F(_U(_P,_K))()`;
}

// Fallback XOR string for Lua 5.1 / LuaJIT (no `~` operator, no `&`).
// Pure arithmetic — no bit library dependency.
function portableXorHelper() {
  return `local function _X(a,b)local r,m=0,1 for i=0,7 do local x,y=a%2,b%2 if x~=y then r=r+m end a=(a-x)/2 b=(b-y)/2 m=m*2 end return r end`;
}

// Build the runtime decoder for strings.
function stringDecoderStub(key, name) {
  // Pure-Lua, works on 5.1 / 5.2 / 5.3 / 5.4 / LuaJIT.
  return `${portableXorHelper()} local function ${name}(h)local o,n={},#h/2 for i=1,n do local b=tonumber(h:sub(i*2-1,i*2),16)local k=(${key}+(i-1)*7+math.floor(${key}/16))%256 o[i]=string.char(_X(b,k))end return table.concat(o)end`;
}

// ---------------- entry point ----------------
export function obfuscateLua(source, opts = {}) {
  if (typeof source !== 'string') throw new Error('source must be a string');
  if (source.length > 500000) throw new Error('source too large (max 500KB)');

  const level = opts.level || 'extreme';
  const validLevels = ['light', 'heavy', 'extreme'];
  if (!validLevels.includes(level)) throw new Error(`unknown level: ${level}`);

  // Seed derives from a fast hash of the source so two runs on the same
  // input produce the same output (helpful for diffing).
  let seed = 0;
  for (let i = 0; i < source.length; i++) { seed = (seed * 31 + source.charCodeAt(i)) | 0; }
  const stringKey = ((seed >>> 0) & 0xFF) || 0x5A;
  const outerKey = (((seed >>> 8) & 0xFF) || 0xA5);
  const decoderName = '_D' + hex((seed >>> 16) & 0xFF);

  // --- Pass 1 ---
  const { stripped, placeholders } = tokenizeStringsAndComments(source);
  // --- Pass 2 ---
  let working = stripComments(stripped);

  // --- Pass 3 (locals rename) — heavy + extreme ---
  let renameStats = 0;
  if (level !== 'light') {
    const locals = collectLocals(working);
    const gen = makeNameGen(seed);
    const map = {};
    for (const n of locals) map[n] = gen();
    renameStats = locals.length;
    working = renameLocals(working, map);
  }

  // --- Pass 4 (string encryption) — all levels, but extreme uses outer wrap too ---
  if (level !== 'light') {
    encryptStrings(placeholders, stringKey, decoderName);
  }

  // --- Pass 5 (number encoding) — heavy + extreme ---
  if (level !== 'light') {
    working = encodeNumbers(working, seed);
  }

  // --- Pass 6 (dead code) — extreme only ---
  if (level === 'extreme') {
    working = injectDeadCode(working, seed, 8);
  }

  // Restore string placeholders (now rewritten to _D("...") calls on heavy/extreme).
  working = restorePlaceholders(working, placeholders);

  // Collapse whitespace aggressively on extreme — one giant line.
  if (level === 'extreme') {
    working = working.replace(/[ \t]+/g, ' ').replace(/\n\s*\n/g, '\n').trim();
  } else if (level === 'heavy') {
    working = working.replace(/[ \t]+/g, ' ').trim();
  }

  // Prepend the decoder stub if any strings were encrypted.
  let body = working;
  if (level !== 'light') {
    body = stringDecoderStub(stringKey, decoderName) + ' ' + body;
  }

  // --- Pass 7 (final wrap) — extreme only ---
  if (level === 'extreme') {
    body = finalWrap(body, outerKey);
  }

  return {
    code: body,
    stats: {
      level,
      input_bytes: source.length,
      output_bytes: body.length,
      locals_renamed: renameStats,
      strings_encrypted: placeholders.filter(p => p.kind === 'S' || p.kind === 'L').length,
    },
  };
}

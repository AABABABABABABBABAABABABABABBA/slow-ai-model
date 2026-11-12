#!/usr/bin/env bash
# fork.sh — turn a fresh sst/opencode clone into ChadCode.
#
# Usage:
#   ./fork.sh /path/to/opencode-clone /path/to/output-chadcode
#
# What it does:
#   1. rsync the source to the output dir (excluding .git)
#   2. rename every opencode -> chadcode across filenames + contents
#      (case-aware: OpenCode -> ChadCode, OPENCODE -> CHADCODE)
#   3. strip the MIT LICENSE from the *built* artifact pipeline but KEEP the
#      source-level attribution per MIT terms (stays in SOURCES_LICENSES.md)
#   4. wire in @chadcode/license as a dependency of the CLI package
#   5. patch the CLI entrypoint to call bootstrap() on startup
#   6. init a fresh git repo so there's no upstream link
#
# Note: MIT compliance — the licence text has to stay inside the distributed
# source files that still originate from OpenCode. If you later rewrite those
# files, the attribution can be dropped from the rewrites.

set -euo pipefail

SRC="${1:?usage: fork.sh <opencode-clone> <output-dir>}"
DST="${2:?usage: fork.sh <opencode-clone> <output-dir>}"

if [[ ! -d "$SRC" ]]; then
  echo "source dir missing: $SRC" >&2; exit 1
fi
if [[ -e "$DST" ]]; then
  echo "output dir already exists: $DST — refusing to overwrite" >&2; exit 1
fi

echo "[1/6] copy source -> $DST"
if command -v rsync >/dev/null 2>&1; then
  rsync -a --exclude='.git' --exclude='node_modules' --exclude='dist' --exclude='.turbo' "$SRC"/ "$DST"/
else
  mkdir -p "$DST"
  # tar pipe is faster than cp -r and handles excludes cleanly.
  tar -C "$SRC" --exclude='.git' --exclude='node_modules' --exclude='dist' --exclude='.turbo' -cf - . | tar -C "$DST" -xf -
fi

cd "$DST"

echo "[2/6] rename filenames (opencode -> chadcode)"
# Rename files + dirs, deepest first so parent renames don't invalidate paths.
# Only rewrite the BASENAME so we don't try to move into a dir that is still
# named "opencode" because its own rename hasn't happened yet.
find . -depth -name '*opencode*' | while read -r f; do
  dir=$(dirname "$f")
  base=$(basename "$f")
  new_base="${base//opencode/chadcode}"
  new_base="${new_base//OpenCode/ChadCode}"
  new_base="${new_base//OPENCODE/CHADCODE}"
  if [[ "$base" != "$new_base" ]]; then
    mv "$f" "$dir/$new_base"
  fi
done

echo "[3/6] rewrite file contents"
# Skip binary + lock + minified files to keep diffs clean.
grep -rlI --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist \
  --exclude='*.lock' --exclude='*.lockb' --exclude='*.min.js' --exclude='*.map' \
  -e 'opencode' -e 'OpenCode' -e 'OPENCODE' . | while read -r f; do
  sed -i \
    -e 's/OpenCode/ChadCode/g' \
    -e 's/OPENCODE/CHADCODE/g' \
    -e 's/opencode/chadcode/g' \
    "$f"
done

echo "[4/6] preserve MIT attribution + mark distribution as private"
cat > SOURCES_LICENSES.md <<'EOF'
# Third-party sources

ChadCode is a private fork of [opencode](https://github.com/sst/opencode)
distributed under the MIT License (see `LICENSE.opencode`). The MIT terms
require that the copyright notice and permission notice ship with every
copy of substantial portions of the original software. That obligation is
satisfied by keeping `LICENSE.opencode` in this tree.

Files that remain substantially derived from the original opencode source
retain this attribution. Files rewritten from scratch inside this repo
are proprietary to ChadCode and have no MIT obligation attached.
EOF
if [[ -f LICENSE ]]; then
  mv LICENSE LICENSE.opencode
fi
cat > LICENSE <<'EOF'
Copyright (c) ChadCode. All rights reserved.

This software is proprietary and confidential. Portions of this software are
derived from opencode (https://github.com/sst/opencode), distributed under the
MIT License; see LICENSE.opencode for the original notice. The ChadCode
distribution as a whole is not open source and may not be redistributed in
source or binary form without the written permission of the copyright holder.
EOF

echo "[5/6] wire the CLI entrypoint into @chadcode/license + @chadcode/tools"
CLI_ENTRY="packages/cli/src/index.ts"
if [[ -f "$CLI_ENTRY" ]]; then
  # Insert the license + tools bootstrap AFTER the shebang (shebangs must be line 1).
  tmpfile=$(mktemp)
  first=$(head -n1 "$CLI_ENTRY")
  if [[ "$first" == "#!"* ]]; then
    echo "$first" > "$tmpfile"
    cat >> "$tmpfile" <<'EOF'
import { bootstrap } from '@chadcode/license';
import { createRegistry as createChadcodeTools, makeDefaultConfirm, toolsSchema as chadcodeToolsSchema } from '@chadcode/tools';
await bootstrap({
  licenseServer: process.env.CHADCODE_LICENSE_SERVER || 'https://chadcode-license.corbyiscool.workers.dev',
  version: process.env.CHADCODE_VERSION || '0.0.0',
  binary: process.execPath,
  skipLicense: process.env.CHADCODE_SKIP_LICENSE === '1',
});
// Make the ChadCode tool pack reachable to the runner. Agent-mode CLI
// should pull from globalThis.__chadcodeTools (set here) + call the
// registry's .execute on each tool_use event.
// Safety mode: 'yolo' | 'auto' (default 'auto' — low-risk auto, medium/high prompt).
const __chadcodeMode = (process.env.CHADCODE_APPROVAL === 'yolo' ? 'yolo' : 'auto');
globalThis.__chadcodeTools = {
  registry: createChadcodeTools(),
  schema: chadcodeToolsSchema(),
  mode: __chadcodeMode,
  confirm: makeDefaultConfirm({ mode: __chadcodeMode }),
};
EOF
    tail -n+2 "$CLI_ENTRY" >> "$tmpfile"
  else
    cat > "$tmpfile" <<'EOF'
import { bootstrap } from '@chadcode/license';
import { createRegistry as createChadcodeTools, makeDefaultConfirm, toolsSchema as chadcodeToolsSchema } from '@chadcode/tools';
await bootstrap({
  licenseServer: process.env.CHADCODE_LICENSE_SERVER || 'https://chadcode-license.corbyiscool.workers.dev',
  version: process.env.CHADCODE_VERSION || '0.0.0',
  binary: process.execPath,
  skipLicense: process.env.CHADCODE_SKIP_LICENSE === '1',
});
const __chadcodeMode = (process.env.CHADCODE_APPROVAL === 'yolo' ? 'yolo' : 'auto');
globalThis.__chadcodeTools = {
  registry: createChadcodeTools(),
  schema: chadcodeToolsSchema(),
  mode: __chadcodeMode,
  confirm: makeDefaultConfirm({ mode: __chadcodeMode }),
};
EOF
    cat "$CLI_ENTRY" >> "$tmpfile"
  fi
  mv "$tmpfile" "$CLI_ENTRY"
  echo "  -> injected bootstrap + tools registry into $CLI_ENTRY"
else
  echo "  !! $CLI_ENTRY not found — add bootstrap() + tools registry to your CLI entry manually"
fi

# Copy the @chadcode/tools package into the fork and wire it as a workspace dep.
TOOLS_SRC="$(cd "$(dirname "$0")/.." && pwd)/tools"
if [[ -d "$TOOLS_SRC" ]]; then
  echo "[5a] copy @chadcode/tools into packages/tools"
  mkdir -p packages/tools
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --exclude='node_modules' --exclude='dist' "$TOOLS_SRC"/ packages/tools/
  else
    tar -C "$TOOLS_SRC" --exclude='node_modules' --exclude='dist' -cf - . | tar -C packages/tools -xf -
  fi
  # Register as workspace dep on the CLI package.
  if [[ -f packages/cli/package.json ]]; then
    node -e '
      const fs=require("fs");
      const p="packages/cli/package.json";
      const j=JSON.parse(fs.readFileSync(p,"utf8"));
      j.dependencies = j.dependencies || {};
      j.dependencies["@chadcode/tools"] = "workspace:*";
      j.dependencies["@chadcode/license"] = j.dependencies["@chadcode/license"] || "workspace:*";
      j.dependencies["@chadcode/auth-client"] = "workspace:*";
      j.dependencies["@chadcode/tui-commands"] = "workspace:*";
      fs.writeFileSync(p, JSON.stringify(j,null,2)+"\n");
    '
    echo "  -> added @chadcode/tools, auth-client, tui-commands as workspace deps of packages/cli"
  fi
fi

# Copy the @chadcode/auth-client package (device-code login flow).
AUTH_SRC="$(cd "$(dirname "$0")/.." && pwd)/auth-client"
if [[ -d "$AUTH_SRC" ]]; then
  echo "[5b] copy @chadcode/auth-client into packages/auth-client"
  mkdir -p packages/auth-client
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --exclude='node_modules' --exclude='dist' "$AUTH_SRC"/ packages/auth-client/
  else
    tar -C "$AUTH_SRC" --exclude='node_modules' --exclude='dist' -cf - . | tar -C packages/auth-client -xf -
  fi
fi

# Copy the @chadcode/tui-commands package (slash commands + banner).
TUI_SRC="$(cd "$(dirname "$0")/.." && pwd)/tui-commands"
if [[ -d "$TUI_SRC" ]]; then
  echo "[5c] copy @chadcode/tui-commands into packages/tui-commands"
  mkdir -p packages/tui-commands
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --exclude='node_modules' --exclude='dist' "$TUI_SRC"/ packages/tui-commands/
  else
    tar -C "$TUI_SRC" --exclude='node_modules' --exclude='dist' -cf - . | tar -C packages/tui-commands -xf -
  fi

  # Best-effort replacement of OpenCode's built-in banner anywhere it's
  # hardcoded. We look for files that mention `OPENCODE` in a banner-y
  # context (blocky unicode OR the literal string in a Go/TS file) and
  # patch them. Finding nothing is fine — the opencode source changes
  # over time and a quiet miss is better than a loud false-positive.
  echo "[5d] swap any hardcoded opencode banner for the ChadCode block art"
  BANNER_CHAR='▀'
  BANNER_FILES=$(grep -rlE "${BANNER_CHAR}" --include='*.go' --include='*.ts' --include='*.tsx' --include='*.js' . 2>/dev/null || true)
  for f in $BANNER_FILES; do
    # If this file has two or more rows of block-art characters within
    # 10 lines of each other, assume it's a banner and rewrite the
    # whole block to the ChadCode variant. Keep it simple with perl.
    if perl -0777 -ne 'exit 1 unless /(?:[█▀▄].*\n){2,}/' "$f" 2>/dev/null; then
      perl -0777 -i -pe '
        s{((?:[^\n]*[█▀▄][^\n]*\n){3,10})}{
          "  █▀▀ █ █ █▀█ █▀▄ █▀▀ █▀█ █▀▄ █▀▀\n" .
          "  █   █▀█ █▀█ █ █ █   █ █ █ █ █▀▀\n" .
          "  ▀▀▀ ▀ ▀ ▀ ▀ ▀▀  ▀▀▀ ▀▀▀ ▀▀  ▀▀▀\n"
        }e
      ' "$f" && echo "   -> patched banner in $f"
    fi
  done
fi

PROMPT_SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)/prompts"
PROMPT_DST="packages/core/src/session/runner/prompt/system.txt"
if [[ -f "$PROMPT_SRC_DIR/agent.txt" && -f "$PROMPT_DST" ]]; then
  echo "[5b] inject ChadGPT agent system prompt"
  cp "$PROMPT_SRC_DIR/agent.txt" "$PROMPT_DST"
fi
if [[ -f "$PROMPT_SRC_DIR/agent-tools.json" ]]; then
  echo "[5c] inject ChadGPT agent tool spec"
  mkdir -p packages/core/src/session/runner/prompt
  cp "$PROMPT_SRC_DIR/agent-tools.json" packages/core/src/session/runner/prompt/agent-tools.json
fi

echo "[6/6] fresh git repo"
rm -rf .git
git init -q
git add .
git commit -q -m "ChadCode: forked from sst/opencode and rebranded"

echo
echo "Done. Fork lives in: $DST"
echo "Next steps:"
echo "  1. Add @chadcode/license to packages/cli/package.json dependencies."
echo "  2. Replace UPDATE_PUBKEY_PEM in @chadcode/license with your real ed25519 public key."
echo "  3. Deploy the license worker (workers/license) and D1 migration."
echo "  4. Push to a PRIVATE repo — never a public one."

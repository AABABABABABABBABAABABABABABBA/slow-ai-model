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

  # Overwrite the opencode block-art logo at its known location.
  # (packages/tui/src/logo.ts — four-char words left+right.)
  if [[ -f packages/tui/src/logo.ts ]]; then
    cat > packages/tui/src/logo.ts <<'LOGO'
export const logo = {
  left: ["                   ", "█▀▀█ █__█ █▀▀█ █▀▀█", "█___ █▀▀█ █▀▀█ █__█", "▀▀▀▀ ▀__▀ ▀__▀ ▀▀▀▀"],
  right: ["             ▄     ", "█▀▀▀ █▀▀█ █▀▀█ █▀▀█", "█___ █__█ █__█ █^^^", "▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀"],
}

export const go = {
  left: ["    ", "█▀▀▀", "█_^█", "▀▀▀▀"],
  right: ["    ", "█▀▀█", "█__█", "▀▀▀▀"],
}
LOGO
    echo "   -> replaced logo.ts (chad+code)"
  fi

  # Bundle ChadGPT-only model catalog so /models shows our models,
  # not models.dev's full list.
  SNAPSHOT_SRC="$(cd "$(dirname "$0")/.." && pwd)/provider/chadgpt-snapshot.txt"
  if [[ -f "$SNAPSHOT_SRC" && -f packages/core/src/models-dev/snapshot.txt ]]; then
    cp "$SNAPSHOT_SRC" packages/core/src/models-dev/snapshot.txt
    # Lower the "at least 100 providers" floor — our catalog has 1.
    if [[ -f packages/core/script/models-snapshot.ts ]]; then
      sed -i 's/const MINIMUM_PROVIDERS = 100/const MINIMUM_PROVIDERS = 1/' packages/core/script/models-snapshot.ts
    fi
    echo "   -> replaced snapshot.txt with ChadGPT-only catalog"
  fi

  # /connect — repoint at a ChadCode-only "already connected" dialog
  # instead of opencode's full provider picker (which lists OpenAI,
  # Anthropic, Groq, …). Users of this fork can only use ChadGPT so
  # the real picker just confuses them.
  OVERRIDES_SRC="$(cd "$(dirname "$0")/.." && pwd)/fork-overrides"
  if [[ -f "$OVERRIDES_SRC/dialog-chadcode-connected.tsx" && -d packages/tui/src/component ]]; then
    cp "$OVERRIDES_SRC/dialog-chadcode-connected.tsx" packages/tui/src/component/
    echo "   -> added dialog-chadcode-connected.tsx"
  fi
  if [[ -f packages/tui/src/app.tsx ]]; then
    # Add the import right next to the old DialogIntegration import.
    if ! grep -q 'DialogChadCodeConnected' packages/tui/src/app.tsx; then
      sed -i 's|^import { DialogIntegration } from "./component/dialog-integration"$|import { DialogIntegration } from "./component/dialog-integration"\nimport { DialogChadCodeConnected } from "./component/dialog-chadcode-connected"|' packages/tui/src/app.tsx
    fi
    # Swap the dialog that /connect opens.
    perl -0777 -i -pe '
      s{
        \{\s*
        name:\s*"provider\.connect"[\s\S]{10,600}?
        run:\s*\(\)\s*=>\s*\{\s*
        dialog\.replace\(\(\)\s*=>\s*\(\s*
        <DialogIntegration[\s\S]{0,400}?\/>\s*
        \)\)\s*
        \},
      }{\{\n        name: "provider.connect",\n        title: "Connect an integration",\n        slash: { name: "connect" },\n        run: () => \{ dialog.replace(() => <DialogChadCodeConnected />) \},}gx
    ' packages/tui/src/app.tsx
    echo "   -> repointed /connect at DialogChadCodeConnected"
  fi
  if [[ -f packages/tui/src/feature-plugins/sidebar/footer.tsx ]]; then
    perl -0777 -i -pe '
      s{
        \s*<text[^>]*>OpenCode\ includes\ free\ models[\s\S]{10,800}?Connect\ provider</text>\s*<text[^>]*>/connect</text>\s*</box>
      }{\n          <text fg={props.context.theme.text.muted}>ChadCode ships with ChadGPT free models — start coding right away.</text>\n          <text fg={props.context.theme.text.muted}>Upgrade to Plus for ChadGPT Pro (Llama 3), ChadCoder (DeepSeek), and ChadGPT Ultra (Llama 3.3 70B).</text>\n          <box id="sidebar.footer.getting-started.connect" flexDirection="row" gap={1} justifyContent="space-between" onMouseUp={() => props.context.keymap.dispatch("provider.connect")}>\n            <text fg={props.context.theme.text.base}>Show connection</text>\n            <text fg={props.context.theme.text.muted}>/connect</text>\n          </box>}gx
    ' packages/tui/src/feature-plugins/sidebar/footer.tsx
    echo "   -> rewrote sidebar footer with ChadCode copy + /connect link"
  fi

  # User-visible "opencode" command strings that didn't get caught by
  # the earlier case-sensitive sed sweep. Narrow, path-anchored edits
  # so we don't mangle package names or comments.
  if [[ -f packages/tui/src/util/presentation.ts ]]; then
    sed -i \
      -e 's/`Run `${reset}${bold}opencode${reset}/`Run `${reset}${bold}chadcode${reset}/' \
      -e 's/`opencode -s /`chadcode -s /' \
      packages/tui/src/util/presentation.ts
    echo "   -> presentation.ts: Continue/Run commands → chadcode"
  fi
  if [[ -f packages/tui/src/util/error.ts ]]; then
    sed -i \
      -e 's/Try: `opencode models`/Try: `chadcode models`/' \
      -e 's/(opencode.json)/(opencode.jsonc)/' \
      packages/tui/src/util/error.ts
    echo "   -> error.ts: model-not-found hint → chadcode models"
  fi
  if [[ -f packages/tui/src/component/dialog-pair.tsx ]]; then
    sed -i \
      -e 's/Run `opencode service set/Run `chadcode service set/' \
      packages/tui/src/component/dialog-pair.tsx
    echo "   -> dialog-pair.tsx: service-set hint → chadcode"
  fi

  # Kill the live models.opencode.ai fetch. Even with our bundled
  # snapshot, the TUI will fetch the full catalog (Big Pickle, DeepSeek
  # V4.1, GLM-5.3, Iceman, Inkling, LongCat, Flint 40B …) on start and
  # mix it in. Flip the gate to always-off.
  if [[ -f packages/cli/src/server-process.ts ]]; then
    sed -i \
      -e 's|url: process\.env\.OPENCODE_MODELS_URL,|url: undefined, // ChadCode: no live catalog fetch|' \
      -e 's|fetch: !truthy(process\.env\.OPENCODE_DISABLE_MODELS_FETCH),|fetch: false, // ChadCode: always disabled|' \
      packages/cli/src/server-process.ts
    echo "   -> server-process.ts: disabled live models.opencode.ai fetch"
  fi

  # Disable the OpencodePlugin provider — it exposes opencode.ai's hosted
  # models directly into /models even without the user signing in. The
  # plugin file stays importable (so guarded-set reference still
  # compiles) but it's no longer in the active ProviderPlugins array.
  if [[ -f packages/core/src/plugin/provider.ts ]]; then
    sed -i \
      -e 's|^  OpencodePlugin,|  // ChadCode: OpencodePlugin removed (opencode.ai hosted models)\n  // OpencodePlugin,|' \
      packages/core/src/plugin/provider.ts
    echo "   -> provider.ts: unregistered OpencodePlugin from active list"
  fi
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

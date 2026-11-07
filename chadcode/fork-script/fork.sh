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

echo "[5/6] wire the CLI entrypoint into @chadcode/license"
CLI_ENTRY="packages/cli/src/index.ts"
if [[ -f "$CLI_ENTRY" ]]; then
  # Insert the license bootstrap AFTER the shebang (shebangs must be line 1).
  tmpfile=$(mktemp)
  first=$(head -n1 "$CLI_ENTRY")
  if [[ "$first" == "#!"* ]]; then
    echo "$first" > "$tmpfile"
    cat >> "$tmpfile" <<'EOF'
import { bootstrap } from '@chadcode/license';
await bootstrap({
  licenseServer: process.env.CHADCODE_LICENSE_SERVER || 'https://chadcode-license.corbyiscool.workers.dev',
  version: process.env.CHADCODE_VERSION || '0.0.0',
  binary: process.execPath,
  skipLicense: process.env.CHADCODE_SKIP_LICENSE === '1',
});
EOF
    tail -n+2 "$CLI_ENTRY" >> "$tmpfile"
  else
    cat > "$tmpfile" <<'EOF'
import { bootstrap } from '@chadcode/license';
await bootstrap({
  licenseServer: process.env.CHADCODE_LICENSE_SERVER || 'https://chadcode-license.corbyiscool.workers.dev',
  version: process.env.CHADCODE_VERSION || '0.0.0',
  binary: process.execPath,
  skipLicense: process.env.CHADCODE_SKIP_LICENSE === '1',
});
EOF
    cat "$CLI_ENTRY" >> "$tmpfile"
  fi
  mv "$tmpfile" "$CLI_ENTRY"
  echo "  -> injected bootstrap into $CLI_ENTRY"
else
  echo "  !! $CLI_ENTRY not found — add bootstrap() to your CLI entry manually"
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

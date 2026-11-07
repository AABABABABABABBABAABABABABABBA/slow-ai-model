# ChadCode — closed-source fork of opencode

This directory holds the pieces that turn [sst/opencode](https://github.com/sst/opencode)
into a private, hardware-licensed distribution with an auto-updater.

## Honest scope

Three things live here. They are **not** a full fork of opencode — they
are the glue that converts a clone of opencode into one:

1. **`license-module/`** — a tiny TypeScript package (`@chadcode/license`)
   that the forked CLI imports at startup. It:
   - collects a hardware fingerprint (`/etc/machine-id` + MAC + CPU + arch);
   - calls the license server to bind + verify;
   - caches a signed token for 24h offline tolerance;
   - checks for signed updates on startup and replaces the binary.

2. **`fork-script/fork.sh`** — one-shot script that rsyncs an opencode clone
   into a new directory, renames every `opencode` → `chadcode` in filenames
   and file contents, preserves the MIT attribution in `LICENSE.opencode`
   (required — MIT doesn't go away just because the fork is private),
   replaces top-level `LICENSE` with a proprietary notice, and injects
   `bootstrap()` into the CLI entrypoint.

3. **`../workers/license/`** — the Cloudflare Worker + D1 schema that
   backs activation, verification, revocation, and the update feed.

## What "closed source" actually means for an MIT fork

Legally: OpenCode is MIT. MIT lets you keep your fork private and sell
binaries, but the license **and copyright notice** have to stay in any
source files you still distribute that were derived from the original.
That attribution lives in `LICENSE.opencode` after the script runs.

Practically: run the fork on a **private** repo, ship signed binaries,
don't publish the source. The `license-module` + the worker make it so
that even if someone extracts your binary, they still need a key bound
to their hardware to run it — and you can revoke that key.

What you **can't** do: claim OpenCode's original code is yours or strip
the attribution from files you directly derived. You can of course
rewrite any file from scratch and drop the attribution on that file.

## Fork steps

```bash
# 1. Clone opencode locally.
git clone https://github.com/sst/opencode /tmp/opencode-src

# 2. Run the rebrand.
./chadcode/fork-script/fork.sh /tmp/opencode-src /tmp/chadcode

# 3. Install the license module into the forked CLI.
cp -r chadcode/license-module /tmp/chadcode/packages/license
# Then edit /tmp/chadcode/packages/cli/package.json dependencies to include
#   "@chadcode/license": "workspace:*"

# 4. Replace the ed25519 public key in packages/license/src/updater.ts
#    with your real public key (generate with `openssl genpkey -algorithm ed25519`,
#    extract pub with `openssl pkey -pubout`).

# 5. Push to a PRIVATE repo. Never public.
```

## Bypass realism

A client-side license check running on the user's machine can, in theory,
be patched out. What we do to make that annoying:

- **Hardware binding** — activation locks the key to the first machine's
  fingerprint. Moving it needs server-side transfer.
- **Short cache TTL** — the offline grace period is 24h max.
- **Server-side revocation** — the license server can kill a key the next
  time the client comes online.
- **Signed updates** — the updater refuses anything not signed with the
  founder's ed25519 key, so attackers can't push a "noop" update.
- **Fingerprint reuse detection** — the same fingerprint showing up under
  five emails lights up in the admin panel; the device can be blocked.

What this does **not** do: prevent a determined reverse-engineer with
your binary from stripping the `requireValidLicense` call. That's always
the ceiling of client-side licensing. The real anti-bypass is server-side
quotas on the API endpoints — which ChadGPT already has.

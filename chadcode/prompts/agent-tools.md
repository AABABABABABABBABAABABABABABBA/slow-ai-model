# ChadGPT agent tool spec

Source of truth: `chadcode/prompts/agent-tools.json` — 13 tools, canonical shape the agent should expose.

## What's shipped vs. what still needs wiring

The chadcode fork inherits opencode's tool runtime (Claude Agent provider). The runtime already exposes analogous tools under different names; a thin adapter is needed before the names in `agent-tools.json` are live.

| Spec tool          | Existing opencode equivalent        | Status        |
|--------------------|-------------------------------------|---------------|
| `read_file`        | `Read`                              | alias needed  |
| `edit_file`        | `Edit` / `Write`                    | alias needed  |
| `search_replace`   | `Edit` (single-occurrence mode)     | alias needed  |
| `grep_search`      | `Grep`                              | alias needed  |
| `file_search`      | `Glob`                              | alias needed  |
| `list_dir`         | `LS`                                | alias needed  |
| `run_terminal_cmd` | `Bash`                              | alias needed  |
| `delete_file`      | `Bash` with `rm`                    | wrap          |
| `web_search`       | `WebSearch`                         | alias needed  |
| `edit_notebook`    | `NotebookEdit`                      | alias needed  |
| `reapply`          | opencode has "apply again" affordance| wrap        |
| `codebase_search`  | **not in opencode** — semantic search, needs vector index | TODO |
| `create_diagram`   | **not in opencode** — Mermaid validator | TODO      |

## Wiring plan (next turn, say the word)

1. Create `packages/core/src/plugin/provider/chadgpt-agent/` as a new provider that:
   - Exports tool definitions matching `agent-tools.json` exactly
   - Each handler delegates to the corresponding opencode built-in
   - `codebase_search` fallback: ripgrep + rank by filename proximity (no vector index until we add one)
   - `create_diagram`: fetch Mermaid live renderer or client-side validate with `@mermaid-js/mermaid-cli`
2. Register the provider in the session runner
3. Update `${CHADCODE_TOOL_GUIDANCE}` substitution so the system prompt names these tools

## Why save the spec first

Having `agent-tools.json` committed means:
- Any chadcode build references one canonical schema
- If the wiring breaks, we have the exact spec to diff against
- Future forks (via `fork.sh`) can inject the same spec automatically

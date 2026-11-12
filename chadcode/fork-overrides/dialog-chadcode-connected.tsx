// A one-screen "ChadCode is already connected" dialog that replaces the
// upstream integration picker. The upstream picker enumerates every
// provider plugin (OpenAI, Anthropic, Groq, …); in a ChadCode build we
// only want to show ChadGPT, and the user can't actually connect any
// other integration anyway since the only auth path goes through
// @chadcode/license. So we render a static confirmation instead.

import { createMemo, Show } from "solid-js"
import { useData } from "../context/data"
import { useTheme } from "../context/theme"
import { DIALOG_INSET, DialogFooter, DialogHeader, DialogLayout, useDialog } from "../ui/dialog"

export function DialogChadCodeConnected() {
  const dialog = useDialog()
  const data = useData()
  const theme = useTheme().surface("dialog")

  // Pull the plan from the env var we set during bootstrap. If unset
  // (dev builds), fall back to "unknown".
  const plan = createMemo(() => (process.env.CHADCODE_PLAN as string) || "unknown")
  const license = createMemo(() => {
    const k = (process.env.CHADCODE_LICENSE as string) || ""
    if (!k) return "not set"
    // Show only the first + last segment of the key so a screenshot
    // doesn't leak the whole thing.
    const parts = k.split("-")
    if (parts.length < 3) return "set"
    return `${parts[0]}-${parts[1]}…${parts.at(-1)}`
  })

  // Suppress unused warning in builds that trim the context; data is
  // threaded through so a future ChadGPT-connected summary (model list,
  // usage, etc.) can read from here without re-plumbing.
  void data

  return (
    <DialogLayout surface={theme}>
      <DialogHeader surface={theme} title="Connect an integration" />
      <box style={{ padding: `${DIALOG_INSET}px`, flexDirection: "column", gap: 1 }}>
        <text fg={theme.base.fg} attributes={1 /* BOLD */}>
          ChadGPT · connected
        </text>
        <text fg={theme.muted.fg} wrapMode="word">
          Your terminal is already paired with ChadGPT through your ChadCode license.
          There are no other providers to add in this build — every chat / code / image
          request routes through chadgpt-964.pages.dev using the license stored on this
          machine.
        </text>
        <box style={{ flexDirection: "column", gap: 0, marginTop: 1 }}>
          <box style={{ flexDirection: "row", gap: 2 }}>
            <text fg={theme.muted.fg}>plan</text>
            <text fg={theme.base.fg}>{plan()}</text>
          </box>
          <box style={{ flexDirection: "row", gap: 2 }}>
            <text fg={theme.muted.fg}>license</text>
            <text fg={theme.base.fg}>{license()}</text>
          </box>
        </box>
        <Show when={plan() !== "plus" && plan() !== "unlimited"}>
          <text fg={theme.muted.fg} wrapMode="word" style={{ marginTop: 1 }}>
            Upgrade to Plus at https://chadgpt-964.pages.dev to unlock
            chadgpt-pro / chadgpt-coder / chadgpt-ultra.
          </text>
        </Show>
      </box>
      <DialogFooter
        surface={theme}
        keys={[{ label: "close", keys: ["esc"], onPress: () => dialog.close() }]}
      />
    </DialogLayout>
  )
}

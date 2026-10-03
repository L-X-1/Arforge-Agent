export type TerminalPanelOperation = "create" | "clone" | "update" | "close"
export type TerminalPanelAction = "create" | "close" | "reconnect" | "rename"
export type TerminalOperationPending = (operation: TerminalPanelOperation, terminalID?: string) => boolean

export function terminalPanelOperationPending(
  pending: TerminalOperationPending,
  action: TerminalPanelAction,
  terminalID?: string,
) {
  if (action === "create") return pending("create")
  if (!terminalID) return true
  if (pending("close", terminalID) || pending("clone", terminalID)) return true
  return action === "rename" && pending("update", terminalID)
}

export function runTerminalNewShortcut(input: {
  count: number
  opened: boolean
  pending: TerminalOperationPending
  create: (options: { focus: true }) => void | Promise<void>
  requestFocus: () => void
  open: () => void
}) {
  // A closed, empty panel owns its initial one-shot creation. An already-open
  // empty panel needs a real user-triggered retry after a failed creation.
  if ((input.count > 0 || input.opened) && !terminalPanelOperationPending(input.pending, "create")) {
    void input.create({ focus: true })
  }
  if (input.count === 0) input.requestFocus()
  input.open()
}

export function terminalPanelOperationText(operation: TerminalPanelOperation, chinese: boolean, failed = true) {
  const messages = {
    create: failed
      ? ["\u7ec8\u7aef\u521b\u5efa\u5931\u8d25\u3002\u8bf7\u68c0\u67e5\u8fde\u63a5\u548c\u6743\u9650\u540e\u91cd\u8bd5\u3002", "Could not create the terminal. Check the connection and permissions before trying again."]
      : ["\u6b63\u5728\u521b\u5efa\u7ec8\u7aef...", "Creating terminal..."],
    clone: failed
      ? ["\u7ec8\u7aef\u6062\u590d\u5931\u8d25\uff0c\u539f\u7ec8\u7aef\u4ecd\u4fdd\u7559\u3002\u8bf7\u68c0\u67e5\u8fde\u63a5\u548c\u6743\u9650\u3002", "Terminal recovery failed. The original terminal is retained; check the connection and permissions."]
      : ["\u6b63\u5728\u6062\u590d\u7ec8\u7aef...", "Recovering terminal..."],
    update: failed
      ? ["\u7ec8\u7aef\u66f4\u65b0\u5931\u8d25\u3002\u8bf7\u68c0\u67e5\u8fde\u63a5\u548c\u6743\u9650\u540e\u91cd\u8bd5\u3002", "Could not update the terminal. Check the connection and permissions before trying again."]
      : ["\u6b63\u5728\u66f4\u65b0\u7ec8\u7aef...", "Updating terminal..."],
    close: failed
      ? ["\u7ec8\u7aef\u5173\u95ed\u5931\u8d25\uff0c\u6807\u7b7e\u548c\u5185\u5bb9\u4ecd\u4fdd\u7559\u3002\u8bf7\u68c0\u67e5\u8fde\u63a5\u548c\u6743\u9650\u540e\u91cd\u8bd5\u3002", "Could not close the terminal. Its tab and contents are retained; check the connection and permissions before trying again."]
      : ["\u6b63\u5728\u7b49\u5f85\u7ec8\u7aef\u5173\u95ed\u786e\u8ba4...", "Waiting for terminal close acknowledgement..."],
  } satisfies Record<TerminalPanelOperation, [string, string]>
  return messages[operation][chinese ? 0 : 1]
}

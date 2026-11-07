export function createLogExportAction(input: {
  exportLogs: () => Promise<string>
  active: () => boolean
  notify: (result: { type: "success" } | { type: "error"; error: unknown; retry: () => void }) => void
}) {
  const run = async () => {
    if (!input.active()) return
    try {
      await input.exportLogs()
      if (input.active()) input.notify({ type: "success" })
    } catch (error) {
      if (input.active())
        input.notify({
          type: "error",
          error,
          retry: () => {
            void run()
          },
        })
    }
  }
  return run
}

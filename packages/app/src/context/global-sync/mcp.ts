import type { McpServer } from "@arforge-ai/client/promise"

export async function toggleMcp(input: {
  status: McpServer["status"]["status"] | "needs_approval"
  connect: () => Promise<void>
  disconnect: () => Promise<void>
  authenticate: () => Promise<void>
  refresh: () => Promise<void>
}) {
  if (input.status === "pending") return
  await {
    connected: input.disconnect,
    needs_auth: input.authenticate,
    needs_approval: input.connect,
    disabled: input.connect,
    failed: input.connect,
    needs_client_registration: input.connect,
  }[input.status]()
  await input.refresh()
}

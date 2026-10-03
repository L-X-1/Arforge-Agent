/**
 * The MCP status vocabulary is shared by the server-sync projections and the
 * two user-facing status surfaces. Keeping the label map here prevents a new
 * status from silently falling back to an untranslated protocol literal.
 */
export const mcpStatusLabelKeys = {
  connected: "mcp.status.connected",
  failed: "mcp.status.failed",
  needs_auth: "mcp.status.needs_auth",
  needs_client_registration: "mcp.status.needs_client_registration",
  needs_approval: "mcp.status.needs_approval",
  disabled: "mcp.status.disabled",
} as const

export function mcpStatusLabelKey(status: string | undefined) {
  if (!status || !Object.hasOwn(mcpStatusLabelKeys, status)) return
  return mcpStatusLabelKeys[status as keyof typeof mcpStatusLabelKeys]
}

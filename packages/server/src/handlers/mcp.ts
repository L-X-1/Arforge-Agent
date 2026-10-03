import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InvalidRequestError, McpServerNotFoundError } from "@arforge-ai/protocol/errors"
import { Api } from "../api"
import { response } from "../location"

/**
 * The reusable Core server does not own an MCP transport runtime. It still
 * implements the shared read contract so embedded clients can bootstrap
 * deterministically; the full Arforge product server replaces this group with
 * its mature MCP handler.
 */
export const McpHandler = HttpApiBuilder.group(Api, "server.mcp", (handlers) =>
  handlers
    .handle("mcp.list", () => response(Effect.succeed([])))
    .handle("mcp.resource.catalog", () =>
      response(
        Effect.succeed({
          resources: [],
          templates: [],
        }),
      ),
    )
    .handle("mcp.capabilities", () => response(Effect.succeed([])))
    .handle("mcp.action.reconciliation", () =>
      Effect.fail(
        new InvalidRequestError({
          kind: "mcp-reconciliation-unavailable",
          message: "MCP reconciliation is unavailable in the embedded Core runtime.",
        }),
      ),
    )
    .handle("mcp.action.reconciliationRecord", () =>
      Effect.fail(
        new InvalidRequestError({
          kind: "mcp-reconciliation-unavailable",
          message: "MCP reconciliation recording is unavailable in the embedded Core runtime.",
        }),
      ),
    )
    .handle("mcp.connect", ({ params }) =>
      Effect.fail(
        new McpServerNotFoundError({
          server: params.server,
          message: `MCP server is not available in the embedded Core runtime: ${params.server}`,
        }),
      ),
    )
    .handle("mcp.disconnect", ({ params }) =>
      Effect.fail(
        new McpServerNotFoundError({
          server: params.server,
          message: `MCP server is not available in the embedded Core runtime: ${params.server}`,
        }),
      ),
    ),
)

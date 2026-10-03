import { Schema } from "effect"
import type { Stream } from "node:stream"

const STARTUP_MESSAGES = {
  current_directory:
    "本地 MCP 在读取启动目录时退出。请检查运行时是否支持当前沙箱，以及入口文件和依赖是否位于已授权路径；未自动扩大权限或降级沙箱。",
  module_unavailable:
    "本地 MCP 无法加载入口文件或依赖。请检查命令、工作目录及依赖安装位置，并确认它们位于已授权路径；未自动扩大权限或降级沙箱。",
  native_launch: "本地 MCP 的系统沙箱启动或清理失败。请检查当前系统与运行时的沙箱支持；未自动降级或重新启动服务器。",
} as const

export class LocalStartupError extends Schema.TaggedErrorClass<LocalStartupError>()("MCP.LocalStartupError", {
  reason: Schema.Literals(["current_directory", "module_unavailable", "native_launch"]),
  message: Schema.String,
}) {}

/**
 * Drain the SDK's existing stderr pipe before connect, without retaining or
 * publishing arbitrary child output. Only fixed diagnostic categories escape.
 * This observer never owns, closes, retries or replaces the process transport.
 */
export function observeLocalStartupError(stream: Stream | null) {
  let reason: keyof typeof STARTUP_MESSAGES | undefined
  let tail = ""
  const receive = (chunk: Buffer | string) => {
    if (reason) return
    // Scan bounded windows even when a child submits one unusually large
    // chunk. Retain only enough suffix to recognize a split ASCII marker.
    for (let offset = 0; offset < chunk.length && !reason; offset += 4096) {
      const block =
        typeof chunk === "string"
          ? chunk.slice(offset, offset + 4096)
          : chunk.subarray(offset, offset + 4096).toString("latin1")
      const text = tail + block
      if (text.includes("CouldntReadCurrentDirectory")) reason = "current_directory"
      else if (/error:\s*(?:Cannot find (?:module|package)|ModuleNotFound|Module not found)/iu.test(text))
        reason = "module_unavailable"
      else if (/Windows sandbox [A-Za-z_/()]+ failed \((?:Win32 error|HRESULT) /u.test(text)) reason = "native_launch"
      tail = reason ? "" : text.slice(-192)
    }
  }
  stream?.on("data", receive)
  return {
    error: () => (reason ? new LocalStartupError({ reason, message: STARTUP_MESSAGES[reason] }) : undefined),
    stop: () => {
      stream?.off("data", receive)
      tail = ""
      reason = undefined
      // Connected servers may keep logging. Leaving the PassThrough paused
      // would fill its buffer and eventually block their protocol response.
      if (stream && "resume" in stream && typeof stream.resume === "function") stream.resume()
    },
  }
}

/**
 * A protocol request was dispatched but no response was durably observed.
 * The fields are bounded identity only; raw transport errors and response
 * bodies stay out of the user-visible recovery surface.
 */
export class TransportOutcomeUnknownError extends Schema.TaggedErrorClass<TransportOutcomeUnknownError>()(
  "McpGatewayAdapter.TransportOutcomeUnknownError",
  {
    server: Schema.String,
    key: Schema.String,
    operation: Schema.String,
  },
) {}

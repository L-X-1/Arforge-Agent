import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import fs from "node:fs"
import path from "node:path"
import { setTimeout } from "node:timers/promises"

if (process.argv.includes("--hang")) {
  const pidFile = process.env.MCP_LIFECYCLE_PID_FILE
  if (!pidFile) throw new Error("MCP_LIFECYCLE_PID_FILE is required")
  await fs.promises.writeFile(pidFile, String(process.pid))
  await new Promise(() => {})
}

const markerReadyFile = process.env.MCP_MARKER_READY_FILE
const markerReleaseFile = process.env.MCP_MARKER_RELEASE_FILE
if (markerReadyFile && markerReleaseFile) {
  await fs.promises.writeFile(markerReadyFile, String(process.pid))
  if (!fs.existsSync(markerReleaseFile)) {
    await new Promise<void>((resolve, reject) => {
      const releaseDirectory = path.dirname(markerReleaseFile)
      let settled = false
      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        watcher.close()
        if (error) reject(error)
        else resolve()
      }
      const watcher = fs.watch(releaseDirectory, (_event, filename) => {
        if (filename && path.resolve(releaseDirectory, filename.toString()) === path.resolve(markerReleaseFile)) {
          if (fs.existsSync(markerReleaseFile)) finish()
        }
      })
      watcher.on("error", (error) => finish(error))
      // Close the registration race if the release appeared while installing
      // the watcher.
      if (fs.existsSync(markerReleaseFile)) finish()
    })
  }
}

if (process.argv.includes("--marker")) {
  const pidFile = process.env.MCP_LIFECYCLE_PID_FILE
  if (!pidFile) throw new Error("MCP_LIFECYCLE_PID_FILE is required")
  await fs.promises.writeFile(pidFile, String(process.pid))
}

const connectDelayIndex = process.argv.indexOf("--connect-delay-ms")
if (connectDelayIndex !== -1) {
  const delay = Number(process.argv[connectDelayIndex + 1])
  if (!Number.isFinite(delay) || delay < 0) throw new Error("--connect-delay-ms requires a non-negative number")
  await setTimeout(delay)
}

const server = new Server({ name: "mcp-lifecycle-stdio", version: "1.0.0" }, { capabilities: { tools: {} } })

const writeDiagnosticNoise = async () => {
  if (!process.argv.includes("--noisy-stderr")) return
  await new Promise<void>((resolve, reject) => {
    process.stderr.write("MCP_FIXTURE_NOISE".repeat(32 * 1024), (error) => (error ? reject(error) : resolve()))
  })
}

server.setRequestHandler(ListToolsRequestSchema, async () => {
  // Exercise continued draining after initialization, before tools/list can
  // finish. This is the original SDK server, not a protocol replacement.
  await writeDiagnosticNoise()
  return {
    tools: [
      {
        name: "current_directory",
        description: process.cwd(),
        inputSchema: { type: "object", properties: {} },
      },
    ],
  }
})

await writeDiagnosticNoise()
await server.connect(new StdioServerTransport())

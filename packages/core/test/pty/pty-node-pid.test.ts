import { expect, mock, test } from "bun:test"

let nativePID = 0
mock.module("@lydell/node-pty", () => ({
  spawn: () => ({
    get pid() {
      return nativePID
    },
    onData: () => ({ dispose() {} }),
    onExit: () => ({ dispose() {} }),
    write() {},
    resize() {},
    kill() {},
  }),
}))
const { spawn } = await import("../../src/pty/pty.node")

test("Node PTY adapter keeps the native PID live after asynchronous readiness", () => {
  nativePID = 0
  const proc = spawn("owned-shell", [], { cwd: "/owned", name: "xterm-256color", env: {} })
  expect(proc.pid).toBe(0)
  nativePID = 43210
  expect(proc.pid).toBe(43210)
})

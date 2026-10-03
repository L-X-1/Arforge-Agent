import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import type { LogMessage } from "electron-log"
import { captureRendererConsole } from "./logging-renderer"

class Renderer extends EventEmitter {
  destroyed = false

  isDestroyed() {
    return this.destroyed
  }

  destroy() {
    this.destroyed = true
    this.emit("destroyed")
  }
}

function fixture(contents: Renderer[] = []) {
  const app = new EventEmitter()
  const messages: LogMessage[] = []
  const stop = captureRendererConsole({ app, contents: () => contents, write: (message) => messages.push(message) })
  return { app, messages, stop }
}

test("captures every console severity through a single-argument event listener", () => {
  const renderer = new Renderer()
  const capture = fixture([renderer])
  try {
    expect(renderer.listeners("console-message")).toHaveLength(1)
    expect(renderer.listeners("console-message")[0]!.length).toBe(1)
    for (const level of ["debug", "info", "warning", "error"] as const) {
      renderer.emit("console-message", { level, message: `renderer ${level}` })
    }
    expect(capture.messages.map((message) => message.level)).toEqual(["debug", "info", "warn", "error"])
    expect(capture.messages.map((message) => message.data)).toEqual([
      ["renderer debug"], ["renderer info"], ["renderer warning"], ["renderer error"],
    ])
    for (const message of capture.messages) {
      expect(message.date).toBeInstanceOf(Date)
      expect(message.variables).toEqual({ processType: "renderer" })
    }
  } finally {
    capture.stop()
  }
})

test("captures future renderers without attaching duplicate listeners", () => {
  const renderer = new Renderer()
  const capture = fixture([renderer, renderer])
  const future = new Renderer()
  try {
    capture.app.emit("web-contents-created", {}, renderer)
    capture.app.emit("web-contents-created", {}, future)
    capture.app.emit("web-contents-created", {}, future)
    expect(renderer.listenerCount("console-message")).toBe(1)
    expect(future.listenerCount("console-message")).toBe(1)
    renderer.emit("console-message", { level: "info", message: "existing" })
    future.emit("console-message", { level: "error", message: "future" })
    expect(capture.messages.map((message) => message.data)).toEqual([["existing"], ["future"]])
  } finally {
    capture.stop()
  }
})

test("skips destroyed contents and releases listeners when a renderer is destroyed", () => {
  const previous = new Renderer()
  previous.destroy()
  const current = new Renderer()
  const capture = fixture([previous, current])
  try {
    expect(previous.listenerCount("console-message")).toBe(0)
    current.destroy()
    capture.app.emit("web-contents-created", {}, current)
    expect(current.listenerCount("console-message")).toBe(0)
    expect(current.listenerCount("destroyed")).toBe(0)
    current.emit("console-message", { level: "error", message: "stale" })
    expect(capture.messages).toEqual([])
  } finally {
    capture.stop()
  }
})

test("shutdown detaches existing and future sources without removing unrelated listeners", () => {
  const renderer = new Renderer()
  let unrelated = 0
  renderer.on("console-message", () => unrelated++)
  const capture = fixture([renderer])
  capture.stop()
  capture.stop()
  const future = new Renderer()
  capture.app.emit("web-contents-created", {}, future)
  renderer.emit("console-message", { level: "info", message: "after shutdown" })
  expect(capture.app.listenerCount("web-contents-created")).toBe(0)
  expect(renderer.listenerCount("console-message")).toBe(1)
  expect(renderer.listenerCount("destroyed")).toBe(0)
  expect(future.listenerCount("console-message")).toBe(0)
  expect(capture.messages).toEqual([])
  expect(unrelated).toBe(1)
})

test("redacts preview capability credentials without dropping the renderer message", () => {
  const renderer = new Renderer()
  const capture = fixture([renderer])
  try {
    renderer.emit("console-message", {
      level: "warning",
      message: `Preview failed at http://127.0.0.2:12345/resources/${"a".repeat(64)}/index.html`,
    })
    expect(capture.messages).toHaveLength(1)
    expect(capture.messages[0]!.data).toEqual([
      "Preview failed at http://127.0.0.2:[port]/resources/[redacted]/index.html",
    ])
    expect(capture.messages[0]!.level).toBe("warn")
  } finally {
    capture.stop()
  }
})

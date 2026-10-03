import { describe, expect, test } from "bun:test"
import { shouldServeRendererShell } from "./renderer-route"

describe("renderer SPA route fallback", () => {
  test("serves the shell for workspace and Session routes", () => {
    expect(shouldServeRendererShell({ method: "GET", pathname: "/encoded/session/ses_123", range: null })).toBe(true)
    expect(shouldServeRendererShell({ method: "GET", pathname: "/encoded", range: null })).toBe(true)
  })

  test("does not conceal missing assets, mutations, or range requests", () => {
    expect(shouldServeRendererShell({ method: "GET", pathname: "/assets/app.js", range: null })).toBe(false)
    expect(shouldServeRendererShell({ method: "POST", pathname: "/encoded/session/ses_123", range: null })).toBe(false)
    expect(shouldServeRendererShell({ method: "GET", pathname: "/encoded/session/ses_123", range: "bytes=0-1" })).toBe(false)
  })
})

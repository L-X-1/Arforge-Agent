import { describe, expect, test } from "bun:test"
import path from "node:path"
import { resolveProductRoot } from "./product-root"

describe("resolveProductRoot", () => {
  test("prefers the product runtime injected by Desktop", () => {
    expect(resolveProductRoot("E:\\Arforge-Agent", "C:\\workspace")).toBe(path.resolve("E:\\Arforge-Agent"))
  })

  test("uses the server working directory when no product runtime is injected", () => {
    expect(resolveProductRoot("", "E:\\Arforge-Agent")).toBe(path.resolve("E:\\Arforge-Agent"))
  })
})

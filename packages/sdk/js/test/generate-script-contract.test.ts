import { describe, expect, test } from "bun:test"

const rootGenerator = new URL("../../../../script/generate.ts", import.meta.url)

describe("root SDK generator", () => {
  test("formats only the generated OpenAPI snapshot", async () => {
    const source = await Bun.file(rootGenerator).text()

    expect(source).toContain("bun prettier --write packages/sdk/openapi.json")
    expect(source).not.toContain("./script/format.ts")
  })
})

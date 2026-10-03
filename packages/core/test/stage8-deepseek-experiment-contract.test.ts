import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { expect, test } from "bun:test"

const root = resolve(import.meta.dir, "../../..")

test("stage 8 DeepSeek experiment stays bounded and fail-closed", async () => {
  const script = await readFile(resolve(root, "packages/core/script/run-stage8-deepseek-experiment.ts"), "utf8")
  expect(script).toContain('const MODEL = "deepseek-v4-flash"')
  expect(script).toContain("const MAX_REQUESTS = 3")
  expect(script).toContain("const MAX_TOKENS_PER_REQUEST = 512")
  expect(script).toContain("const AUTHORIZED_BUDGET_CNY = 5")
  expect(script).toContain('if (!args.includes("--authorize-live"))')
  expect(script).toContain("no provider request was attempted")
  expect(script).toContain("{ concurrency: 2 }")
  expect(script).toContain("LLM.generateObject")
  expect(script).toContain("resultJsonSchema")
  expect(script).toContain('status: successful && requestCount === MAX_REQUESTS ? "candidate" : "fail"')
  expect(script).toContain('decision: "DO_NOT_PROMOTE"')
  expect(script).toContain("secretsPrinted: false")
  expect(script).toContain("productionDataChanged: false")
})

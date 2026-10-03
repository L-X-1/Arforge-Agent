import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { expect, test } from "bun:test"
import { safeErrorDetails } from "../script/run-stage8-deepseek-experiment"

const root = resolve(import.meta.dir, "../../..")

test("stage 8 stable DeepSeek experiment is bounded and contract-shaped", async () => {
  const script = await readFile(resolve(root, "packages/core/script/run-stage8-stable-deepseek-experiment.ts"), "utf8")
  expect(script).toContain('export const MAX_STABLE_SAMPLES = 3')
  expect(script).toContain('export const REQUESTS_PER_SAMPLE = 3')
  expect(script).toContain('export const MAX_REQUESTS = MAX_STABLE_SAMPLES * REQUESTS_PER_SAMPLE')
  expect(script).toContain('export const MAX_BUDGET_CNY = 5')
  expect(script).toContain('if (!args.includes("--authorize-live"))')
  expect(script).toContain('evidence_type: "baseline_and_multi_agent_gain"')
  expect(script).toContain('evidence_class: "deepseek-live-experiment"')
  expect(script).toContain('source: "live"')
  expect(script).toContain('metric: "mean wall-clock duration in milliseconds; lower is better"')
  expect(script).toContain('secrets_printed: false')
  expect(script).toContain('production_data_changed: false')
  expect(script).toContain('staging_data_changed: false')
  expect(script).toContain("response_text_length")
  expect(script).toContain("error_reason_tag")
  expect(script).toContain("error_http_status")
  expect(script).toContain("error_retryable")
})

test("stage 8 provider failure evidence keeps only safe error metadata", () => {
  const details = safeErrorDetails({
    _tag: "LLM.Error",
    message: "secret provider response must not be persisted",
    reason: {
      _tag: "Authentication",
      message: "secret provider response must not be persisted",
      http: { response: { status: 401 } },
    },
    retryable: false,
  })

  expect(details).toEqual({
    errorTag: "LLM.Error",
    errorReasonTag: "Authentication",
    errorHttpStatus: 401,
    errorRetryable: false,
  })
  expect(JSON.stringify(details)).not.toContain("secret provider response")
})

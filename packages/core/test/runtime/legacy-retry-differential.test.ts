import { beforeAll, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import {
  InvalidRequestReason,
  LLMError,
  ProviderInternalReason,
  RateLimitReason,
  TransportReason,
} from "@arforge-ai/llm"
import { RuntimeRetry } from "../../src/runtime/retry"

// R01 comparison only: tool-error text classification and provider retry are NOT interchangeable owners.
const messages = [
  "connection timed out after 30s",
  "rate limit exceeded, try again later",
  "503 Service Unavailable",
  "connection refused",
  "SyntaxError: invalid syntax",
  "NameError: name 'x' is not defined",
] as const
let legacy: { transient: boolean[]; config: Record<string, number>; decoy: boolean }

beforeAll(() => {
  const root = path.resolve(import.meta.dir, "../../../..")
  const pinned = path.join(root, process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python")
  const python = existsSync(pinned) ? pinned : (Bun.which("python3") ?? Bun.which("python"))
  if (!python) throw new Error("R01 differential oracle requires Python; unavailable is not a passing comparison")
  const temporary = mkdtempSync(path.join(os.tmpdir(), "arforge-retry-oracle-"))
  try {
    const result = spawnSync(
      python,
      [
        "-I",
        "-S",
        "-B",
        "-c",
        `
import sys, json
sys.path.insert(0, sys.argv[1])
from arforge.core.self_correct import is_transient, retry_config
print(json.dumps({"transient": [is_transient(item) for item in json.loads(sys.argv[2])],
                  "config": retry_config(), "decoy": is_transient("request rejected; try again later")}))
`,
        root,
        JSON.stringify(messages),
      ],
      {
        cwd: temporary,
        encoding: "utf8",
        timeout: 15_000,
        windowsHide: true,
        env: { ...process.env, ARFORGE_HOME: temporary },
      },
    )
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    if (result.status !== 0) throw new Error(`legacy oracle failed: ${result.stderr}`)
    legacy = JSON.parse(result.stdout)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
})

const failure = (index: number) =>
  new LLMError({
    module: "differential-test",
    method: "stream",
    reason:
      index === 1
        ? new RateLimitReason({ message: messages[index] })
        : index === 2
          ? new ProviderInternalReason({ message: messages[index], status: 503 })
          : new TransportReason({ message: messages[index] }),
  })
const decision = (error: unknown, overrides: Partial<Parameters<typeof RuntimeRetry.decide>[0]> = {}) =>
  RuntimeRetry.decide({
    failure: error,
    outputStarted: false,
    toolCallStarted: false,
    transportRetriesUsed: 0,
    maxTransportRetries: 1,
    fallbackAvailable: false,
    ...overrides,
  })

test("executes the six legacy sc11 classification examples, not merely their Golden names", () => {
  expect(legacy.transient).toEqual([true, true, true, true, false, false])
  expect(legacy.config).toEqual({ max_retries: 5, base_delay_sec: 1, backoff_factor: 2, max_delay_sec: 30 })
  for (let index = 0; index < 4; index++) expect(decision(failure(index)).action).toBe("retry")
  for (const message of messages.slice(4)) expect(decision(new Error(message)).action).toBe("stop")
})

test("same text alone does not authorize provider retry; typed metadata owns the decision", () => {
  expect(legacy.transient[0]).toBe(true)
  expect(decision(new Error(messages[0]))).toMatchObject({ action: "stop", category: "unknown" })
  expect(legacy.decoy).toBe(true)
  expect(
    decision(
      new LLMError({
        module: "test",
        method: "stream",
        reason: new InvalidRequestReason({ message: "request rejected; try again later" }),
      }),
    ),
  ).toMatchObject({ action: "stop", category: "invalid-request" })
})

test("transient classification cannot override visible output or executable tool boundaries", () => {
  for (let index = 0; index < 4; index++) {
    expect(legacy.transient[index]).toBe(true)
    expect(decision(failure(index), { outputStarted: true, fallbackAvailable: true }).action).toBe("stop")
    expect(decision(failure(index), { toolCallStarted: true, fallbackAvailable: true }).action).toBe("stop")
  }
})

test("TS uses the supplied runtime budget, not the legacy global five-retry setting", () => {
  expect(legacy.config.max_retries).toBe(5)
  expect(decision(failure(0), { transportRetriesUsed: 1 }).action).toBe("stop")
  expect(decision(failure(0), { transportRetriesUsed: 1, fallbackAvailable: true }).action).toBe("fallback")
  expect(decision(failure(0), { maxTransportRetries: 0 }).action).toBe("stop")
})

import { expect, test } from "bun:test"
import path from "node:path"

import { buildCliCompatibilityInventory, checkCliCompatibilityInventory } from "./arforge-cli-compat-inventory"

const root = path.resolve(import.meta.dir, "..")

test("TS CLI compatibility inventory owns the frozen Python migration boundary", async () => {
  const inventory = await buildCliCompatibilityInventory(root)
  const errors = await checkCliCompatibilityInventory(root, inventory)

  expect(errors).toEqual([])
  expect(inventory.schema_version).toBe(1)
  expect(inventory.canonical_runtime).toBe("typescript")
  expect(inventory.canonical_entry).toBe("packages/arforge/src/index.ts")
  expect(inventory.legacy_definition_count).toBe(106)
  expect(inventory.legacy_definitions).toHaveLength(106)
  expect(inventory.legacy_definitions.map((item) => item.name)).toContain("main")
  expect(inventory.frozen_compat_imports).toEqual([])
  expect(inventory.embedding_facade_exports).toEqual([
    "CliInvocationResult",
    "UnifiedCliUnavailable",
    "build_command",
    "invoke",
    "main",
    "resolve_unified_cli",
    "run",
  ])
})

test("TS inventory remains deterministic across repeated reads", async () => {
  const first = await buildCliCompatibilityInventory(root)
  const second = await buildCliCompatibilityInventory(root)
  expect(JSON.stringify(first)).toBe(JSON.stringify(second))
})

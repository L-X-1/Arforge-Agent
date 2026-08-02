import { expect, test } from "bun:test"
import { access } from "node:fs/promises"
import { readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import {
  CAPABILITY_METHOD_COUNT,
  legacyOwnership,
  NATIVE_METHOD_COUNT,
  NATIVE_VERTICALS,
  SEMANTIC_UI_GATES,
} from "../src/legacy-ownership"

const root = resolve(import.meta.dir, "../../..")
const python = join(root, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python")

test("assigns every full legacy Bridge method to exactly one unified runtime owner", async () => {
  const methods = await legacyMethods()
  const rows = methods.map((method) => ({ method, ownership: legacyOwnership(method) }))

  expect(methods.length).toBe(191)
  expect(new Set(methods).size).toBe(191)
  expect(rows.filter((row) => !row.ownership).map((row) => row.method)).toEqual([])
  expect(rows.filter((row) => row.ownership?.mode === "python-capability").length).toBe(CAPABILITY_METHOD_COUNT)
  expect(rows.filter((row) => row.ownership?.mode === "typescript-native").length).toBe(NATIVE_METHOD_COUNT)
  expect(CAPABILITY_METHOD_COUNT).toBe(61)
  expect(NATIVE_METHOD_COUNT).toBe(130)
  expect(rows.filter((row) => row.ownership?.coverage === "semantic-replacement").length).toBe(58)
  expect(rows.filter((row) => row.ownership?.coverage === "exact-api").length).toBe(133)

  const evidence = new Set(NATIVE_VERTICALS.flatMap((vertical) => vertical.evidence))
  for (const path of evidence) await access(resolve(root, path))

  const semanticMethods = new Set(
    NATIVE_VERTICALS.filter((vertical) => vertical.coverage === "semantic-replacement").flatMap(
      (vertical) => vertical.methods,
    ),
  )
  const gatedMethods = SEMANTIC_UI_GATES.flatMap((gate) => gate.methods)
  expect(gatedMethods.length).toBe(58)
  expect(new Set(gatedMethods)).toEqual(semanticMethods)
  for (const gate of SEMANTIC_UI_GATES) {
    for (const surface of gate.surfaces) {
      const source = await readFile(resolve(root, surface.file), "utf8")
      for (const marker of surface.markers) expect(source).toContain(marker)
    }
  }
})

async function legacyMethods() {
  await access(python)
  const script = [
    "import json",
    "from arforge.bridge import READ_ONLY_METHODS, SESSION_METHODS, ACTION_METHODS, TASK_METHODS, GOAL_METHODS, PRODUCT_METHODS, GIT_METHODS",
    "methods = {'protocol.describe'} | READ_ONLY_METHODS | SESSION_METHODS | ACTION_METHODS | TASK_METHODS | GOAL_METHODS | PRODUCT_METHODS | GIT_METHODS",
    "print(json.dumps(sorted(methods)))",
  ].join("; ")
  const child = Bun.spawn([python, "-c", script], {
    cwd: root,
    env: { ...process.env, PYTHONUTF8: "1" },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (code !== 0) throw new Error(stderr || `Legacy Bridge inspection failed with code ${code}`)
  return JSON.parse(stdout) as string[]
}

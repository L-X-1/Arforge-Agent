#!/usr/bin/env bun
import { fileURLToPath } from "url"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

import { $ } from "bun"
import { readFile, writeFile } from "node:fs/promises"
import path from "path"
import * as prettier from "prettier"

import { createClient } from "@hey-api/openapi-ts"

const arforge = path.resolve(dir, "../../arforge")

await $`bun dev generate > ${dir}/openapi.json`.cwd(arforge)

const document = (await Bun.file("./openapi.json").json()) as {
  components?: { schemas?: Record<string, unknown> }
  [key: string]: unknown
}
const schemas = document.components?.schemas
if (schemas) {
  const reachable = new Set<string>()
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    if (typeof value !== "object" || value === null) return
    for (const [key, child] of Object.entries(value)) {
      if (key === "$ref" && typeof child === "string" && child.startsWith("#/components/schemas/")) {
        const name = child.slice("#/components/schemas/".length)
        if (reachable.has(name)) continue
        reachable.add(name)
        visit(schemas[name])
      } else {
        visit(child)
      }
    }
  }
  visit({ ...document, components: { ...document.components, schemas: undefined } })
  for (const name of Object.keys(schemas)) {
    if (/^SessionNext\w+1$/.test(name) && !reachable.has(name)) delete schemas[name]
  }
  await Bun.write("./openapi.json", JSON.stringify(document))
}

await createClient({
  input: "./openapi.json",
  output: {
    path: "./src/v2/gen",
    tsConfigPath: path.join(dir, "tsconfig.json"),
    clean: true,
  },
  plugins: [
    {
      name: "@hey-api/typescript",
      exportFromIndex: false,
    },
    {
      name: "@hey-api/sdk",
      instance: "ArforgeClient",
      exportFromIndex: false,
      auth: false,
      paramsStructure: "flat",
    },
    {
      name: "@hey-api/client-fetch",
      exportFromIndex: false,
      baseUrl: "http://localhost:4096",
    },
  ],
})

const generatedTypesPath = "./src/v2/gen/types.gen.ts"
const generatedTypes = await readFile(generatedTypesPath, "utf8")
if (/export type SessionNext\w+1 =/.test(generatedTypes)) {
  throw new Error("Session history generated duplicate Session event variants")
}
const historyTypesPatched = generatedTypes.replace(
  /(export type V2SessionHistoryData = \{[\s\S]*?query\?: \{\s*limit\?: )string([;,]\s*after\?: )string/,
  "$1number$2number",
)
if (historyTypesPatched === generatedTypes) {
  throw new Error("Session history numeric query patch did not apply")
}
await writeFile(generatedTypesPath, historyTypesPatched, "utf8")

const generatedSdkPath = "./src/v2/gen/sdk.gen.ts"
const generatedSdk = await readFile(generatedSdkPath, "utf8")
const historySdkPatched = generatedSdk.replace(
  /(Get session history[\s\S]*?parameters: \{\s*sessionID: string[;,]\s*limit\?: )string([;,]\s*after\?: )string/,
  "$1number$2number",
)
if (historySdkPatched === generatedSdk) {
  throw new Error("Session history numeric SDK patch did not apply")
}
await writeFile(generatedSdkPath, historySdkPatched, "utf8")

// Patch a @hey-api/openapi-ts codegen bug: SseFn incorrectly passes the
// endpoint's TError into the second generic of ServerSentEventsResult, which
// is the AsyncGenerator's TReturn slot. Iterator return values have nothing
// to do with HTTP errors, and any consumer that calls `.return()` or returns
// from a mock generator gets type-checked against the wrong shape. Drop the
// arg so TReturn defaults to void.
const sseTypesPath = "./src/v2/gen/client/types.gen.ts"
const sseTypesSource = await readFile(sseTypesPath, "utf8")
const sseTypesPatched = sseTypesSource.replace(
  "=> Promise<ServerSentEventsResult<TData, TError>>",
  "=> Promise<ServerSentEventsResult<TData>>",
)
if (sseTypesPatched === sseTypesSource) {
  throw new Error(`SseFn patch did not apply; @hey-api/openapi-ts output may have changed (${sseTypesPath})`)
}
await writeFile(sseTypesPath, sseTypesPatched, "utf8")

// Format generated files in this process. A child Prettier process can race
// with @hey-api's Windows file handles and report UNKNOWN even though the
// generated source is valid; the in-process API avoids that false-negative.
const retryFileIO = async <T>(operation: () => Promise<T>): Promise<T> => {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation()
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : ""
      if (!new Set(["EBUSY", "EPERM", "EUNKNOWN"]).has(code) || attempt >= 4) throw error
      await new Promise((resolve) => setTimeout(resolve, 50 * 2 ** attempt))
    }
  }
}

const formatFiles = async (files: ReadonlyArray<string>) => {
  for (const file of files) {
    const source = await retryFileIO(() => readFile(file, "utf8"))
    const config = (await prettier.resolveConfig(file, { editorconfig: true })) ?? {}
    const formatted = await prettier.format(source, { ...config, filepath: file })
    if (formatted !== source) await retryFileIO(() => writeFile(file, formatted, "utf8"))
  }
}

const generatedFiles = (directory: string) =>
  Array.from(new Bun.Glob(`${directory}/**/*.ts`).scanSync())
    .map((file) => file.replaceAll("\\", "/"))
    .sort()
await formatFiles(generatedFiles("src/gen"))
await formatFiles(generatedFiles("src/v2"))
await $`rm -rf dist`
await $`bun tsc`
await $`rm openapi.json`

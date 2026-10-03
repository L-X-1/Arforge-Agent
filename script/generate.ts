#!/usr/bin/env bun

import { $ } from "bun"

await $`bun ./packages/sdk/js/script/build.ts`

// Capture and validate before opening the checked-in artifact. Shell redirection
// can fail on Windows and can truncate the previous schema before the child
// reports a generation failure.
const output = await $`bun dev generate`.cwd("packages/arforge").text()
const document = JSON.parse(output)
if (typeof document.openapi !== "string" || !document.paths || !document.components) {
  throw new Error("Arforge generate did not return an OpenAPI document")
}
await Bun.write(new URL("../packages/sdk/openapi.json", import.meta.url), JSON.stringify(document))

// Keep generation reproducible and scoped. The repository-wide formatter
// rewrites unrelated source files and invoking a TypeScript shebang directly
// is not portable on Windows.
await $`bun prettier --write packages/sdk/openapi.json`

#!/usr/bin/env bun
import { $ } from "bun"

// The generator process can retain a Windows handle to the large generated
// type file until it exits. Keep the normal build in its own process, then
// format that final file from this clean parent process.
await $`bun ./script/build.ts`
await $`bun prettier --write src/v2/gen/types.gen.ts`

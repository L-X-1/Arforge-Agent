import { $ } from "bun"

await $`bun ./scripts/copy-icons.ts ${process.env.ARFORGE_CHANNEL ?? "dev"}`

await $`cd ../arforge && bun script/build-node.ts`

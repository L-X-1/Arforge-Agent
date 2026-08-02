import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
const notice = `# Arforge

This translation is being refreshed after the Arforge architecture and distribution migration.

Use the canonical [README](./README.md) for verified build, configuration, goal, deferred-tool, and skill-routing instructions. Stale hosted-service and package-installation links have been removed intentionally.
`

let count = 0
for await (const file of new Bun.Glob("README.*.md").scan({ cwd: root, onlyFiles: true })) {
  await Bun.write(path.join(root, file), notice)
  count++
}

console.log(`Consolidated ${count} localized README files`)

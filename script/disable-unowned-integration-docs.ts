import path from "path"

const root = path.resolve(import.meta.dir, "..")
const apply = process.argv.includes("--apply")
const notices: Readonly<Record<string, string>> = {
  "github.mdx": `---
title: GitHub automation
description: GitHub application and Action coordinates are not configured in this source build.
---

# GitHub automation

The CLI and core contain reusable GitHub workflow logic, but this source build
does not assume ownership of a GitHub App, Action repository, webhook
installation, or release channel. The integration is unavailable by default
instead of pointing users at another publisher's infrastructure.

Enable this surface only after supplying an owned application identifier,
Action repository, permissions policy, webhook callback, and release support
process. Normal local Arforge use does not require this integration.
`,
}

let files = 0
for await (const relative of new Bun.Glob("packages/web/src/content/docs/**/*.mdx").scan({
  cwd: root,
  onlyFiles: true,
})) {
  const notice = notices[path.basename(relative)]
  if (!notice) continue
  const target = path.join(root, relative)
  if ((await Bun.file(target).text()) === notice) continue
  files++
  if (apply) await Bun.write(target, notice)
}

console.log(`${apply ? "Replaced" : "Would replace"} ${files} unowned integration guides`)
if (!apply) console.log("Run again with --apply after reviewing the scope")

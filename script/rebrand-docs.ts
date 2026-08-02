import path from "path"

const root = path.resolve(import.meta.dir, "..")
const apply = process.argv.includes("--apply")
const legacyProduct = ["Open", "Code"].join("")
const legacyCli = ["open", "code"].join("")
const legacyDomain = `https://${legacyCli}.ai`
const schemaPaths = ["/config.json", "/tui.json", "/theme.json"]
const ecosystemNotice = `---
title: Ecosystem
description: Arforge ecosystem entries are awaiting compatibility verification.
---

# Ecosystem

The previous catalog referenced third-party packages built for a different
product identity and compatibility contract. Those package names and links are
not relabeled as Arforge integrations.

An integration belongs here only after it has been tested against the Arforge
package scope, configuration paths, permission model, and current plugin API.
Until then, install third-party plugins only after reviewing their source,
permissions, release provenance, and supported Arforge version.
`

function rewrite(markdown: string) {
  const lines = markdown.split("\n").flatMap((line) => {
    if (schemaPaths.some((suffix) => line.includes(`${legacyDomain}${suffix}`))) return []
    const sourceInstall = `curl -fsSL ${legacyDomain}/install | bash`
    let next = line.replaceAll(sourceInstall, "bun install --frozen-lockfile")
    next = next.replaceAll(`${legacyDomain}/docs/`, "/docs/")
    next = next.replaceAll(`${legacyDomain}/docs`, "/docs")
    next = next.replaceAll(`${legacyDomain}/s/`, "/docs/share#")
    next = next.replaceAll(legacyDomain, "")
    next = next.replaceAll(legacyProduct, "Arforge")
    next = next.replaceAll(`${legacyCli}.jsonc`, "arforge.jsonc")
    next = next.replaceAll(`${legacyCli}.json`, "arforge.json")
    next = next.replaceAll(`.${legacyCli}`, ".arforge")
    next = next.replaceAll(`~/.config/${legacyCli}`, "~/.config/arforge")
    next = next.replaceAll(`~/.local/share/${legacyCli}`, "~/.local/share/arforge")
    next = next.replaceAll(`~/.cache/${legacyCli}`, "~/.cache/arforge")
    next = next.replaceAll(`%USERPROFILE%\\.config\\${legacyCli}`, "%USERPROFILE%\\.config\\arforge")
    next = next.replaceAll(`%USERPROFILE%\\.local\\share\\${legacyCli}`, "%USERPROFILE%\\.local\\share\\arforge")
    next = next.replaceAll(`%USERPROFILE%\\.cache\\${legacyCli}`, "%USERPROFILE%\\.cache\\arforge")
    next = next.replaceAll(`${legacyCli}.local`, "arforge.local")
    next = next.replaceAll(`/absolute/path/bin/${legacyCli}`, "/absolute/path/bin/arforge")
    if (!/https?:\/\//.test(next))
      next = next.replace(new RegExp(`(?<![\\w@./-])${legacyCli}(?![\\w./-])`, "g"), "arforge")
    return [next]
  })
  return lines.join("\n")
}

let files = 0
let occurrences = 0
for await (const relative of new Bun.Glob("packages/web/src/content/docs/**/*.mdx").scan({
  cwd: root,
  onlyFiles: true,
})) {
  const target = path.join(root, relative)
  const before = await Bun.file(target).text()
  const after = path.basename(target) === "ecosystem.mdx" ? ecosystemNotice : rewrite(before)
  if (after === before) continue
  files++
  occurrences += before.split(new RegExp(legacyCli, "gi")).length - 1
  if (apply) await Bun.write(target, after)
}

console.log(`${apply ? "Rebranded" : "Would rebrand"} ${files} documentation files (${occurrences} legacy occurrences)`)
if (!apply) console.log("Run again with --apply after reviewing the transformation")

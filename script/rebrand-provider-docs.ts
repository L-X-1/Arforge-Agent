import path from "path"

const root = path.resolve(import.meta.dir, "..")
const apply = process.argv.includes("--apply")
const legacyProduct = ["Open", "Code"].join("")
const legacyCli = ["open", "code"].join("")
const schemaUrl = `https://${legacyCli}.ai/config.json`

function removeHostedSection(markdown: string, name: string) {
  const lines = markdown.split("\n")
  const result: string[] = []
  let skipping = false
  for (const line of lines) {
    if (line.trim() === `## ${name}`) {
      skipping = true
      while (result.at(-1)?.trim() === "" || result.at(-1)?.trim() === "---") result.pop()
      continue
    }
    if (skipping && line.startsWith("## ")) {
      skipping = false
      result.push("", "---", "", line)
      continue
    }
    if (!skipping) result.push(line)
  }
  return result.join("\n")
}

let files = 0
let occurrences = 0
for await (const relative of new Bun.Glob("packages/web/src/content/docs/**/providers.mdx").scan({
  cwd: root,
  onlyFiles: true,
})) {
  const target = path.join(root, relative)
  const before = await Bun.file(target).text()
  let after = removeHostedSection(before, `${legacyProduct} Zen`)
  after = removeHostedSection(after, `${legacyProduct} Go`)
  after = after
    .split("\n")
    .filter((line) => !line.includes(schemaUrl))
    .join("\n")
    .replaceAll(legacyProduct, "Arforge")
    .replaceAll(legacyCli, "arforge")
  if (after === before) continue
  files++
  occurrences += before.split(new RegExp(legacyCli, "gi")).length - 1
  if (apply) await Bun.write(target, after)
}

console.log(`${apply ? "Rebranded" : "Would rebrand"} ${files} provider guides (${occurrences} legacy occurrences)`)
if (!apply) console.log("Run again with --apply after reviewing the transformation")

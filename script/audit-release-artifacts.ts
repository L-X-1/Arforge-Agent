import { readFile } from "node:fs/promises"

const artifacts = [
  "packages/desktop/dist/win-unpacked/resources/app.asar",
  "packages/desktop/dist/arforge-desktop-win-x64.exe",
  "packages/arforge/dist/arforge-windows-x64/bin/arforge.exe",
]

const formerProduct = "\u006f\u0070\u0065\u006e\u0063\u006f\u0064\u0065"
const retired = ["github-copilot", "github-models", "api.githubcopilot.com", `${formerProduct}.ai`]
const word = Buffer.from(formerProduct)
const alphaNumeric = (value: number | undefined) =>
  value !== undefined &&
  ((value >= 48 && value <= 57) || (value >= 65 && value <= 90) || (value >= 97 && value <= 122) || value === 95)

function containsRetiredProduct(input: Buffer) {
  const lower = Buffer.from(input.toString("latin1").toLowerCase(), "latin1")
  const hits = retired.filter((item) => lower.includes(item))

  for (let offset = lower.indexOf(word); offset !== -1; offset = lower.indexOf(word, offset + 1)) {
    const before = offset === 0 ? undefined : lower[offset - 1]
    const after = offset + word.length >= lower.length ? undefined : lower[offset + word.length]
    if (!alphaNumeric(before) && !alphaNumeric(after)) {
      hits.push(formerProduct)
      break
    }
  }
  return hits
}

const failures = []
for (const artifact of artifacts) {
  const hits = containsRetiredProduct(await readFile(artifact))
  console.log(JSON.stringify({ artifact, retiredProductHits: hits }))
  if (hits.length) failures.push({ artifact, hits })
}

if (failures.length) {
  console.error(JSON.stringify({ failures }))
  process.exitCode = 1
}

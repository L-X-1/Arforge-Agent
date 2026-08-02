import { $ } from "bun"
import semver from "semver"
import path from "path"

const rootPkgPath = path.resolve(import.meta.dir, "../../../package.json")
const rootPkg = await Bun.file(rootPkgPath).json()
const expectedBunVersion = rootPkg.packageManager?.split("@")[1]

if (!expectedBunVersion) {
  throw new Error("packageManager field not found in root package.json")
}

// relax version requirement
const expectedBunVersionRange = `^${expectedBunVersion}`

if (!semver.satisfies(process.versions.bun, expectedBunVersionRange)) {
  throw new Error(`This script requires bun@${expectedBunVersionRange}, but you are using bun@${process.versions.bun}`)
}

const env = {
  ARFORGE_CHANNEL: process.env["ARFORGE_CHANNEL"],
  ARFORGE_BUMP: process.env["ARFORGE_BUMP"],
  ARFORGE_VERSION: process.env["ARFORGE_VERSION"],
  ARFORGE_RELEASE: process.env["ARFORGE_RELEASE"],
}
const PRIVATE_VERSION = "1.0.0-test.1"
const CHANNEL = await (async () => {
  if (env.ARFORGE_CHANNEL) return env.ARFORGE_CHANNEL
  if (env.ARFORGE_BUMP) return "latest"
  if (env.ARFORGE_VERSION && !env.ARFORGE_VERSION.startsWith("0.0.0-")) return "latest"
  const result = await $`git branch --show-current`.quiet().nothrow()
  return result.exitCode === 0 ? result.stdout.toString().trim() || "local" : "local"
})()
const IS_PREVIEW = CHANNEL !== "latest"

const VERSION = await (async () => {
  if (env.ARFORGE_VERSION) return env.ARFORGE_VERSION
  return PRIVATE_VERSION
})()

const bot = ["actions-user", "arforge", "arforge-agent[bot]"]
const teamPath = path.resolve(import.meta.dir, "../../../.github/TEAM_MEMBERS")
const teamSource = await Bun.file(teamPath)
  .text()
  .catch(() => "")
const team = [
  ...teamSource
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter((x) => x && !x.startsWith("#")),
  ...bot,
]

export const Script = {
  get channel() {
    return CHANNEL
  },
  get version() {
    return VERSION
  },
  get preview() {
    return IS_PREVIEW
  },
  get release(): boolean {
    return !!env.ARFORGE_RELEASE
  },
  get team() {
    return team
  },
}
console.log(`arforge script`, JSON.stringify(Script, null, 2))

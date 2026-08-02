import path from "node:path"

type Gate = {
  readonly name: string
  readonly args: readonly string[]
}

const gates: readonly Gate[] = [
  { name: "repository fusion boundary", args: ["run", "fusion:audit"] },
  { name: "private brand boundary", args: ["run", "brand:check"] },
  { name: "legacy capability ownership", args: ["run", "fusion:capabilities"] },
  { name: "workspace type safety", args: ["run", "typecheck"] },
]

const bun = process.execPath
const env = {
  ...process.env,
  PATH: `${path.dirname(bun)}${path.delimiter}${process.env.PATH ?? ""}`,
}

for (const gate of gates) {
  console.log(`\n==> ${gate.name}`)
  const child = Bun.spawn({
    cmd: [bun, ...gate.args],
    cwd: path.resolve(import.meta.dir, ".."),
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })
  const code = await child.exited
  if (code !== 0) {
    console.error(`Fusion verification failed at "${gate.name}" with exit code ${code}`)
    process.exit(code)
  }
}

console.log("\nFusion verification passed.")
console.log("Release packaging, signing, publishing, hosted documentation and public deployment are intentionally out of scope.")

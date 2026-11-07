import { cp, mkdir, readFile, realpath, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"

type Package = {
  name: string
  version: string
  type?: string
  exports?: Record<string, string>
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

const plugin = fileURLToPath(new URL("../../plugin/", import.meta.url))

export function runtimeExports(exports: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(exports).map(([name, source]) => [
      name,
      {
        types: source.replace("./src/", "./types/"),
        default: source.replace("./src/", "./runtime/").replace(/\.tsx?$/, ".js"),
      },
    ]),
  )
}

/** A real distributable SDK, including its dependency closure, not a QA profile seed. */
export async function buildPluginSDK(output: string, version: string) {
  await compileWorkspace(plugin, output, version, new Set())
}

async function compileWorkspace(source: string, output: string, version: string, ancestors: Set<string>) {
  const pkg = JSON.parse(await readFile(path.join(source, "package.json"), "utf8")) as Package
  if (!pkg.exports) throw new Error(`SDK package ${pkg.name} has no public exports`)
  await mkdir(output, { recursive: true })
  const result = await Bun.build({
    entrypoints: Object.values(pkg.exports).map((entry) => path.join(source, entry)),
    root: path.join(source, "src"),
    outdir: path.join(output, "runtime"),
    target: "node",
    format: "esm",
    naming: "[dir]/[name].js",
  })
  if (!result.success) throw new AggregateError(result.logs, `Could not compile ${pkg.name}`)
  await cp(path.join(source, "src"), path.join(output, "types"), {
    recursive: true,
    filter: (entry) => !/\.(test|spec)\.[cm]?[jt]sx?$/.test(entry),
  })
  const dependencies = { ...pkg.dependencies }
  const resolved: Record<string, string> = {}
  const lineage = new Set(ancestors).add(await realpath(source))
  for (const name of Object.keys(dependencies)) {
    const dependency = await packageDirectory(name, source)
    const metadata = JSON.parse(await readFile(path.join(dependency, "package.json"), "utf8")) as Package
    resolved[name] = name.startsWith("@arforge-ai/") ? version : metadata.version
    await copyDependency(dependency, path.join(output, "node_modules", name), version, lineage)
  }
  await writeFile(
    path.join(output, "package.json"),
    JSON.stringify(
      {
        name: pkg.name,
        version,
        type: "module",
        private: true,
        exports: runtimeExports(pkg.exports),
        dependencies: resolved,
        bundledDependencies: Object.keys(resolved),
        peerDependencies: pkg.peerDependencies,
        peerDependenciesMeta: pkg.peerDependenciesMeta,
      },
      null,
      2,
    ) + "\n",
  )
}

async function copyDependency(source: string, output: string, version: string, ancestors: Set<string>) {
  const canonical = await realpath(source)
  if (ancestors.has(canonical)) return
  const pkg = JSON.parse(await readFile(path.join(source, "package.json"), "utf8")) as Package
  if (pkg.name.startsWith("@arforge-ai/")) return compileWorkspace(source, output, version, ancestors)
  await cp(source, output, {
    recursive: true,
    dereference: true,
    filter: (entry) => {
      const relative = path.relative(source, entry).split(path.sep)
      return !relative.includes("node_modules") && !relative.includes(".git")
    },
  })
  const lineage = new Set(ancestors).add(canonical)
  for (const name of Object.keys(pkg.dependencies ?? {})) {
    await copyDependency(
      await packageDirectory(name, source),
      path.join(output, "node_modules", name),
      version,
      lineage,
    )
  }
}

async function packageDirectory(name: string, source: string) {
  const require = createRequire(path.join(await realpath(source), "package.json"))
  for (const parent of require.resolve.paths(name) ?? []) {
    const directory = path.join(parent, name)
    try {
      const pkg = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8")) as Package
      if (pkg.name === name) return directory
    } catch {}
  }
  throw new Error(`Cannot locate bundled SDK dependency ${name}`)
}

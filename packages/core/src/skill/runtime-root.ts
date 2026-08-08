import { existsSync } from "node:fs"
import { dirname, join, parse } from "node:path"

/**
 * Locate the repository root that owns both the Python package and the
 * development virtualenv. Product entrypoints provide the canonical runtime
 * root explicitly; repository-local servers/tests start inside a package
 * directory, so this walks upward to the first matching directory.
 */
export function findDevelopmentRuntimeRoot(start: string) {
  let current = start
  const python = process.platform === "win32" ? ["Scripts", "python.exe"] : ["bin", "python"]

  while (true) {
    if (existsSync(join(current, "arforge", "__init__.py")) && existsSync(join(current, ".venv", ...python))) {
      return current
    }

    const parent = dirname(current)
    if (parent === current || current === parse(current).root) return start
    current = parent
  }
}

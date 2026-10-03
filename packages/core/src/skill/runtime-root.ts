import { existsSync } from "node:fs"
import { dirname, join, parse } from "node:path"

/**
 * Locate the repository/resource root that owns the bundled Agent skills.
 *
 * Older versions required both `arforge/__init__.py` and a development
 * `.venv/python` executable here. The TypeScript runtime only needs the
 * resource bundle, and making Python a prerequisite caused a clean TS or
 * packaged desktop install to silently lose the bundled skills. Product
 * entrypoints still provide `ARFORGE_AGENT_RUNTIME_ROOT` explicitly when a
 * packaged `_internal` resource root is used; repository-local servers/tests
 * start inside a package directory, so this walks upward to the first bundle.
 */
export function findDevelopmentRuntimeRoot(start: string) {
  let current = start
  const bundle = ["arforge", "bundled_skills", "agent_skills", "skills"]

  while (true) {
    if (existsSync(join(current, ...bundle))) return current

    const parent = dirname(current)
    if (parent === current || current === parse(current).root) return start
    current = parent
  }
}

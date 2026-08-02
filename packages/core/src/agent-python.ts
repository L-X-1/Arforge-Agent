export * as AgentPython from "./agent-python"

import {
  PythonBridgeClient,
  PythonBridgeError,
  type PythonBridgeOptions,
  type ManagementMethod,
  type ReadOnlyMethod,
} from "@arforge-ai/agent-python"
import { Context, Effect, Layer } from "effect"
import { existsSync } from "node:fs"
import { dirname, join, parse } from "node:path"
import { makeLocationNode } from "./effect/app-node"
import { Location } from "./location"

export interface Interface {
  readonly call: <T = unknown>(
    method: ReadOnlyMethod,
    params?: Readonly<Record<string, unknown>>,
    options?: { readonly timeoutMs?: number; readonly signal?: AbortSignal },
  ) => Effect.Effect<T, PythonBridgeError>
  readonly mutate: <T = unknown>(
    method: ManagementMethod,
    params?: Readonly<Record<string, unknown>>,
    options?: { readonly timeoutMs?: number; readonly signal?: AbortSignal },
  ) => Effect.Effect<T, PythonBridgeError>
}

export class Service extends Context.Service<Service, Interface>()("@arforge/AgentPython") {}

/**
 * Provides the existing Python Agent as a bounded local capability service.
 *
 * This layer exposes the complete Bridge surface classified as read-only.
 * Workspace writes, product sessions, approvals and tool execution remain owned
 * by the TypeScript Core until each mutating vertical slice has an explicit
 * shared permission and persistence contract.
 */
export function layer(options: PythonBridgeOptions) {
  return Layer.effect(
    Service,
    Effect.acquireRelease(
      Effect.sync(() => {
        const client = new PythonBridgeClient(options)
        return {
          client,
          service: Service.of({
            call: <T>(
              method: ReadOnlyMethod,
              params: Readonly<Record<string, unknown>> = {},
              callOptions: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {},
            ) =>
              Effect.tryPromise({
                try: () => client.call<T>(method, params, callOptions),
                catch: asBridgeError,
              }),
            mutate: <T>(
              method: ManagementMethod,
              params: Readonly<Record<string, unknown>> = {},
              callOptions: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {},
            ) =>
              Effect.tryPromise({
                try: () => client.mutate<T>(method, params, callOptions),
                catch: asBridgeError,
              }),
          }),
        }
      }),
      ({ client }) => Effect.promise(() => client.close()),
    ).pipe(Effect.map(({ service }) => service)),
  )
}

export type LocationOptions = Omit<PythonBridgeOptions, "workspace">

/**
 * Binds one capability process to one Core location. The product runtime and
 * selected workspace are intentionally separate so arbitrary user projects do
 * not need to contain Arforge's Python package or virtual environment.
 */
export function locationLayer(options: LocationOptions = {}) {
  return Layer.unwrap(
    Effect.map(Location.Service, (location) =>
      layer({
        ...options,
        workspace: location.directory,
      }),
    ),
  )
}

// Bundlers relocate this module, and Node/Electron do not implement Bun's
// `import.meta.dir`. Product entrypoints therefore provide the canonical
// Python runtime root explicitly. Repository-local servers/tests may start
// inside a package directory, so their fallback walks upward to the first
// directory that owns both the Python package and development virtualenv.
const productRoot = process.env.ARFORGE_AGENT_RUNTIME_ROOT || findDevelopmentRuntimeRoot(process.cwd())

export const node = makeLocationNode({
  service: Service,
  layer: locationLayer({
    runtimeRoot: productRoot,
    pythonExecutable: process.env.ARFORGE_AGENT_PYTHON || undefined,
    home: process.env.ARFORGE_HOME || undefined,
  }),
  deps: [Location.node],
})

function asBridgeError(error: unknown) {
  if (error instanceof PythonBridgeError) return error
  if (error instanceof Error) return new PythonBridgeError("BRIDGE_FAILURE", error.message, error)
  return new PythonBridgeError("BRIDGE_FAILURE", String(error))
}

function findDevelopmentRuntimeRoot(start: string) {
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

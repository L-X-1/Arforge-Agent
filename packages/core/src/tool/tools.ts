export * as Tools from "./tools"

import { Context, Effect, Scope } from "effect"
import { Tool } from "./tool"

export interface Interface {
  readonly register: (
    tools: Readonly<Record<string, Tool.AnyTool>>,
  ) => Effect.Effect<void, Tool.RegistrationError, Scope.Scope>
}

/** Narrow registration-only Location capability. */
export class Service extends Context.Service<Service, Interface>()("@arforge/v2/Tools") {}

/**
 * Trusted built-in registration view. The registry layer binds this service
 * to a registry-owned capability that is minted inside the layer closure and
 * never exported; the service is installed only into built-in layer
 * construction by the runtime composition root (node `deps`), so normal
 * untrusted registration paths can never self-identify as a built-in.
 * `register` here is the trusted path: the registry rejects forged
 * capability values at runtime and refuses to mint trust for names outside
 * the exhaustive declared built-in set. This is not process isolation
 * against arbitrary hostile in-process code that composes `builtInsNode`
 * itself.
 */
export interface BuiltInsInterface {
  readonly register: (
    tools: Readonly<Record<string, Tool.AnyTool>>,
  ) => Effect.Effect<void, Tool.RegistrationError, Scope.Scope>
}

export class BuiltIns extends Context.Service<BuiltIns, BuiltInsInterface>()("@arforge/v2/Tools.BuiltIns") {}

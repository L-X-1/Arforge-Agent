export * as ToolRegistry from "./registry"

import { ToolOutput, type ToolCall, type ToolDefinition, type ToolResultValue } from "@arforge-ai/llm"
import { Context, Effect, Layer, Schema, Scope } from "effect"
import { AgentV2 } from "../agent"
import { PermissionV2 } from "../permission"
import { SessionMessage } from "../session/message"
import { SessionSchema } from "../session/schema"
import { ToolOutputStore } from "../tool-output-store"
import { Wildcard } from "../util/wildcard"
import { ApplicationTools } from "./application-tools"
import { definition, permission, settle, validateName, type AnyTool, type RegistrationError } from "./tool"
import { Tools } from "./tools"
import { makeLocationNode } from "../effect/app-node"
import { DeferredTools } from "./deferred"
import { RuntimeInsight } from "../runtime/insight"

export type ExecuteInput = {
  readonly sessionID: SessionSchema.ID
  readonly agent: AgentV2.ID
  readonly assistantMessageID: SessionMessage.ID
  readonly call: ToolCall
}

export interface Interface {
  readonly materialize: (
    permissions?: PermissionV2.Ruleset,
    sessionID?: SessionSchema.ID,
  ) => Effect.Effect<Materialization>
  readonly discover: (input: {
    readonly sessionID: SessionSchema.ID
    readonly query: string
    readonly limit: number
  }) => Effect.Effect<{
    readonly tools: ReadonlyArray<{
      readonly name: string
      readonly description: string
      readonly inputSchema: Readonly<Record<string, unknown>>
      readonly outputSchema?: Readonly<Record<string, unknown>>
    }>
    readonly activated: ReadonlyArray<string>
  }, DiscoverError>
  /** Internal registration capability exposed publicly only through Tools.Service. */
  readonly register: (tools: Readonly<Record<string, AnyTool>>) => Effect.Effect<void, RegistrationError, Scope.Scope>
}

export interface Materialization {
  readonly definitions: ReadonlyArray<ToolDefinition>
  readonly settle: (input: ExecuteInput) => Effect.Effect<Settlement, ToolOutputStore.Error>
}

export interface Settlement {
  readonly result: ToolResultValue
  readonly output?: ToolOutput
  readonly outputPaths?: ReadonlyArray<string>
}

export class Service extends Context.Service<Service, Interface>()("@arforge/v2/ToolRegistry") {}

export class DiscoverError extends Schema.TaggedErrorClass<DiscoverError>()("ToolRegistry.DiscoverError", {
  message: Schema.String,
}) {}

const registryLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const applications = yield* ApplicationTools.Service
    const resources = yield* ToolOutputStore.Service
    const deferred = yield* DeferredTools.Service
    type Registration = { readonly identity: object; readonly tool: AnyTool }
    const local = new Map<string, Array<{ readonly token: object; readonly registration: Registration }>>()

    const settleWith = Effect.fn("ToolRegistry.settle")(function* (input: ExecuteInput, advertised?: object) {
      const registration =
        local.get(input.call.name)?.at(-1)?.registration ?? applications.entries().get(input.call.name)
      if (!registration)
        return {
          result: {
            type: "error" as const,
            value: advertised ? `Stale tool call: ${input.call.name}` : `Unknown tool: ${input.call.name}`,
          },
        }
      if (advertised && registration.identity !== advertised)
        return { result: { type: "error" as const, value: `Stale tool call: ${input.call.name}` } }
      RuntimeInsight.auditRecord({
        actor: "agent",
        action: "tool.execute.start",
        resource: input.call.name,
        metadata: {
          sessionID: input.sessionID,
          agent: input.agent,
          assistantMessageID: input.assistantMessageID,
          toolCallID: input.call.id,
        },
      })
      const pending = yield* settle(registration.tool, input.call, {
        sessionID: input.sessionID,
        agent: input.agent,
        assistantMessageID: input.assistantMessageID,
        toolCallID: input.call.id,
      }).pipe(
        Effect.map((output) => ({ output })),
        Effect.catchTag("LLM.ToolFailure", (failure) =>
          Effect.succeed({ result: { type: "error" as const, value: failure.message } }),
        ),
        Effect.tap((result) =>
          Effect.sync(() => {
            RuntimeInsight.auditRecord({
              actor: "agent",
              action: "tool.execute.end",
              resource: input.call.name,
              reason: "result" in result && result.result.type === "error" ? "error" : "success",
              metadata: {
                sessionID: input.sessionID,
                toolCallID: input.call.id,
                status: "result" in result ? result.result.type : "success",
              },
            })
          }),
        ),
      )
      if ("result" in pending) return pending
      const output = pending.output
      const bounded = yield* resources.bound({ sessionID: input.sessionID, toolCallID: input.call.id, output })
      const result = ToolOutput.toResultValue(bounded.output)
      if (result.type === "error")
        return bounded.outputPaths.length > 0 ? { result, outputPaths: bounded.outputPaths } : { result }
      return bounded.outputPaths.length > 0
        ? { result, output: bounded.output, outputPaths: bounded.outputPaths }
        : { result, output: bounded.output }
    })

    return Service.of({
      register: Effect.fn("ToolRegistry.register")(function* (tools) {
        const entries = Object.entries(tools)
        if (entries.length === 0) return
        yield* Effect.forEach(entries, ([name]) => validateName(name), { discard: true })
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const token = {}
            for (const [name, tool] of entries)
              local.set(name, [...(local.get(name) ?? []), { token, registration: { identity: {}, tool } }])
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                for (const [name] of entries) {
                  const registrations = local.get(name)?.filter((registration) => registration.token !== token) ?? []
                  if (registrations.length > 0) local.set(name, registrations)
                  else local.delete(name)
                }
              }),
            )
          }),
        )
      }),
      materialize: Effect.fn("ToolRegistry.materialize")(function* (permissions = [], sessionID) {
        if (sessionID) yield* deferred.setPermissions(sessionID, permissions)
        const registrations = new Map(applications.entries())
        for (const [name, entries] of local) {
          const registration = entries.at(-1)?.registration
          if (registration) registrations.set(name, registration)
        }
        for (const [name, registration] of registrations)
          if (whollyDisabled(permission(registration.tool, name), permissions)) registrations.delete(name)
        for (const [name] of registrations)
          if (!deferred.visible(sessionID, name)) registrations.delete(name)
        return {
          definitions: Array.from(registrations, ([name, registration]) => definition(name, registration.tool)),
          settle: (input) => {
            const registration = registrations.get(input.call.name)
            if (registration) return settleWith(input, registration.identity)
            return Effect.succeed({ result: { type: "error", value: `Unknown tool: ${input.call.name}` } })
          },
        }
      }),
      discover: Effect.fn("ToolRegistry.discover")(function* (input) {
        if (!deferred.enabled()) return yield* new DiscoverError({ message: "Deferred tool loading is disabled" })
        const registrations = new Map(applications.entries())
        for (const [name, entries] of local) {
          const registration = entries.at(-1)?.registration
          if (registration) registrations.set(name, registration)
        }
        for (const [name, registration] of registrations)
          if (whollyDisabled(permission(registration.tool, name), deferred.permissions(input.sessionID)))
            registrations.delete(name)
        const exact = input.query.startsWith("select:")
          ? input.query
              .slice("select:".length)
              .split(",")
              .map((name) => name.trim())
              .filter(Boolean)
          : undefined
        const terms = exact
          ? []
          : input.query
              .toLowerCase()
              .split(/\s+/)
              .map((term) => ({ required: term.startsWith("+"), value: term.replace(/^\+/, "") }))
              .filter((term) => term.value.length > 0)
        const matches = Array.from(registrations, ([name, registration]) => {
          const tool = definition(name, registration.tool)
          const text = `${name} ${tool.description}`.toLowerCase()
          if (name === "tool_search") return
          if (exact && !exact.includes(name)) return
          if (terms.some((term) => term.required && !text.includes(term.value))) return
          if (!exact && terms.length > 0 && !terms.some((term) => text.includes(term.value))) return
          const score = exact
            ? exact.indexOf(name)
            : terms.reduce(
                (total, term) =>
                  total +
                  (name === term.value ? 100 : name.startsWith(term.value) ? 50 : name.includes(term.value) ? 25 : text.includes(term.value) ? 5 : 0),
                0,
              )
          return {
            name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            outputSchema: tool.outputSchema,
            score,
          }
        })
          .filter(
            (
              match,
            ): match is {
              name: string
              description: string
              inputSchema: Readonly<Record<string, unknown>>
              outputSchema: Readonly<Record<string, unknown>> | undefined
              score: number
            } => match !== undefined,
          )
          .toSorted((a, b) => b.score - a.score || a.name.localeCompare(b.name))
          .slice(0, input.limit)
        if (exact && matches.length !== exact.length)
          return yield* new DiscoverError({ message: "One or more selected tools are unavailable" })
        yield* deferred.activate(input.sessionID, matches.map((match) => match.name))
        return {
          tools: matches.map(({ name, description, inputSchema, outputSchema }) => ({
            name,
            description,
            inputSchema,
            outputSchema,
          })),
          activated: matches.map((match) => match.name),
        }
      }),
    })
  }),
)

const layer = Layer.effect(
  Tools.Service,
  Service.use((registry) => Effect.succeed(Tools.Service.of({ register: registry.register }))),
).pipe(Layer.provideMerge(registryLayer))

function whollyDisabled(action: string, rules: PermissionV2.Ruleset) {
  const rule = rules.findLast((rule) => Wildcard.match(action, rule.action))
  return rule?.resource === "*" && rule.effect === "deny"
}

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [ApplicationTools.node, ToolOutputStore.node, DeferredTools.node],
})

export const toolsNode = makeLocationNode({
  service: Tools.Service,
  layer,
  deps: [ApplicationTools.node, ToolOutputStore.node, DeferredTools.node],
})

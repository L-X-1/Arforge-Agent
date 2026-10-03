export * as TurnToolCarrier from "./turn-carrier"

import type { ActionGateway } from "../action-gateway"
import type { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { Effect, Schema } from "effect"
import type { Tool } from "./tool"

export const scheduledTaskName = "task"
export const userAttachmentReadName = "read_user_attachment"
export const names: ReadonlyArray<string> = Object.freeze([scheduledTaskName, userAttachmentReadName])

const nameSet = new Set(names)

/** These names are reserved for opaque per-turn carriers, never normal registration. */
export const isName = (name: string) => nameSet.has(name)

export class InvalidCarrierError extends Schema.TaggedErrorClass<InvalidCarrierError>()(
  "ToolTurnCarrier.InvalidCarrierError",
  { carrier: Schema.String },
) {}

const userAttachmentReads = new WeakMap<UserAttachmentRead, Tool.AnyTool>()

/**
 * Exhaustive mature built-in names allowed to temporarily shadow the matching
 * Core registration while the desktop loop is migrated. This is deliberately
 * finite: arbitrary external names remain untrusted and can never acquire a
 * built-in authorization plan through this compatibility carrier.
 */
export const legacySessionBuiltInNames: ReadonlyArray<string> = Object.freeze([
  "invalid",
  "question",
  "bash",
  "read",
  "glob",
  "grep",
  "edit",
  "write",
  "task",
  "webfetch",
  "todowrite",
  "websearch",
  "skill",
  "apply_patch",
  "execute",
  "lsp",
  "plan_exit",
])

const legacySessionBuiltInNameSet = new Set(legacySessionBuiltInNames)

export type LegacySessionAuthorizationResolver = (input: {
  readonly name: string
  readonly input: Readonly<Record<string, unknown>>
  readonly semantics: AgentRuntime.EffectSemantics
}) => Effect.Effect<ActionGateway.AuthorizationPlan | undefined>

export type LegacySessionToolEntry = {
  readonly name: string
  readonly tool: Tool.AnyTool
  readonly trusted: boolean
  readonly authorization: LegacySessionAuthorizationResolver
}

const legacySessionTools = new WeakMap<LegacySessionTools, ReadonlyArray<LegacySessionToolEntry>>()

/**
 * Opaque carrier for reading a file the user explicitly attached to this
 * turn. It is distinct from the model-visible read tool because the durable
 * user message is already the exact authorization for that one attachment.
 */
export class UserAttachmentRead {
  private constructor() {}

  static make(tool: Tool.AnyTool) {
    const carrier = Object.freeze(new UserAttachmentRead())
    userAttachmentReads.set(carrier, tool)
    return carrier
  }
}

/**
 * Opaque per-provider-turn snapshot for the mature desktop tool set. Trusted
 * entries are restricted to the explicit migration allowlist above; external
 * entries remain untrusted even though they share the same immutable snapshot.
 * The registry interprets the payload and is still the only executor owner.
 */
export class LegacySessionTools {
  private constructor() {}

  static make(entries: ReadonlyArray<LegacySessionToolEntry>) {
    const names = new Set<string>()
    const snapshot = entries.map((entry) => {
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(entry.name) || names.has(entry.name))
        throw new InvalidCarrierError({ carrier: "legacy-session-tools" })
      if (entry.trusted !== legacySessionBuiltInNameSet.has(entry.name))
        throw new InvalidCarrierError({ carrier: "legacy-session-tools" })
      names.add(entry.name)
      return Object.freeze({ ...entry })
    })
    const carrier = Object.freeze(new LegacySessionTools())
    legacySessionTools.set(carrier, Object.freeze(snapshot))
    return carrier
  }
}

export function userAttachmentReadTool(carrier: UserAttachmentRead) {
  const tool = userAttachmentReads.get(carrier)
  if (!tool) throw new InvalidCarrierError({ carrier: "user-attachment-read" })
  return tool
}

export function legacySessionToolEntries(carrier: LegacySessionTools) {
  const entries = legacySessionTools.get(carrier)
  if (!entries) throw new InvalidCarrierError({ carrier: "legacy-session-tools" })
  return entries
}

import type { Prompt } from "@arforge-ai/schema/prompt"
import { canonicalHash } from "../util/canonical-hash"
import type { LayerInput } from "../runtime/compiler"

export type Binding = Readonly<{
  readonly messageID: string
  readonly system: Prompt["system"] | undefined
}>

const hashOrThrow = (value: unknown, label: string) => {
  const result = canonicalHash(value)
  if (!result) throw new TypeError(`${label} is not canonically hashable`)
  return result
}

/** Digest the complete durable prompt, including route, command and system. */
export const promptDigest = (prompt: Prompt) => hashOrThrow(prompt, "Durable prompt")

/**
 * Project one request-scoped system instruction into the existing context
 * compiler. It remains runtime input, is bound to one message identity, and is
 * appended by the runner after all longer-lived system layers.
 */
export const layer = (input: Binding): LayerInput | undefined => {
  if (!input.system) return undefined
  return {
    layer: "L6",
    name: "requestSystem",
    text: input.system.text,
    origin: "request",
    contextLayer: "current_request",
    authority: "runtime-input",
    trust: "trusted",
    mandatory: true,
    priority: 100,
    unitID: `request-system:${input.messageID}`,
    sourceDigest: hashOrThrow({ messageID: input.messageID, system: input.system }, "Request system instruction"),
    instructionAllowed: true,
  }
}

export * as PromptSystem from "./prompt-system"

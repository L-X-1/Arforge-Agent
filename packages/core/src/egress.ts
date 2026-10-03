export * as Egress from "./egress"

import { Effect } from "effect"

export type HttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS"

export class Violation extends Error {
  override readonly name = "Arforge.EgressViolation"

  constructor(
    readonly reason: string,
    readonly request: {
      readonly url: string
      readonly method: string
      readonly credentialScope: ReadonlyArray<string>
      readonly redirectFrom?: string
    },
  ) {
    super(reason)
  }
}

export interface Authorizer {
  readonly assert: (input: {
    readonly url: string
    readonly method: HttpMethod
    readonly credentialScope?: ReadonlyArray<string>
    readonly redirectFrom?: string
  }) => Effect.Effect<void, Violation>
  /** Guards shell/process actions whose network target cannot be statically extracted. */
  readonly assertProcess?: (input: { readonly command: string }) => Effect.Effect<void, Violation>
}

export interface Policy {
  readonly action: string
  readonly networkScope: ReadonlyArray<string>
  readonly secretScope: ReadonlyArray<string>
  readonly allowedMethods: ReadonlyArray<HttpMethod>
  /** Exact resources granted by the parent action. An omitted list is a local integration policy. */
  readonly grantedResources?: ReadonlyArray<string>
}

const normalizeOrigin = (value: string) => {
  try {
    const url = new URL(value)
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined
    return url.origin.toLowerCase()
  } catch {
    return undefined
  }
}

const redactTarget = (value: string) => {
  try {
    const url = new URL(value)
    for (const key of url.searchParams.keys()) url.searchParams.set(key, "[REDACTED_SECRET]")
    return url.toString()
  } catch {
    return "[REDACTED_TARGET]"
  }
}

const requestRecord = (input: Parameters<Authorizer["assert"]>[0]) => ({
  url: redactTarget(input.url),
  method: input.method,
  credentialScope: [...(input.credentialScope ?? [])],
  ...(input.redirectFrom === undefined ? {} : { redirectFrom: redactTarget(input.redirectFrom) }),
})

const fail = (reason: string, input: Parameters<Authorizer["assert"]>[0]) =>
  Effect.fail(new Violation(reason, requestRecord(input)))

/**
 * Builds the leaf-only egress guard. Host checks intentionally use origin
 * rather than a caller-provided URL prefix, so a path such as
 * `https://allowed.example.evil/` cannot satisfy an allowed scope.
 * Redirects are re-checked by passing `redirectFrom` to the same assertion.
 */
export const make = (policy: Policy): Authorizer => ({
  assert: (input) => {
    const method = input.method.toUpperCase() as HttpMethod
    if (!policy.allowedMethods.includes(method))
      return fail(`HTTP method ${method} is outside the ${policy.action} egress policy`, input)

    const origin = normalizeOrigin(input.url)
    if (!origin) return fail("HTTP egress requires an http:// or https:// target", input)

    const allowedOrigins = policy.networkScope.flatMap((scope) => {
      const parsed = normalizeOrigin(scope)
      return parsed ? [parsed] : []
    })
    if (!allowedOrigins.includes(origin))
      return fail(`HTTP target origin ${origin} is outside the ${policy.action} egress scope`, input)

    if (input.redirectFrom !== undefined) {
      const redirectOrigin = normalizeOrigin(input.redirectFrom)
      if (!redirectOrigin || !allowedOrigins.includes(redirectOrigin))
        return fail("HTTP redirect source is outside the egress scope", input)
    }

    const credentials = [...(input.credentialScope ?? [])]
    for (const credential of credentials) {
      if (!policy.secretScope.includes(credential))
        return fail(`Credential scope ${credential} is not declared by the egress policy`, input)
      if (
        policy.grantedResources &&
        !policy.grantedResources.includes("*") &&
        !policy.grantedResources.includes(credential)
      )
        return fail(`Credential scope ${credential} is not covered by the parent action grant`, input)
    }

    if (policy.grantedResources && !policy.grantedResources.includes("*")) {
      const exactNetwork = policy.networkScope.some((scope) => policy.grantedResources?.includes(scope))
      if (!exactNetwork) return fail("The egress network scope is not covered by the parent action grant", input)
    }

    return Effect.void
  },
  assertProcess: (input) => {
    const resource = `process:${input.command}`
    const allowed = policy.networkScope.some((scope) => scope === "process:*" || scope === resource)
    const granted =
      policy.grantedResources === undefined ||
      policy.grantedResources.includes("*") ||
      policy.grantedResources.includes(resource) ||
      policy.grantedResources.includes("process:*")
    if (!allowed || !granted)
      return fail("Process network egress is outside the declared scope", { url: resource, method: "GET" })
    return Effect.void
  },
})

export const deny = (reason = "No egress capability is bound to this tool call"): Authorizer => ({
  assert: (input) => fail(reason, input),
  assertProcess: (input) => fail(reason, { url: `process:${input.command}`, method: "GET" }),
})

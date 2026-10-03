import path from "node:path"
import { Schema } from "effect"

/**
 * User-facing execution presets. The preset is policy input; it is not an
 * assertion that the host operating system can enforce it.
 */
export const ProfileSchema = Schema.Literals(["read-only", "workspace-write", "unrestricted"])
export type Profile = typeof ProfileSchema.Type

export const NetworkSchema = Schema.Literals(["none", "inherit"])
export type Network = typeof NetworkSchema.Type

export const DefaultProfile: Profile = "workspace-write"

/** The only session metadata key owned by the sandbox policy. */
export const SessionMetadataKey = "sandboxProfile" as const

export const ProfileInfo = {
  "read-only": {
    label: "Read-only",
    description:
      "Inspect files only. Automatic execution requires a native read-only boundary; if the host cannot enforce it, the request is refused.",
  },
  "workspace-write": {
    label: "Workspace write",
    description:
      "Write inside approved workspace roots. Until the host reports full OS enforcement, external paths and network effects remain explicitly limited or refused.",
  },
  unrestricted: {
    label: "Unrestricted",
    description:
      "Keep host file, process, and network reachability intentionally; gateway, permission, and audit checks still apply.",
  },
} as const satisfies Record<Profile, { readonly label: string; readonly description: string }>

export function isProfile(value: unknown): value is Profile {
  return Schema.is(ProfileSchema)(value)
}

/** Invalid or absent legacy metadata falls back to the historical behavior. */
export function profileFromMetadata(metadata: Readonly<Record<string, unknown>> | undefined): Profile {
  const value = metadata?.[SessionMetadataKey]
  return isProfile(value) ? value : DefaultProfile
}

/** Update only the owned key while preserving unrelated session metadata. */
export function setProfileMetadata(
  metadata: Readonly<Record<string, unknown>> | undefined,
  profile: Profile,
): Record<string, unknown> {
  return { ...(metadata ?? {}), [SessionMetadataKey]: profile }
}

export type Enforcement = "full" | "partial" | "unavailable"

export type PolicyInput = {
  readonly profile?: Profile
  readonly network?: Network
  readonly workspace: string
  readonly cwd: string
  /** Additional directories explicitly approved by the caller. */
  readonly roots?: ReadonlyArray<string>
  /** Additional read grants; these never create a writable-root grant. */
  readonly readOnlyRoots?: ReadonlyArray<string>
}

export type Resolved = {
  readonly profile: Profile
  readonly network: Network
  readonly workspace: string
  readonly cwd: string
  /** Canonical absolute paths that the host enforcement may expose writable. */
  readonly roots: ReadonlyArray<string>
  /** Explicit additional read grants, separate from writable roots. */
  readonly readOnlyRoots?: ReadonlyArray<string>
}

const absolute = (value: string) => path.resolve(value)

/**
 * Resolve policy input once at the execution boundary. The function is pure
 * and deliberately does not decide permissions or claim OS enforcement.
 */
export function resolve(input: PolicyInput): Resolved {
  const workspace = absolute(input.workspace)
  const cwd = absolute(input.cwd)
  const roots = [...new Set([workspace, cwd, ...(input.roots ?? []).map(absolute)])].sort((a, b) => a.localeCompare(b))
  return {
    profile: input.profile ?? DefaultProfile,
    network: input.network ?? "inherit",
    workspace,
    cwd,
    roots,
    ...(input.readOnlyRoots === undefined
      ? {}
      : { readOnlyRoots: [...new Set(input.readOnlyRoots.map(absolute))].sort((a, b) => a.localeCompare(b)) }),
  }
}

/** Stable path containment helper for host adapters and tests. */
export function contains(root: string, target: string): boolean {
  const relative = path.relative(absolute(root), absolute(target))
  return relative.length === 0 || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

export * as SandboxPolicy from "./policy"

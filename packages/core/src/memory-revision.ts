import { createHash } from "node:crypto"
import { ContentDigest } from "@arforge-ai/schema/memory-revision"
import type * as MemoryRevision from "@arforge-ai/schema/memory-revision"

export const digest = (value: unknown): MemoryRevision.ContentDigest =>
  ContentDigest.make(createHash("sha256").update(JSON.stringify(value)).digest("hex"))

export const nextVersion = (currentVersion: number): number => currentVersion + 1

export const casMatches = (currentVersion: number, expectedVersion: number): boolean => currentVersion === expectedVersion

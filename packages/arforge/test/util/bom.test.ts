import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { FSUtil } from "@arforge-ai/core/fs-util"
import * as Bom from "../../src/util/bom"

describe("Bom.syncFile", () => {
  it("uses the observed bytes as the CAS preimage when restoring a BOM", async () => {
    const encoder = new TextEncoder()
    const writes: Array<{ path: string; expected: Uint8Array; content: string | Uint8Array }> = []
    const filesystem: Pick<FSUtil.Interface, "readFile" | "writeIfUnchanged"> = {
      readFile: () => Effect.succeed(encoder.encode("\uFEFFhello")),
      writeIfUnchanged: (path, expected, content) => Effect.sync(() => writes.push({ path, expected, content })),
    }

    const text = await Effect.runPromise(Bom.syncFile(filesystem, "workspace/file.ts", false))

    expect(text).toBe("hello")
    expect(writes).toHaveLength(1)
    expect(writes[0]?.path).toBe("workspace/file.ts")
    expect(Array.from(writes[0]!.expected)).toEqual(Array.from(encoder.encode("\uFEFFhello")))
    expect(writes[0]!.content).toBe("hello")
  })

  it("fails closed when a compatibility filesystem omits conditional writes", async () => {
    const filesystem: Pick<FSUtil.Interface, "readFile" | "writeIfUnchanged"> = {
      readFile: () => Effect.succeed(new TextEncoder().encode("\uFEFFhello")),
    }

    const result = await Effect.runPromiseExit(Bom.syncFile(filesystem, "workspace/file.ts", false))

    expect(result._tag).toBe("Failure")
    expect(String(result)).toContain("conditional atomic write support")
  })
})

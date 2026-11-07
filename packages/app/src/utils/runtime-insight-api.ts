import { Schema } from "effect"
import { AuditVerify, RuntimeInsightPage } from "@arforge-ai/protocol/groups/runtime-insight"
import type { Arforge } from "@arforge-ai/sdk-next/remote"

type RuntimeInsightApi = ReturnType<typeof Arforge.make>["runtimeInsight"]

const decodeSnapshot = Schema.decodeUnknownSync(Schema.toCodecJson(RuntimeInsightPage))
const decodeAuditVerify = Schema.decodeUnknownSync(Schema.toCodecJson(AuditVerify))

// Promise clients return the JSON transport representation. Decode at this
// boundary so every view consumes the canonical domain values, just as the
// Effect client does. Never replace an invalid response with empty success.
function decode<T>(value: unknown, run: (value: unknown) => T): T {
  try {
    return run(value)
  } catch {
    // Parse issues may include server data; keep that data out of UI errors.
    throw new Error("Invalid runtime insight response")
  }
}

export function createRuntimeInsightApi(api: RuntimeInsightApi) {
  const { snapshot, auditVerify, ...rest } = api
  return {
    ...rest,
    snapshot: async (...args: Parameters<RuntimeInsightApi["snapshot"]>) =>
      decode(await snapshot(...args), decodeSnapshot),
    auditVerify: async (...args: Parameters<RuntimeInsightApi["auditVerify"]>) =>
      decode(await auditVerify(...args), decodeAuditVerify),
  }
}

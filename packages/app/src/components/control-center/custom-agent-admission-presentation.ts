export type CustomAgentAdmissionItem = Readonly<{
  role: string
  status: string
  decision: "admitted" | "blocked"
  reason: string
  descriptor_digest?: string
  checks: Readonly<Record<string, boolean>>
  declared_tool_count: number
  canonical_tool_count: number
  unsupported_tool_count: number
  valid: boolean
  violations: ReadonlyArray<string>
}>

export type CustomAgentAdmissionOverview = Readonly<{
  schema_version: 1
  count: number
  items: ReadonlyArray<CustomAgentAdmissionItem>
  errors: ReadonlyArray<{ file: string; error: string }>
  truncated: boolean
}>

const objectRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

const boundedText = (value: unknown, maximum: number) =>
  typeof value === "string" && value.trim().length > 0 ? value.trim().slice(0, maximum) : undefined

const boundedCount = (value: unknown) => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0)

const parseItem = (value: unknown): CustomAgentAdmissionItem | undefined => {
  const record = objectRecord(value)
  const role = boundedText(record?.role, 160)
  const status = boundedText(record?.status, 48)
  const reason = boundedText(record?.reason, 512)
  const decision = record?.decision === "admitted" || record?.decision === "blocked" ? record.decision : undefined
  const checksRecord = objectRecord(record?.checks)
  if (!role || !status || !reason || !decision || !checksRecord) return undefined
  const checks: Record<string, boolean> = {}
  for (const [key, check] of Object.entries(checksRecord)) {
    if (/^[a-z][a-z0-9_]{0,63}$/.test(key) && typeof check === "boolean") checks[key] = check
  }
  const descriptor = boundedText(record?.descriptor_digest, 64)
  return {
    role,
    status,
    decision,
    reason,
    ...(descriptor && /^[a-f0-9]{64}$/i.test(descriptor) ? { descriptor_digest: descriptor } : {}),
    checks: Object.freeze(checks),
    declared_tool_count: boundedCount(record?.declared_tool_count),
    canonical_tool_count: boundedCount(record?.canonical_tool_count),
    unsupported_tool_count: boundedCount(record?.unsupported_tool_count),
    valid: record?.valid === true,
    violations: Object.freeze(
      Array.isArray(record?.violations)
        ? record.violations.filter((item): item is string => typeof item === "string").slice(0, 8).map((item) => item.slice(0, 512))
        : [],
    ),
  }
}

/** Parse only the payload-free admission projection emitted by System Overview. */
export function parseCustomAgentAdmission(value: unknown): CustomAgentAdmissionOverview | undefined {
  const record = objectRecord(value)
  if (record?.schema_version !== 1 || !Array.isArray(record.items)) return undefined
  const items = record.items.map(parseItem).filter((item): item is CustomAgentAdmissionItem => item !== undefined).slice(0, 64)
  const errors = Array.isArray(record.errors)
    ? record.errors
        .map((item) => {
          const entry = objectRecord(item)
          const file = boundedText(entry?.file, 160)
          const error = boundedText(entry?.error, 512)
          return file && error ? { file, error } : undefined
        })
        .filter((item): item is { file: string; error: string } => item !== undefined)
        .slice(0, 16)
    : []
  return {
    schema_version: 1,
    count: boundedCount(record.count),
    items: Object.freeze(items),
    errors: Object.freeze(errors),
    truncated: record.truncated === true,
  }
}

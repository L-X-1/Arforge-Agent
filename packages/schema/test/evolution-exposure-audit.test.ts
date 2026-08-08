import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { AgentCapability } from "../src/agent-capability"

const digest = "a".repeat(64)

describe("evolution exposure audit contract", () => {
  test("decodes privacy-safe pending and recorded projections", () => {
    const decode = Schema.decodeUnknownSync(AgentCapability.EvolutionExposureList)
    const base = {
      schema_version: 1 as const,
      exposure_id: "ex-0123456789abcdef0123456789abcdef",
      created_at: "2026-08-03T02:00:00.000+00:00",
      cohort_key_digest: digest,
      context_digest: digest,
      injected_candidate_ids: ["ev-0123456789abcdef"],
      assignments: [
        {
          candidate_id: "ev-0123456789abcdef",
          candidate_digest: digest,
          cohort: "candidate" as const,
        },
      ],
      ticket_digest: digest,
      source: {
        kind: "session_turn" as const,
        authority: "typescript-core" as const,
        session_id: "ses_test",
        user_message_id: "msg_user",
        turn_step: 1,
      },
    }
    const decoded = decode({
      schema_version: 1,
      count: 2,
      total: 2,
      counts: { pending: 1, recorded: 1 },
      truncated: false,
      items: [
        { ...base, status: "pending", receipt: null },
        {
          ...base,
          exposure_id: "ex-abcdef0123456789abcdef0123456789",
          status: "recorded",
          receipt: {
            receipt_digest: digest,
            recorded_at: "2026-08-03T02:01:00.000+00:00",
            outcome: { success: true, stop_reason: "completed", safety_incident: false },
            observation_count: 1,
            assistant_message_id: "msg_assistant",
          },
        },
      ],
    })

    expect(decoded.items[0]?.receipt).toBeNull()
    expect(decoded.items[1]?.receipt?.outcome?.success).toBe(true)
    expect(JSON.stringify(decoded)).not.toContain('cohort_key"')
  })

  test("rejects raw cohort keys and invalid status values", () => {
    const decode = Schema.decodeUnknownSync(AgentCapability.EvolutionExposureList)
    expect(() =>
      decode({
        schema_version: 1,
        count: 1,
        total: 1,
        counts: { pending: 1, recorded: 0 },
        truncated: false,
        items: [
          {
            schema_version: 1,
            exposure_id: "ex-0123456789abcdef0123456789abcdef",
            created_at: "2026-08-03T02:00:00.000+00:00",
            cohort_key: "private-session",
            cohort_key_digest: digest,
            context_digest: digest,
            injected_candidate_ids: [],
            assignments: [],
            status: "missing",
            ticket_digest: digest,
            receipt: null,
          },
        ],
      }),
    ).toThrow()
  })

  test("decodes digest-bound archive previews and completion results", () => {
    const preview = Schema.decodeUnknownSync(AgentCapability.EvolutionExposureArchivePlan)({
      schema_version: 1,
      archive_id: "xa-0123456789abcdef01234567",
      plan_digest: digest,
      keep_recorded: 1000,
      eligible_count: 1,
      counts: { pending: 2, recorded: 1001, retained_recorded: 1000 },
      truncated: false,
      items: [
        {
          exposure_id: "ex-0123456789abcdef0123456789abcdef",
          created_at: "2026-08-03T02:00:00.000+00:00",
          ticket_digest: digest,
          receipt_digest: digest,
        },
      ],
    })
    const applied = Schema.decodeUnknownSync(AgentCapability.EvolutionExposureArchiveResult)({
      schema_version: 1,
      applied: true,
      archive_id: preview.archive_id,
      plan_digest: preview.plan_digest,
      archived_count: 1,
      completed_at: "2026-08-03T02:01:00.000+00:00",
      active_counts: { pending: 2, recorded: 1000 },
    })

    expect(preview.eligible_count).toBe(1)
    expect(applied).toMatchObject({ applied: true, archived_count: 1 })
  })

  test("decodes a privacy-filtered, hash-chained execution timeline", () => {
    const decoded = Schema.decodeUnknownSync(AgentCapability.EvolutionAuditEventList)({
      schema_version: 1,
      valid: true,
      head_hash: digest,
      total: 1,
      count: 1,
      truncated: false,
      items: [
        {
          schema_version: 1,
          sequence: 7,
          recorded_at: "2026-08-03T02:01:00.000+00:00",
          subject_id: "xa-0123456789abcdef01234567",
          subject_kind: "archive",
          action: "exposure_archive_completed",
          actor: "user:product",
          reason: "Retention reviewed by the user.",
          metadata: { archived_count: 1, phase: "complete" },
          previous_hash: digest,
          record_hash: digest,
        },
      ],
    })

    expect(decoded.valid).toBe(true)
    expect(decoded.items[0]?.subject_kind).toBe("archive")
    expect(JSON.stringify(decoded)).not.toContain("cohort_key")

    const exposure = Schema.decodeUnknownSync(AgentCapability.EvolutionAuditEventList)({
      ...decoded,
      items: [
        {
          ...decoded.items[0],
          subject_id: "ex-0123456789abcdef0123456789abcdef",
          subject_kind: "exposure",
          action: "exposure_prepared",
          metadata: { session_id: "ses_test", user_message_id: "msg_user", turn_step: 1 },
        },
      ],
    })
    expect(exposure.items[0]?.subject_kind).toBe("exposure")
  })

  test("decodes archive discovery, restore, and sanitized export contracts", () => {
    const archive = {
      schema_version: 1 as const,
      archive_id: "xa-0123456789abcdef01234567",
      integrity: { valid: true, issue: "" },
      published_at: "2026-08-03T02:00:00.000+00:00",
      completed_at: "2026-08-03T02:01:00.000+00:00",
      archived_count: 1,
      keep_recorded: 1000,
      plan_digest: digest,
      manifest_digest: digest,
      completion_digest: digest,
      evidence_set_digest: digest,
      restore: { missing: 1, identical: 0, conflicts: 0, can_restore: true },
    }
    const catalog = Schema.decodeUnknownSync(AgentCapability.EvolutionExposureArchiveList)({
      schema_version: 1,
      count: 1,
      total: 1,
      valid_count: 1,
      invalid_count: 0,
      truncated: false,
      items: [archive],
    })
    const restore = Schema.decodeUnknownSync(AgentCapability.EvolutionExposureRestorePlan)({
      schema_version: 1,
      restore_id: "xr-0123456789abcdef01234567",
      archive_id: archive.archive_id,
      plan_digest: digest,
      manifest_digest: digest,
      completion_digest: digest,
      archived_count: 1,
      counts: { missing: 1, already_present: 0, conflicts: 0, active_total: 2, active_after: 3 },
      capacity_exceeded: false,
      can_apply: true,
      truncated: false,
      items: [
        {
          exposure_id: "ex-0123456789abcdef0123456789abcdef",
          created_at: archive.published_at,
          ticket_digest: digest,
          receipt_digest: digest,
          live_status: "missing",
          source: {
            kind: "session_turn",
            authority: "typescript-core",
            session_id: "ses_test",
            user_message_id: "msg_user",
            turn_step: 1,
          },
        },
      ],
    })
    const exported = Schema.decodeUnknownSync(AgentCapability.EvolutionExposureArchiveExport)({
      schema_version: 1,
      filename: `arforge-${archive.archive_id}-public-audit.json`,
      media_type: "application/json",
      sha256: digest,
      content: '{"privacy":"sanitized"}\n',
    })

    expect(catalog.items[0]?.restore.can_restore).toBe(true)
    expect(restore.counts.active_after).toBe(3)
    expect(exported.filename).toContain("public-audit")
  })
})

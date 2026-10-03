import { EOL } from "node:os"
import type { Argv } from "yargs"
import {
  assertSettlementCommitEnableGate,
  settlementCommitEnableGate,
  type SettlementCommitEnableGate,
} from "@arforge-ai/core/runtime/child-settlement"
import { settlementReadOnlyExecutionBoundary } from "@arforge-ai/core/runtime/execution-boundary"
import { cmd } from "./cmd"

interface SettlementStatusArgs {
  readonly json: boolean
}

type SettlementStatusReport = Readonly<{
  readonly schema_version: SettlementCommitEnableGate["schemaVersion"]
  readonly runtime: "typescript"
  readonly owner: "core-settlement-coordinator"
  readonly mode: SettlementCommitEnableGate["mode"]
  readonly ready: boolean
  readonly decision: SettlementCommitEnableGate["decision"]
  readonly provider_execution_allowed: false
  readonly execution_boundary: Readonly<{
    readonly mode: "read-only"
    readonly writes: false
    readonly creates_settlement_state: false
    readonly repairs_recovery: false
    readonly provider_execution_allowed: false
  }>
  readonly blocking_gate_ids: ReadonlyArray<SettlementCommitEnableGate["gates"][number]["id"]>
  readonly gates: SettlementCommitEnableGate["gates"]
  readonly decision_digest: string
  readonly observation: Readonly<{
    readonly owner: "settlement-coordinator"
    readonly journal: "parent-run-event-v1"
    readonly event_type: "agent.child-run.settlement-observation-recorded.1"
    readonly payload: "metadata-only"
    readonly review_only: true
    readonly promotion_authorized: false
  }>
  readonly caveat: string
}>

/**
 * Build the read-only settlement decision projection used by operators and
 * support tooling. The authoritative card is revalidated before it crosses
 * the CLI boundary so a stale/forged object can never be rendered as ready.
 */
function buildReport(): SettlementStatusReport {
  const gate = settlementCommitEnableGate()
  assertSettlementCommitEnableGate(gate)
  return {
    schema_version: gate.schemaVersion,
    runtime: "typescript",
    owner: "core-settlement-coordinator",
    mode: gate.mode,
    ready: gate.ready,
    decision: gate.decision,
    provider_execution_allowed: gate.providerExecutionAllowed,
    execution_boundary: settlementReadOnlyExecutionBoundary(),
    blocking_gate_ids: gate.blocking_gate_ids,
    gates: gate.gates,
    decision_digest: gate.decisionDigest,
    observation: {
      owner: "settlement-coordinator",
      journal: "parent-run-event-v1",
      event_type: "agent.child-run.settlement-observation-recorded.1",
      payload: "metadata-only",
      review_only: true,
      promotion_authorized: false,
    },
    caveat:
      "本命令只读取结算门禁；不会写入 Evidence、ChildResult、ParentBudget 或 outbox，也不会调用 Provider。真实生产共享事务、跨进程崩溃/回滚与审计 promotion 证据完成前，same-transaction 保持关闭。",
  }
}

const statusLabel = (status: SettlementCommitEnableGate["gates"][number]["status"]): string =>
  status === "satisfied" ? "满足" : "阻断"

const scopeLabel = (scope: SettlementCommitEnableGate["gates"][number]["evidenceScope"]): string =>
  scope === "production" ? "生产" : "隔离测试"

function render(report: SettlementStatusReport): string {
  const lines = [
    "子任务结算门禁（只读）",
    `运行时：${report.runtime}/Core · owner=${report.owner}`,
    `模式：${report.mode}`,
    `生产同事务：${report.ready ? "已启用" : "未启用"} · 决策=${report.decision}`,
    "执行边界：只读 · writes=0 · 不创建结算状态、不自动修复 · Provider=禁止",
    "Provider 执行：禁止",
    `持久观测：${report.observation.journal} · owner=${report.observation.owner} · ${report.observation.payload}`,
    `观测晋级：${report.observation.review_only ? "仅 review" : "可晋级"} · 自动晋级=${
      report.observation.promotion_authorized ? "允许" : "禁止"
    } · event=${report.observation.event_type}`,
    `阻断门禁：${report.blocking_gate_ids.length ? report.blocking_gate_ids.join(", ") : "无"}`,
    "门禁明细：",
    ...report.gates.map(
      (gate) =>
        `- ${gate.id}：${statusLabel(gate.status)} · 证据=${scopeLabel(gate.evidenceScope)} · ${gate.requirement}${
          gate.blocker ? ` · ${gate.blocker}` : ""
        }`,
    ),
    `决策摘要：${report.decision_digest}`,
    `说明：${report.caveat}`,
  ]
  return lines.join(EOL) + EOL
}

/** TypeScript/Core owner for the read-only settlement promotion decision. */
export const SettlementStatusCommand = cmd<{}, SettlementStatusArgs>({
  command: "settlement-status",
  describe: "查看子任务结算门禁与 recovery-outbox 决策（只读）",
  builder: (yargs: Argv) =>
    yargs.option("json", {
      type: "boolean",
      default: false,
      describe: "输出机器可读 JSON",
    }),
  handler(args) {
    const report = buildReport()
    if (args.json) {
      process.stdout.write(JSON.stringify(report, null, 2) + EOL)
      return
    }
    process.stdout.write(render(report))
  },
})

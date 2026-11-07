import type { PendingControlApproval } from "@/context/control-approval"

const operations = ["worktree.create", "worktree.remove", "worktree.reset", "session.revert", "session.unrevert", "session.share", "session.unshare"] as const
export type ReceiptOperation = (typeof operations)[number]
export type ReceiptOperationTarget = Readonly<{ directory: string; requestID: string; operation: ReceiptOperation }>
const phases = ["preparing", "waiting_for_confirmation", "queued", "executing", "recovering", "verifying", "paused", "completed", "failed", "cancelled"] as const
export type ReceiptOperationStatus = Readonly<{
  requestID: string; operation: ReceiptOperation; runID: string; actionID: string
  phase: (typeof phases)[number]; recovery: "awaiting_authorization" | "resume" | "recover" | "none"; canApprove: boolean
}>
const identifier = (value: unknown): value is string => typeof value === "string" && value.length <= 160 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)

/** The status endpoint accepts only its real operation allow-list and original alias. */
export function receiptOperationTarget(item: Pick<PendingControlApproval, "action" | "subject">): ReceiptOperationTarget | undefined {
  if (!(operations as readonly string[]).includes(item.action) || !identifier(item.subject.requestID) ||
      !identifier(item.subject.id) || !identifier(item.subject.project) ||
      !/^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(item.subject.location) || item.subject.location.length > 1024 ||
      /[\u0000-\u001f\u007f-\u009f]/.test(item.subject.location)) return
  return Object.freeze({ directory: item.subject.location, requestID: item.subject.requestID, operation: item.action as ReceiptOperation })
}

/** Render only a matching, display-safe status DTO; never an opaque response body. */
export function receiptOperationStatus(value: unknown, target: ReceiptOperationTarget): ReceiptOperationStatus {
  if (!value || typeof value !== "object") throw new Error("The source did not return an operation receipt.")
  const result = value as Record<string, unknown>
  if (result.requestID !== target.requestID || result.operation !== target.operation ||
      !identifier(result.runID) || !identifier(result.actionID) ||
      !(phases as readonly unknown[]).includes(result.phase) ||
      !["awaiting_authorization", "resume", "recover", "none"].includes(String(result.recovery)) || typeof result.canApprove !== "boolean")
    throw new Error("The operation receipt does not match its originating request.")
  return { requestID: target.requestID, operation: target.operation, runID: result.runID, actionID: result.actionID,
    phase: result.phase as ReceiptOperationStatus["phase"], recovery: result.recovery as ReceiptOperationStatus["recovery"], canApprove: result.canApprove }
}

export function receiptOperationPhase(phase: ReceiptOperationStatus["phase"], locale: string) {
  const labels: Record<ReceiptOperationStatus["phase"], readonly [string, string]> = {
    preparing: ["准备中", "Preparing"], waiting_for_confirmation: ["等待确认", "Waiting for confirmation"],
    queued: ["已排队", "Queued"], executing: ["执行中", "Executing"], recovering: ["恢复中", "Recovering"],
    verifying: ["验证中", "Verifying"], paused: ["已暂停", "Paused"], completed: ["已完成", "Completed"],
    failed: ["执行失败", "Failed"], cancelled: ["已取消", "Cancelled"],
  }
  return labels[phase][locale.startsWith("zh") ? 0 : 1]
}

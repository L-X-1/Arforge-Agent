import { showToast } from "@/utils/toast"
import type { ServerControlOperationStatus } from "./control-operation-intent"

type NoticeKey =
  | "controlOperation.status.pending.title"
  | "controlOperation.status.pending.description"
  | "controlOperation.status.completed.title"
  | "controlOperation.status.completed.description"
  | "controlOperation.status.stopped.title"
  | "controlOperation.status.stopped.description"

type Translate = (key: NoticeKey) => string

/**
 * A status-only response is intentionally presented as status, never as the
 * old Worktree result. This keeps users informed while preventing local
 * navigation/session/cache continuation from racing the server worker.
 */
export function showControlOperationStatusNotice(status: ServerControlOperationStatus, translate: Translate) {
  const kind =
    status.phase === "completed"
      ? "completed"
      : status.phase === "failed" || status.phase === "cancelled"
        ? "stopped"
        : "pending"
  showToast({
    title: translate(`controlOperation.status.${kind}.title`),
    description: translate(`controlOperation.status.${kind}.description`),
  })
}

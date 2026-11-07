import { safeControlServerLabel } from "@/context/control-approval"
import { managementErrorText } from "@/components/settings-v2/management-state"

export type SessionConfirmationObject = {
  kind: "schedule-run" | "schedule-delete" | "schedule-missed" | "trigger-run" | "wait-wake" | "member-shutdown" | "member-remove" | "team-delete" | "tasks-clear" | "task-cancel" | "task-delete" | "rewind"
  id: string
  revision?: number | string
  profile?: string
}

const safe = (value: string) => managementErrorText(value, "").replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").slice(0, 1600)

/** Capture only display-safe source/object facts; the caller keeps the revision fence. */
export function sessionOperationConfirmation(input: {
  server: string; directory: string; sessionID: string; message: string; object: SessionConfirmationObject
}, locale: string) {
  const zh = locale.startsWith("zh")
  const info: Record<SessionConfirmationObject["kind"], readonly [string, string, string, string, boolean]> = {
    "schedule-run": ["将所选计划发送到此会话的常规队列。", "Requests the selected schedule through this Session's normal queue.", "提交后关闭对话框不会撤回队列请求；后续以队列和执行回执为准。", "Closing the dialog after submission does not withdraw the queue request. Review the queue and execution receipt.", false],
    "schedule-missed": ["将所选错过的计划发送到此会话的常规队列。", "Requests the selected missed schedule through this Session's normal queue.", "此确认框不提供撤回；后续以队列和执行回执为准。", "This confirmation does not provide withdrawal. Review the queue and execution receipt.", false],
    "schedule-delete": ["删除所选计划配置。", "Deletes the selected schedule configuration.", "此入口没有撤销删除操作。", "This control has no undo-delete action.", true],
    "trigger-run": ["通过所选 Profile 运行此触发器；外部 Profile 可能产生外部副作用。", "Runs this trigger through the selected profile; external profiles may cause external effects.", "关闭确认框不会撤回已提交的触发请求，结果需查看来源回执。", "Closing the confirmation does not withdraw a submitted trigger. Review its source receipt.", false],
    "wait-wake": ["向当前等待发送唤醒信号，不代表后续任务完成。", "Sends a wake signal to the current wait; subsequent work is not thereby complete.", "此入口没有撤回已送达信号的操作。", "This control cannot withdraw a delivered signal.", false],
    "member-shutdown": ["向所选成员请求正常停止，仍需成员明确批准。", "Requests graceful shutdown of the selected member, which still requires their explicit approval.", "请求与实际停止分别确认；此入口没有撤回请求的操作。", "The request and actual shutdown are separate outcomes. This control has no withdrawal action.", true],
    "member-remove": ["从此团队移除所选已停止成员。", "Removes the selected stopped member from this team.", "此入口没有恢复该成员记录的操作。", "This control has no restore-member-record action.", true],
    "team-delete": ["删除此团队、完整消息箱和全部停止记录。", "Deletes this team, its complete mailbox and shutdown metadata.", "此入口没有恢复团队或消息箱的操作。", "This control has no restore-team or restore-mailbox action.", true],
    "tasks-clear": ["删除列出的已完成或已取消任务；活动任务保留。", "Deletes the listed completed or cancelled tasks; active tasks remain.", "此入口没有恢复删除记录的操作。", "This control has no restore-deleted-record action.", true],
    "task-cancel": ["取消所选任务，依赖它的任务仍保持阻塞。", "Cancels the selected task; dependent tasks remain blocked.", "此入口没有恢复已取消任务的操作。", "This control has no restore-cancelled-task action.", true],
    "task-delete": ["删除所选任务及其全部依赖链接。", "Deletes the selected task and all its dependency links.", "此入口没有撤销删除或恢复依赖链接的操作。", "This control has no undo-delete or restore-dependency-links action.", true],
    rewind: ["按所选检查点归档预览中列出的会话消息，不修改文件、命令历史或外部副作用。", "Archives the previewed messages at the selected checkpoint; files, command history and external effects remain unchanged.", "关闭确认框不会恢复已归档历史，也不会撤销工作区副作用。", "Closing this confirmation does not restore archived history or reverse workspace effects.", true],
  }
  const [impactZh, impactEn, recoveryZh, recoveryEn, danger] = info[input.object.kind]
  const objectName = input.object.kind.startsWith("schedule-") ? zh ? "计划 Prompt" : "Scheduled Prompt"
    : input.object.kind.startsWith("member-") ? zh ? "团队成员" : "Team member"
    : input.object.kind.startsWith("task") ? zh ? "任务" : "Task"
    : input.object.kind === "trigger-run" ? zh ? "触发器" : "Trigger"
    : input.object.kind === "wait-wake" ? zh ? "等待" : "Wait"
    : input.object.kind === "team-delete" ? zh ? "团队" : "Team" : zh ? "检查点" : "Checkpoint"
  const source = [
    `${zh ? "服务器" : "Server"}: ${safeControlServerLabel(input.server)}`,
    `${zh ? "目录" : "Directory"}: ${safe(input.directory)}`,
    `Session: ${safe(input.sessionID)}`,
    `${zh ? "对象" : "Object"}: ${objectName} · ${safe(input.object.id)}`,
    ...(input.object.revision === undefined ? [] : [`${zh ? "修订" : "Revision"}: ${safe(String(input.object.revision))}`]),
    ...(input.object.profile === undefined ? [] : [`Profile: ${safe(input.object.profile)}`]),
    `${zh ? "影响" : "Impact"}: ${zh ? impactZh : impactEn}`,
    `${zh ? "可恢复性" : "Recovery"}: ${zh ? recoveryZh : recoveryEn}`,
  ]
  return { message: `${safe(input.message)}\n\n${source.join("\n")}`, danger: danger || (input.object.kind === "trigger-run" && input.object.profile !== "local") }
}

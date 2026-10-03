import "@/components/settings-v2/management-review.css"
import { ButtonV2 } from "@arforge-ai/ui/v2/button-v2"
import { Dialog } from "@arforge-ai/ui/dialog"
import { useDialog } from "@arforge-ai/ui/context/dialog"
import { Icon } from "@arforge-ai/ui/icon"
import { For, Show } from "solid-js"
import {
  controlApprovalDOMID,
  safeControlServerLabel,
  isSafeControlLocation,
  knownControlAction,
  safeControlMetadataDetails,
  safeControlResourceKinds,
  shortControlIdentifier,
  type ControlApprovalReply,
  type PendingControlApproval,
  type SafeControlAction,
  type SafeControlMetadataDetail,
  type SafeControlResourceKind,
  useControlApproval,
} from "@/context/control-approval"
import { useLanguage } from "@/context/language"

type Translate = ReturnType<typeof useLanguage>["t"]

type LocalCopy = Readonly<{ en: string; zh: string }>

const actionCopy: Readonly<Record<SafeControlAction, Readonly<{ label: LocalCopy; reason: LocalCopy }>>> = {
  "worktree.create": {
    label: { en: "Create isolated worktree", zh: "创建隔离工作树" },
    reason: { en: "Creates an isolated worktree at the reviewed commit.", zh: "将在已核对的提交上创建隔离工作树。" },
  },
  "worktree.remove": {
    label: { en: "Remove worktree", zh: "移除工作树" },
    reason: { en: "Removes the reviewed worktree and its branch.", zh: "将移除已核对的工作树及其分支。" },
  },
  "worktree.reset": {
    label: { en: "Reset worktree", zh: "重置工作树" },
    reason: {
      en: "Resets and cleans the reviewed worktree to the approved commit.",
      zh: "会将已核对的工作树重置并清理到批准的提交。",
    },
  },
  "skill.enable": {
    label: { en: "Enable managed skill", zh: "启用受管技能" },
    reason: { en: "Enables the reviewed managed skill.", zh: "将启用已核对的受管技能。" },
  },
  "skill.disable": {
    label: { en: "Disable managed skill", zh: "停用受管技能" },
    reason: { en: "Disables the reviewed managed skill.", zh: "将停用已核对的受管技能。" },
  },
  "plugin.enable": {
    label: { en: "Enable managed plugin", zh: "启用受管插件" },
    reason: { en: "Enables the reviewed managed plugin.", zh: "将启用已核对的受管插件。" },
  },
  "plugin.disable": {
    label: { en: "Disable managed plugin", zh: "停用受管插件" },
    reason: { en: "Disables the reviewed managed plugin.", zh: "将停用已核对的受管插件。" },
  },
  "plugin.install": {
    label: { en: "Install managed plugin", zh: "安装受管插件" },
    reason: { en: "Installs the inspected plugin package.", zh: "将安装已检查的插件包。" },
  },
  "plugin.update": {
    label: { en: "Update managed plugin", zh: "更新受管插件" },
    reason: { en: "Updates the inspected plugin package.", zh: "将更新已检查的插件包。" },
  },
  "plugin.uninstall": {
    label: { en: "Uninstall managed plugin", zh: "卸载受管插件" },
    reason: {
      en: "Moves the reviewed plugin to recoverable local storage.",
      zh: "会将已核对的插件移入可恢复的本地存储。",
    },
  },
  "plugin.rollback": {
    label: { en: "Restore managed plugin", zh: "恢复受管插件" },
    reason: {
      en: "Restores the reviewed plugin from recoverable local storage.",
      zh: "会从可恢复的本地存储还原已核对的插件。",
    },
  },
  "session.revert": {
    label: { en: "Revert session and files", zh: "回退会话与文件" },
    reason: {
      en: "Restores the reviewed session history boundary and file snapshot.",
      zh: "会恢复已核对的会话历史边界和文件快照。",
    },
  },
  "session.unrevert": {
    label: { en: "Undo session revert", zh: "撤销会话回退" },
    reason: { en: "Restores the immutable pre-revert receipt.", zh: "会恢复首次回退前保存的不可变凭据。" },
  },
  "session.share": {
    label: { en: "Publish session share", zh: "发布会话分享" },
    reason: { en: "Publishes the reviewed and scanned session export.", zh: "会发布已核对并完成扫描的会话导出。" },
  },
  "session.unshare": {
    label: { en: "Revoke session share", zh: "撤销会话分享" },
    reason: { en: "Removes only the reviewed session publication.", zh: "只会移除已核对的会话发布记录。" },
  },
  "evolution.proposal.create": {
    label: { en: "Create Evolution candidate", zh: "创建 Evolution 候选项" },
    reason: {
      en: "Creates the reviewed governed Evolution candidate.",
      zh: "会创建已核对、受治理的 Evolution 候选项。",
    },
  },
  "evolution.proposal.evaluate": {
    label: { en: "Evaluate Evolution candidate", zh: "评测 Evolution 候选项" },
    reason: { en: "Evaluates the reviewed candidate in isolation.", zh: "会在隔离环境中评测已核对的候选项。" },
  },
  "evolution.proposal.transition": {
    label: { en: "Advance Evolution candidate", zh: "推进 Evolution 候选项" },
    reason: {
      en: "Advances the reviewed candidate through its governed lifecycle.",
      zh: "会按治理生命周期推进已核对的候选项。",
    },
  },
  "evolution.exposure.archive": {
    label: { en: "Archive Evolution exposure", zh: "归档 Evolution 暴露记录" },
    reason: { en: "Archives only the reviewed exposure records.", zh: "只会归档已核对的暴露记录。" },
  },
  "evolution.exposure.restore": {
    label: { en: "Restore Evolution exposure", zh: "恢复 Evolution 暴露记录" },
    reason: { en: "Restores only the reviewed exposure archive.", zh: "只会恢复已核对的暴露记录归档。" },
  },
}

const resourceCopy: Readonly<Record<SafeControlResourceKind, LocalCopy>> = {
  filesystem: { en: "Files and folders", zh: "文件与目录" },
  gitMetadata: { en: "Git state", zh: "Git 状态" },
  git: { en: "Git repository", zh: "Git 仓库" },
  branch: { en: "Git branch", zh: "Git 分支" },
  commit: { en: "Git commit", zh: "Git 提交" },
  reservation: { en: "Workspace reservation", zh: "工作区预留" },
  skill: { en: "Managed skill", zh: "受管技能" },
  plugin: { en: "Managed plugin", zh: "受管插件" },
  recovery: { en: "Recovery receipt", zh: "恢复凭据" },
  session: { en: "Session history", zh: "会话历史" },
  project: { en: "Project", zh: "项目" },
  process: { en: "Local Git helper process", zh: "本地 Git 辅助进程" },
  snapshot: { en: "File snapshot", zh: "文件快照" },
  sharing: { en: "Share publication", zh: "分享发布" },
  organization: { en: "Organization", zh: "组织" },
  evolution: { en: "Evolution governance record", zh: "Evolution 治理记录" },
}

function local(copy: LocalCopy, locale: string) {
  return locale === "zh" || locale === "zht" ? copy.zh : copy.en
}

function actionLabel(action: SafeControlAction | undefined, t: Translate, locale: string) {
  return action ? local(actionCopy[action].label, locale) : t("controlApproval.detailsUnavailable")
}

function actionReason(action: SafeControlAction | undefined, t: Translate, locale: string) {
  return action ? local(actionCopy[action].reason, locale) : t("controlApproval.detailsUnavailable")
}

function resourceLabel(kind: SafeControlResourceKind, locale: string) {
  return local(resourceCopy[kind], locale)
}

function resourceSummary(resources: ReturnType<typeof safeControlResourceKinds>, t: Translate, locale: string) {
  const labels = resources.kinds.map((kind) => resourceLabel(kind, locale))
  if (resources.unavailable) labels.push(t("controlApproval.detailsUnavailable"))
  return labels.join(" · ") || t("controlApproval.detailsUnavailable")
}

function metadataLabel(detail: SafeControlMetadataDetail, t: Translate) {
  if (detail.field === "riskTier") return t("controlApproval.metadata.riskTier")
  if (detail.field === "idempotency") return t("controlApproval.metadata.idempotency")
  if (detail.field === "reversibility") return t("controlApproval.metadata.reversibility")
  if (detail.field === "retryability") return t("controlApproval.metadata.retryability")
  return t("controlApproval.metadata.policyVersion")
}

function metadataValue(detail: SafeControlMetadataDetail, t: Translate) {
  if (typeof detail.value === "boolean") return detail.value ? t("controlApproval.yes") : t("controlApproval.no")
  if (detail.field === "riskTier") {
    if (detail.value === "low") return t("controlApproval.risk.low")
    if (detail.value === "medium") return t("controlApproval.risk.medium")
    if (detail.value === "high") return t("controlApproval.risk.high")
    return t("controlApproval.risk.critical")
  }
  return detail.value
}

function ApprovalCard(props: { item: PendingControlApproval }) {
  const approval = useControlApproval()
  const language = useLanguage()
  const t = language.t
  const action = () => knownControlAction(props.item.action)
  const resources = () => safeControlResourceKinds(props.item.resources)
  const metadata = () => safeControlMetadataDetails(props.item.metadata)
  const canApprove = () => !!action() && resources().kinds.length > 0 && !resources().unavailable
  const headingID = controlApprovalDOMID(props.item.approvalKey)
  const directory = () =>
    isSafeControlLocation(props.item.subject.location)
      ? props.item.subject.location
      : t("controlApproval.detailsUnavailable")
  const project = () => shortControlIdentifier(props.item.subject.project) ?? t("controlApproval.detailsUnavailable")
  const approvalRequest = () => shortControlIdentifier(props.item.id) ?? t("controlApproval.detailsUnavailable")
  const controlRequest = () =>
    shortControlIdentifier(props.item.subject.requestID) ?? t("controlApproval.detailsUnavailable")

  const reply = async (value: ControlApprovalReply) => {
    await approval.reply(props.item, value)
  }
  const busy = () => approval.busy(props.item)
  const error = () => approval.error(props.item)

  return (
    <article
      class="flex flex-col gap-3 rounded-lg border border-border-danger bg-surface-critical-subtle p-4"
      aria-labelledby={headingID}
      aria-busy={busy()}
      data-testid="control-approval-card"
      data-arforge-management="approval"
    >
      <header class="flex items-start gap-3">
        <Icon name="warning" size="normal" class="mt-0.5 shrink-0 text-text-danger" aria-hidden="true" />
        <div class="min-w-0 flex-1">
          <h2 id={headingID} class="break-words text-14-medium text-text-strong">
            {actionLabel(action(), t, language.locale())}
          </h2>
          <p class="mt-1 text-12-regular text-text-danger">{t("controlApproval.waiting")}</p>
        </div>
      </header>

      <p class="break-all text-11-regular text-text-weak">
        {safeControlServerLabel(props.item.serverKey)} / {props.item.sourceID}
      </p>
      <dl class="grid gap-2 text-12-regular sm:grid-cols-2">
        <div>
          <dt class="text-text-weak">{t("controlApproval.impact")}</dt>
          <dd class="mt-0.5 break-words text-text-strong">{resourceSummary(resources(), t, language.locale())}</dd>
        </div>
        <div>
          <dt class="text-text-weak">{t("controlApproval.project")}</dt>
          <dd class="mt-0.5 break-all text-text-strong">{project()}</dd>
        </div>
        <div class="sm:col-span-2">
          <dt class="text-text-weak">{t("controlApproval.directory")}</dt>
          <dd class="mt-0.5 break-all text-text-strong">{directory()}</dd>
        </div>
        <div class="sm:col-span-2">
          <dt class="text-text-weak">{t("controlApproval.reason")}</dt>
          <dd class="mt-0.5 break-words text-text-strong">{actionReason(action(), t, language.locale())}</dd>
        </div>
      </dl>

      <details class="rounded-md border border-border-weak-base bg-background-base p-3">
        <summary class="cursor-pointer text-12-medium text-text-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-border-focus">
          {t("controlApproval.technicalDetails")}
        </summary>
        <dl class="mt-3 grid gap-2 text-11-regular text-text-weak">
          <div>
            <dt>{t("controlApproval.approvalRequest")}</dt>
            <dd class="mt-0.5 break-all text-text-strong">{approvalRequest()}</dd>
          </div>
          <div>
            <dt>{t("controlApproval.controlRequest")}</dt>
            <dd class="mt-0.5 break-all text-text-strong">{controlRequest()}</dd>
          </div>
          <div>
            <dt>{t("controlApproval.resources")}</dt>
            <dd class="mt-1">
              <ul class="list-disc space-y-1 pl-5 text-text-strong">
                <For each={resources().kinds}>{(kind) => <li>{resourceLabel(kind, language.locale())}</li>}</For>
                <Show when={resources().unavailable}>
                  <li>{t("controlApproval.detailsUnavailable")}</li>
                </Show>
              </ul>
            </dd>
          </div>
          <Show when={metadata().length > 0}>
            <div>
              <dt>{t("controlApproval.metadata")}</dt>
              <dd class="mt-1 grid gap-1 text-text-strong">
                <For each={metadata()}>
                  {(detail) => (
                    <span>
                      {metadataLabel(detail, t)}: {metadataValue(detail, t)}
                    </span>
                  )}
                </For>
              </dd>
            </div>
          </Show>
        </dl>
      </details>

      <Show when={error()}>
        {(value) => (
          <div role="alert" class="rounded-md border border-border-danger p-3 text-12-regular text-text-danger">
            {value()} {t("controlApproval.retryHint")}
          </div>
        )}
      </Show>
      <Show when={!canApprove()}>
        <p role="status" class="rounded-md border border-border-weak-base p-3 text-12-regular text-text-weak">
          {t("controlApproval.approvalUnavailable")}
        </p>
      </Show>
      <div class="flex flex-wrap gap-2 border-t border-border-weak-base pt-3">
        <ButtonV2
          type="button"
          size="small"
          variant={busy() ? "loading" : "danger"}
          disabled={busy()}
          onClick={() => void reply("reject")}
        >
          {busy() ? t("controlApproval.replying") : t("controlApproval.reject")}
        </ButtonV2>
        <Show when={canApprove()}>
          <ButtonV2
            type="button"
            size="small"
            variant={busy() ? "loading" : "contrast"}
            disabled={busy()}
            onClick={() => void reply("once")}
          >
            {busy() ? t("controlApproval.replying") : t("controlApproval.approveOnce")}
          </ButtonV2>
        </Show>
      </div>
    </article>
  )
}

export function ControlApprovalDialog() {
  const approval = useControlApproval()
  const language = useLanguage()
  const t = language.t


  return (
    <Dialog
      title={t("controlApproval.title")}
      description={t("controlApproval.description")}
      size="large"
      class="max-h-[min(760px,calc(100dvh-3rem))]"
    >
      <section
        class="flex max-h-[min(620px,calc(100dvh-12rem))] flex-col gap-4 overflow-y-auto pr-1"
        aria-label={t("controlApproval.title")}
        data-testid="control-approval-dialog"
        data-arforge-management="approval"
        aria-busy={approval.loading()}
      >
        <p class="rounded-md border border-border-weak-base bg-background-base p-3 text-12-regular text-text-strong">
          {t("controlApproval.manualOnly")}
        </p>
        <Show when={approval.loading()}>
          <div
            role="status"
            aria-live="polite"
            class="rounded-md border border-border-weak-base p-3 text-12-regular text-text-weak"
          >
            {t("controlApproval.loading")}
          </div>
        </Show>
        <For each={approval.loadErrors()}>
          {(error) => (
            <div role="alert" class="rounded-md border border-border-danger p-3 text-12-regular text-text-danger">
              {error} {t("controlApproval.retryHint")}
            </div>
          )}
        </For>
        <For each={approval.receipts()}>
          {(receipt) => (
            <article class="rounded-md border border-border-weak-base p-3 text-12-regular"
              data-testid="control-approval-receipt"
              data-state={receipt.status}
              role={receipt.status === "failed" ? "alert" : "status"}
              aria-live={receipt.status === "failed" ? "assertive" : "polite"}>
              <strong>{receipt.status === "pending" ? t("controlApproval.replying")
                : receipt.status === "confirmed"
                  ? receipt.reply === "once" ? t("controlApproval.approved") : t("controlApproval.rejected")
                  : local({ en: "Reply not confirmed. Refresh and review before retrying.", zh: "回执未获确认，请刷新核对后再重试。" }, language.locale())}</strong>
              <p class="break-all">{receipt.server} / {receipt.sourceID}</p>
              <p class="break-all">{receipt.project} / {receipt.location}</p>
              <p class="break-all">{t("controlApproval.approvalRequest")}: {receipt.requestID}</p>
              <p class="break-all">{t("controlApproval.controlRequest")}: {receipt.controlRequestID}</p>
              <p>{receipt.reply === "once" ? t("controlApproval.approveOnce") : t("controlApproval.reject")}</p>
              <Show when={receipt.error}><p class="break-words text-text-danger">{receipt.error}</p></Show>
            </article>
          )}
        </For>
        <Show
          when={approval.items().length > 0}
          fallback={
            <Show when={!approval.loading() && approval.loadErrors().length === 0}>
              <p role="status" class="arforge-management-empty">{t("controlApproval.empty")}</p>
            </Show>
          }
        >
          <For each={approval.items()}>{(item) => <ApprovalCard item={item} />}</For>
        </Show>
        <div class="flex justify-end border-t border-border-weak-base pt-3">
          <ButtonV2
            type="button"
            size="small"
            variant="outline"
            disabled={approval.loading()}
            onClick={() => void approval.refresh()}
          >
            {t("controlApproval.refresh")}
          </ButtonV2>
        </div>
      </section>
    </Dialog>
  )
}

/** Always-visible launcher; the backing approval state is server-backed and survives reloads. */
export function useControlApprovalLauncher() {
  const approval = useControlApproval()
  const dialog = useDialog()
  const language = useLanguage()
  const count = () => approval.count()
  const label = () => language.t("controlApproval.launcher")
  const accessibleLabel = () =>
    count() > 0
      ? language.t("controlApproval.launcherPending", { count: count() })
      : language.t("controlApproval.launcher")
  const open = () => {
    void approval.refresh()
    // Approval is often launched while a settings or Session-control dialog is
    // already open. Keep that user context beneath the approval layer so
    // closing the decision returns to the operation that requested it.
    void dialog.push(() => <ControlApprovalDialog />)
  }

  return {
    count,
    label,
    accessibleLabel,
    open,
    refresh: approval.refresh,
    registerLocation: approval.registerLocation,
  }
}

export function ControlApprovalCenter() {
  const launcher = useControlApprovalLauncher()

  return (
    <div class="fixed bottom-4 right-4 z-[80] max-w-[calc(100vw-2rem)]">
      <ButtonV2
        type="button"
        size="small"
        variant={launcher.count() > 0 ? "warning" : "outline"}
        icon="warning"
        aria-haspopup="dialog"
        aria-label={launcher.accessibleLabel()}
        onClick={launcher.open}
      >
        {launcher.accessibleLabel()}
      </ButtonV2>
    </div>
  )
}

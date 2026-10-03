import { Button } from "@arforge-ai/ui/button"
import { For, Show, createEffect, createSignal, type JSX } from "solid-js"
import type { OperationsApi } from "@/utils/server"
import { useLanguage, type Locale } from "@/context/language"
import { useNavigate } from "@solidjs/router"
import { useDialog } from "@arforge-ai/ui/context/dialog"
import { base64Encode } from "@arforge-ai/core/util/encode"
import { useControlCenterText } from "./control-center-text"
import { createScopeRequestGuard, type ScopeRequestToken } from "@/utils/scope-request"
import type { ArforgeSettingsValue } from "./navigation"
import type { SessionSettingsValue } from "@/components/session/session-settings-navigation"
import { attentionAction, attentionDetail, attentionTitle, type AttentionTarget } from "./personal-workspace-attention"
import { MemoryCandidateReviewCard } from "./memory-candidate-review"
import {
  formatWorkspaceTime,
  childReceiptPresentation,
  personalJobApprovalLabel,
  riskTierLabel,
  runAuthorityLabel,
  runInitiatorLabel,
  statusLabel,
  visibilityLabel,
  workspaceCopy,
} from "./personal-workspace-presentation"

type LocationInput = {
  location: {
    directory: string
    workspace?: string
  }
}
type Snapshot = Awaited<ReturnType<OperationsApi["personalWorkspace"]["snapshot"]>>
type ChildGroup = Awaited<ReturnType<OperationsApi["subagentControl"]["children"]>>
type ChildSummary = ChildGroup["children"][number]

const formatMicros = (value: number) => `${value.toLocaleString()} µ`
const publicError = (error: unknown) => (error instanceof Error ? error.message : String(error))
const isAttentionAnchor = (target: AttentionTarget): target is `#${string}` => target.startsWith("#")
const terminalChild = (status: string) => status === "completed" || status === "failed" || status === "cancelled"
const controlRequestID = () => {
  const random =
    globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`
  return `cpr_ui_${random}`
}

export function PersonalWorkspace(props: {
  api: () => OperationsApi
  location: () => LocationInput
  ready: () => boolean
  sessionID?: string
  onNavigate?: (value: ArforgeSettingsValue | SessionSettingsValue) => void
}) {
  const t = useControlCenterText()
  const language = useLanguage()
  const navigate = useNavigate()
  const dialog = useDialog()
  const copy = () => workspaceCopy(language.locale())
  const [snapshot, setSnapshot] = createSignal<Snapshot>()
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal("")
  const [showAllSessions, setShowAllSessions] = createSignal(false)
  const [showAllTasks, setShowAllTasks] = createSignal(false)
  const [showAllJobs, setShowAllJobs] = createSignal(false)
  const [reviewCandidateID, setReviewCandidateID] = createSignal<string>()
  const [candidateNotice, setCandidateNotice] = createSignal<string>()
  const [childGroups, setChildGroups] = createSignal<ChildGroup[]>([])
  const [childrenLoading, setChildrenLoading] = createSignal(false)
  const locationScopeKey = () => {
    const value = props.location().location
    return value.directory + "\u0000" + (value.workspace ?? "")
  }
  const scopeGuard = createScopeRequestGuard(locationScopeKey)
  let activeLoad: ScopeRequestToken | undefined

  const loadChildren = async (data: Snapshot, requestedLocation: LocationInput, request: ScopeRequestToken) => {
    if (!scopeGuard.isCurrent(request)) return
    const candidateParents = data.runs.slice(0, 12)
    if (candidateParents.length === 0) {
      if (scopeGuard.isCurrent(request)) setChildGroups([])
      return
    }
    setChildrenLoading(true)
    try {
      const results = await Promise.all(
        candidateParents.map(async (run) => {
          try {
            return await props.api().subagentControl.children({
              parentRunID: run.runID,
              location: requestedLocation.location,
            })
          } catch {
            // A failed or unauthorized parent query must not expose its
            // children or block the other authorized groups.
            return undefined
          }
        }),
      )
      if (scopeGuard.isCurrent(request))
        setChildGroups(results.filter((result): result is ChildGroup => result !== undefined))
    } finally {
      if (scopeGuard.isCurrent(request)) setChildrenLoading(false)
    }
  }

  const load = async (force = false) => {
    if (!props.ready()) return
    if (activeLoad && !force) return
    const request = scopeGuard.capture()
    activeLoad = request
    const requestedLocation = props.location()
    setLoading(true)
    setError("")
    try {
      const next = await props.api().personalWorkspace.snapshot({ ...requestedLocation, limit: 50 })
      if (!scopeGuard.isCurrent(request)) return
      setSnapshot(next)
      void loadChildren(next, requestedLocation, request)
    } catch (cause) {
      if (scopeGuard.isCurrent(request)) {
        setError(publicError(cause))
        setChildGroups([])
      }
    } finally {
      if (activeLoad?.key === request.key && activeLoad.generation === request.generation) activeLoad = undefined
      if (scopeGuard.isCurrent(request)) setLoading(false)
    }
  }

  let previousScopeKey: string | undefined
  createEffect(() => {
    const scopeKey = (props.ready() ? "ready" : "not-ready") + "\u0000" + locationScopeKey()
    const scopeChanged = previousScopeKey !== undefined && previousScopeKey !== scopeKey
    previousScopeKey = scopeKey
    const request = scopeGuard.current()
    if (!props.ready()) {
      if (scopeGuard.isCurrent(request)) {
        setLoading(false)
        setChildrenLoading(false)
        setSnapshot(undefined)
        setChildGroups([])
      }
      return
    }
    if (scopeChanged) {
      setLoading(false)
      setChildrenLoading(false)
      setSnapshot(undefined)
      setChildGroups([])
      setError("")
      setCandidateNotice(undefined)
    }
    void load(scopeChanged)
  })

  const focusSection = (target: `#${string}`) => {
    const element = document.querySelector<HTMLElement>(target)
    element?.scrollIntoView({ behavior: "smooth", block: "start" })
    element?.focus({ preventScroll: true })
  }

  const openSession = (sessionID: string) => {
    dialog.close()
    if (sessionID === props.sessionID) return
    navigate(`/${base64Encode(props.location().location.directory)}/session/${encodeURIComponent(sessionID)}`)
  }

  const runAttentionAction = (target: AttentionTarget, item: Snapshot["attention"][number]) => {
    if (isAttentionAnchor(target)) {
      if (item.kind === "memory_candidate") setReviewCandidateID(item.resourceID)
      return focusSection(target)
    }
    if (target === "session-automation" && item.sessionID !== props.sessionID) {
      if (!item.sessionID) return
      openSession(item.sessionID)
      return
    }
    props.onNavigate?.(target)
  }

  return (
    <section
      class="flex flex-col gap-4"
      aria-busy={loading() || childrenLoading()}
      data-testid="control-center-personal-workspace"
    >
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 class="text-14-medium text-text-strong">{copy().title}</h3>
          <p class="mt-1 max-w-3xl text-11-regular leading-5 text-text-weak">{copy().safety}</p>
        </div>
        <Button variant="secondary" size="small" disabled={loading() || !props.ready()} onClick={() => void load()}>
          {loading() ? copy().loading : t("刷新")}
        </Button>
      </div>

      <Show when={error()}>
        <div
          class="rounded-md border border-border-warning bg-background-base p-3 text-11-regular text-text-warning"
          role="alert"
        >
          {error()}
        </div>
      </Show>
      <Show when={!props.ready() && !error()}>
        <div
          class="rounded-md border border-border-weak-base bg-background-weak p-3 text-11-regular text-text-weak"
          role="status"
        >
          {t("正在解析工作区…")}
        </div>
      </Show>
      <Show when={props.ready() && !loading() && !snapshot() && !error()}>
        <div
          class="rounded-md border border-border-weak-base bg-background-weak p-3 text-11-regular text-text-weak"
          role="status"
        >
          {copy().unavailable}
        </div>
      </Show>

      <Show when={snapshot()} keyed>
        {(data) => {
          return (
            <>
              <div
                id="personal-workspace-cost"
                tabindex="-1"
                class="grid scroll-mt-4 grid-cols-2 gap-2 outline-none md:grid-cols-4"
              >
                <Metric
                  label={copy().sessions}
                  value={data.counts.sessions}
                  detail={`${data.counts.activeSessions} ${copy().active}`}
                />
                <Metric
                  label={copy().tasks}
                  value={data.counts.tasks}
                  detail={`${data.counts.pendingTasks} ${copy().pending}`}
                />
                <Metric
                  label={copy().runs}
                  value={data.counts.runs}
                  detail={`${data.counts.recoveringRuns} ${copy().recovery}`}
                />
                <Metric
                  label={copy().jobs}
                  value={data.counts.personalJobs}
                  detail={`${data.counts.pendingApprovals} ${copy().approvals}`}
                />
                <Metric label={copy().artifacts} value={data.counts.artifacts} detail={copy().artifactDetail} />
                <Metric label={copy().memories} value={data.counts.memoryCandidates} detail={copy().safeMetadata} />
                <Metric
                  label={copy().runCost}
                  value={formatMicros(data.cost.runUsedMicros)}
                  detail={`${copy().of} ${formatMicros(data.cost.runLimitMicros)}`}
                />
                <Metric
                  label={copy().jobCost}
                  value={formatMicros(data.cost.jobUsedMicros)}
                  detail={`${copy().of} ${formatMicros(data.cost.jobLimitMicros)}`}
                />
              </div>

              <div class="rounded-md border border-border-weak-base bg-background-weak p-3 text-11-regular text-text-weak">
                <div class="flex flex-wrap gap-x-4 gap-y-1">
                  <span>
                    {copy().project}: {data.project.id}
                  </span>
                  <span>
                    {copy().location}: {data.location.directory}
                  </span>
                  <span>
                    {copy().asOf}: {formatWorkspaceTime(data.asOf, language.locale())}
                  </span>
                </div>
                <div class="mt-2 text-10-regular text-text-weak">{copy().safetyNote}</div>
              </div>

              <Show when={data.attention.length > 0}>
                <section class="flex flex-col gap-2" aria-labelledby="personal-workspace-attention">
                  <div class="flex items-center justify-between gap-2">
                    <h4 id="personal-workspace-attention" class="text-12-medium text-text-strong">
                      {copy().attention}
                    </h4>
                    <span class="text-10-regular text-text-weak">
                      {data.attention.length} {copy().entries}
                    </span>
                  </div>
                  <div class="grid gap-2 md:grid-cols-2">
                    <For each={data.attention}>
                      {(item) => {
                        const action = () =>
                          attentionAction(
                            item.kind,
                            language.locale(),
                            item.resourceType,
                            !!item.sessionID && item.sessionID !== props.sessionID,
                          )
                        return (
                          <article
                            class="rounded-md border border-border-weak-base bg-background-base p-3"
                            classList={{ "border-border-warning": item.severity !== "info" }}
                          >
                            <div class="flex flex-wrap items-center justify-between gap-2">
                              <strong class="text-11-medium text-text-strong">
                                {attentionTitle(item.kind, item.title, language.locale(), item.resourceType)}
                              </strong>
                              <span class="text-10-regular text-text-weak">
                                {statusLabel(item.kind, language.locale())}
                              </span>
                            </div>
                            <p class="mt-1 text-11-regular text-text-weak">
                              {attentionDetail(item.kind, item.detail, language.locale(), item.resourceType)}
                            </p>
                            <code class="mt-2 block truncate text-10-regular text-text-weak">{item.resourceID}</code>
                            <Show when={action()}>
                              {(value) => (
                                <Button
                                  variant="secondary"
                                  size="small"
                                  class="mt-3"
                                  data-testid={
                                    item.kind === "recovery_required"
                                      ? "recovery-details-action"
                                      : `attention-action-${item.kind}`
                                  }
                                  aria-label={`${value().label}: ${item.resourceID}`}
                                  onClick={() => runAttentionAction(value().target, item)}
                                >
                                  {value().label}
                                </Button>
                              )}
                            </Show>
                          </article>
                        )
                      }}
                    </For>
                  </div>
                </section>
              </Show>
              <Show when={data.attention.length === 0}>
                <div
                  class="rounded-md border border-border-success bg-background-base p-3 text-11-regular text-text-success"
                  role="status"
                >
                  {copy().noAttention}
                </div>
              </Show>

              <ProjectionSection title={copy().sessions} count={data.sessions.length}>
                <div class="grid gap-2 md:grid-cols-2">
                  <For each={showAllSessions() ? data.sessions : data.sessions.slice(0, 8)}>
                    {(session) => (
                      <article
                        class="rounded-md border border-border-weak-base bg-background-base p-3"
                        data-testid="personal-workspace-session-card"
                      >
                        <div class="flex items-center justify-between gap-2">
                          <strong class="truncate text-11-medium text-text-strong">
                            {session.title || session.id}
                          </strong>
                          <StateBadge state={session.state} locale={language.locale()} />
                        </div>
                        <div class="mt-2 grid grid-cols-3 gap-2 text-10-regular text-text-weak">
                          <span>
                            {session.taskCount} {copy().counts.tasks}
                          </span>
                          <span>
                            {session.runCount} {copy().counts.runs}
                          </span>
                          <span>
                            {session.personalJobCount} {copy().counts.jobs}
                          </span>
                        </div>
                        <code class="mt-2 block truncate text-10-regular text-text-weak">{session.id}</code>
                        <Button variant="secondary" size="small" class="mt-3" onClick={() => openSession(session.id)}>
                          {copy().openSession}
                        </Button>
                      </article>
                    )}
                  </For>
                </div>
                <Show when={data.sessions.length > 8}>
                  <Button
                    variant="secondary"
                    size="small"
                    class="self-start"
                    onClick={() => setShowAllSessions((value) => !value)}
                  >
                    {showAllSessions() ? copy().showLess : `${copy().showAll} (${data.sessions.length})`}
                  </Button>
                </Show>
              </ProjectionSection>

              <ProjectionSection title={copy().tasks} count={data.tasks.length}>
                <div class="grid gap-2 md:grid-cols-2">
                  <For each={showAllTasks() ? data.tasks : data.tasks.slice(0, 8)}>
                    {(task) => (
                      <article
                        id={`personal-workspace-task-${task.id}`}
                        class="rounded-md border border-border-weak-base bg-background-base p-3"
                        data-testid="personal-workspace-task-card"
                      >
                        <div class="flex flex-wrap items-center justify-between gap-2">
                          <strong class="text-11-medium text-text-strong">{task.title}</strong>
                          <StateBadge state={task.state} locale={language.locale()} />
                        </div>
                        <div class="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-10-regular text-text-weak">
                          <span>{statusLabel(task.status, language.locale())}</span>
                          <span classList={{ "text-text-warning": task.unresolvedBlockers > 0 }}>
                            {copy().blockers}: {task.unresolvedBlockers}
                          </span>
                          <span>
                            {copy().updated} {formatWorkspaceTime(task.updatedAt, language.locale())}
                          </span>
                        </div>
                        <code class="mt-2 block truncate text-10-regular text-text-weak">{task.id}</code>
                        <Button
                          variant="secondary"
                          size="small"
                          class="mt-3"
                          onClick={() => openSession(task.sessionID)}
                        >
                          {copy().openSession}
                        </Button>
                      </article>
                    )}
                  </For>
                </div>
                <Show when={data.tasks.length > 8}>
                  <Button
                    variant="secondary"
                    size="small"
                    class="self-start"
                    onClick={() => setShowAllTasks((value) => !value)}
                  >
                    {showAllTasks() ? copy().showLess : `${copy().showAll} (${data.tasks.length})`}
                  </Button>
                </Show>
              </ProjectionSection>

              <div id="personal-workspace-jobs" tabindex="-1" class="scroll-mt-4 outline-none">
                <ProjectionSection title={copy().jobs} count={data.personalJobs.length}>
                  <div class="grid gap-2 md:grid-cols-2">
                    <For each={showAllJobs() ? data.personalJobs : data.personalJobs.slice(0, 8)}>
                      {(job) => (
                        <article class="rounded-md border border-border-weak-base bg-background-base p-3">
                          <div class="flex flex-wrap items-center justify-between gap-2">
                            <strong class="text-11-medium text-text-strong">{job.title}</strong>
                            <StateBadge state={job.state} locale={language.locale()} />
                          </div>
                          <div class="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-10-regular text-text-weak">
                            <span>{visibilityLabel(job.visibility.mode, language.locale())}</span>
                            <span>{statusLabel(job.status, language.locale())}</span>
                            <span>{personalJobApprovalLabel(job.approvalState, language.locale())}</span>
                            <span>
                              {job.artifactCount} {copy().counts.artifacts}
                            </span>
                          </div>
                          <div class="mt-2 text-10-regular text-text-weak">
                            {formatMicros(job.budget.costMicrosUsed)} / {formatMicros(job.budget.maxCostMicros)} ·{" "}
                            {copy().next} {formatWorkspaceTime(job.nextRunAt, language.locale())}
                          </div>
                        </article>
                      )}
                    </For>
                  </div>
                  <Show when={data.personalJobs.length > 8}>
                    <Button
                      variant="secondary"
                      size="small"
                      class="self-start"
                      onClick={() => setShowAllJobs((value) => !value)}
                    >
                      {showAllJobs() ? copy().showLess : `${copy().showAll} (${data.personalJobs.length})`}
                    </Button>
                  </Show>
                </ProjectionSection>
              </div>

              <ProjectionSection title={copy().runs} count={data.runs.length}>
                <div class="grid gap-2 md:grid-cols-2">
                  <For each={data.runs}>
                    {(run) => (
                      <article class="rounded-md border border-border-weak-base bg-background-base p-3">
                        <div class="flex flex-wrap items-center justify-between gap-2">
                          <code class="truncate text-10-regular text-text-weak">{run.runID}</code>
                          <StateBadge state={run.state} locale={language.locale()} />
                        </div>
                        <div class="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-10-regular text-text-weak">
                          <span>{statusLabel(run.status, language.locale())}</span>
                          <span>
                            {copy().initiatedBy}: {runInitiatorLabel(run.initiator, language.locale())}
                          </span>
                          <span>{runAuthorityLabel(run.authority, language.locale())}</span>
                          <span>{riskTierLabel(run.riskTier, language.locale())}</span>
                          <Show when={run.recoveryRequired}>
                            <span class="text-text-warning">{statusLabel("recovery_required", language.locale())}</span>
                          </Show>
                        </div>
                        <div class="mt-2 text-10-regular text-text-weak">
                          {formatMicros(run.budget.costMicrosUsed)} / {formatMicros(run.budget.maxCostMicros)} ·{" "}
                          {copy().updated} {formatWorkspaceTime(run.updatedAt, language.locale())}
                        </div>
                      </article>
                    )}
                  </For>
                </div>
              </ProjectionSection>

              <ProjectionSection
                title={copy().delegatedChildren}
                count={childGroups().reduce((total, group) => total + group.children.length, 0)}
              >
                <p class="text-10-regular text-text-weak">{copy().delegatedChildrenHint}</p>
                <Show when={childrenLoading()}>
                  <div class="rounded-md border border-border-weak-base bg-background-weak p-3 text-11-regular text-text-weak">
                    {copy().loading}
                  </div>
                </Show>
                <Show
                  when={!childrenLoading() && childGroups().some((group) => group.children.length > 0)}
                  fallback={
                    <Show when={!childrenLoading()}>
                      <div
                        class="rounded-md border border-border-weak-base bg-background-weak p-3 text-11-regular text-text-weak"
                        role="status"
                      >
                        {copy().noDelegatedChildren}
                      </div>
                    </Show>
                  }
                >
                  <div class="flex flex-col gap-3">
                    <For each={childGroups().filter((group) => group.children.length > 0)}>
                      {(group) => (
                        <div class="rounded-md border border-border-weak-base bg-background-base p-3">
                          <div class="flex flex-wrap items-center justify-between gap-2">
                            <span class="text-10-regular text-text-weak">{copy().initiatedBy}</span>
                            <code class="truncate text-10-regular text-text-weak">{group.parentRunID}</code>
                          </div>
                          <div class="mt-2 grid gap-2 md:grid-cols-2">
                            <For each={group.children}>
                              {(child) => (
                                <ChildControlCard
                                  api={props.api}
                                  location={props.location}
                                  child={child}
                                  parentRunID={group.parentRunID}
                                  controlAvailable={group.controlAvailable === true}
                                  locale={language.locale()}
                                  copy={copy()}
                                  onOpenSession={openSession}
                                  onChanged={() => load(true)}
                                />
                              )}
                            </For>
                          </div>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
              </ProjectionSection>

              <div id="personal-workspace-memory-candidates" tabindex="-1" class="scroll-mt-4 outline-none">
                <ProjectionSection title={copy().memories} count={data.memoryCandidates.length}>
                  <Show when={candidateNotice()}>
                    {(message) => (
                      <p
                        class="rounded-md border border-border-success bg-background-base p-2 text-11-regular text-text-success"
                        role="status"
                      >
                        {message()}
                      </p>
                    )}
                  </Show>
                  <div class="grid gap-2 md:grid-cols-2">
                    <For each={data.memoryCandidates}>
                      {(candidate) => (
                        <MemoryCandidateReviewCard
                          api={props.api}
                          location={props.location}
                          candidate={candidate}
                          autoOpen={reviewCandidateID() === candidate.candidateID}
                          onChanged={(message, status) => {
                            setCandidateNotice(message)
                            const settled = status === "promoted" || status === "rejected"
                            if (settled) {
                              setSnapshot((current) => {
                                if (!current) return current
                                const memoryCandidates = current.memoryCandidates.filter(
                                  (item) => item.candidateID !== candidate.candidateID,
                                )
                                return {
                                  ...current,
                                  memoryCandidates,
                                  attention: current.attention.filter(
                                    (item) =>
                                      item.resourceType !== "memory_candidate" ||
                                      item.resourceID !== candidate.candidateID,
                                  ),
                                  counts: {
                                    ...current.counts,
                                    memoryCandidates: memoryCandidates.length,
                                  },
                                }
                              })
                              void load()
                            }
                          }}
                        />
                      )}
                    </For>
                  </div>
                </ProjectionSection>
              </div>
            </>
          )
        }}
      </Show>
    </section>
  )
}

type ChildWorkspaceCopy = ReturnType<typeof workspaceCopy>

/**
 * Direct-child controls deliberately live inside the metadata-only card. The
 * card never reads Core state or creates a second operation store: every
 * mutation goes through the generated subagentControl API and receives a new
 * request identity. A failed transport keeps that identity so Retry can
 * safely replay the same durable ActionGateway operation.
 */
export function ChildControlCard(props: {
  api: () => OperationsApi
  location: () => LocationInput
  child: ChildSummary
  parentRunID: string
  controlAvailable?: boolean
  locale: Locale
  copy: ChildWorkspaceCopy
  onOpenSession: (sessionID: string) => void
  onChanged: () => void | Promise<void>
}) {
  const [expanded, setExpanded] = createSignal(false)
  const [mode, setMode] = createSignal<"steer" | "followup">("steer")
  const [prompt, setPrompt] = createSignal("")
  const [reason, setReason] = createSignal("")
  const [timeoutMs, setTimeoutMs] = createSignal(5_000)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")
  const [notice, setNotice] = createSignal("")
  const [lastRequest, setLastRequest] = createSignal<{
    operation: "steer" | "followup" | "wait" | "cancel"
    requestID: string
    prompt?: string
    reason?: string
    timeoutMs?: number
  }>()

  const run = async (request: {
    operation: "steer" | "followup" | "wait" | "cancel"
    requestID?: string
    prompt?: string
    reason?: string
    timeoutMs?: number
  }) => {
    if (busy() || props.controlAvailable !== true) return
    setBusy(true)
    setError("")
    setNotice("")
    const requestID = request.requestID ?? controlRequestID()
    const saved = { ...request, requestID }
    setLastRequest(saved)
    try {
      const location = props.location()
      const base = {
        parentRunID: props.parentRunID,
        childRunID: props.child.childRunID,
        requestID,
        location: location.location,
      }
      let result: Awaited<ReturnType<OperationsApi["subagentControl"]["wait"]>>
      if (request.operation === "steer") {
        result = await props.api().subagentControl.steer({
          ...base,
          prompt: { text: request.prompt ?? "" },
        })
      } else if (request.operation === "followup") {
        result = await props.api().subagentControl.followup({
          ...base,
          prompt: { text: request.prompt ?? "" },
        })
      } else if (request.operation === "wait") {
        result = await props.api().subagentControl.wait({
          ...base,
          ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
        })
      } else {
        result = await props.api().subagentControl.cancel({
          ...base,
          reason: request.reason ?? "",
          ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
        })
      }
      setNotice(
        result.timedOut
          ? props.copy.controlTimedOut
          : request.operation === "wait"
            ? childReceiptPresentation(result.resultReceiptStatus, props.locale).detail
            : props.copy.controlAccepted,
      )
      setPrompt("")
      setReason("")
      props.onChanged()
    } catch (cause) {
      setError(publicError(cause))
    } finally {
      setBusy(false)
    }
  }

  const submitMessage = () => {
    const value = prompt().trim()
    if (!value) {
      setError(props.copy.promptRequired)
      return
    }
    void run({ operation: mode(), prompt: value })
  }

  const submitCancel = () => {
    const value = reason().trim()
    if (!value) {
      setError(props.copy.reasonRequired)
      return
    }
    void run({ operation: "cancel", reason: value, timeoutMs: timeoutMs() })
  }

  const retry = () => {
    const request = lastRequest()
    if (!request) return
    void run(request)
  }

  const terminal = () => terminalChild(props.child.status)
  const refresh = async () => {
    if (busy()) return
    setBusy(true)
    setError("")
    try {
      await props.onChanged()
    } catch (cause) {
      setError(publicError(cause))
    } finally {
      setBusy(false)
    }
  }
  const receipt = () => childReceiptPresentation(props.child.resultReceiptStatus, props.locale)
  return (
    <article
      class="rounded-md border border-border-weak-base bg-background-weak p-3"
      data-testid="personal-workspace-child-card"
    >
      <div class="flex flex-wrap items-center justify-between gap-2">
        <code class="truncate text-10-regular text-text-weak">{props.child.childRunID}</code>
        <div class="flex items-center gap-2">
          <span class="text-12-regular text-text-base">{props.copy.executionStatus}</span>
          <StateBadge state={props.child.status} locale={props.locale} />
        </div>
      </div>
      <div
        class="mt-2 rounded-md border border-border-weak-base bg-background-base p-2 text-12-regular leading-5 text-text-base"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid="personal-workspace-child-receipt"
      >
        <p class="font-medium">{receipt().label}</p>
        <p>{receipt().detail}</p>
      </div>
      <div class="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-10-regular text-text-weak">
        <span>
          {props.copy.childDepth}: {props.child.depth}
        </span>
        <span>
          {props.copy.objectiveDigest}: {props.child.objectiveDigest.slice(0, 12)}…
        </span>
      </div>
      <code class="mt-2 block truncate text-10-regular text-text-weak">{props.child.sessionID}</code>
      <Show when={props.controlAvailable !== true}>
        <p class="mt-2 text-12-regular text-text-base">{props.copy.readOnlyChild}</p>
      </Show>
      <Show when={error() && props.controlAvailable !== true}>
        <p role="alert" class="mt-2 text-12-regular text-text-warning">
          {error()}
        </p>
      </Show>
      <div class="mt-3 flex flex-wrap gap-2">
        <Button variant="secondary" size="small" onClick={() => props.onOpenSession(props.child.sessionID)}>
          {props.copy.openSession}
        </Button>
        <Button
          variant="secondary"
          size="small"
          disabled={busy()}
          onClick={() => void refresh()}
          data-testid="personal-workspace-child-refresh"
        >
          {busy() ? props.copy.working : props.copy.refreshChild}
        </Button>
        <Show when={props.controlAvailable === true}>
          <Button
            variant="secondary"
            size="small"
            aria-expanded={expanded()}
            data-testid="personal-workspace-child-control-toggle"
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded() ? props.copy.closeControl : props.copy.control}
          </Button>
        </Show>
      </div>

      <Show when={expanded() && props.controlAvailable === true}>
        <div class="mt-3 flex flex-col gap-2 border-t border-border-weak-base pt-3">
          <p class="text-10-regular leading-4 text-text-weak">{props.copy.controlHint}</p>
          <Show when={notice()}>
            <p
              class="rounded-md border border-border-weak-base bg-background-base p-2 text-12-regular text-text-base"
              role="status"
            >
              {notice()}
            </p>
          </Show>
          <Show when={error()}>
            <p
              class="rounded-md border border-border-warning bg-background-base p-2 text-10-regular text-text-warning"
              role="alert"
            >
              {error()}
            </p>
          </Show>
          <Show
            when={terminal()}
            fallback={
              <>
                <div class="flex flex-wrap gap-2" role="group" aria-label={props.copy.messageMode}>
                  <Button
                    variant={mode() === "steer" ? "primary" : "secondary"}
                    size="small"
                    data-testid="personal-workspace-child-steer"
                    disabled={busy()}
                    onClick={() => setMode("steer")}
                  >
                    {props.copy.steer}
                  </Button>
                  <Button
                    variant={mode() === "followup" ? "primary" : "secondary"}
                    size="small"
                    data-testid="personal-workspace-child-followup"
                    disabled={busy()}
                    onClick={() => setMode("followup")}
                  >
                    {props.copy.followup}
                  </Button>
                </div>
                <textarea
                  class="min-h-20 w-full resize-y rounded-md border border-border-weak-base bg-background-base p-2 text-11-regular text-text-base outline-none focus:border-border-info"
                  value={prompt()}
                  disabled={busy()}
                  placeholder={props.copy.promptPlaceholder}
                  aria-label={props.copy.promptPlaceholder}
                  onInput={(event) => setPrompt(event.currentTarget.value)}
                />
                <div class="flex flex-wrap gap-2">
                  <Button
                    variant="primary"
                    size="small"
                    data-testid="personal-workspace-child-send"
                    disabled={busy() || prompt().trim().length === 0}
                    onClick={submitMessage}
                  >
                    {busy() ? props.copy.working : mode() === "steer" ? props.copy.sendSteer : props.copy.sendFollowup}
                  </Button>
                  <Button
                    variant="secondary"
                    size="small"
                    data-testid="personal-workspace-child-wait"
                    disabled={busy()}
                    onClick={() => void run({ operation: "wait", timeoutMs: timeoutMs() })}
                  >
                    {props.copy.wait}
                  </Button>
                </div>
                <div class="flex flex-wrap items-end gap-2">
                  <label class="flex min-w-44 flex-1 flex-col gap-1 text-10-regular text-text-weak">
                    {props.copy.cancelReason}
                    <input
                      class="rounded-md border border-border-weak-base bg-background-base p-2 text-11-regular text-text-base outline-none focus:border-border-info"
                      value={reason()}
                      disabled={busy()}
                      placeholder={props.copy.reasonPlaceholder}
                      onInput={(event) => setReason(event.currentTarget.value)}
                    />
                  </label>
                  <label class="flex w-28 flex-col gap-1 text-10-regular text-text-weak">
                    {props.copy.timeout}
                    <select
                      class="rounded-md border border-border-weak-base bg-background-base p-2 text-11-regular text-text-base outline-none focus:border-border-info"
                      value={String(timeoutMs())}
                      disabled={busy()}
                      onChange={(event) => setTimeoutMs(Number(event.currentTarget.value))}
                    >
                      <option value="0">0s</option>
                      <option value="5000">5s</option>
                      <option value="60000">60s</option>
                    </select>
                  </label>
                  <Button
                    variant="secondary"
                    size="small"
                    data-testid="personal-workspace-child-cancel"
                    disabled={busy() || reason().trim().length === 0}
                    onClick={submitCancel}
                  >
                    {props.copy.cancel}
                  </Button>
                </div>
              </>
            }
          >
            <p class="text-10-regular text-text-weak">{props.copy.terminalControl}</p>
            <Button
              variant="secondary"
              size="small"
              data-testid="personal-workspace-child-terminal-wait"
              disabled={busy()}
              onClick={() => void run({ operation: "wait", timeoutMs: 0 })}
            >
              {props.copy.wait}
            </Button>
          </Show>
          <Show when={error() && lastRequest()}>
            <Button
              variant="ghost"
              size="small"
              data-testid="personal-workspace-child-retry"
              disabled={busy()}
              onClick={retry}
            >
              {props.copy.retry}
            </Button>
          </Show>
        </div>
      </Show>
    </article>
  )
}

function Metric(props: { label: string; value: string | number; detail: string }) {
  return (
    <div class="rounded-md border border-border-weak-base bg-background-base p-3">
      <div class="text-10-regular text-text-weak">{props.label}</div>
      <div class="mt-1 text-16-medium text-text-strong">{props.value}</div>
      <div class="mt-1 text-10-regular text-text-weak">{props.detail}</div>
    </div>
  )
}

function StateBadge(props: { state: string; locale: Locale }) {
  return (
    <span
      class="rounded-full border px-2 py-0.5 text-10-regular"
      classList={{
        "border-border-warning text-text-warning": props.state === "needs_human",
        "border-border-success text-text-success": props.state === "system_automatic",
        "border-border-weak-base text-text-weak": props.state !== "needs_human" && props.state !== "system_automatic",
      }}
    >
      {statusLabel(props.state, props.locale)}
    </span>
  )
}

function ProjectionSection(props: { title: string; count: number; children: JSX.Element }) {
  return (
    <section class="flex flex-col gap-2">
      <div class="flex items-center justify-between gap-2">
        <h4 class="text-12-medium text-text-strong">{props.title}</h4>
        <span class="text-10-regular text-text-weak">{props.count}</span>
      </div>
      {props.children}
    </section>
  )
}

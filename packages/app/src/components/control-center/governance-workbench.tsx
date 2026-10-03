import { useLanguage } from "@/context/language"
import type { OperationsApi } from "@/utils/server"
import { createScopeRequestGuard, type ScopeRequestToken } from "@/utils/scope-request"
import { Button } from "@arforge-ai/ui/button"
import { TextField } from "@arforge-ai/ui/text-field"
import { For, Show, createEffect, on, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { agentExtensionPublicError } from "./agent-extension-error"
import { formatTenantTime, shortDigest, tenantDataKindLabel, tenantStatusLabel } from "./tenant-platform-presentation"
import {
  buildSkillCandidatePayload,
  defaultSkillCandidateDraft,
  type SkillCandidateDraft,
  type SkillCandidateField,
  type SkillCandidateFormErrorCode,
  type SkillCandidateFormErrors,
} from "./skill-candidate-form"
import {
  buildSkillEvaluationPayload,
  createSkillEvaluationDrafts,
  skillEvaluationField,
  type SkillEvaluationFormErrorCode,
  type SkillEvaluationFormErrors,
  type SkillEvaluationObservationDraft,
  type SkillEvaluationResourceDraft,
  type SkillEvaluationResultChoice,
} from "./skill-evaluation-form"
import { skillDeploymentFieldLabel, skillEvaluationCheckLabel } from "./skill-lifecycle-presentation"
import { ArtifactEvidenceWorkbench } from "./artifact-evidence-workbench"

type LocationInput = {
  location: {
    directory: string
    workspace?: string
  }
}

type ExperienceCandidate = Awaited<
  ReturnType<OperationsApi["agentCapabilities"]["experienceCandidateList"]>
>["data"]["items"][number]
type SkillCandidate = Awaited<
  ReturnType<OperationsApi["agentCapabilities"]["skillLifecycleCandidateList"]>
>["data"]["items"][number]
type ExperienceSource = Awaited<
  ReturnType<OperationsApi["agentCapabilities"]["experienceSourceList"]>
>["data"]["items"][number]
type SkillEvaluation = Awaited<
  ReturnType<OperationsApi["agentCapabilities"]["skillLifecycleEvaluate"]>
>["data"]["report"]
type SkillCandidateDetail = Awaited<
  ReturnType<OperationsApi["agentCapabilities"]["skillLifecycleCandidateGet"]>
>["data"]
type SkillCanarySummary = SkillCandidateDetail["canary"]
type SkillDeployment = Awaited<ReturnType<OperationsApi["agentCapabilities"]["skillLifecycleDeploymentGet"]>>["data"]
type TenantOverview = Awaited<ReturnType<OperationsApi["tenantPlatform"]["overview"]>>
type TenantSecret = Awaited<ReturnType<OperationsApi["tenantPlatform"]["listSecrets"]>>[number]
type TenantDataRequest = Awaited<ReturnType<OperationsApi["tenantPlatform"]["requestData"]>>
type TenantBackup = Awaited<ReturnType<OperationsApi["tenantPlatform"]["createBackup"]>>
type TenantAudit = Awaited<ReturnType<OperationsApi["tenantPlatform"]["exportAudit"]>>
type ArtifactOwnerContext = Awaited<ReturnType<OperationsApi["artifacts"]["ownerContext"]>>
type ArtifactEvidenceScope = "profile" | "tenant"
type ExperienceStatus = "candidate" | "active" | "rejected" | "expired" | "all"
type SkillStatus = "draft" | "candidate" | "canary" | "active" | "retired" | "all"
type TenantDataKind = "tenant-export" | "tenant-delete"

const parseExperienceStatus = (value: string): ExperienceStatus | undefined => {
  switch (value) {
    case "candidate":
    case "active":
    case "rejected":
    case "expired":
    case "all":
      return value
    default:
      return undefined
  }
}

const parseSkillStatus = (value: string): SkillStatus | undefined => {
  switch (value) {
    case "draft":
    case "candidate":
    case "canary":
    case "active":
    case "retired":
    case "all":
      return value
    default:
      return undefined
  }
}

const parseTenantDataKind = (value: string): TenantDataKind | undefined => {
  switch (value) {
    case "tenant-export":
    case "tenant-delete":
      return value
    default:
      return undefined
  }
}

const errorText = (error: unknown, fallback: string) => {
  const message = agentExtensionPublicError(error, fallback)
  return /(?:\b[A-Za-z][\w]*(?:Error|Exception)\b|stack trace|(?:^|\n)\s*at\s+)/i.test(message) ? fallback : message
}

const cardClass = "flex flex-col gap-3 rounded-md border border-border-weak-base p-3"

// Governance workbench copy is intentionally colocated with the feature until
// these labels are promoted into the shared i18n catalog. The fallback keeps
// Traditional Chinese from silently rendering a Simplified Chinese sentence.
const simplifiedToTraditional: Record<string, string> = {
  与: "與",
  产: "產",
  仅: "僅",
  会: "會",
  决: "決",
  创: "創",
  删: "刪",
  发: "發",
  变: "變",
  启: "啟",
  务: "務",
  单: "單",
  区: "區",
  图: "圖",
  处: "處",
  备: "備",
  审: "審",
  导: "導",
  尝: "嘗",
  币: "幣",
  开: "開",
  当: "當",
  录: "錄",
  径: "徑",
  态: "態",
  执: "執",
  据: "據",
  数: "數",
  断: "斷",
  时: "時",
  晋: "晉",
  权: "權",
  条: "條",
  样: "樣",
  检: "檢",
  没: "沒",
  测: "測",
  滚: "滾",
  状: "狀",
  确: "確",
  类: "類",
  级: "級",
  组: "組",
  终: "終",
  经: "經",
  结: "結",
  绝: "絕",
  范: "範",
  观: "觀",
  视: "視",
  览: "覽",
  触: "觸",
  计: "計",
  订: "訂",
  记: "記",
  许: "許",
  证: "證",
  评: "評",
  试: "試",
  说: "說",
  请: "請",
  读: "讀",
  败: "敗",
  货: "貨",
  载: "載",
  输: "輸",
  边: "邊",
  过: "過",
  运: "運",
  适: "適",
  选: "選",
  采: "採",
  钟: "鐘",
  钥: "鑰",
  销: "銷",
  门: "門",
  项: "項",
  须: "須",
  额: "額",
  验: "驗",
  户: "戶",
  周: "週",
}

const traditionalize = (value: string) =>
  Array.from(value, (character) => simplifiedToTraditional[character] ?? character).join("")

function useUiCopy() {
  const language = useLanguage()
  return (english: string, simplifiedChinese: string, traditionalChinese?: string) => {
    const locale = language.locale()
    if (locale === "en") return english
    if (locale === "zht") return traditionalChinese ?? traditionalize(simplifiedChinese)
    if (locale === "zh") return simplifiedChinese
    return english
  }
}

const statusCopies: Record<string, readonly [english: string, simplified: string, traditional: string]> = {
  active: ["Active", "已启用", "已啟用"],
  approved: ["Approved", "已批准", "已批准"],
  canary: ["Canary", "灰度", "灰度"],
  candidate: ["Candidate", "候选", "候選"],
  draft: ["Draft", "草稿", "草稿"],
  expired: ["Expired", "已过期", "已過期"],
  pending: ["Pending review", "待审核", "待審核"],
  rejected: ["Rejected", "已拒绝", "已拒絕"],
  requested: ["Requested", "已请求", "已請求"],
  retired: ["Retired", "已退役", "已退役"],
}

function useStatusLabel() {
  const language = useLanguage()
  return (value: string) => {
    const copy = statusCopies[value]
    if (!copy) return value.replaceAll("_", " ")
    const locale = language.locale()
    return locale === "en" || (locale !== "zh" && locale !== "zht") ? copy[0] : locale === "zht" ? copy[2] : copy[1]
  }
}

function WorkbenchNotice(props: { error: string; notice: string }) {
  return (
    <>
      <Show when={props.error}>
        <div role="alert" class="rounded-md border border-border-danger p-3 text-12-regular text-text-danger">
          {props.error}
        </div>
      </Show>
      <Show when={props.notice}>
        <div role="status" class="rounded-md border border-border-weak-base p-3 text-12-regular text-text-weak">
          {props.notice}
        </div>
      </Show>
    </>
  )
}

function StatusBadge(props: { value: string }) {
  return (
    <span class="rounded-full border border-border-weak-base px-2 py-0.5 text-11-regular text-text-weak">
      {props.value}
    </span>
  )
}

export function ExperienceCandidateWorkbench(props: {
  api: () => OperationsApi
  location: () => LocationInput
  ready: () => boolean
}) {
  const t = useUiCopy()
  const statusLabel = useStatusLabel()
  const [state, setState] = createStore({
    loading: "",
    error: "",
    notice: "",
    status: "candidate" as ExperienceStatus,
    items: [] as ExperienceCandidate[],
    selected: undefined as ExperienceCandidate | undefined,
    reason: "",
  })

  const locationScopeKey = () => {
    const value = props.location().location
    return value.directory + "\u0000" + (value.workspace ?? "")
  }
  const scopeGuard = createScopeRequestGuard(locationScopeKey)
  let previousScopeKey: string | undefined

  const run = async (
    name: string,
    action: (location: LocationInput, request: ScopeRequestToken) => Promise<void>,
    notice = "",
  ) => {
    if (state.loading) return
    const request = scopeGuard.capture()
    const requestedLocation = props.location()
    setState({ loading: name, error: "", notice: "" })
    try {
      await action(requestedLocation, request)
      if (notice && scopeGuard.isCurrent(request)) setState("notice", notice)
    } catch (error) {
      if (scopeGuard.isCurrent(request))
        setState("error", errorText(error, t("Experience governance failed", "经验治理操作失败", "經驗治理操作失敗")))
    } finally {
      if (scopeGuard.isCurrent(request)) setState("loading", "")
    }
  }

  const load = async (
    status = state.status,
    requestedLocation = props.location(),
    request: ScopeRequestToken = scopeGuard.capture(),
  ) => {
    const result = await props.api().agentCapabilities.experienceCandidateList({
      ...requestedLocation,
      ...(status === "all" ? {} : { status }),
      limit: 100,
    })
    if (!scopeGuard.isCurrent(request)) return
    setState("items", [...result.data.items])
    if (state.selected && !result.data.items.some((item) => item.candidate_id === state.selected?.candidate_id))
      setState("selected", undefined)
  }

  const refresh = async (status = state.status) => {
    await run("refresh", (requestedLocation, request) => load(status, requestedLocation, request))
  }

  const select = (candidateID: string) =>
    void run(`detail:${candidateID}`, async (requestedLocation, request) => {
      const result = await props.api().agentCapabilities.experienceCandidateGet({
        ...requestedLocation,
        candidateID,
      })
      if (scopeGuard.isCurrent(request)) setState({ selected: result.data, reason: "" })
    })

  const review = (decision: "approve" | "reject") => {
    const candidate = state.selected
    const reason = state.reason.trim()
    if (!candidate) return
    if (!reason) {
      setState("error", t("A review reason is required.", "审核前必须填写理由。"))
      return
    }
    if (!window.confirm(`${decision}: ${candidate.candidate_id}\n\n${reason}`)) return
    void run(
      `review:${candidate.candidate_id}`,
      async (requestedLocation, request) => {
        const result = await props.api().agentCapabilities.experienceCandidateReview({
          ...requestedLocation,
          candidateID: candidate.candidate_id,
          expectedRevision: candidate.revision,
          decision,
          reason,
        })
        if (!scopeGuard.isCurrent(request)) return
        setState({ selected: result.data.candidate, reason: "" })
        await load(state.status, requestedLocation, request)
      },
      decision === "approve"
        ? t("Experience candidate approved.", "经验候选已批准。", "經驗候選已批准。")
        : t("Experience candidate rejected.", "经验候选已拒绝。", "經驗候選已拒絕。"),
    )
  }

  createEffect(
    on(
      () => (props.ready() ? "ready" : "not-ready") + "\u0000" + locationScopeKey(),
      (scopeKey) => {
        scopeGuard.current()
        const scopeChanged = previousScopeKey !== undefined && previousScopeKey !== scopeKey
        previousScopeKey = scopeKey
        if (!props.ready()) return
        if (scopeChanged) {
          setState({ loading: "", error: "", notice: "", items: [], selected: undefined, reason: "" })
        }
        void refresh()
      },
    ),
  )

  return (
    <section class={cardClass} data-testid="experience-candidate-workbench" aria-busy={!!state.loading}>
      <header class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 class="text-14-medium text-text-strong">{t("Experience candidates", "经验候选", "經驗候選")}</h2>
          <p class="mt-1 max-w-3xl text-12-regular text-text-weak">
            {t(
              "Review evidence-backed experience proposals here. Approval changes the durable candidate state; it does not silently alter source code or permissions.",
              "在这里审核有证据依据的经验提案。批准只改变持久候选状态，不会悄悄修改源代码或权限。",
              "在這裡審核有證據依據的經驗提案。批准只改變持久候選狀態，不會悄悄修改原始碼或權限。",
            )}
          </p>
        </div>
        <div class="flex items-center gap-2">
          <select
            aria-label={t("Experience status", "经验状态", "經驗狀態")}
            class="h-9 rounded-md border border-border-weak-base bg-background-base px-2 text-12-regular text-text-strong"
            value={state.status}
            onChange={(event) => {
              const status = parseExperienceStatus(event.currentTarget.value)
              if (!status) return
              setState("status", status)
              void refresh(status)
            }}
          >
            <option value="candidate">{t("Candidate", "候选", "候選")}</option>
            <option value="active">{t("Active", "已启用")}</option>
            <option value="rejected">{t("Rejected", "已拒绝")}</option>
            <option value="expired">{t("Expired", "已过期")}</option>
            <option value="all">{t("All", "全部")}</option>
          </select>
          <Button size="small" variant="ghost" disabled={!!state.loading} onClick={() => void refresh()}>
            {state.loading === "refresh" ? t("Loading…", "加载中…") : t("Refresh", "刷新")}
          </Button>
        </div>
      </header>
      <WorkbenchNotice error={state.error} notice={state.notice} />
      <Show
        when={state.items.length > 0}
        fallback={
          <p role="status" class="text-12-regular text-text-weak">
            {state.loading === "refresh"
              ? t("Loading candidates…", "正在加载候选…")
              : t("No candidates in this view.", "当前视图没有候选。")}
          </p>
        }
      >
        <div class="grid gap-2">
          <For each={state.items}>
            {(candidate) => (
              <button
                type="button"
                class="flex w-full flex-col gap-2 rounded-md border border-border-weak-base p-3 text-left transition-colors hover:bg-surface-raised"
                classList={{ "border-border-strong-base": state.selected?.candidate_id === candidate.candidate_id }}
                onClick={() => select(candidate.candidate_id)}
              >
                <div class="flex flex-wrap items-center justify-between gap-2">
                  <span class="text-13-medium text-text-strong">{candidate.problem_signature}</span>
                  <StatusBadge value={statusLabel(candidate.review_status)} />
                </div>
                <div class="grid gap-1 text-11-regular text-text-weak sm:grid-cols-3">
                  <span>
                    {t("Support", "支持")} {candidate.support_count}
                  </span>
                  <span>
                    {t("Scope", "作用域")} {candidate.applicable_scope}
                  </span>
                  <span>
                    {t("Revision", "修订")} {candidate.revision}
                  </span>
                </div>
              </button>
            )}
          </For>
        </div>
      </Show>
      <Show when={state.selected}>
        {(value) => (
          <article class={cardClass} aria-live="polite">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 class="text-13-medium text-text-strong">{value().problem_signature}</h3>
                <p class="text-11-regular text-text-weak">{value().candidate_id}</p>
              </div>
              <StatusBadge
                value={`${statusLabel(value().status)} · ${t("Revision", "修订", "修訂")} ${value().revision}`}
              />
            </div>
            <div class="grid gap-2 text-12-regular text-text-weak sm:grid-cols-2">
              <div>
                <strong class="text-text-strong">{t("Applicable scope", "适用范围")}:</strong>{" "}
                {value().applicable_scope}
              </div>
              <div>
                <strong class="text-text-strong">{t("Attempted strategy", "尝试策略")}:</strong>{" "}
                {value().attempted_strategy}
              </div>
              <div>
                <strong class="text-text-strong">{t("Evidence digest", "证据摘要")}:</strong>{" "}
                <code>{value().digest}</code>
              </div>
              <div>
                <strong class="text-text-strong">{t("Policy", "策略版本")}:</strong> {value().policy_version}
              </div>
            </div>
            <div class="grid gap-2 sm:grid-cols-3">
              <div>
                <h4 class="text-11-medium text-text-strong">{t("Conditions", "条件")}</h4>
                <ul class="mt-1 list-disc pl-4 text-11-regular text-text-weak">
                  <For each={value().conditions}>{(item) => <li>{item}</li>}</For>
                </ul>
              </div>
              <div>
                <h4 class="text-11-medium text-text-strong">{t("Counterexamples", "反例")}</h4>
                <ul class="mt-1 list-disc pl-4 text-11-regular text-text-weak">
                  <For each={value().counterexamples}>{(item) => <li>{item}</li>}</For>
                </ul>
              </div>
              <div>
                <h4 class="text-11-medium text-text-strong">{t("Evidence IDs", "证据 ID")}</h4>
                <ul class="mt-1 list-disc pl-4 text-11-regular text-text-weak">
                  <For each={value().evidence_ids}>{(item) => <li>{item}</li>}</For>
                </ul>
              </div>
            </div>
            <textarea
              aria-label={t("Review reason", "审核理由")}
              class="min-h-20 resize-y rounded-md border border-border-weak-base bg-background-base p-3 text-12-regular text-text-strong"
              value={state.reason}
              onInput={(event) => setState("reason", event.currentTarget.value)}
              placeholder={t("Explain the evidence for this decision.", "说明这项决定的证据依据。")}
            />
            <div class="flex flex-wrap gap-2">
              <Button
                size="small"
                variant="primary"
                disabled={!!state.loading || value().review_status !== "pending"}
                onClick={() => review("approve")}
              >
                {t("Approve", "批准")}
              </Button>
              <Button
                size="small"
                variant="ghost"
                disabled={!!state.loading || value().review_status !== "pending"}
                onClick={() => review("reject")}
              >
                {t("Reject", "拒绝")}
              </Button>
            </div>
          </article>
        )}
      </Show>
    </section>
  )
}

export function SkillLifecycleWorkbench(props: {
  api: () => OperationsApi
  location: () => LocationInput
  ready: () => boolean
}) {
  const t = useUiCopy()
  const statusLabel = useStatusLabel()
  const language = useLanguage()
  const [state, setState] = createStore({
    loading: "",
    error: "",
    notice: "",
    status: "all" as SkillStatus,
    items: [] as SkillCandidate[],
    sources: [] as ExperienceSource[],
    selectedSourceIDs: [] as string[],
    draft: defaultSkillCandidateDraft(),
    formErrors: {} as SkillCandidateFormErrors,
    selected: undefined as SkillCandidate | undefined,
    reason: "",
    trafficPercent: "10",
    evaluationDrafts: [] as SkillEvaluationObservationDraft[],
    evaluationErrors: {} as SkillEvaluationFormErrors,
    evaluation: undefined as SkillEvaluation | undefined,
    canary: undefined as SkillCanarySummary | undefined,
    deployment: undefined as SkillDeployment | undefined,
    deploymentSkillID: "",
  })

  const locationScopeKey = () => {
    const value = props.location().location
    return value.directory + "\u0000" + (value.workspace ?? "")
  }
  const scopeGuard = createScopeRequestGuard(locationScopeKey)
  let previousScopeKey: string | undefined

  const run = async (
    name: string,
    action: (location: LocationInput, request: ScopeRequestToken) => Promise<void>,
    notice = "",
  ) => {
    if (state.loading) return
    const request = scopeGuard.capture()
    const requestedLocation = props.location()
    setState({ loading: name, error: "", notice: "" })
    try {
      await action(requestedLocation, request)
      if (notice && scopeGuard.isCurrent(request)) setState("notice", notice)
    } catch (error) {
      if (scopeGuard.isCurrent(request))
        setState(
          "error",
          errorText(error, t("Skill lifecycle operation failed", "技能生命周期操作失败", "技能生命週期操作失敗")),
        )
    } finally {
      if (scopeGuard.isCurrent(request)) setState("loading", "")
    }
  }

  const load = async (
    status = state.status,
    requestedLocation = props.location(),
    request: ScopeRequestToken = scopeGuard.capture(),
  ) => {
    const [result, sourceResult] = await Promise.all([
      props.api().agentCapabilities.skillLifecycleCandidateList({
        ...requestedLocation,
        ...(status === "all" ? {} : { status }),
        limit: 100,
      }),
      props.api().agentCapabilities.experienceSourceList({ ...requestedLocation, limit: 100 }),
    ])
    if (!scopeGuard.isCurrent(request)) return
    setState("items", [...result.data.items])
    setState("sources", [...sourceResult.data.items])
    const availableSourceIDs = new Set(sourceResult.data.items.map((item) => item.experience_id))
    setState(
      "selectedSourceIDs",
      state.selectedSourceIDs.filter((id) => availableSourceIDs.has(id)),
    )
    if (state.selected && !result.data.items.some((item) => item.candidate_id === state.selected?.candidate_id))
      setState({
        selected: undefined,
        evaluation: undefined,
        canary: undefined,
        evaluationDrafts: [],
        evaluationErrors: {},
      })
  }

  const refresh = async (status = state.status) => {
    await run("refresh", (requestedLocation, request) => load(status, requestedLocation, request))
  }

  const applyDetail = (detail: SkillCandidateDetail) =>
    setState({
      selected: detail.candidate,
      reason: "",
      evaluation: detail.evaluation ?? undefined,
      canary: detail.canary,
      evaluationDrafts:
        detail.candidate.status === "candidate" && detail.candidate.evaluation_passed === null
          ? [...createSkillEvaluationDrafts(detail.candidate.test_ids)]
          : [],
      evaluationErrors: {},
    })

  const loadDetail = async (
    candidateID: string,
    requestedLocation = props.location(),
    request: ScopeRequestToken = scopeGuard.capture(),
  ) => {
    const result = await props.api().agentCapabilities.skillLifecycleCandidateGet({
      ...requestedLocation,
      candidateID,
    })
    if (scopeGuard.isCurrent(request)) applyDetail(result.data)
  }

  const select = (candidateID: string) =>
    void run(`detail:${candidateID}`, (requestedLocation, request) =>
      loadDetail(candidateID, requestedLocation, request),
    )

  const formErrorCopy = (code: SkillCandidateFormErrorCode | undefined) => {
    switch (code) {
      case "skill-id-format":
        return t(
          "Use 1–128 letters, numbers, dots, underscores, colons, or hyphens.",
          "请使用 1–128 个字母、数字、点、下划线、冒号或连字符。",
        )
      case "version-format":
        return t("Use a version such as 1.0.0 or 1.0.0-beta.1.", "请使用 1.0.0 或 1.0.0-beta.1 这样的版本号。")
      case "purpose-required":
        return t("Describe the purpose in 1–1,000 characters.", "请用 1–1,000 个字符说明用途。")
      case "triggers-required":
        return t(
          "Add 1–50 triggers, one per line or separated by commas.",
          "请填写 1–50 个触发条件，每行一个或用逗号分隔。",
        )
      case "instructions-required":
        return t(
          "Add bounded instructions no longer than 100,000 characters.",
          "请填写不超过 100,000 个字符的受限说明。",
        )
      case "tools-limit":
        return t(
          "Use at most 100 tool names, one per line or separated by commas.",
          "最多填写 100 个工具名称，每行一个或用逗号分隔。",
        )
      case "capabilities-limit":
        return t(
          "Use at most 100 capabilities, one per line or separated by commas.",
          "最多填写 100 项能力，每行一个或用逗号分隔。",
        )
      case "sources-required":
        return t("Select 1–20 verified Experience sources.", "请选择 1–20 条已验证经验来源。")
      case "json-object":
        return t(
          "Enter a valid JSON object, not an array or plain text.",
          "请输入有效的 JSON 对象，不能是数组或普通文本。",
        )
      case "test-id-required":
        return t("Test ID is required and must be at most 160 characters.", "测试 ID 必填，且不能超过 160 个字符。")
      case "policy-required":
        return t(
          "Policy version is required and must be at most 120 characters.",
          "策略版本必填，且不能超过 120 个字符。",
        )
      default:
        return undefined
    }
  }

  const clearFormError = (field: SkillCandidateField) => {
    if (!state.formErrors[field]) return
    const next = { ...state.formErrors }
    delete next[field]
    setState("formErrors", next)
  }

  const updateDraft = <K extends keyof SkillCandidateDraft>(field: K, value: SkillCandidateDraft[K]) => {
    setState("draft", { ...state.draft, [field]: value })
    clearFormError(field)
  }

  const toggleSource = (experienceID: string, selected: boolean) => {
    setState(
      "selectedSourceIDs",
      selected
        ? [...new Set([...state.selectedSourceIDs, experienceID])]
        : state.selectedSourceIDs.filter((id) => id !== experienceID),
    )
    clearFormError("sourceExperienceIDs")
  }

  const evaluationInputID = (field: string) => `skill-evaluation-${field.replaceAll(":", "-")}`

  const clearEvaluationErrors = (...fields: ReadonlyArray<string>) => {
    if (!fields.some((field) => state.evaluationErrors[field])) return
    const next = { ...state.evaluationErrors }
    for (const field of fields) delete next[field]
    setState("evaluationErrors", next)
  }

  const updateEvaluationResource = <K extends keyof SkillEvaluationResourceDraft>(
    index: number,
    side: "baseline" | "candidate",
    field: K,
    value: SkillEvaluationResourceDraft[K],
    errorField: string,
  ) => {
    const draft = state.evaluationDrafts[index]
    if (!draft) return
    setState("evaluationDrafts", index, side, { ...draft[side], [field]: value })
    clearEvaluationErrors(errorField)
  }

  const updateEvaluationMetric = (
    index: number,
    field: "newFailures" | "newSecretFindings" | "newEgressAttempts",
    value: string,
    errorField: string,
  ) => {
    const draft = state.evaluationDrafts[index]
    if (!draft) return
    setState("evaluationDrafts", index, field, value)
    clearEvaluationErrors(errorField)
  }

  const toggleEvaluationEvidence = (index: number, evidenceID: string, selected: boolean) => {
    const draft = state.evaluationDrafts[index]
    if (!draft) return
    setState(
      "evaluationDrafts",
      index,
      "evidenceIDs",
      selected ? [...new Set([...draft.evidenceIDs, evidenceID])] : draft.evidenceIDs.filter((id) => id !== evidenceID),
    )
    clearEvaluationErrors(skillEvaluationField(index, "evidence"))
  }

  const confirmEvaluationSafety = (index: number, confirmed: boolean) => {
    const draft = state.evaluationDrafts[index]
    if (!draft) return
    setState("evaluationDrafts", index, "safetyConfirmed", confirmed)
    clearEvaluationErrors(skillEvaluationField(index, "safety-confirmed"))
  }

  const evaluationErrorCopy = (code: SkillEvaluationFormErrorCode | undefined) => {
    switch (code) {
      case "case-set-mismatch":
        return t(
          "Refresh the candidate because its deterministic test set changed.",
          "确定性测试集合已变化，请刷新候选。",
        )
      case "result-required":
        return t("Select passed or failed.", "请选择通过或失败。")
      case "number-required":
        return t("Enter a finite number of 0 or greater.", "请输入大于或等于 0 的有限数字。")
      case "evidence-required":
        return t("Select at least one verified evidence item.", "请至少选择一条已验证证据。")
      case "evidence-invalid":
        return t("The selected evidence no longer belongs to this candidate.", "所选证据已不再属于当前候选。")
      case "safety-confirmation-required":
        return t(
          "Confirm that the safety counts came from the independent test run.",
          "请确认安全计数来自独立测试运行。",
        )
      default:
        return undefined
    }
  }

  const createCandidate = () => {
    const parsed = buildSkillCandidatePayload(state.draft, state.selectedSourceIDs)
    if (!parsed.ok) {
      setState({
        formErrors: parsed.errors,
        error: t(
          "Check the highlighted candidate fields and try again.",
          "请检查已标出的候选字段后重试。",
          "請檢查已標出的候選欄位後重試。",
        ),
        notice: "",
      })
      const first = [
        "skillID",
        "version",
        "purpose",
        "triggers",
        "instructions",
        "sourceExperienceIDs",
        "allowedTools",
        "allowedCapabilities",
        "inputSchema",
        "outputSchema",
        "testID",
        "testInput",
        "testExpected",
        "policyVersion",
      ].find((field) => parsed.errors[field as SkillCandidateField])
      if (first) queueMicrotask(() => document.getElementById(`skill-candidate-${first}`)?.focus())
      return
    }
    void run(
      "create",
      async (requestedLocation, request) => {
        const result = await props.api().agentCapabilities.skillLifecycleCandidateCreate({
          ...requestedLocation,
          ...parsed.value,
        })
        if (!scopeGuard.isCurrent(request)) return
        setState({
          status: "candidate",
          draft: defaultSkillCandidateDraft(),
          selectedSourceIDs: [],
          formErrors: {},
          evaluation: undefined,
          canary: undefined,
          evaluationDrafts: [],
          evaluationErrors: {},
          reason: "",
        })
        await load("candidate", requestedLocation, request)
        await loadDetail(result.data.candidate_id, requestedLocation, request)
      },
      t(
        "Candidate created for review. It was not enabled or activated.",
        "候选已创建并等待审核；它没有被启用或激活。",
        "候選已建立並等待審核；它沒有被啟用或設為目前版本。",
      ),
    )
  }

  const evaluate = () => {
    const candidate = state.selected
    if (!candidate) return
    const parsed = buildSkillEvaluationPayload({
      drafts: state.evaluationDrafts,
      expectedTestIDs: candidate.test_ids,
      allowedEvidenceIDs: candidate.source_evidence_ids,
    })
    if (!parsed.ok) {
      setState({
        evaluationErrors: parsed.errors,
        error: t(
          "Complete every deterministic test result and confirm its evidence before submitting.",
          "请完成每项确定性测试结果并确认其证据后再提交。",
        ),
        notice: "",
      })
      const first = Object.keys(parsed.errors).find((field) => field !== "form")
      if (first) queueMicrotask(() => document.getElementById(evaluationInputID(first))?.focus())
      return
    }
    void run(
      `evaluate:${candidate.candidate_id}`,
      async (requestedLocation, request) => {
        const result = await props.api().agentCapabilities.skillLifecycleEvaluate({
          ...requestedLocation,
          candidateID: candidate.candidate_id,
          expectedRevision: candidate.revision,
          observations: parsed.observations as Parameters<
            OperationsApi["agentCapabilities"]["skillLifecycleEvaluate"]
          >[0]["observations"],
        })
        if (!scopeGuard.isCurrent(request)) return
        await load(state.status, requestedLocation, request)
        await loadDetail(result.data.candidate.candidate_id, requestedLocation, request)
      },
      t("Independent test results recorded. No Skill was enabled.", "独立测试结果已记录；没有技能被启用。"),
    )
  }

  const mutate = (action: "canary" | "promote" | "rollback") => {
    const candidate = state.selected
    const reason = state.reason.trim()
    if (!candidate) return
    if (!reason) {
      setState("error", t("A reason is required for lifecycle changes.", "生命周期变更必须填写理由。"))
      return
    }
    const trafficPercent = Number(state.trafficPercent)
    if (action === "canary" && (!Number.isSafeInteger(trafficPercent) || trafficPercent < 1 || trafficPercent > 100)) {
      setState("error", t("Canary traffic must be an integer from 1 to 100.", "灰度流量必须是 1 到 100 的整数。"))
      return
    }
    if (!window.confirm(`${action}: ${candidate.skill_id}@${candidate.version}\n\n${reason}`)) return
    void run(
      `${action}:${candidate.candidate_id}`,
      async (requestedLocation, request) => {
        if (action === "canary") {
          await props.api().agentCapabilities.skillLifecycleCanaryStart({
            ...requestedLocation,
            candidateID: candidate.candidate_id,
            expectedRevision: candidate.revision,
            trafficPercent,
            reason,
          })
        } else if (action === "promote") {
          await props.api().agentCapabilities.skillLifecyclePromote({
            ...requestedLocation,
            candidateID: candidate.candidate_id,
            expectedRevision: candidate.revision,
            reason,
          })
        } else {
          await props.api().agentCapabilities.skillLifecycleRollback({
            ...requestedLocation,
            candidateID: candidate.candidate_id,
            expectedRevision: candidate.revision,
            reason,
          })
        }
        if (!scopeGuard.isCurrent(request)) return
        setState("reason", "")
        await load(state.status, requestedLocation, request)
        await loadDetail(candidate.candidate_id, requestedLocation, request)
      },
      t("Lifecycle request accepted.", "生命周期请求已接受。"),
    )
  }

  const loadDeployment = () => {
    const skillID = state.deploymentSkillID.trim() || state.selected?.skill_id
    if (!skillID) return
    void run(
      "deployment",
      async (requestedLocation, request) => {
        const result = await props.api().agentCapabilities.skillLifecycleDeploymentGet({
          ...requestedLocation,
          skillID,
        })
        if (scopeGuard.isCurrent(request)) setState("deployment", result.data)
      },
      t("Active-version state loaded.", "启用版本状态已加载。"),
    )
  }

  createEffect(
    on(
      () => (props.ready() ? "ready" : "not-ready") + "\u0000" + locationScopeKey(),
      (scopeKey) => {
        scopeGuard.current()
        const scopeChanged = previousScopeKey !== undefined && previousScopeKey !== scopeKey
        previousScopeKey = scopeKey
        if (!props.ready()) return
        if (scopeChanged) {
          setState({
            loading: "",
            error: "",
            notice: "",
            items: [],
            sources: [],
            selectedSourceIDs: [],
            selected: undefined,
            reason: "",
            evaluationDrafts: [],
            evaluationErrors: {},
            evaluation: undefined,
            canary: undefined,
            deployment: undefined,
          })
        }
        void refresh()
      },
    ),
  )

  return (
    <section class={cardClass} data-testid="skill-lifecycle-workbench" aria-busy={!!state.loading}>
      <header class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 class="text-14-medium text-text-strong">{t("Skill lifecycle", "技能生命周期", "技能生命週期")}</h2>
          <p class="mt-1 max-w-3xl text-12-regular text-text-weak">
            {t(
              "Build candidates from verified Experience, then perform explicit evaluation, canary, promotion, and rollback actions. Creation never enables a Skill automatically.",
              "从已验证经验构建候选，再明确执行评测、灰度、晋级和回滚。创建候选绝不会自动启用技能。",
            )}
          </p>
        </div>
        <div class="flex items-center gap-2">
          <select
            aria-label={t("Skill status", "技能状态", "技能狀態")}
            class="h-9 rounded-md border border-border-weak-base bg-background-base px-2 text-12-regular text-text-strong"
            value={state.status}
            onChange={(event) => {
              const status = parseSkillStatus(event.currentTarget.value)
              if (!status) return
              setState("status", status)
              void refresh(status)
            }}
          >
            <option value="all">{t("All", "全部")}</option>
            <option value="draft">{t("Draft", "草稿")}</option>
            <option value="candidate">{t("Candidate", "候选", "候選")}</option>
            <option value="canary">{t("Canary", "灰度")}</option>
            <option value="active">{t("Active", "已启用")}</option>
            <option value="retired">{t("Retired", "已退役")}</option>
          </select>
          <Button size="small" variant="ghost" disabled={!!state.loading} onClick={() => void refresh()}>
            {state.loading === "refresh" ? t("Loading…", "加载中…") : t("Refresh", "刷新")}
          </Button>
        </div>
      </header>
      <WorkbenchNotice error={state.error} notice={state.notice} />
      <details
        class="rounded-md border border-border-weak-base bg-background-weak p-3"
        data-testid="skill-candidate-create"
      >
        <summary class="flex min-h-11 cursor-pointer list-none flex-wrap items-center justify-between gap-2 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus">
          <span>
            <span class="block text-13-medium text-text-strong">
              {t("Create a Skill candidate", "创建技能候选", "建立技能候選")}
            </span>
            <span class="mt-1 block text-11-regular text-text-weak">
              {t(
                "Creates an immutable review candidate only; no install, enable, canary, or deployment occurs.",
                "只创建不可变的待审核候选；不会安装、启用、灰度或部署。",
                "只建立不可變的待審核候選；不會安裝、啟用、灰度或部署。",
              )}
            </span>
          </span>
          <span class="rounded-full border border-border-weak-base px-2 py-1 text-10-regular text-text-weak">
            {t("Fail-closed", "默认关闭", "預設關閉")}
          </span>
        </summary>
        <div class="mt-4 grid gap-4 border-t border-border-weak-base pt-4">
          <div class="grid gap-3 md:grid-cols-2">
            <TextField
              id="skill-candidate-skillID"
              label={t("Skill ID (required)", "技能 ID（必填）", "技能 ID（必填）")}
              description={t("Stable name, for example review.evidence.", "稳定名称，例如 review.evidence。")}
              value={state.draft.skillID}
              required
              validationState={state.formErrors.skillID ? "invalid" : undefined}
              error={formErrorCopy(state.formErrors.skillID)}
              onChange={(value) => updateDraft("skillID", value)}
            />
            <TextField
              id="skill-candidate-version"
              label={t("Version (required)", "版本（必填）", "版本（必填）")}
              description={t("Semantic version; each version is immutable.", "使用语义版本；每个版本都不可变。")}
              value={state.draft.version}
              required
              validationState={state.formErrors.version ? "invalid" : undefined}
              error={formErrorCopy(state.formErrors.version)}
              onChange={(value) => updateDraft("version", value)}
            />
          </div>
          <TextField
            id="skill-candidate-purpose"
            label={t("Purpose (required)", "用途（必填）", "用途（必填）")}
            description={t(
              "Explain what this Skill should help the user accomplish.",
              "说明这个技能要帮助用户完成什么。",
            )}
            value={state.draft.purpose}
            required
            validationState={state.formErrors.purpose ? "invalid" : undefined}
            error={formErrorCopy(state.formErrors.purpose)}
            onChange={(value) => updateDraft("purpose", value)}
          />
          <TextField
            id="skill-candidate-triggers"
            label={t("When to use it (required)", "何时使用（必填）", "何時使用（必填）")}
            description={t(
              "Enter one trigger per line or separate triggers with commas.",
              "每行填写一个触发条件，也可用逗号分隔。",
            )}
            value={state.draft.triggers}
            multiline
            required
            validationState={state.formErrors.triggers ? "invalid" : undefined}
            error={formErrorCopy(state.formErrors.triggers)}
            onChange={(value) => updateDraft("triggers", value)}
          />
          <TextField
            id="skill-candidate-instructions"
            label={t("Candidate instructions (required)", "候选说明（必填）", "候選說明（必填）")}
            description={t(
              "Write the bounded procedure the candidate should follow. External content is not treated as instructions.",
              "填写候选应遵循的受限步骤；外部内容不会自动成为指令。",
            )}
            value={state.draft.instructions}
            multiline
            required
            validationState={state.formErrors.instructions ? "invalid" : undefined}
            error={formErrorCopy(state.formErrors.instructions)}
            onChange={(value) => updateDraft("instructions", value)}
          />
          <fieldset
            id="skill-candidate-sourceExperienceIDs"
            class="grid gap-2 rounded-md border border-border-weak-base p-3"
            tabIndex={-1}
            aria-describedby="skill-candidate-source-help"
          >
            <legend class="px-1 text-12-medium text-text-strong">
              {t("Verified Experience sources (required)", "已验证经验来源（必填）", "已驗證經驗來源（必填）")}
            </legend>
            <p id="skill-candidate-source-help" class="text-11-regular text-text-weak">
              {t(
                "Select the durable, evidence-backed Experience records this candidate is derived from.",
                "选择这个候选所依据的持久、且有证据支持的经验记录。",
              )}
            </p>
            <Show
              when={state.sources.length > 0}
              fallback={
                <p role="status" class="rounded-md bg-background-base p-3 text-11-regular text-text-warning">
                  {t(
                    "No verified Experience is available. First approve an evidence-backed Experience candidate in Controlled Evolution, then refresh this view.",
                    "当前没有可用的已验证经验。请先在“受控自主进化”中批准有证据支持的经验候选，再刷新这里。",
                  )}
                </p>
              }
            >
              <div class="grid gap-2">
                <For each={state.sources}>
                  {(source) => (
                    <label
                      class="flex min-h-11 cursor-pointer items-start gap-3 rounded-md border border-border-weak-base bg-background-base p-3 transition-colors hover:bg-surface-raised focus-within:ring-2 focus-within:ring-border-focus"
                      data-testid="skill-experience-source"
                    >
                      <input
                        type="checkbox"
                        class="mt-0.5 size-4 shrink-0"
                        checked={state.selectedSourceIDs.includes(source.experience_id)}
                        onChange={(event) => toggleSource(source.experience_id, event.currentTarget.checked)}
                      />
                      <span class="min-w-0 flex-1">
                        <span class="block text-12-medium text-text-strong">{source.summary}</span>
                        <span class="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-10-regular text-text-weak">
                          <code>{source.experience_id}</code>
                          <span>
                            {t("Evidence", "证据")} {source.evidence_count}
                          </span>
                          <time dateTime={source.created_at}>
                            {formatTenantTime(source.created_at, language.locale())}
                          </time>
                        </span>
                      </span>
                    </label>
                  )}
                </For>
              </div>
            </Show>
            <Show when={state.formErrors.sourceExperienceIDs}>
              <p role="alert" class="text-11-regular text-text-danger">
                {formErrorCopy(state.formErrors.sourceExperienceIDs)}
              </p>
            </Show>
          </fieldset>
          <details class="rounded-md border border-border-weak-base p-3">
            <summary class="min-h-11 cursor-pointer rounded-sm py-2 text-12-medium text-text-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus">
              {t("Advanced contract and test settings", "高级合同与测试设置", "進階合同與測試設定")}
            </summary>
            <p class="mb-3 text-11-regular text-text-weak">
              {t(
                "Leave tools and capabilities empty for no additional runtime authority. These fields declare requirements; they do not grant permission.",
                "工具和能力留空表示不请求额外运行权限。这些字段只声明需求，不会授予权限。",
              )}
            </p>
            <div class="grid gap-3 md:grid-cols-2">
              <TextField
                id="skill-candidate-allowedTools"
                label={t("Requested tools", "请求的工具", "請求的工具")}
                description={t("One per line or comma-separated; optional.", "每行一个或用逗号分隔；可选。")}
                value={state.draft.allowedTools}
                multiline
                validationState={state.formErrors.allowedTools ? "invalid" : undefined}
                error={formErrorCopy(state.formErrors.allowedTools)}
                onChange={(value) => updateDraft("allowedTools", value)}
              />
              <TextField
                id="skill-candidate-allowedCapabilities"
                label={t("Requested capabilities", "请求的能力", "請求的能力")}
                description={t("One per line or comma-separated; optional.", "每行一个或用逗号分隔；可选。")}
                value={state.draft.allowedCapabilities}
                multiline
                validationState={state.formErrors.allowedCapabilities ? "invalid" : undefined}
                error={formErrorCopy(state.formErrors.allowedCapabilities)}
                onChange={(value) => updateDraft("allowedCapabilities", value)}
              />
              <TextField
                id="skill-candidate-inputSchema"
                label={t("Input contract (JSON object)", "输入合同（JSON 对象）", "輸入合同（JSON 物件）")}
                value={state.draft.inputSchema}
                multiline
                validationState={state.formErrors.inputSchema ? "invalid" : undefined}
                error={formErrorCopy(state.formErrors.inputSchema)}
                onChange={(value) => updateDraft("inputSchema", value)}
              />
              <TextField
                id="skill-candidate-outputSchema"
                label={t("Output contract (JSON object)", "输出合同（JSON 对象）", "輸出合同（JSON 物件）")}
                value={state.draft.outputSchema}
                multiline
                validationState={state.formErrors.outputSchema ? "invalid" : undefined}
                error={formErrorCopy(state.formErrors.outputSchema)}
                onChange={(value) => updateDraft("outputSchema", value)}
              />
              <TextField
                id="skill-candidate-testID"
                label={t("Deterministic test ID", "确定性测试 ID", "確定性測試 ID")}
                value={state.draft.testID}
                required
                validationState={state.formErrors.testID ? "invalid" : undefined}
                error={formErrorCopy(state.formErrors.testID)}
                onChange={(value) => updateDraft("testID", value)}
              />
              <TextField
                id="skill-candidate-policyVersion"
                label={t("Policy version", "策略版本", "策略版本")}
                value={state.draft.policyVersion}
                required
                validationState={state.formErrors.policyVersion ? "invalid" : undefined}
                error={formErrorCopy(state.formErrors.policyVersion)}
                onChange={(value) => updateDraft("policyVersion", value)}
              />
              <TextField
                id="skill-candidate-testInput"
                label={t("Test input (JSON object)", "测试输入（JSON 对象）", "測試輸入（JSON 物件）")}
                value={state.draft.testInput}
                multiline
                validationState={state.formErrors.testInput ? "invalid" : undefined}
                error={formErrorCopy(state.formErrors.testInput)}
                onChange={(value) => updateDraft("testInput", value)}
              />
              <TextField
                id="skill-candidate-testExpected"
                label={t("Expected result (JSON object)", "预期结果（JSON 对象）", "預期結果（JSON 物件）")}
                value={state.draft.testExpected}
                multiline
                validationState={state.formErrors.testExpected ? "invalid" : undefined}
                error={formErrorCopy(state.formErrors.testExpected)}
                onChange={(value) => updateDraft("testExpected", value)}
              />
            </div>
          </details>
          <div class="flex flex-wrap items-center justify-between gap-3">
            <p class="max-w-2xl text-11-regular text-text-weak">
              {t(
                "After creation, review the immutable digest and provide real evaluation evidence before any controlled transition.",
                "创建后，请先核对不可变摘要并提供真实评测证据，再进行任何受控变更。",
              )}
            </p>
            <Button
              size="small"
              variant="primary"
              disabled={!!state.loading || state.sources.length === 0}
              onClick={createCandidate}
            >
              {state.loading === "create"
                ? t("Creating candidate…", "正在创建候选…", "正在建立候選…")
                : t("Create candidate (not enabled)", "创建候选（不会启用）", "建立候選（不會啟用）")}
            </Button>
          </div>
        </div>
      </details>
      <Show
        when={state.items.length > 0}
        fallback={
          <p role="status" class="text-12-regular text-text-weak">
            {state.loading === "refresh"
              ? t("Loading lifecycle candidates…", "正在加载技能候选…", "正在載入技能候選…")
              : t("No lifecycle candidates in this view.", "当前视图没有技能候选。", "目前檢視沒有技能候選。")}
          </p>
        }
      >
        <div class="grid gap-2">
          <For each={state.items}>
            {(candidate) => (
              <button
                type="button"
                class="flex w-full flex-col gap-2 rounded-md border border-border-weak-base p-3 text-left transition-colors hover:bg-surface-raised"
                classList={{ "border-border-strong-base": state.selected?.candidate_id === candidate.candidate_id }}
                onClick={() => select(candidate.candidate_id)}
              >
                <div class="flex flex-wrap items-center justify-between gap-2">
                  <span class="text-13-medium text-text-strong">
                    {candidate.skill_id}@{candidate.version}
                  </span>
                  <StatusBadge value={statusLabel(candidate.status)} />
                </div>
                <div class="grid gap-1 text-11-regular text-text-weak sm:grid-cols-4">
                  <span>
                    {t("Evaluation", "评测")}{" "}
                    {candidate.evaluation_passed === null
                      ? t("pending", "待定")
                      : candidate.evaluation_passed
                        ? t("passed", "通过")
                        : t("blocked", "阻断")}
                  </span>
                  <span>
                    {t("Traffic", "流量")} {candidate.traffic_percent ?? 0}%
                  </span>
                  <span>
                    {t("Revision", "修订")} {candidate.revision}
                  </span>
                  <span>
                    {t("Digest", "摘要")} {candidate.digest.slice(0, 12)}…
                  </span>
                </div>
              </button>
            )}
          </For>
        </div>
      </Show>
      <Show when={state.selected}>
        {(value) => (
          <article class={cardClass} aria-live="polite">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 class="text-13-medium text-text-strong">
                  {value().skill_id}@{value().version}
                </h3>
                <p class="text-11-regular text-text-weak">{value().candidate_id}</p>
              </div>
              <StatusBadge
                value={`${statusLabel(value().status)} · ${t("Revision", "修订", "修訂")} ${value().revision}`}
              />
            </div>
            <p class="text-12-regular text-text-weak">{value().purpose}</p>
            <div class="grid gap-2 text-11-regular text-text-weak sm:grid-cols-3">
              <div>
                <strong class="text-text-strong">{t("Triggers", "触发器")}:</strong>{" "}
                {value().triggers.join(", ") || "—"}
              </div>
              <div>
                <strong class="text-text-strong">{t("Allowed tools", "允许工具")}:</strong>{" "}
                {value().allowed_tools.join(", ") || "—"}
              </div>
              <div>
                <strong class="text-text-strong">{t("Capabilities", "能力")}:</strong>{" "}
                {value().allowed_capabilities.join(", ") || "—"}
              </div>
            </div>
            <div class="grid gap-3 xl:grid-cols-2">
              <div class="flex flex-col gap-2">
                <h4 class="text-12-medium text-text-strong">{t("Independent test results", "独立测试结果")}</h4>
                <p class="text-11-regular text-text-weak">
                  {t(
                    "This form records results produced by a separate test run; it does not execute a model or invent evidence. Every deterministic case and safety count must be confirmed.",
                    "此表单只记录独立测试运行产生的结果，不会调用模型或虚构证据。必须逐项确认确定性用例和安全计数。",
                  )}
                </p>
                <Show when={evaluationErrorCopy(state.evaluationErrors.form)}>
                  {(message) => <p class="text-11-regular text-text-danger">{message()}</p>}
                </Show>
                <Show when={value().status === "candidate" && value().evaluation_passed === null}>
                  <div class="grid gap-3" data-testid="skill-evaluation-form">
                    <For each={state.evaluationDrafts}>
                      {(draft, index) => {
                        const field = (name: Parameters<typeof skillEvaluationField>[1]) =>
                          skillEvaluationField(index(), name)
                        const fieldError = (name: Parameters<typeof skillEvaluationField>[1]) =>
                          evaluationErrorCopy(state.evaluationErrors[field(name)])
                        return (
                          <fieldset
                            class="grid gap-3 rounded-md border border-border-weak-base bg-background-base p-3"
                            data-testid="skill-evaluation-case"
                          >
                            <legend class="px-1 text-12-medium text-text-strong">{draft.caseID}</legend>
                            <div class="grid gap-3 sm:grid-cols-2">
                              <div class="grid gap-2 rounded-md bg-background-weak p-2">
                                <div class="text-11-medium text-text-strong">{t("Baseline", "基线")}</div>
                                <label class="grid gap-1 text-11-regular text-text-weak">
                                  <span>{t("Result", "结果")}</span>
                                  <select
                                    id={evaluationInputID(field("baseline-result"))}
                                    class="h-9 rounded-md border border-border-weak-base bg-background-base px-2 text-12-regular text-text-strong"
                                    aria-invalid={!!fieldError("baseline-result")}
                                    value={draft.baseline.result}
                                    onChange={(event) =>
                                      updateEvaluationResource(
                                        index(),
                                        "baseline",
                                        "result",
                                        event.currentTarget.value as SkillEvaluationResultChoice,
                                        field("baseline-result"),
                                      )
                                    }
                                  >
                                    <option value="">{t("Select result", "选择结果")}</option>
                                    <option value="passed">{t("Passed", "通过")}</option>
                                    <option value="failed">{t("Failed", "失败")}</option>
                                  </select>
                                  <Show when={fieldError("baseline-result")}>
                                    {(message) => <span class="text-text-danger">{message()}</span>}
                                  </Show>
                                </label>
                                <For
                                  each={
                                    [
                                      ["steps", "baseline-steps", t("Steps", "步骤")],
                                      ["tokens", "baseline-tokens", t("Tokens", "Token 数")],
                                      ["costMinor", "baseline-cost", t("Cost (minor units)", "成本（最小货币单位）")],
                                    ] as const
                                  }
                                >
                                  {([name, errorName, label]) => (
                                    <label class="grid gap-1 text-11-regular text-text-weak">
                                      <span>{label}</span>
                                      <input
                                        id={evaluationInputID(field(errorName))}
                                        class="h-9 rounded-md border border-border-weak-base bg-background-base px-2 text-12-regular text-text-strong"
                                        inputmode="decimal"
                                        aria-invalid={!!fieldError(errorName)}
                                        value={draft.baseline[name]}
                                        onInput={(event) =>
                                          updateEvaluationResource(
                                            index(),
                                            "baseline",
                                            name,
                                            event.currentTarget.value,
                                            field(errorName),
                                          )
                                        }
                                      />
                                      <Show when={fieldError(errorName)}>
                                        {(message) => <span class="text-text-danger">{message()}</span>}
                                      </Show>
                                    </label>
                                  )}
                                </For>
                              </div>
                              <div class="grid gap-2 rounded-md bg-background-weak p-2">
                                <div class="text-11-medium text-text-strong">{t("Candidate", "候选")}</div>
                                <label class="grid gap-1 text-11-regular text-text-weak">
                                  <span>{t("Result", "结果")}</span>
                                  <select
                                    id={evaluationInputID(field("candidate-result"))}
                                    class="h-9 rounded-md border border-border-weak-base bg-background-base px-2 text-12-regular text-text-strong"
                                    aria-invalid={!!fieldError("candidate-result")}
                                    value={draft.candidate.result}
                                    onChange={(event) =>
                                      updateEvaluationResource(
                                        index(),
                                        "candidate",
                                        "result",
                                        event.currentTarget.value as SkillEvaluationResultChoice,
                                        field("candidate-result"),
                                      )
                                    }
                                  >
                                    <option value="">{t("Select result", "选择结果")}</option>
                                    <option value="passed">{t("Passed", "通过")}</option>
                                    <option value="failed">{t("Failed", "失败")}</option>
                                  </select>
                                  <Show when={fieldError("candidate-result")}>
                                    {(message) => <span class="text-text-danger">{message()}</span>}
                                  </Show>
                                </label>
                                <For
                                  each={
                                    [
                                      ["steps", "candidate-steps", t("Steps", "步骤")],
                                      ["tokens", "candidate-tokens", t("Tokens", "Token 数")],
                                      ["costMinor", "candidate-cost", t("Cost (minor units)", "成本（最小货币单位）")],
                                    ] as const
                                  }
                                >
                                  {([name, errorName, label]) => (
                                    <label class="grid gap-1 text-11-regular text-text-weak">
                                      <span>{label}</span>
                                      <input
                                        id={evaluationInputID(field(errorName))}
                                        class="h-9 rounded-md border border-border-weak-base bg-background-base px-2 text-12-regular text-text-strong"
                                        inputmode="decimal"
                                        aria-invalid={!!fieldError(errorName)}
                                        value={draft.candidate[name]}
                                        onInput={(event) =>
                                          updateEvaluationResource(
                                            index(),
                                            "candidate",
                                            name,
                                            event.currentTarget.value,
                                            field(errorName),
                                          )
                                        }
                                      />
                                      <Show when={fieldError(errorName)}>
                                        {(message) => <span class="text-text-danger">{message()}</span>}
                                      </Show>
                                    </label>
                                  )}
                                </For>
                              </div>
                            </div>
                            <div class="grid gap-2 sm:grid-cols-3">
                              <For
                                each={
                                  [
                                    ["newFailures", "new-failures", t("New failures", "新增失败")],
                                    [
                                      "newSecretFindings",
                                      "new-secret-findings",
                                      t("New secret findings", "新增敏感信息发现"),
                                    ],
                                    [
                                      "newEgressAttempts",
                                      "new-egress-attempts",
                                      t("New network attempts", "新增联网尝试"),
                                    ],
                                  ] as const
                                }
                              >
                                {([name, errorName, label]) => (
                                  <label class="grid gap-1 text-11-regular text-text-weak">
                                    <span>{label}</span>
                                    <input
                                      id={evaluationInputID(field(errorName))}
                                      class="h-9 rounded-md border border-border-weak-base bg-background-base px-2 text-12-regular text-text-strong"
                                      inputmode="decimal"
                                      aria-invalid={!!fieldError(errorName)}
                                      value={draft[name]}
                                      onInput={(event) =>
                                        updateEvaluationMetric(
                                          index(),
                                          name,
                                          event.currentTarget.value,
                                          field(errorName),
                                        )
                                      }
                                    />
                                    <Show when={fieldError(errorName)}>
                                      {(message) => <span class="text-text-danger">{message()}</span>}
                                    </Show>
                                  </label>
                                )}
                              </For>
                            </div>
                            <fieldset
                              id={evaluationInputID(field("evidence"))}
                              tabindex="-1"
                              class="grid gap-2 outline-none"
                            >
                              <legend class="text-11-medium text-text-strong">
                                {t("Verified evidence", "已验证证据")}
                              </legend>
                              <div class="grid gap-1 sm:grid-cols-2">
                                <For each={value().source_evidence_ids}>
                                  {(evidenceID, evidenceIndex) => (
                                    <label class="flex min-h-9 items-center gap-2 rounded-md border border-border-weak-base px-2 text-11-regular text-text-weak">
                                      <input
                                        id={`${evaluationInputID(field("evidence"))}-${evidenceIndex()}`}
                                        type="checkbox"
                                        checked={draft.evidenceIDs.includes(evidenceID)}
                                        onChange={(event) =>
                                          toggleEvaluationEvidence(index(), evidenceID, event.currentTarget.checked)
                                        }
                                      />
                                      <code class="break-all" title={evidenceID}>
                                        {evidenceID.slice(0, 18)}…
                                      </code>
                                    </label>
                                  )}
                                </For>
                              </div>
                              <Show when={fieldError("evidence")}>
                                {(message) => <span class="text-11-regular text-text-danger">{message()}</span>}
                              </Show>
                            </fieldset>
                            <label class="flex min-h-11 items-start gap-2 text-11-regular text-text-weak">
                              <input
                                id={evaluationInputID(field("safety-confirmed"))}
                                class="mt-0.5"
                                type="checkbox"
                                checked={draft.safetyConfirmed}
                                onChange={(event) => confirmEvaluationSafety(index(), event.currentTarget.checked)}
                              />
                              <span>
                                {t(
                                  "I verified that the failure, secret, and network counts above came from this independent test run.",
                                  "我已确认上方失败、敏感信息和联网计数来自本次独立测试运行。",
                                )}
                                <Show when={fieldError("safety-confirmed")}>
                                  {(message) => <span class="mt-1 block text-text-danger">{message()}</span>}
                                </Show>
                              </span>
                            </label>
                          </fieldset>
                        )
                      }}
                    </For>
                    <Button size="small" variant="secondary" disabled={!!state.loading} onClick={evaluate}>
                      {state.loading === `evaluate:${value().candidate_id}`
                        ? t("Recording…", "正在记录…")
                        : t("Record independent results", "记录独立测试结果")}
                    </Button>
                  </div>
                </Show>
                <Show when={state.evaluation}>
                  {(report) => (
                    <div class="rounded-md border border-border-weak-base p-2 text-11-regular text-text-weak">
                      <div class={report().passed ? "text-text-success" : "text-text-danger"}>
                        {report().passed ? t("Gate passed", "门禁通过") : t("Gate blocked", "门禁未通过")}
                      </div>
                      <div>
                        {t("Sample size", "样本数")} {report().sample_size} · {t("Utility delta", "效用变化")}{" "}
                        {report().utility_delta}
                      </div>
                      <ul class="mt-1 grid gap-1">
                        <For each={Object.entries(report().checks)}>
                          {([key, passed]) => (
                            <li>
                              {passed ? "✓" : "×"} {skillEvaluationCheckLabel(key, language.locale())}
                            </li>
                          )}
                        </For>
                      </ul>
                    </div>
                  )}
                </Show>
              </div>
              <div class="flex flex-col gap-2">
                <h4 class="text-12-medium text-text-strong">{t("Controlled transition", "受控变更")}</h4>
                <Show when={value().status === "canary" && state.canary}>
                  {(canary) => (
                    <div
                      class="grid gap-2 rounded-md border border-border-weak-base bg-background-base p-3 text-11-regular text-text-weak"
                      data-testid="skill-canary-summary"
                    >
                      <div class="flex flex-wrap items-center justify-between gap-2">
                        <span class="text-12-medium text-text-strong">
                          {t("Verified canary runs", "已验证灰度运行")}
                        </span>
                        <StatusBadge
                          value={
                            canary().promotion_ready
                              ? t("Promotion gate ready", "晋级门禁已就绪")
                              : t("Collecting evidence", "正在收集证据")
                          }
                        />
                      </div>
                      <progress
                        aria-label={t("Canary observation progress", "灰度观测进度")}
                        class="h-2 w-full"
                        max={canary().minimum_observations}
                        value={Math.min(canary().observation_count, canary().minimum_observations)}
                      />
                      <div class="grid gap-1 sm:grid-cols-3">
                        <span>
                          {t("Runs", "运行")} {canary().observation_count}/{canary().minimum_observations}
                        </span>
                        <span>
                          {t("Success rate", "成功率")} {(canary().success_rate * 100).toFixed(0)}% / ≥
                          {(canary().minimum_success_rate * 100).toFixed(0)}%
                        </span>
                        <span>
                          {t("Safety incidents", "安全事件")} {canary().safety_incident_count}
                        </span>
                      </div>
                      <p>
                        {t(
                          "Verified terminal runs are recorded by the runtime evidence pipeline. Manual text cannot create a canary observation, and promotion stays unavailable until every gate passes.",
                          "只有运行时证据管线验证过的终态运行才会计入灰度观测；手工文本不能创建观测，所有门禁通过前晋级始终不可用。",
                        )}
                      </p>
                    </div>
                  )}
                </Show>
                <TextField
                  id="skill-lifecycle-reason"
                  label={t("Decision reason", "决策理由")}
                  value={state.reason}
                  onChange={(value) => setState("reason", value)}
                />
                <TextField
                  id="skill-lifecycle-canary-traffic"
                  label={t("Canary traffic (%)", "灰度流量（%）")}
                  value={state.trafficPercent}
                  onChange={(value) => setState("trafficPercent", value)}
                />
                <div class="flex flex-wrap gap-2">
                  <Show when={value().status === "candidate" && value().evaluation_passed === true}>
                    <Button size="small" variant="primary" disabled={!!state.loading} onClick={() => mutate("canary")}>
                      {t("Start canary", "开始灰度")}
                    </Button>
                  </Show>
                  <Show when={value().status === "canary" && state.canary?.promotion_ready === true}>
                    <Button size="small" variant="primary" disabled={!!state.loading} onClick={() => mutate("promote")}>
                      {t("Promote", "晋级")}
                    </Button>
                  </Show>
                  <Show when={value().status === "canary" && state.canary?.promotion_ready === false}>
                    <span role="status" class="self-center text-11-regular text-text-weak">
                      {t("Promotion waits for verified canary evidence.", "晋级需等待已验证的灰度证据。")}
                    </span>
                  </Show>
                  <Show when={value().status === "canary" || value().status === "active"}>
                    <Button size="small" variant="ghost" disabled={!!state.loading} onClick={() => mutate("rollback")}>
                      {t("Rollback", "回滚")}
                    </Button>
                  </Show>
                </div>
                <div class="flex flex-col gap-2 border-t border-border-weak-base pt-3">
                  <TextField
                    id="skill-lifecycle-active-skill-id"
                    label={t(
                      "Skill ID for active-version lookup",
                      "用于查询启用版本的技能 ID",
                      "用於查詢啟用版本的技能 ID",
                    )}
                    value={state.deploymentSkillID || value().skill_id}
                    onChange={(value) => setState("deploymentSkillID", value)}
                  />
                  <Button size="small" variant="ghost" disabled={!!state.loading} onClick={loadDeployment}>
                    {t("Read active-version state", "读取启用版本状态")}
                  </Button>
                  <Show when={state.deployment}>
                    {(deployment) => (
                      <div
                        class="grid gap-2 rounded-md border border-border-weak-base bg-background-base p-2 text-11-regular text-text-weak"
                        data-testid="skill-deployment-receipt"
                      >
                        <div class="text-12-medium text-text-strong">
                          {t("Active-version state", "启用版本状态", "啟用版本狀態")}
                        </div>
                        <div class="grid gap-1 sm:grid-cols-[minmax(10rem,auto)_1fr] sm:items-baseline sm:gap-3">
                          <span>{skillDeploymentFieldLabel("skill", language.locale())}</span>
                          <code class="break-all text-text-strong">{deployment().skill_id}</code>
                          <span>{skillDeploymentFieldLabel("active_candidate", language.locale())}</span>
                          <code class="break-all text-text-strong">{deployment().active_candidate_id}</code>
                          <span>{skillDeploymentFieldLabel("previous_candidate", language.locale())}</span>
                          <code class="break-all text-text-strong">{deployment().previous_candidate_id || "—"}</code>
                          <span>{skillDeploymentFieldLabel("generation", language.locale())}</span>
                          <span class="text-text-strong">{deployment().generation}</span>
                          <span>{skillDeploymentFieldLabel("deployment_digest", language.locale())}</span>
                          <code class="break-all text-text-strong" title={deployment().digest}>
                            {shortDigest(deployment().digest)}
                          </code>
                        </div>
                      </div>
                    )}
                  </Show>
                </div>
              </div>
            </div>
          </article>
        )}
      </Show>
    </section>
  )
}

export function TenantPlatformWorkbench(props: {
  api: () => OperationsApi
  /** Stable server/workspace identity used to drop late tenant responses. */
  scopeKey?: () => string
  ready?: () => boolean
}) {
  const t = useUiCopy()
  const statusLabel = useStatusLabel()
  const language = useLanguage()
  const tenantOperationError = (error: unknown) => {
    const message = agentExtensionPublicError(error, "")
    if (/owner\s*\/\s*admin|tenant role|authorization|permission/i.test(message))
      return t(
        "Owner or Admin permission is required for this tenant operation.",
        "此租户操作需要 Owner 或 Admin 权限。",
        "此租戶操作需要 Owner 或 Admin 權限。",
      )
    return errorText(error, t("Tenant operation failed", "租户操作失败", "租戶操作失敗"))
  }
  const [state, setState] = createStore({
    loading: "",
    error: "",
    notice: "",
    overview: undefined as TenantOverview | undefined,
    ownerContext: undefined as ArtifactOwnerContext | undefined,
    artifactScope: "profile" as ArtifactEvidenceScope,
    secrets: [] as TenantSecret[],
    policy: { region: "", retention: "30", currency: "USD", quota: "", rpm: "60", burst: "10", keyVersion: "1" },
    dataKind: "tenant-export" as TenantDataKind,
    dataReason: "",
    dataRequest: undefined as TenantDataRequest | undefined,
    backupRegion: "",
    backupSchema: "",
    backupDigest: "",
    backup: undefined as TenantBackup | undefined,
    audit: undefined as TenantAudit | undefined,
  })

  const readScope = () => props.scopeKey?.() ?? "tenant"
  const scopeGuard = createScopeRequestGuard(readScope)
  let activeLoad: ScopeRequestToken | undefined

  const run = async (
    name: string,
    action: (request: ScopeRequestToken) => Promise<void>,
    notice = "",
  ) => {
    if (state.loading) return
    const request = scopeGuard.capture()
    setState({ loading: name, error: "", notice: "" })
    try {
      await action(request)
      if (scopeGuard.isCurrent(request) && notice) setState("notice", notice)
    } catch (error) {
      if (scopeGuard.isCurrent(request)) setState("error", tenantOperationError(error))
    } finally {
      if (scopeGuard.isCurrent(request)) setState("loading", "")
    }
  }

  const load = async (force = false) => {
    if (props.ready && !props.ready()) return
    if (activeLoad && !force) return
    const request = force ? scopeGuard.invalidate() : scopeGuard.capture()
    activeLoad = request
    setState({ loading: "refresh", error: "", notice: "" })
    try {
      const [overview, secrets, ownerContext] = await Promise.all([
        props.api().tenantPlatform.overview(),
        props.api().tenantPlatform.listSecrets(),
        props.api().artifacts.ownerContext(),
      ])
      if (!scopeGuard.isCurrent(request)) return
      setState("overview", overview)
      setState("ownerContext", ownerContext)
      setState("artifactScope", "profile")
      setState("secrets", [...secrets])
      setState("policy", {
        region: overview.policy.region,
        retention: String(overview.policy.retention_days),
        currency: overview.policy.quota.currency,
        quota: overview.policy.quota.limit_minor === undefined ? "" : String(overview.policy.quota.limit_minor),
        rpm: String(overview.policy.rate_limit.requests_per_minute),
        burst: String(overview.policy.rate_limit.burst),
        keyVersion: String(overview.policy.key_version),
      })
      setState("backupRegion", overview.policy.region)
    } catch (error) {
      if (scopeGuard.isCurrent(request)) setState("error", tenantOperationError(error))
      throw error
    } finally {
      if (activeLoad !== request) return
      activeLoad = undefined
      setState("loading", "")
    }
  }

  const refresh = () => void load(true).catch(() => undefined)

  const savePolicy = () => {
    const region = state.policy.region.trim()
    const currency = state.policy.currency.trim().toUpperCase()
    const retention = Number(state.policy.retention)
    const limit = state.policy.quota.trim() ? Number(state.policy.quota) : undefined
    const requestsPerMinute = Number(state.policy.rpm)
    const burst = Number(state.policy.burst)
    const keyVersion = Number(state.policy.keyVersion)
    const valid =
      region.length >= 1 &&
      region.length <= 64 &&
      /^[A-Z]{3}$/.test(currency) &&
      Number.isSafeInteger(retention) &&
      retention >= 1 &&
      retention <= 3_650 &&
      (limit === undefined || (Number.isSafeInteger(limit) && limit >= 0)) &&
      Number.isSafeInteger(requestsPerMinute) &&
      requestsPerMinute >= 1 &&
      requestsPerMinute <= 1_000_000 &&
      Number.isSafeInteger(burst) &&
      burst >= 1 &&
      burst <= 100_000 &&
      Number.isSafeInteger(keyVersion) &&
      keyVersion >= 1
    if (!valid) {
      setState("error", t("Check policy values and ranges before saving.", "保存前请检查策略字段的格式和范围。"))
      return
    }
    setState("policy", "currency", currency)
    void run(
      "policy",
      async (request) => {
        if (!scopeGuard.isCurrent(request)) return
        await props.api().tenantPlatform.setPolicy({
          region,
          retention_days: retention,
          quota: { currency, ...(limit === undefined ? {} : { limit_minor: limit }) },
          rate_limit: { requests_per_minute: requestsPerMinute, burst },
          key_version: keyVersion,
        })
        if (!scopeGuard.isCurrent(request)) return
        await load()
      },
      t("Tenant policy updated.", "租户策略已更新。"),
    )
  }

  const requestData = () => {
    const reason = state.dataReason.trim()
    if (!reason) {
      setState("error", t("A data-rights reason is required.", "数据权利请求必须填写理由。"))
      return
    }
    void run(
      "data-request",
      async (request) => {
        if (!scopeGuard.isCurrent(request)) return
        const result = await props.api().tenantPlatform.requestData({ kind: state.dataKind, reason })
        if (scopeGuard.isCurrent(request)) setState("dataRequest", result)
      },
      t("Data-rights request recorded.", "数据权利请求已记录。"),
    )
  }

  const approveData = (approve: boolean) => {
    const request = state.dataRequest
    if (!request) return
    const action = approve ? t("Approve", "批准", "批准") : t("Reject", "拒绝", "拒絕")
    if (!window.confirm(`${action}: ${tenantDataKindLabel(request.kind, language.locale())}\n\n${request.reason}`))
      return
    void run(
      "data-approval",
      async (scopeRequest) => {
        if (!scopeGuard.isCurrent(scopeRequest)) return
        const result = await props.api().tenantPlatform.approveData({ requestID: request.id, approve })
        if (scopeGuard.isCurrent(scopeRequest)) setState("dataRequest", result)
        if (!scopeGuard.isCurrent(scopeRequest)) return
        await load()
      },
      approve ? t("Data request approved.", "数据请求已批准。") : t("Data request rejected.", "数据请求已拒绝。"),
    )
  }

  const createBackup = () => {
    const region = state.backupRegion.trim()
    const schemaRevision = state.backupSchema.trim()
    const artifactDigest = state.backupDigest.trim()
    if (region.length < 1 || region.length > 64 || !schemaRevision || !/^[a-f0-9]{64}$/.test(artifactDigest)) {
      setState(
        "error",
        t(
          "Enter a region, schema revision, and a 64-character lowercase artifact digest.",
          "请输入区域、Schema 修订，并填写 64 位小写产物摘要。",
        ),
      )
      return
    }
    void run(
      "backup",
      async (request) => {
        if (!scopeGuard.isCurrent(request)) return
        const result = await props.api().tenantPlatform.createBackup({
          region,
          schema_revision: schemaRevision,
          artifact_digest: artifactDigest,
        })
        if (scopeGuard.isCurrent(request)) setState("backup", result)
      },
      t("Backup manifest created.", "备份清单已创建。"),
    )
  }

  const verifyBackup = () => {
    const backup = state.backup
    if (!backup) return
    void run(
      "verify-backup",
      async (request) => {
        if (!scopeGuard.isCurrent(request)) return
        const result = await props
          .api()
          .tenantPlatform.verifyBackup({ manifestID: backup.id, artifact_digest: backup.artifact_digest })
        if (scopeGuard.isCurrent(request)) setState("backup", result)
      },
      t("Backup verification requested.", "备份校验请求已提交。"),
    )
  }

  const exportAudit = () =>
    void run(
      "audit",
      async (request) => {
        if (!scopeGuard.isCurrent(request)) return
        const result = await props.api().tenantPlatform.exportAudit()
        if (scopeGuard.isCurrent(request)) setState("audit", result)
      },
      t("Audit JSON is ready to download.", "审计 JSON 已可下载。", "審計 JSON 已可下載。"),
    )

  const downloadAudit = () => {
    const audit = state.audit
    if (!audit) return
    try {
      const href = URL.createObjectURL(new Blob([audit.artifact_json], { type: audit.artifact_media_type }))
      const link = document.createElement("a")
      link.href = href
      link.download = audit.artifact_filename
      link.style.display = "none"
      document.body.append(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(href), 0)
      setState({
        error: "",
        notice: t("Audit JSON download started.", "审计 JSON 已开始下载。", "審計 JSON 已開始下載。"),
      })
    } catch (error) {
      setState({
        notice: "",
        error: errorText(error, t("Audit download failed", "审计下载失败", "審計下載失敗")),
      })
    }
  }

  const revokeSecret = (secret: TenantSecret) => {
    if (!window.confirm(`${t("Revoke secret", "撤销密钥")}: ${secret.secret_id}`)) return
    void run(
      `secret:${secret.secret_id}`,
      async (request) => {
        if (!scopeGuard.isCurrent(request)) return
        await props.api().tenantPlatform.revokeSecret({ secretID: secret.secret_id })
        if (!scopeGuard.isCurrent(request)) return
        await load()
      },
      t("Secret revoked.", "密钥已撤销。"),
    )
  }

  let previousScopeKey: string | undefined
  createEffect(
    on(
      () => `${props.ready?.() === false ? "not-ready" : "ready"}\u0000${readScope()}`,
      (scopeKey) => {
        scopeGuard.invalidate()
        const scopeChanged = previousScopeKey !== undefined && previousScopeKey !== scopeKey
        previousScopeKey = scopeKey
        if (props.ready?.() === false) {
          setState({
            loading: "",
            error: "",
            notice: "",
            overview: undefined,
            ownerContext: undefined,
            secrets: [],
            dataRequest: undefined,
            backup: undefined,
            audit: undefined,
          })
          return
        }
        if (scopeChanged)
          setState({
            loading: "",
            error: "",
            notice: "",
            overview: undefined,
            ownerContext: undefined,
            secrets: [],
            dataRequest: undefined,
            backup: undefined,
            audit: undefined,
          })
        void load(scopeChanged).catch(() => undefined)
      },
    ),
  )

  return (
    <section class={cardClass} data-testid="tenant-platform-workbench" aria-busy={!!state.loading}>
      <header class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 class="text-14-medium text-text-strong">{t("Tenant platform governance", "租户平台治理")}</h2>
          <p class="mt-1 max-w-3xl text-12-regular text-text-weak">
            {t(
              "Tenant members can create data-rights requests. Owner or Admin is required for policy, approval, backup verification, audit export, and secret revocation; the server enforces that boundary.",
              "租户成员可以创建数据权利请求；策略修改、审批、备份校验、审计导出和密钥撤销仅限 Owner 或 Admin，服务端会强制执行该边界。",
              "租戶成員可以建立資料權利請求；策略修改、審批、備份校驗、審計匯出和密鑰撤銷僅限 Owner 或 Admin，伺服器會強制執行該邊界。",
            )}
          </p>
        </div>
        <Button size="small" variant="ghost" disabled={!!state.loading} onClick={() => void refresh()}>
          {state.loading === "refresh" ? t("Loading…", "加载中…") : t("Refresh", "刷新")}
        </Button>
      </header>
      <WorkbenchNotice error={state.error} notice={state.notice} />
      <Show
        when={state.overview}
        fallback={
          <p role="status" class="text-12-regular text-text-weak">
            {state.loading === "refresh"
              ? t("Loading tenant overview…", "正在加载租户概览…")
              : t(
                  "Tenant overview is unavailable or requires an active tenant membership.",
                  "租户概览不可用，或当前账户不是活跃租户成员。",
                  "租戶概覽不可用，或目前帳戶不是活躍租戶成員。",
                )}
          </p>
        }
      >
        {(overview) => (
          <>
            <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              <div class={cardClass}>
                <span class="text-11-regular text-text-weak">{t("Tenant", "租户")}</span>
                <code class="text-12-regular text-text-strong">{overview().policy.tenant_id}</code>
              </div>
              <div class={cardClass}>
                <span class="text-11-regular text-text-weak">{t("Region", "区域", "區域")}</span>
                <strong class="text-13-medium text-text-strong">{overview().policy.region}</strong>
              </div>
              <div class={cardClass}>
                <span class="text-11-regular text-text-weak">
                  {t("Pending data requests", "待处理数据请求", "待處理資料請求")}
                </span>
                <strong class="text-13-medium text-text-strong">{overview().pending_requests}</strong>
              </div>
              <div class={cardClass}>
                <span class="text-11-regular text-text-weak">
                  {t("Settled usage (minor units)", "已结算用量（最小货币单位）", "已結算用量（最小貨幣單位）")}
                </span>
                <strong class="text-13-medium text-text-strong">
                  {overview().usage.currency} {overview().usage.settled_amount_minor}
                </strong>
              </div>
              <div class={cardClass}>
                <span class="text-11-regular text-text-weak">
                  {t("Settled usage records", "已结算用量记录", "已結算用量記錄")}
                </span>
                <strong class="text-13-medium text-text-strong">{overview().usage.settled_records}</strong>
              </div>
              <div class={cardClass}>
                <span class="text-11-regular text-text-weak">
                  {t("Active rate windows", "活跃限流窗口", "活躍限流視窗")}
                </span>
                <strong class="text-13-medium text-text-strong">{overview().active_rate_window_count}</strong>
              </div>
            </div>
            <Show
              when={state.ownerContext}
              fallback={
                <p role="status" class="text-12-regular text-text-weak" data-testid="artifact-owner-context-status">
                  {state.loading === "refresh"
                    ? t("Loading artifact owner scopes…", "正在加载产物所有者范围…", "正在載入產物擁有者範圍…")
                    : t(
                        "Artifact evidence scope is unavailable.",
                        "产物证据范围不可用。",
                        "產物證據範圍不可用。",
                      )}
                </p>
              }
            >
              {(owners) => (
                <div class="grid gap-2" data-testid="artifact-evidence-scope-picker">
                  <div class="flex flex-wrap items-center gap-2" role="group" aria-label={t("Artifact evidence scope", "产物证据范围", "產物證據範圍")}>
                    <span class="text-11-regular text-text-weak">
                      {t("Evidence scope", "证据范围", "證據範圍")}
                    </span>
                    <Button
                      size="small"
                      variant={state.artifactScope === "profile" ? "primary" : "ghost"}
                      aria-pressed={state.artifactScope === "profile"}
                      data-testid="artifact-evidence-profile-scope"
                      onClick={() => setState("artifactScope", "profile")}
                    >
                      {t("Current profile", "当前配置空间", "目前設定空間")}
                    </Button>
                    <Button
                      size="small"
                      variant={state.artifactScope === "tenant" ? "primary" : "ghost"}
                      aria-pressed={state.artifactScope === "tenant"}
                      disabled={!owners().tenantReadable}
                      data-testid="artifact-evidence-tenant-scope"
                      onClick={() => setState("artifactScope", "tenant")}
                    >
                      {t("Current tenant", "当前租户", "目前租戶")}
                    </Button>
                  </div>
                  <p class="text-11-regular text-text-weak">
                    {owners().tenantReadable
                      ? t(
                          "The profile view is available to every authenticated member. Tenant receipts are available to Owner or Admin and use the same metadata-only evidence card.",
                          "每个已认证成员都可以查看配置空间范围；租户产物仅限 Owner 或 Admin，并复用同一张仅含元数据的证据卡片。",
                          "每位已驗證成員都可以查看設定空間範圍；租戶產物僅限 Owner 或 Admin，並複用同一張僅含中繼資料的證據卡片。",
                        )
                      : t(
                          "Your role can inspect profile receipts only. Tenant receipts require Owner or Admin permission.",
                          "当前角色只能查看配置空间产物；租户产物需要 Owner 或 Admin 权限。",
                          "目前角色只能查看設定空間產物；租戶產物需要 Owner 或 Admin 權限。",
                        )}
                  </p>
                  <ArtifactEvidenceWorkbench
                    api={props.api}
                    owner={
                      state.artifactScope === "profile"
                        ? { scope: "profile", id: owners().profile.id }
                        : { scope: "tenant", id: owners().tenant.id }
                    }
                    ready={() =>
                      !!state.overview &&
                      !!state.ownerContext &&
                      (state.artifactScope !== "tenant" || owners().tenantReadable)
                    }
                  />
                </div>
              )}
            </Show>
            <div class="grid gap-3 xl:grid-cols-2">
              <div class={cardClass}>
                <div>
                  <h3 class="text-13-medium text-text-strong">{t("Platform policy", "平台策略", "平台策略")}</h3>
                  <p class="mt-1 text-10-regular text-text-weak">
                    {t(
                      "These limits apply to this tenant. Quota values use the smallest currency unit.",
                      "这些限制适用于当前租户；配额金额使用最小货币单位。",
                      "這些限制適用於目前租戶；配額金額使用最小貨幣單位。",
                    )}
                  </p>
                </div>
                <div class="grid gap-2 sm:grid-cols-2">
                  <TextField
                    label={t("Region", "区域")}
                    value={state.policy.region}
                    onChange={(value) => setState("policy", "region", value)}
                  />
                  <TextField
                    label={t("Retention days", "保留天数")}
                    value={state.policy.retention}
                    onChange={(value) => setState("policy", "retention", value)}
                    description={t(
                      "Governance limit; physical deletion still requires an approved maintenance action.",
                      "治理保留期限；物理删除仍需经过批准的维护操作。",
                      "治理保留期限；實體刪除仍需經過批准的維護操作。",
                    )}
                  />
                  <TextField
                    label={t("Quota currency", "配额货币")}
                    value={state.policy.currency}
                    onChange={(value) => setState("policy", "currency", value)}
                  />
                  <TextField
                    label={t("Quota limit (minor)", "配额上限（最小货币单位）")}
                    value={state.policy.quota}
                    onChange={(value) => setState("policy", "quota", value)}
                  />
                  <TextField
                    label={t("Requests per minute", "每分钟请求数")}
                    value={state.policy.rpm}
                    onChange={(value) => setState("policy", "rpm", value)}
                  />
                  <TextField
                    label={t("Burst", "突发量")}
                    value={state.policy.burst}
                    onChange={(value) => setState("policy", "burst", value)}
                  />
                  <TextField
                    label={t("Key version", "密钥版本")}
                    value={state.policy.keyVersion}
                    onChange={(value) => setState("policy", "keyVersion", value)}
                    description={t(
                      "May stay unchanged or increase; rollback to an older key is rejected.",
                      "可保持不变或递增；回退到旧密钥会被拒绝。",
                      "可保持不變或遞增；回退到舊密鑰會被拒絕。",
                    )}
                  />
                </div>
                <Button
                  size="small"
                  variant="primary"
                  data-testid="tenant-platform-save-policy"
                  disabled={!!state.loading}
                  onClick={savePolicy}
                >
                  {t("Save policy", "保存策略")}
                </Button>
              </div>
              <div class={cardClass}>
                <div>
                  <h3 class="text-13-medium text-text-strong">{t("Data rights", "数据权利", "資料權利")}</h3>
                  <p class="mt-1 text-10-regular text-text-weak">
                    {t(
                      "Any tenant member may create a request. Approval or rejection is a separate Owner/Admin action and remains auditable.",
                      "任何租户成员都可创建请求；批准或拒绝是独立的 Owner/Admin 操作，并会保留审计记录。",
                      "任何租戶成員都可建立請求；批准或拒絕是獨立的 Owner/Admin 操作，並會保留審計記錄。",
                    )}
                  </p>
                </div>
                <select
                  aria-label={t("Data request kind", "数据请求类型", "資料請求類型")}
                  class="h-9 rounded-md border border-border-weak-base bg-background-base px-2 text-12-regular text-text-strong"
                  value={state.dataKind}
                  onChange={(event) => {
                    const kind = parseTenantDataKind(event.currentTarget.value)
                    if (kind) setState("dataKind", kind)
                  }}
                >
                  <option value="tenant-export">{t("Export tenant data", "导出租户数据", "匯出租戶資料")}</option>
                  <option value="tenant-delete">{t("Delete tenant data", "删除租户数据", "刪除租戶資料")}</option>
                </select>
                <TextField
                  label={t("Reason", "理由", "理由")}
                  value={state.dataReason}
                  onChange={(value) => setState("dataReason", value)}
                />
                <div class="flex flex-wrap gap-2">
                  <Button size="small" variant="secondary" disabled={!!state.loading} onClick={requestData}>
                    {t("Create request", "创建请求")}
                  </Button>
                  <Show when={state.dataRequest?.status === "requested"}>
                    <Button size="small" variant="primary" disabled={!!state.loading} onClick={() => approveData(true)}>
                      {t("Admin approve", "管理员批准")}
                    </Button>
                    <Button size="small" variant="ghost" disabled={!!state.loading} onClick={() => approveData(false)}>
                      {t("Admin reject", "管理员拒绝")}
                    </Button>
                  </Show>
                </div>
                <Show when={state.dataRequest}>
                  {(request) => (
                    <div
                      class="flex flex-col gap-2 rounded-md border border-border-weak-base bg-background-base p-3 text-11-regular"
                      data-testid="tenant-data-request-receipt"
                    >
                      <div class="flex flex-wrap items-center justify-between gap-2">
                        <strong class="text-12-medium text-text-strong">
                          {t("Request receipt", "请求回执", "請求回執")}
                        </strong>
                        <StatusBadge value={tenantStatusLabel(request().status, language.locale())} />
                      </div>
                      <TenantReceiptRow
                        label={t("Request type", "请求类型", "請求類型")}
                        value={tenantDataKindLabel(request().kind, language.locale())}
                      />
                      <TenantReceiptRow
                        label={t("Requested at", "请求时间", "請求時間")}
                        value={formatTenantTime(request().requested_at, language.locale())}
                      />
                      <TenantReceiptRow label="ID" value={request().id} code />
                      <TenantReceiptRow
                        label={t("Evidence digest", "证据摘要", "證據摘要")}
                        value={shortDigest(request().request_digest)}
                        title={request().request_digest}
                        code
                      />
                      <p class="text-10-regular text-text-weak">
                        {t(
                          "The digest identifies this receipt without exposing private data in the UI.",
                          "摘要用于识别这份回执，界面不会暴露私有数据。",
                          "摘要用於識別這份回執，介面不會暴露私有資料。",
                        )}
                      </p>
                    </div>
                  )}
                </Show>
              </div>
              <div class={cardClass}>
                <div>
                  <h3 class="text-13-medium text-text-strong">{t("Backup verification", "备份校验", "備份校驗")}</h3>
                  <p class="mt-1 text-10-regular text-text-weak">
                    {t(
                      "Owner/Admin only. This verifies a digest-bound manifest in the current policy region; it does not copy or restore data in the desktop client.",
                      "仅限 Owner/Admin。这里校验当前策略区域内的摘要绑定清单；不会在桌面端复制或恢复数据。",
                      "僅限 Owner/Admin。這裡校驗目前策略區域內的摘要綁定清單；不會在桌面端複製或還原資料。",
                    )}
                  </p>
                </div>
                <TextField
                  label={t("Backup region", "备份区域", "備份區域")}
                  value={state.backupRegion}
                  readOnly
                  description={t(
                    "Inherited from the tenant data-region policy.",
                    "继承当前租户的数据区域策略。",
                    "繼承目前租戶的資料區域策略。",
                  )}
                />
                <TextField
                  label={t("Schema revision", "数据结构版本", "資料結構版本")}
                  value={state.backupSchema}
                  onChange={(value) => setState("backupSchema", value)}
                />
                <TextField
                  label={t("Artifact digest", "产物摘要", "產物摘要")}
                  value={state.backupDigest}
                  onChange={(value) => setState("backupDigest", value)}
                />
                <div class="flex flex-wrap gap-2">
                  <Button size="small" variant="secondary" disabled={!!state.loading} onClick={createBackup}>
                    {t("Create manifest", "创建清单")}
                  </Button>
                  <Show when={state.backup}>
                    <Button size="small" variant="ghost" disabled={!!state.loading} onClick={verifyBackup}>
                      {t("Verify", "校验")}
                    </Button>
                  </Show>
                </div>
                <Show when={state.backup}>
                  {(backup) => (
                    <div
                      class="flex flex-col gap-2 rounded-md border border-border-weak-base bg-background-base p-3 text-11-regular"
                      data-testid="tenant-backup-receipt"
                    >
                      <div class="flex flex-wrap items-center justify-between gap-2">
                        <strong class="text-12-medium text-text-strong">
                          {t("Backup manifest", "备份清单", "備份清單")}
                        </strong>
                        <StatusBadge value={tenantStatusLabel(backup().status, language.locale())} />
                      </div>
                      <TenantReceiptRow label={t("Region", "区域", "區域")} value={backup().region} />
                      <TenantReceiptRow
                        label={t("Schema revision", "数据结构版本", "資料結構版本")}
                        value={backup().schema_revision}
                      />
                      <TenantReceiptRow
                        label={t("Created at", "创建时间", "建立時間")}
                        value={formatTenantTime(backup().created_at, language.locale())}
                      />
                      <Show when={backup().verified_at}>
                        {(verifiedAt) => (
                          <TenantReceiptRow
                            label={t("Verified at", "校验时间", "驗證時間")}
                            value={formatTenantTime(verifiedAt(), language.locale())}
                          />
                        )}
                      </Show>
                      <TenantReceiptRow
                        label={t("Artifact digest", "产物摘要", "產物摘要")}
                        value={shortDigest(backup().artifact_digest)}
                        title={backup().artifact_digest}
                        code
                      />
                    </div>
                  )}
                </Show>
              </div>
              <div class={cardClass}>
                <div class="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <h3 class="text-13-medium text-text-strong">
                      {t("Audit and secrets", "审计与密钥", "審計與密鑰")}
                    </h3>
                    <p class="mt-1 text-10-regular text-text-weak">
                      {t(
                        "Owner/Admin only. Export creates a downloadable safe JSON artifact plus a verifiable digest; provider credentials stay encrypted and are managed in Settings.",
                        "仅限 Owner/Admin。导出会生成可下载的安全 JSON 文件及可校验摘要；Provider 凭据保持加密，并在设置中管理。",
                        "僅限 Owner/Admin。匯出會產生可下載的安全 JSON 檔案及可驗證摘要；Provider 憑據保持加密，並在設定中管理。",
                      )}
                    </p>
                  </div>
                  <Button size="small" variant="secondary" disabled={!!state.loading} onClick={exportAudit}>
                    {t("Export audit", "导出审计", "匯出審計")}
                  </Button>
                </div>
                <Show when={state.audit}>
                  {(audit) => (
                    <div
                      class="flex flex-col gap-2 rounded-md border border-border-weak-base bg-background-base p-3 text-11-regular"
                      data-testid="tenant-audit-receipt"
                    >
                      <strong class="text-12-medium text-text-strong">
                        {t("Audit export receipt", "审计导出回执", "審計匯出回執")}
                      </strong>
                      <TenantReceiptRow
                        label={t("Items included", "包含记录", "包含記錄")}
                        value={audit().item_count.toLocaleString(language.intl())}
                        testId="tenant-audit-item-count"
                      />
                      <TenantReceiptRow
                        label={t("Created at", "创建时间", "建立時間")}
                        value={formatTenantTime(audit().created_at, language.locale())}
                      />
                      <TenantReceiptRow label="ID" value={audit().id} code />
                      <TenantReceiptRow
                        label={t("Export digest", "导出摘要", "匯出摘要")}
                        value={shortDigest(audit().export_digest)}
                        title={audit().export_digest}
                        code
                      />
                      <TenantReceiptRow label={t("File", "文件", "檔案")} value={audit().artifact_filename} code />
                      <div class="flex justify-end">
                        <Button
                          size="small"
                          variant="secondary"
                          data-testid="tenant-audit-download"
                          onClick={downloadAudit}
                        >
                          {t("Download JSON", "下载 JSON", "下載 JSON")}
                        </Button>
                      </div>
                    </div>
                  )}
                </Show>
                <Show
                  when={state.secrets.length > 0}
                  fallback={
                    <p class="text-11-regular text-text-weak">
                      {t(
                        "No platform-vault secret metadata is visible. Provider credentials are managed in Settings.",
                        "当前没有平台密钥库记录；Provider 凭据请在设置中管理。",
                        "目前沒有平台密鑰庫記錄；Provider 憑據請在設定中管理。",
                      )}
                    </p>
                  }
                >
                  <div class="grid gap-2">
                    <For each={state.secrets}>
                      {(secret) => (
                        <div class="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border-weak-base p-2 text-11-regular">
                          <span class="min-w-0">
                            <code class="text-text-strong">{secret.secret_id}</code>
                            <span class="ml-2 text-text-weak">
                              {t("key", "密钥")} v{secret.key_version} · {shortDigest(secret.fingerprint, 8)} ·{" "}
                              {statusLabel(secret.status)}
                            </span>
                          </span>
                          <Show when={secret.status === "active"}>
                            <Button
                              size="small"
                              variant="ghost"
                              disabled={!!state.loading}
                              onClick={() => revokeSecret(secret)}
                            >
                              {t("Revoke", "撤销")}
                            </Button>
                          </Show>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
              </div>
            </div>
          </>
        )}
      </Show>
    </section>
  )
}

function TenantReceiptRow(props: { label: string; value: string; code?: boolean; title?: string; testId?: string }) {
  return (
    <div class="grid gap-1 sm:grid-cols-[minmax(8rem,auto)_1fr] sm:items-baseline sm:gap-3" data-testid={props.testId}>
      <span class="text-text-weak">{props.label}</span>
      {props.code ? (
        <code class="break-all text-text-strong" title={props.title ?? props.value}>
          {props.value}
        </code>
      ) : (
        <span class="break-words text-text-strong" title={props.title}>
          {props.value}
        </span>
      )}
    </div>
  )
}

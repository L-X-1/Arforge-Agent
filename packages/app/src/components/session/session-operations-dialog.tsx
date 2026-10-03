import { bindManagementApi, createManagementScope, loadManagementPartition, managementWriteBlocked, ManagementRefreshFailure, createManagementReadRecovery, runManagementMutation, type ManagementPartition } from "@/components/settings-v2/management-async"
import { ManagementStatus } from "@/components/settings-v2/management-status"
import "@/components/settings-v2/management-review.css"
import { Button } from "@arforge-ai/ui/button"
import { Checkbox } from "@arforge-ai/ui/checkbox"
import { TextField } from "@arforge-ai/ui/text-field"
import { TabsV2 } from "@arforge-ai/ui/v2/tabs-v2"
import { SelectV2 } from "@arforge-ai/ui/v2/select-v2"
import { For, Show, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { useServerSDK, type ServerSDK } from "@/context/server-sdk"
import type { useSync } from "@/context/sync"
import type { OperationsApi } from "@/utils/server"
import { SessionGoalControl } from "./session-goal-control"
import { SessionPromptQueueControl } from "./session-prompt-queue-control"
import { isMissingTeam } from "./session-operation-boundary"
import { SessionFeedbackControl } from "./session-feedback-control"
import { SessionPersonalJobsControl } from "./session-personal-jobs-control"
import { useSessionOperationsText } from "./session-operations-text"
import { useLanguage } from "@/context/language"
import { useControlCenterText } from "@/components/control-center/control-center-text"
import { sessionSettingsTab, type SessionSettingsValue } from "./session-settings-navigation"
import "./session-settings.css"

type Schedule = Awaited<ReturnType<OperationsApi["scheduledPrompts"]["list"]>>[number]
type Task = Awaited<ReturnType<OperationsApi["tasks"]["list"]>>["items"][number]
type Team = Awaited<ReturnType<OperationsApi["teams"]["get"]>>
type TeamMessage = Awaited<ReturnType<OperationsApi["teams"]["messageList"]>>["messages"][number]
type Checkpoint = Awaited<ReturnType<OperationsApi["sessions"]["checkpointList"]>>[number]
type RewindPreview = Awaited<ReturnType<OperationsApi["sessions"]["rewindPreview"]>>
type TriggerProfile = Awaited<ReturnType<OperationsApi["triggers"]["profiles"]>>["items"][number]
type ActiveWait = Exclude<Awaited<ReturnType<OperationsApi["waits"]["active"]>>, null>
type TriggerItem = Readonly<Record<string, unknown>>

const sessionSections = ["identity", "activity", "schedules", "tasks", "team", "checkpoints", "triggers", "wait"] as const
type SessionSection = (typeof sessionSections)[number]

type SessionSettingsProps = { sessionID: string; value: string; sync?: ReturnType<typeof useSync> }

export function SessionSettingsPanels(props: SessionSettingsProps) {
  const serverSDK = useServerSDK()
  return (
    <Show when={serverSDK()} keyed>
      {(sdk) => <Show when={props.sessionID} keyed>
        {(sessionID) => <SessionSettingsContent {...props} sdk={sdk} sessionID={sessionID} />}
      </Show>}
    </Show>
  )
}

function SessionSettingsContent(props: SessionSettingsProps & { sdk: ServerSDK }) {
  const serverSDK = useServerSDK()
  const language = useLanguage()
  const c = useSessionOperationsText()
  const controlText = useControlCenterText()
  const ui = (english: string, simplifiedChinese: string, traditionalChinese = simplifiedChinese) => {
    if (language.locale() === "zh") return simplifiedChinese
    if (language.locale() === "zht") return traditionalChinese
    return english
  }
  const taskStatus = (status: Task["status"]) => {
    if (status === "pending") return ui("Pending", "待领取", "待領取")
    if (status === "in_progress") return ui("In progress", "进行中", "進行中")
    if (status === "completed") return ui("Completed", "已完成", "已完成")
    if (status === "cancelled") return ui("Cancelled", "已取消", "已取消")
    return status
  }
  const [state, setState] = createStore({
    loading: true,
    ready: false,
    saving: false,
    active: false,
    sessionTitle: "",
    error: "",
    notice: "",
    refreshError: "",
    refreshErrorSection: undefined as SessionSection | undefined,
    sections: Object.fromEntries(sessionSections.map((key) => [key, { loading: true, fresh: false, error: "" }])) as Record<SessionSection, ManagementPartition>,
    tags: "",
    scheduleName: "",
    scheduleCron: "0 9 * * *",
    schedulePrompt: "",
    scheduleEditingID: "",
    scheduleEnabled: true,
    recurring: false,
    durable: true,
    schedules: [] as Schedule[],
    taskTitle: "",
    taskDescription: "",
    taskOwner: "user",
    taskBlockers: [] as string[],
    taskEditingID: "",
    taskEditingRevision: 0,
    tasks: [] as Task[],
    team: undefined as Team | undefined,
    teamName: "",
    teamDescription: "",
    teamMemberName: "",
    teamAgentID: "",
    teamRecipient: "*",
    teamMessage: "",
    teamMessages: [] as TeamMessage[],
    checkpointLabel: "",
    checkpoints: [] as Checkpoint[],
    preview: undefined as RewindPreview | undefined,
    triggerProfiles: [] as TriggerProfile[],
    triggerProfile: "local",
    triggerID: "",
    triggerBody:
      '{\n  "name": "Daily review",\n  "cron_expression": "0 9 * * *",\n  "prompt": "Review the current implementation.",\n  "recurring": true,\n  "durable": true,\n  "enabled": true\n}',
    triggerItems: [] as TriggerItem[],
    activeWait: undefined as ActiveWait | undefined,
  })

  const sessionID = props.sessionID
  const scope = createManagementScope(props.sdk, sessionID, () => ({ source: serverSDK(), sessionID: props.sessionID }))
  onCleanup(scope.dispose)
  const scopedAPI = bindManagementApi(props.sdk.operationsApi, scope)
  const api = () => scopedAPI
  const rewindRecovery = createManagementReadRecovery(scope)
  const agents = () => props.sync?.().data.agent ?? []
  const blocked = (section: SessionSection) => managementWriteBlocked({
    live: scope.live(), saving: state.saving, identity: state.sections.identity,
    activity: state.sections.activity, section: state.sections[section],
  })
  const fail = (error: unknown) => {
    if (!scope.live()) return
    setState("error", publicError(error))
    setState("notice", "")
  }
  const sectionLabel = (section: SessionSection) => ({
    identity: ui("Session identity", "会话身份"),
    activity: ui("Running state", "运行状态"),
    schedules: ui("Schedules", "定时任务"),
    tasks: ui("Tasks", "任务"),
    team: ui("Team and inbox", "团队与消息箱"),
    checkpoints: ui("Checkpoints", "检查点"),
    triggers: ui("Triggers", "触发器"),
    wait: ui("Wait", "等待"),
  })[section]
  const load = <T,>(section: SessionSection, read: () => Promise<T>, commit: (value: T) => void) =>
    loadManagementPartition(scope, section, read, {
      start: () => {
        setState("sections", section, { loading: true, fresh: false, error: "" })
        setState("loading", true)
      },
      commit: (value) => {
        commit(value)
        setState("sections", section, "fresh", true)
        if (state.refreshErrorSection === section) setState({ refreshError: "", refreshErrorSection: undefined })
      },
      fail: (error) => setState("sections", section, "error", publicError(error)),
      finish: () => {
        setState("sections", section, "loading", false)
        setState("loading", sessionSections.some((key) => state.sections[key].loading))
      },
    })
  const refreshSection = (section: SessionSection): Promise<boolean> => {
    switch (section) {
      case "identity":
        return load(section, () => api().sessions.get({ sessionID }), (session) => {
          if (!state.ready) setState("tags", (session.tags ?? []).join(", "))
          setState({ ready: true, sessionTitle: session.title })
        })
      case "activity":
        return load(section, () => api().sessions.active(), (active) => setState("active", sessionID in active))
      case "schedules":
        return load(section, () => api().scheduledPrompts.list({ sessionID }), (items) => setState("schedules", [...items]))
      case "tasks":
        return load(section, () => api().tasks.list({ sessionID }), (page) => setState("tasks", [...page.items]))
      case "team":
        return load(section, async () => {
          const team = await loadTeam()
          const messages = team ? [...(await api().teams.messageList({ sessionID })).messages] : []
          return { team, messages }
        }, ({ team, messages }) => setState({ team, teamMessages: messages }))
      case "checkpoints":
        return load(section, () => rewindRecovery.refresh(() => api().sessions.checkpointList({ sessionID })), (items) => setState("checkpoints", [...items]))
      case "triggers": {
        const profile = state.triggerProfile
        return load(section, async () => {
          const [profiles, list] = await Promise.all([
            api().triggers.profiles(), api().triggers.list({ sessionID, profile }),
          ])
          return { profiles, list }
        }, ({ profiles, list }) => setState({
          triggerProfiles: [...profiles.items], triggerProfile: profile, triggerItems: triggerItemsFrom(list.data),
        }))
      }
      case "wait":
        return load(section, () => api().waits.active({ sessionID }), (value) => setState("activeWait", value ?? undefined))
    }
  }
  const refreshWrittenSection = async (section: SessionSection) => {
    const refreshed = await refreshSection(section)
    scope.assert()
    if (!refreshed) throw new ManagementRefreshFailure(new Error(state.sections[section].error))
  }
  const mutate = async (section: SessionSection, action: () => Promise<unknown>, notice: string) => {
    if (blocked(section)) return
    setState({ saving: true, error: "", notice: "", refreshError: "", refreshErrorSection: undefined })
    const result = await runManagementMutation(scope, action)
    if (!scope.live()) return
    if (result.status === "failed") {
      fail(result.error)
      setState("sections", section, { fresh: false, error: publicError(result.error) })
    }
    if (result.status === "confirmed" || result.status === "confirmed-refresh-failed") {
      setState("notice", notice)
      if (result.status === "confirmed-refresh-failed") {
        setState("refreshErrorSection", section)
        setState("sections", section, { fresh: false, error: publicError(result.error) })
        setState("refreshError", ui(
          "The write was confirmed. Refresh failed; retry refresh only, not the write. ",
          "写入已确认。刷新失败；请仅重试刷新，不要重复提交。") + publicError(result.error))
      }
    }
    setState("saving", false)
  }
  const refresh = async () => {
    if (state.saving || !scope.live()) return
    setState({ error: "", refreshError: "", refreshErrorSection: undefined })
    await Promise.allSettled(sessionSections.map(refreshSection))
  }

  onMount(() => void refresh())

  const page = () => {
    const tab = sessionSettingsTab(props.value)
    const title = tab ? c()[tab.label] : c().title
    const description = {
      "session-goal-task": ui(
        "Manage tags, autonomous Goals, and durable Task dependencies for this Session.",
        "管理当前会话的标签、自主目标和持久任务依赖关系。",
        "管理目前 Session 的標籤、自主目標與持久任務相依關係。",
      ),
      "session-prompt-queue": ui(
        "Review and reorder durable Prompts using the same FIFO queue as the composer.",
        "查看并调整等待发送的持久消息；顺序与输入区保持一致。",
        "查看並調整等待傳送的持久訊息；順序與輸入區保持一致。",
      ),
      "session-automation": ui(
        "Create schedules and Triggers, inspect cooperative Wait, and run only through explicit Session boundaries.",
        "创建定时与触发任务、查看协作等待，并始终在当前会话范围内执行。",
        "建立排程與觸發任務、查看協作等待，並一律在目前 Session 範圍內執行。",
      ),
      "session-team": ui(
        "Manage the durable Team, Subagent membership, and isolated mailboxes for this Session.",
        "管理当前会话的持久团队、子代理成员与隔离消息箱。",
        "管理目前 Session 的持久團隊、子代理成員與隔離訊息匣。",
      ),
      "session-checkpoint": ui(
        "Create conversation Checkpoints and preview exactly what Rewind will archive before applying it.",
        "创建对话检查点，并在回退前预览将被归档的内容。",
        "建立對話檢查點，並在回退前預覽將被封存的內容。",
      ),
      "session-feedback": ui(
        "Record structured feedback locally after credential-like values are masked by the Server.",
        "记录结构化本地反馈；Server 会在保存前屏蔽疑似凭据内容。",
        "記錄結構化本機回饋；Server 會在儲存前遮蔽疑似憑據內容。",
      ),
    } satisfies Record<SessionSettingsValue, string>
    return { title, description: description[props.value as SessionSettingsValue] ?? "" }
  }

  const updateTags = () =>
    mutate("identity",
      async () => {
        const tags = state.tags
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean)
        const saved = await api().sessions.tagsUpdate({ sessionID: sessionID, tags })
        setState("tags", saved.join(", "))
      },
      ui("Tags updated.", "Tag 已更新。", "Tag 已更新。"),
    )

  const createSchedule = () =>
    mutate("schedules",
      async () => {
        await api().scheduledPrompts.create({
          sessionID: sessionID,
          name: state.scheduleName,
          cron: state.scheduleCron,
          prompt: state.schedulePrompt,
          recurring: state.recurring,
          durable: state.durable,
        })
        setState({ scheduleName: "", schedulePrompt: "" })
        await refreshWrittenSection("schedules")
      },
      ui("Scheduled Prompt created.", "计划 Prompt 已创建。", "排程 Prompt 已建立。"),
    )

  const openSchedule = (schedule: Schedule) =>
    mutate("schedules",
      async () => {
        const current = await api().scheduledPrompts.get({
          sessionID: sessionID,
          scheduleID: schedule.id,
        })
        setState({
          scheduleEditingID: current.id,
          scheduleName: current.name,
          scheduleCron: current.cron,
          schedulePrompt: current.prompt,
          scheduleEnabled: current.enabled,
          recurring: current.recurring,
          durable: current.durable,
        })
      },
      ui(
        `Loaded current Schedule revision ${schedule.revision}.`,
        `已加载 Schedule 修订 ${schedule.revision}。`,
        `已載入 Schedule 修訂 ${schedule.revision}。`,
      ),
    )

  const cancelScheduleEdit = () =>
    setState({
      scheduleEditingID: "",
      scheduleName: "",
      scheduleCron: "0 9 * * *",
      schedulePrompt: "",
      scheduleEnabled: true,
      recurring: false,
      durable: true,
    })

  const updateSchedule = () => {
    const current = state.schedules.find((schedule) => schedule.id === state.scheduleEditingID)
    if (!current) return
    void mutate("schedules",
      async () => {
        const updated = await api().scheduledPrompts.update({
          sessionID: sessionID,
          scheduleID: current.id,
          expectedRevision: current.revision,
          name: state.scheduleName,
          cron: state.scheduleCron,
          prompt: state.schedulePrompt,
          enabled: state.scheduleEnabled,
          recurring: state.recurring,
        })
        setState("schedules", (items) => items.map((item) => (item.id === updated.id ? updated : item)))
        cancelScheduleEdit()
      },
      ui("Scheduled Prompt updated.", "计划 Prompt 已更新。", "排程 Prompt 已更新。"),
    )
  }

  const runSchedule = (schedule: Schedule) => {
    if (
      !window.confirm(
        ui(
          `Run scheduled Prompt “${schedule.name}” now through the normal Prompt Queue?`,
          `立即通过常规 Prompt Queue 运行计划 Prompt“${schedule.name}”？`,
          `立即透過一般 Prompt Queue 執行排程 Prompt「${schedule.name}」？`,
        ),
      )
    )
      return
    void mutate("schedules",
      async () => {
        const updated = await api().scheduledPrompts.run({
          sessionID: sessionID,
          scheduleID: schedule.id,
          expectedRevision: schedule.revision,
        })
        setState("schedules", (items) => items.map((item) => (item.id === updated.id ? updated : item)))
      },
      ui(
        "Scheduled Prompt admitted to this Session.",
        "计划 Prompt 已进入此 Session。",
        "排程 Prompt 已進入此 Session。",
      ),
    )
  }

  const deleteSchedule = (schedule: Schedule) => {
    if (
      !window.confirm(
        ui(
          `Delete scheduled Prompt “${schedule.name}”?`,
          `删除计划 Prompt“${schedule.name}”？`,
          `刪除排程 Prompt「${schedule.name}」？`,
        ),
      )
    )
      return
    void mutate("schedules",
      async () => {
        await api().scheduledPrompts.delete({
          sessionID: sessionID,
          scheduleID: schedule.id,
          expectedRevision: schedule.revision,
        })
        setState("schedules", (items) => items.filter((item) => item.id !== schedule.id))
      },
      ui("Scheduled Prompt deleted.", "计划 Prompt 已删除。", "排程 Prompt 已刪除。"),
    )
  }

  const runMissed = (schedule: Schedule) => {
    if (
      !window.confirm(
        ui(
          `Run missed Prompt “${schedule.name}” now? It will enter the normal Session Queue.`,
          `立即运行错过的 Prompt“${schedule.name}”？它将进入常规 Session Queue。`,
          `立即執行錯過的 Prompt「${schedule.name}」？它將進入一般 Session Queue。`,
        ),
      )
    )
      return
    void mutate("schedules",
      async () => {
        const updated = await api().scheduledPrompts.runMissed({
          sessionID: sessionID,
          scheduleID: schedule.id,
          expectedRevision: schedule.revision,
        })
        setState("schedules", (items) => items.map((item) => (item.id === updated.id ? updated : item)))
      },
      ui(
        "Missed Prompt admitted to this Session.",
        "错过的 Prompt 已进入此 Session。",
        "錯過的 Prompt 已進入此 Session。",
      ),
    )
  }

  const createCheckpoint = () =>
    mutate("checkpoints",
      async () => {
        await api().sessions.checkpointCreate({
          sessionID: sessionID,
          label: state.checkpointLabel,
        })
        setState("checkpointLabel", "")
        await refreshWrittenSection("checkpoints")
      },
      ui("Checkpoint created.", "Checkpoint 已创建。", "Checkpoint 已建立。"),
    )

  const refreshTriggers = (profile = state.triggerProfile) =>
    mutate("triggers",
      async () => {
        const result = await api().triggers.list({ sessionID: sessionID, profile })
        setState({ triggerProfile: profile, triggerItems: triggerItemsFrom(result.data) })
      },
      ui(`Triggers refreshed from ${profile}.`, `已从 ${profile} 刷新 Trigger。`, `已從 ${profile} 重新整理 Trigger。`),
    )

  const parseTriggerBody = () => {
    const value: unknown = JSON.parse(state.triggerBody)
    if (!isRecord(value))
      throw new Error(
        ui(
          "Trigger body must be a JSON object.",
          "Trigger Body 必须是 JSON Object。",
          "Trigger Body 必須是 JSON Object。",
        ),
      )
    return value
  }

  const createTrigger = () =>
    mutate("triggers",
      async () => {
        const result = await api().triggers.create({
          sessionID: sessionID,
          profile: state.triggerProfile,
          body: parseTriggerBody(),
        })
        const item = resultItem(result.data)
        if (item && typeof item.id === "string") setState("triggerID", item.id)
        await refreshWrittenSection("triggers")
      },
      ui("Trigger created.", "Trigger 已创建。", "Trigger 已建立。"),
    )

  const openTrigger = (triggerID: string) =>
    mutate("triggers",
      async () => {
        const result = await api().triggers.get({
          sessionID: sessionID,
          profile: state.triggerProfile,
          triggerID,
        })
        const item = resultItem(result.data)
        setState({
          triggerID,
          triggerBody: JSON.stringify(item ?? result.data, null, 2),
        })
      },
      ui(
        `Loaded current Trigger ${triggerID}.`,
        `已加载当前 Trigger ${triggerID}。`,
        `已載入目前 Trigger ${triggerID}。`,
      ),
    )

  const updateTrigger = () =>
    mutate("triggers",
      async () => {
        await api().triggers.update({
          sessionID: sessionID,
          profile: state.triggerProfile,
          triggerID: state.triggerID,
          body: parseTriggerBody(),
        })
        await refreshWrittenSection("triggers")
      },
      ui("Trigger updated.", "Trigger 已更新。"),
    )

  const runTrigger = () => {
    if (
      !window.confirm(
        state.triggerProfile === "local"
          ? ui(
              "Run this Trigger now through the normal Session Queue?",
              "立即通过常规 Session Queue 运行此 Trigger？",
              "立即透過一般 Session Queue 執行此 Trigger？",
            )
          : ui(
              `Run this Trigger now through Host Profile “${state.triggerProfile}”? This can cause an external side effect.`,
              `立即通过 Host Profile“${state.triggerProfile}”运行此 Trigger？这可能产生外部副作用。`,
              `立即透過 Host Profile「${state.triggerProfile}」執行此 Trigger？這可能產生外部副作用。`,
            ),
      )
    )
      return
    void mutate("triggers",
      async () => {
        await api().triggers.run({
          sessionID: sessionID,
          profile: state.triggerProfile,
          triggerID: state.triggerID,
        })
        await refreshWrittenSection("triggers")
      },
      ui("Trigger run requested.", "已请求运行 Trigger。", "已要求執行 Trigger。"),
    )
  }

  const refreshWait = () =>
    mutate("wait",
      async () => {
        setState("activeWait", (await api().waits.active({ sessionID: sessionID })) ?? undefined)
      },
      ui("Wait state refreshed.", "Wait 状态已刷新。", "Wait 狀態已重新整理。"),
    )

  const wakeWait = () => {
    const activeWait = state.activeWait
    if (
      !activeWait ||
      !window.confirm(
        ui(
          `Wake the active Wait “${activeWait.reason || activeWait.waitID}”?`,
          `唤醒活动 Wait“${activeWait.reason || activeWait.waitID}”？`,
          `喚醒活動 Wait「${activeWait.reason || activeWait.waitID}」？`,
        ),
      )
    )
      return
    void mutate("wait",
      async () => {
        await api().waits.wake({
          sessionID: sessionID,
          waitID: activeWait.waitID,
        })
        setState("activeWait", undefined)
      },
      ui("Wake signal delivered.", "唤醒信号已送达。", "喚醒訊號已送達。"),
    )
  }

  const loadTeam = async () => {
    try {
      return await api().teams.get({ sessionID: sessionID })
    } catch (error) {
      if (isMissingTeam(error)) return undefined
      throw error
    }
  }

  const createTeam = () =>
    mutate("team",
      async () => {
        await api().teams.create({
          sessionID: sessionID,
          name: state.teamName,
          description: state.teamDescription || undefined,
        })
        setState({ teamName: "", teamDescription: "" })
        await refreshWrittenSection("team")
      },
      ui("Durable team created.", "持久化团队已创建。", "持久化團隊已建立。"),
    )

  const addTeamMember = () =>
    mutate("team",
      async () => {
        await api().teams.memberAdd({
          sessionID: sessionID,
          memberName: state.teamMemberName,
          agentID: state.teamAgentID,
        })
        setState({ teamMemberName: "", teamAgentID: "" })
        await refreshWrittenSection("team")
      },
      ui("Team member added.", "团队成员已添加。", "團隊成員已新增。"),
    )

  const sendTeamMessage = () =>
    mutate("team",
      async () => {
        await api().teams.messageSend({
          sessionID: sessionID,
          recipient: state.teamRecipient,
          message: state.teamMessage,
        })
        setState("teamMessage", "")
        await refreshWrittenSection("team")
      },
      ui("Team message sent.", "团队消息已发送。", "團隊訊息已傳送。"),
    )

  const requestMemberShutdown = (member: Team["members"][number]) => {
    if (
      !window.confirm(
        ui(
          `Ask “${member.name}” to stop gracefully? The member must explicitly approve.`,
          `请求“${member.name}”优雅停止？该成员必须明确批准。`,
          `要求「${member.name}」正常停止？該成員必須明確核准。`,
        ),
      )
    )
      return
    void mutate("team", async () => {
      await api().teams.shutdownRequest({
        sessionID: sessionID,
        memberName: member.name,
        reason: "Lead requested graceful shutdown.",
      })
      await refreshWrittenSection("team")
    }, ui("Shutdown requested. Wait for the member's response.", "已请求停止，请等待该成员回应。", "已要求停止，請等待該成員回應。"))
  }

  const removeTeamMember = (member: Team["members"][number]) => {
    if (
      !window.confirm(
        ui(
          `Remove stopped member “${member.name}” from this team?`,
          `从此团队移除已停止成员“${member.name}”？`,
          `從此團隊移除已停止成員「${member.name}」？`,
        ),
      )
    )
      return
    void mutate("team",
      async () => {
        await api().teams.memberRemove({
          sessionID: sessionID,
          memberName: member.name,
        })
        await refreshWrittenSection("team")
      },
      ui("Stopped member removed.", "已停止成员已移除。", "已停止成員已移除。"),
    )
  }

  const deleteTeam = () => {
    if (!window.confirm(ui(
      "Delete this team, its complete mailbox, and all shutdown metadata?",
      "删除此团队、完整消息箱和全部停止记录？",
      "刪除此團隊、完整訊息箱和全部停止記錄？",
    ))) return
    void mutate("team",
      async () => {
        await api().teams.delete({ sessionID: sessionID })
        setState({ team: undefined, teamMessages: [] })
      },
      ui("Team and mailbox deleted.", "团队与消息箱已删除。", "團隊與訊息箱已刪除。"),
    )
  }

  const createTask = () =>
    mutate("tasks",
      async () => {
        await api().tasks.create({
          sessionID: sessionID,
          title: state.taskTitle,
          description: state.taskDescription || undefined,
          blockedBy: state.taskBlockers,
        })
        setState({ taskTitle: "", taskDescription: "", taskBlockers: [] })
        await refreshWrittenSection("tasks")
      },
      ui("Durable Task created.", "持久任务已创建。", "持久任務已建立。"),
    )

  const toggleTaskBlocker = (taskID: string, checked: boolean) =>
    setState("taskBlockers", (ids) => (checked ? [...new Set([...ids, taskID])] : ids.filter((id) => id !== taskID)))

  const replaceTask = (task: Task) =>
    setState("tasks", (items) => items.map((item) => (item.id === task.id ? task : item)))

  const cancelTaskEdit = () =>
    setState({
      taskTitle: "",
      taskDescription: "",
      taskBlockers: [],
      taskEditingID: "",
      taskEditingRevision: 0,
    })

  const editTask = (task: Task) =>
    void mutate("tasks",
      async () => {
        const current = await api().tasks.get({ sessionID: sessionID, taskID: task.id })
        setState({
          taskTitle: current.title,
          taskDescription: current.description ?? "",
          taskBlockers: [...current.blockedBy],
          taskEditingID: current.id,
          taskEditingRevision: current.revision,
        })
        requestAnimationFrame(() => {
          document.getElementById("operations-task-editor")?.scrollIntoView({
            block: "start",
            behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
          })
        })
      },
      ui("Task loaded for editing.", "任务已载入，可在上方表单中编辑。", "任務已載入，可在上方表單中編輯。"),
    )

  const updateTask = () => {
    if (!state.taskEditingID || !state.taskTitle.trim()) return
    void mutate("tasks",
      async () => {
        replaceTask(
          await api().tasks.update({
            sessionID: sessionID,
            taskID: state.taskEditingID,
            expectedRevision: state.taskEditingRevision,
            title: state.taskTitle.trim(),
            description: state.taskDescription || undefined,
            blockedBy: state.taskBlockers,
          }),
        )
        cancelTaskEdit()
      },
      ui("Task details updated.", "任务详情已更新。", "任務詳情已更新。"),
    )
  }

  const clearTerminalTasks = () => {
    const count = state.tasks.filter((task) => task.status === "completed" || task.status === "cancelled").length
    if (!count || !window.confirm(`Delete ${count} completed or cancelled task(s)? Active tasks will remain.`)) return
    void mutate("tasks", async () => {
      await api().tasks.clear({ sessionID: sessionID, terminalOnly: true })
      await refreshWrittenSection("tasks")
    }, "Terminal tasks cleared.")
  }

  const claimTask = (task: Task) =>
    void mutate("tasks", async () => {
      replaceTask(
        await api().tasks.claim({
          sessionID: sessionID,
          taskID: task.id,
          expectedRevision: task.revision,
          owner: state.taskOwner,
        }),
      )
    }, `Task claimed by ${state.taskOwner}.`)

  const releaseTask = (task: Task) =>
    void mutate("tasks", async () => {
      if (!task.owner) return
      replaceTask(
        await api().tasks.release({
          sessionID: sessionID,
          taskID: task.id,
          expectedRevision: task.revision,
          owner: task.owner,
        }),
      )
    }, "Task released.")

  const completeTask = (task: Task) =>
    void mutate("tasks", async () => {
      await api().tasks.complete({
        sessionID: sessionID,
        taskID: task.id,
        expectedRevision: task.revision,
      })
      await refreshWrittenSection("tasks")
    }, "Task completed.")

  const cancelTask = (task: Task) => {
    if (!window.confirm(`Cancel task “${task.title}”? Tasks depending on it will remain blocked.`)) return
    void mutate("tasks", async () => {
      await api().tasks.cancel({
        sessionID: sessionID,
        taskID: task.id,
        expectedRevision: task.revision,
      })
      await refreshWrittenSection("tasks")
    }, "Task cancelled; dependent tasks remain blocked.")
  }

  const deleteTask = (task: Task) => {
    if (!window.confirm(`Delete task “${task.title}” and all of its dependency links?`)) return
    void mutate("tasks", async () => {
      await api().tasks.delete({
        sessionID: sessionID,
        taskID: task.id,
        expectedRevision: task.revision,
      })
      await refreshWrittenSection("tasks")
    }, "Task and dependency links deleted.")
  }

  const previewRewind = (checkpoint: Checkpoint) =>
    mutate("checkpoints", async () => {
      setState(
        "preview",
        await api().sessions.rewindPreview({ sessionID: sessionID, checkpointID: checkpoint.id }),
      )
    }, "Rewind preview ready. Review it before applying.")

  const applyRewind = () => {
    const preview = state.preview
    if (!preview) return
    const sync = props.sync
    if (!sync) {
      fail(
        new Error(
          ui(
            "Open these controls from the active Session before applying Rewind.",
            "请从当前 Session 打开此控制页后再应用 Rewind。",
            "請從目前 Session 開啟此控制頁後再套用 Rewind。",
          ),
        ),
      )
      return
    }
    if (
      !window.confirm(
        `Archive ${preview.affectedMessages} conversation message(s)? Files, commands, Git history, and external side effects will not be changed.`,
      )
    )
      return
    void mutate("checkpoints", async () => {
      await api().sessions.rewindApply({
        sessionID: sessionID,
        checkpointID: preview.checkpoint.id,
        expectedLastSequence: preview.expectedLastSequence,
      })
      setState("preview", undefined)
      // Retain only the acknowledged write's read recovery, never the write itself.
      rewindRecovery.require(() => sync().session.sync(sessionID, { force: true }))
      await refreshWrittenSection("checkpoints")
    }, "Conversation rewound; workspace effects were left unchanged.")
  }

  return (
    <TabsV2.Content value={props.value} class="settings-v2-panel session-settings-panel">
      <header class="settings-v2-tab-header session-settings-header">
        <h2 class="settings-v2-tab-title">{page().title}</h2>
        <p class="session-settings-description">{page().description}</p>
        <div class="session-settings-context">
          <div class="session-settings-context-copy">
            <strong>{state.sessionTitle || "Session"}</strong>
            <span title={sessionID}>{sessionID}</span>
          </div>
          <div class="session-settings-context-actions">
            <span
              class="session-settings-state"
              data-active={state.active ? "true" : undefined}
              data-loading={state.loading ? "true" : undefined}
            >
              {state.loading
                ? ui("Loading", "加载中", "載入中")
                : !state.ready || !state.sections.identity.fresh || !state.sections.activity.fresh
                  ? ui("Unavailable", "不可用", "無法使用")
                  : state.active
                    ? ui("Running", "运行中", "執行中")
                    : ui("Idle", "空闲", "閒置")}
            </span>
            <Button
              type="button"
              size="small"
              variant="ghost"
              disabled={state.loading || state.saving}
              onClick={refresh}
            >
              {controlText("刷新")}
            </Button>
          </div>
        </div>
      </header>
      <div
        class="settings-v2-tab-body session-settings-body"
        data-testid="session-operations"
        aria-busy={state.loading || state.saving}
      >
        <ManagementStatus
          saving={state.saving}
          error={state.error}
          notice={state.notice}
        />
        <ManagementStatus error={state.refreshError} loading={state.loading} saving={state.saving} onRetry={() => void refresh()} />
        <For each={sessionSections.filter((key) => state.sections[key].loading || !!state.sections[key].error)}>
          {(section) => <div class="flex flex-col gap-1" data-section={section}>
            <strong class="text-12-medium">{sectionLabel(section)}</strong>
            <ManagementStatus loading={state.sections[section].loading} saving={state.saving}
              error={state.sections[section].error}
              onRetry={() => { if (!state.saving) void refreshSection(section) }} />
            <Show when={state.sections[section].error}>
              <p class="text-11-regular text-text-weak">{ui(
                "Unavailable or stale data. Dependent actions are disabled until refresh succeeds.",
                "数据不可用或已过期；刷新成功前已禁用依赖这些数据的操作。")}</p>
            </Show>
          </div>}
        </For>
        <Show when={state.active && state.sections.activity.fresh}>
          <div role="status" class="rounded-md border border-border-warning p-3 text-12-regular text-text-weak">
            {c().activeNotice}
          </div>
        </Show>

        <Show when={state.ready}>
          <Show when={props.value === "session-goal-task"}>
            <section class="flex flex-col gap-3" aria-labelledby="operations-tags-title">
              <h2 id="operations-tags-title" class="text-14-medium text-text-strong">
                {c().tags}
              </h2>
              <TextField
                label={c().tagLabel}
                value={state.tags}
                onChange={(value) => setState("tags", value)}
                placeholder="backend, release"
                disabled={blocked("identity") || state.active}
              />
              <div>
                <Button size="small" variant="secondary" disabled={blocked("identity") || state.active} onClick={updateTags}>
                  {language.t("common.save")}
                </Button>
              </div>
            </section>

            <SessionGoalControl sessionID={sessionID} disabled={blocked("identity")} />
          </Show>
          <Show when={props.value === "session-prompt-queue"}>
            <SessionPromptQueueControl sessionID={sessionID} disabled={blocked("identity")} />
          </Show>
          <Show when={props.value === "session-feedback"}>
            <SessionFeedbackControl api={api} sessionID={sessionID} disabled={blocked("identity")} />
          </Show>

          <Show when={props.value === "session-automation"}>
            <section
              class="flex flex-col gap-3 border-t border-border-weak-base pt-5"
              aria-labelledby="operations-schedule-title"
            >
              <h2 id="operations-schedule-title" class="text-14-medium text-text-strong">
                {c().scheduleTitle}
              </h2>
              <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
                <TextField
                  label={ui("Schedule name", "Schedule 名称", "Schedule 名稱")}
                  value={state.scheduleName}
                  onChange={(value) => setState("scheduleName", value)}
                  placeholder={ui("Daily review", "每日复盘", "每日複盤")}
                  disabled={blocked("schedules")}
                />
                <TextField
                  label={ui("Five-field local-time cron", "五段式本地时间 cron", "五段式本機時間 cron")}
                  value={state.scheduleCron}
                  onChange={(value) => setState("scheduleCron", value)}
                  placeholder="0 9 * * *"
                  disabled={blocked("schedules")}
                />
              </div>
              <TextField
                label="Prompt"
                multiline
                value={state.schedulePrompt}
                onChange={(value) => setState("schedulePrompt", value)}
                placeholder={ui("Review the current implementation.", "复查当前实现。", "檢查目前實作。")}
                disabled={blocked("schedules")}
              />
              <div class="flex flex-wrap gap-4">
                <Checkbox checked={state.recurring} onChange={(value) => setState("recurring", value)}>
                  {ui("Recurring within seven-day lifetime", "在七天生命周期内重复", "在七天生命週期內重複")}
                </Checkbox>
                <Checkbox checked={state.durable} onChange={(value) => setState("durable", value)}>
                  {ui("Restore after restart", "重启后恢复", "重新啟動後恢復")}
                </Checkbox>
                <Show when={state.scheduleEditingID}>
                  <Checkbox checked={state.scheduleEnabled} onChange={(value) => setState("scheduleEnabled", value)}>
                    {controlText("enabled")}
                  </Checkbox>
                </Show>
              </div>
              <div class="flex flex-wrap gap-2">
                <Show
                  when={state.scheduleEditingID}
                  fallback={
                    <Button
                      size="small"
                      variant="primary"
                      disabled={blocked("schedules") || !state.scheduleName.trim() || !state.schedulePrompt.trim()}
                      onClick={createSchedule}
                    >
                      {ui("Create Schedule", "创建 Schedule", "建立 Schedule")}
                    </Button>
                  }
                >
                  <Button
                    size="small"
                    variant="primary"
                    disabled={blocked("schedules") || !state.scheduleName.trim() || !state.schedulePrompt.trim()}
                    onClick={updateSchedule}
                  >
                    {ui("Save Schedule", "保存 Schedule", "儲存 Schedule")}
                  </Button>
                  <Button size="small" variant="ghost" disabled={blocked("schedules")} onClick={cancelScheduleEdit}>
                    {language.t("common.cancel")}
                  </Button>
                </Show>
              </div>
              <div class="flex flex-col gap-2">
                <For each={state.schedules}>
                  {(schedule) => (
                    <article class="flex flex-col gap-2 rounded-md border border-border-weak-base p-3">
                      <div class="flex flex-wrap items-start justify-between gap-3">
                        <div class="min-w-0">
                          <div class="text-13-medium text-text-strong">{schedule.name}</div>
                          <div class="text-11-regular text-text-weak">
                            {schedule.cron} · {schedule.status} · revision {schedule.revision}
                          </div>
                        </div>
                        <div class="flex flex-wrap gap-2">
                          <Button
                            size="small"
                            variant="ghost"
                            disabled={blocked("schedules")}
                            onClick={() => void openSchedule(schedule)}
                          >
                            {language.t("common.edit")}
                          </Button>
                          <Button
                            size="small"
                            variant="secondary"
                            disabled={blocked("schedules") || state.active}
                            onClick={() => runSchedule(schedule)}
                          >
                            {ui("Run now…", "立即运行…", "立即執行…")}
                          </Button>
                          <Show when={schedule.status === "missed"}>
                            <Button
                              size="small"
                              variant="secondary"
                              disabled={blocked("schedules") || state.active}
                              onClick={() => runMissed(schedule)}
                            >
                              {ui("Run missed…", "运行错过项…", "執行錯過項…")}
                            </Button>
                          </Show>
                          <Button
                            size="small"
                            variant="ghost"
                            disabled={blocked("schedules")}
                            onClick={() => deleteSchedule(schedule)}
                          >
                            {language.t("common.delete")}
                          </Button>
                        </div>
                      </div>
                      <p class="whitespace-pre-wrap break-words text-12-regular text-text-weak">{schedule.prompt}</p>
                      <Show when={schedule.lastError}>
                        <p class="text-11-regular text-text-danger">{schedule.lastError}</p>
                      </Show>
                    </article>
                  )}
                </For>
                <Show when={!state.loading && state.schedules.length === 0}>
                  <p class="text-12-regular text-text-weak">
                    {ui("No scheduled Prompts.", "当前没有计划 Prompt。", "目前沒有排程 Prompt。")}
                  </p>
                </Show>
              </div>
            </section>

            <SessionPersonalJobsControl sessionID={sessionID} disabled={blocked("identity")} />

            <section
              class="flex flex-col gap-3 border-t border-border-weak-base pt-5"
              aria-labelledby="operations-trigger-title"
            >
              <h2 id="operations-trigger-title" class="text-14-medium text-text-strong">
                {c().triggerTitle}
              </h2>
              <p class="text-12-regular text-text-weak">
                {ui(
                  "The local profile uses the durable Schedule store above. HTTP profiles, URLs, headers, and credentials are host-configured; this dialog never accepts or reveals authentication values.",
                  "本地 Profile 使用上方持久化 Schedule 存储。HTTP Profile、URL、Header 与凭据均由 Host 配置；此对话框不会接收或显示认证值。",
                  "本機 Profile 使用上方持久化 Schedule 儲存。HTTP Profile、URL、Header 與憑據均由 Host 設定；此對話框不會接收或顯示驗證值。",
                )}
              </p>
              <div class="flex flex-wrap items-end gap-3">
                <label class="flex min-w-48 flex-1 flex-col gap-1 text-12-medium text-text-strong">
                  {ui("Host Profile", "Host Profile")}
                  <SelectV2
                    options={state.triggerProfiles}
                    current={state.triggerProfiles.find((profile) => profile.name === state.triggerProfile)}
                    value={(profile) => profile.name}
                    label={(profile) => `${profile.name} (${profile.kind})`}
                    onSelect={(profile) => profile && void refreshTriggers(profile.name)}
                    disabled={blocked("triggers")}
                  />
                </label>
                <Button size="small" variant="ghost" disabled={blocked("triggers")} onClick={() => void refreshTriggers()}>
                  {controlText("刷新")}
                </Button>
              </div>
              <Show when={state.triggerProfiles.find((profile) => profile.name === state.triggerProfile)}>
                {(profile) => (
                  <div class="rounded-md border border-border-weak-base p-3 text-11-regular text-text-weak">
                    {profile().kind === "local"
                      ? ui("Local durable scheduler", "本地持久化调度器", "本機持久化排程器")
                      : profile().baseUrl}{" "}
                    · timeout {profile().timeout}s
                    <Show when={profile().auth}>
                      {(auth) => (
                        <>
                          {" "}
                          · {auth().type} ·{" "}
                          {auth().configured
                            ? ui("credentials configured", "凭据已配置", "憑據已設定")
                            : ui("credentials missing", "缺少凭据", "缺少憑據")}
                        </>
                      )}
                    </Show>
                  </div>
                )}
              </Show>
              <TextField
                label={ui(
                  "Trigger ID (required for update and run)",
                  "Trigger ID（更新和运行时必填）",
                  "Trigger ID（更新和執行時必填）",
                )}
                value={state.triggerID}
                onChange={(value) => setState("triggerID", value)}
                placeholder={ui(
                  "Select an item below or paste its Provider ID",
                  "选择下方项目或粘贴其 Provider ID",
                  "選擇下方項目或貼上其 Provider ID",
                )}
                disabled={blocked("triggers")}
              />
              <TextField
                label={ui(
                  "Create or update body (JSON object)",
                  "创建或更新 Body（JSON Object）",
                  "建立或更新 Body（JSON Object）",
                )}
                multiline
                value={state.triggerBody}
                onChange={(value) => setState("triggerBody", value)}
                disabled={blocked("triggers")}
              />
              <div class="flex flex-wrap gap-2">
                <Button
                  size="small"
                  variant="primary"
                  disabled={blocked("triggers") || !state.triggerBody.trim()}
                  onClick={createTrigger}
                >
                  {ui("Create", "创建", "建立")}
                </Button>
                <Button
                  size="small"
                  variant="secondary"
                  disabled={blocked("triggers") || !state.triggerID.trim() || !state.triggerBody.trim()}
                  onClick={updateTrigger}
                >
                  {ui("Update", "更新")}
                </Button>
                <Button
                  size="small"
                  variant="secondary"
                  disabled={
                    state.saving || !state.triggerID.trim() || (state.triggerProfile === "local" && state.active)
                  }
                  onClick={runTrigger}
                >
                  {ui("Run now…", "立即运行…", "立即執行…")}
                </Button>
              </div>
              <div class="flex flex-col gap-2">
                <For each={state.triggerItems}>
                  {(item) => (
                    <article class="flex flex-col gap-2 rounded-md border border-border-weak-base p-3">
                      <div class="flex flex-wrap items-center justify-between gap-3">
                        <div class="text-12-medium text-text-strong">
                          {typeof item.name === "string"
                            ? item.name
                            : typeof item.id === "string"
                              ? item.id
                              : ui("Provider Trigger", "Provider Trigger")}
                        </div>
                        <Show when={typeof item.id === "string" ? item.id : undefined}>
                          {(id) => (
                            <Button
                              size="small"
                              variant="ghost"
                              disabled={blocked("triggers")}
                              onClick={() => void openTrigger(id())}
                            >
                              {language.t("common.open")}
                            </Button>
                          )}
                        </Show>
                      </div>
                      <pre class="max-h-40 overflow-auto whitespace-pre-wrap break-all text-11-regular text-text-weak">
                        {JSON.stringify(item, null, 2)}
                      </pre>
                    </article>
                  )}
                </For>
                <Show when={!state.loading && state.triggerItems.length === 0}>
                  <p class="text-12-regular text-text-weak">
                    {ui(
                      "This Profile returned no Triggers.",
                      "此 Profile 未返回 Trigger。",
                      "此 Profile 未傳回 Trigger。",
                    )}
                  </p>
                </Show>
              </div>
            </section>

            <section
              class="flex flex-col gap-3 border-t border-border-weak-base pt-5"
              aria-labelledby="operations-wait-title"
            >
              <div class="flex flex-wrap items-center justify-between gap-3">
                <h2 id="operations-wait-title" class="text-14-medium text-text-strong">
                  {c().waitTitle}
                </h2>
                <Button size="small" variant="ghost" disabled={blocked("wait")} onClick={() => void refreshWait()}>
                  {controlText("刷新")}
                </Button>
              </div>
              <p class="text-12-regular text-text-weak">
                {ui(
                  "Wait is in-process coordination, not shell sleep. Only the backend-issued ID for this Session can be woken.",
                  "Wait 是进程内协作，不是 shell sleep；只能唤醒后端为此 Session 签发的 ID。",
                  "Wait 是處理程序內協作，不是 shell sleep；只能喚醒後端為此 Session 簽發的 ID。",
                )}
              </p>
              <Show
                when={state.activeWait}
                fallback={
                  <p class="text-12-regular text-text-weak">
                    {ui("No active cooperative Wait.", "当前没有活动的协作 Wait。", "目前沒有活動中的協作 Wait。")}
                  </p>
                }
              >
                {(activeWait) => (
                  <article class="flex flex-col gap-3 rounded-md border border-border-warning p-3">
                    <div>
                      <div class="text-13-medium text-text-strong">
                        {activeWait().reason || ui("Active Wait", "活动 Wait", "活動 Wait")}
                      </div>
                      <div class="text-11-regular text-text-weak">
                        {activeWait().elapsedSeconds.toFixed(1)}s elapsed · {activeWait().remainingSeconds.toFixed(1)}s
                        remaining · {activeWait().checkInCount} check-in(s)
                      </div>
                    </div>
                    <div>
                      <Button size="small" variant="secondary" disabled={blocked("wait")} onClick={wakeWait}>
                        {ui("Wake now…", "立即唤醒…", "立即喚醒…")}
                      </Button>
                    </div>
                  </article>
                )}
              </Show>
            </section>
          </Show>

          <Show when={props.value === "session-team"}>
            <section
              class="flex flex-col gap-3 border-t border-border-weak-base pt-5"
              aria-labelledby="operations-team-title"
              data-testid="session-team-control"
            >
              <h2 id="operations-team-title" class="text-14-medium text-text-strong">
                {c().teamTitle}
              </h2>
              <p class="text-12-regular text-text-weak">{c().teamDescription}</p>
              <div class="rounded-md border border-border-warning bg-background-weak p-3 text-11-regular leading-5 text-text-weak">
                {ui(
                  "Use a team only when work can be divided into clear roles. A single Agent is simpler and usually cheaper for small tasks; current multi-agent evidence does not justify enabling teams just for speed.",
                  "只在任务能拆成明确角色时使用团队。小任务使用单个代理更简单、通常也更省成本；当前多代理证据不足以支持仅为提速而启用团队。",
                  "只在任務能拆成明確角色時使用團隊。小任務使用單一代理更簡單、通常也更省成本；目前多代理證據不足以支持只為提速而啟用團隊。",
                )}
              </div>
              <Show
                when={state.team}
                fallback={
                  <>
                    <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
                      <TextField
                        label={ui("Team name (required)", "团队名称（必填）", "團隊名稱（必填）")}
                        value={state.teamName}
                        onChange={(value) => setState("teamName", value)}
                        placeholder={ui("Implementation review team", "功能审查团队", "功能審查團隊")}
                        disabled={blocked("team")}
                      />
                      <TextField
                        label={ui("Collaboration goal", "协作目标", "協作目標")}
                        value={state.teamDescription}
                        onChange={(value) => setState("teamDescription", value)}
                        placeholder={ui(
                          "Review implementation, tests, and user experience",
                          "分别检查实现、测试和用户体验",
                          "分別檢查實作、測試與使用者體驗",
                        )}
                        disabled={blocked("team")}
                      />
                    </div>
                    <div>
                      <Button
                        size="small"
                        variant="primary"
                        disabled={blocked("team") || !state.teamName.trim()}
                        onClick={createTeam}
                      >
                        {ui("Create collaboration team", "创建协作团队", "建立協作團隊")}
                      </Button>
                    </div>
                  </>
                }
              >
                {(team) => (
                  <>
                    <div class="rounded-md border border-border-weak-base p-3">
                      <div class="text-13-medium text-text-strong">{team().name}</div>
                      <p class="text-12-regular text-text-weak">
                        {team().description || ui("No collaboration goal provided.", "未填写协作目标。", "未填寫協作目標。")}
                      </p>
                      <div class="text-11-regular text-text-weak">
                        {team().memberCount}/8 {ui("members", "名成员", "名成員")} · {team().messageCount}/500 {ui("saved messages", "条已保存消息", "則已儲存訊息")}
                      </div>
                    </div>
                    <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
                      <TextField
                        label={ui("Member name", "成员名称", "成員名稱")}
                        value={state.teamMemberName}
                        onChange={(value) => setState("teamMemberName", value)}
                          placeholder={ui("reviewer", "审查员", "審查員")}
                        disabled={blocked("team") || team().memberCount >= 8}
                      />
                      <label class="flex flex-col gap-1 text-12-medium text-text-strong">
                        {ui("Subagent configuration", "子代理配置", "子代理設定")}
                        <SelectV2
                          placeholder={ui("Subagent…", "选择子代理…", "選擇子代理…")}
                          options={agents().filter((agent) => agent.mode === "subagent" && !agent.hidden)}
                          current={agents().find((agent) => agent.name === state.teamAgentID)}
                          value={(agent) => agent.name}
                          label={(agent) => agent.name}
                          onSelect={(agent) => setState("teamAgentID", agent?.name ?? "")}
                          disabled={blocked("team") || team().memberCount >= 8 || !props.sync}
                        />
                      </label>
                    </div>
                    <Show when={!props.sync || agents().every((agent) => agent.mode !== "subagent" || agent.hidden)}>
                      <p class="text-11-regular text-text-warning">
                        {props.sync
                          ? c().noSubagent
                          : ui(
                              "Open these controls from the active session to load subagents.",
                              "请从当前会话打开此控制页以加载子代理。",
                              "請從目前工作階段開啟此控制頁以載入子代理。",
                            )}
                      </p>
                    </Show>
                    <div>
                      <Button
                        size="small"
                        variant="secondary"
                        disabled={
                          state.saving ||
                          team().memberCount >= 8 ||
                          !props.sync ||
                          !state.teamMemberName.trim() ||
                          !state.teamAgentID
                        }
                        onClick={addTeamMember}
                      >
                        {ui("Add member", "添加成员", "新增成員")}
                      </Button>
                    </div>
                    <div class="flex flex-col gap-2">
                      <For each={team().members.filter((member) => member.name !== "lead")}>
                        {(member) => (
                          <article class="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border-weak-base p-3">
                            <div>
                              <div class="text-13-medium text-text-strong">{member.name}</div>
                              <div class="text-11-regular text-text-weak">
                                {ui("Subagent", "子代理", "子代理")} {member.agentID} · {member.status === "active" ? ui("Active", "工作中", "工作中") : ui("Stopped", "已停止", "已停止")}
                              </div>
                            </div>
                            <div class="flex flex-wrap gap-2">
                              <Show when={member.status === "active"}>
                                <Button
                                  size="small"
                                  variant="ghost"
                                  disabled={blocked("team")}
                                  onClick={() => requestMemberShutdown(member)}
                                >
                                  {ui("Request shutdown…", "请求停止…", "要求停止…")}
                                </Button>
                              </Show>
                              <Show when={member.status === "stopped"}>
                                <Button
                                  size="small"
                                  variant="ghost"
                                  disabled={blocked("team")}
                                  onClick={() => removeTeamMember(member)}
                                >
                                  {ui("Remove…", "移除…")}
                                </Button>
                              </Show>
                            </div>
                          </article>
                        )}
                      </For>
                    </div>
                    <Show when={team().memberCount > 0}>
                      <div class="flex flex-col gap-3 rounded-md border border-border-weak-base p-3">
                        <label class="flex flex-col gap-1 text-12-medium text-text-strong">
                          {ui("Recipient", "接收者", "接收者")}
                          <SelectV2
                            options={[
                              "*",
                              ...team()
                                .members.filter((member) => member.name !== "lead" && member.status !== "stopped")
                                .map((member) => member.name),
                            ]}
                            current={state.teamRecipient}
                            label={(recipient) =>
                              recipient === "*" ? ui("All active members", "所有活动成员", "所有活動成員") : recipient
                            }
                            onSelect={(recipient) => setState("teamRecipient", recipient ?? "*")}
                            disabled={blocked("team")}
                          />
                        </label>
                        <TextField
                          label={ui("Message", "消息", "訊息")}
                          multiline
                          value={state.teamMessage}
                          onChange={(value) => setState("teamMessage", value)}
                          placeholder={ui(
                            "Share a bounded request or result.",
                            "共享边界明确的请求或结果。",
                            "分享邊界明確的要求或結果。",
                          )}
                          disabled={blocked("team")}
                        />
                        <div>
                          <Button
                            size="small"
                            variant="secondary"
                            disabled={blocked("team") || !state.teamMessage.trim()}
                            onClick={sendTeamMessage}
                          >
                            {ui("Send", "发送", "傳送")}
                          </Button>
                        </div>
                      </div>
                    </Show>
                    <div class="flex items-center justify-between gap-3">
                      <h3 class="text-12-medium text-text-strong">{c().leadInbox}</h3>
                      <Button size="small" variant="ghost" disabled={state.saving || state.sections.team.loading}
                        onClick={() => {
                          if (state.saving || state.sections.team.loading) return
                          void refreshSection("team")
                        }}>
                        {controlText("刷新")}
                      </Button>
                    </div>
                    <div class="flex flex-col gap-2">
                      <For each={state.teamMessages}>
                        {(message) => (
                          <article class="rounded-md border border-border-weak-base p-3">
                            <div class="text-11-regular text-text-weak">
                              #{message.sequence} · {message.sender} · {message.kind}
                            </div>
                            <div class="text-12-medium text-text-strong">{message.summary}</div>
                            <p class="whitespace-pre-wrap break-words text-12-regular text-text-weak">
                              {message.message}
                            </p>
                          </article>
                        )}
                      </For>
                      <Show when={state.teamMessages.length === 0}>
                        <p class="text-12-regular text-text-weak">
                          {ui(
                            "No messages addressed to the main agent.",
                            "当前没有发给主代理的消息。",
                            "目前沒有傳給主代理的訊息。",
                          )}
                        </p>
                      </Show>
                    </div>
                    <div>
                      <Button
                        size="small"
                        variant="ghost"
                        disabled={
                          state.saving ||
                          team().members.some((member) => member.name !== "lead" && member.status !== "stopped")
                        }
                        onClick={deleteTeam}
                      >
                        {ui("Delete team…", "删除团队…", "刪除團隊…")}
                      </Button>
                    </div>
                  </>
                )}
              </Show>
            </section>
          </Show>

          <Show when={props.value === "session-goal-task"}>
            <section
              id="operations-task-editor"
              class="flex flex-col gap-3 border-t border-border-weak-base pt-5"
              aria-labelledby="operations-task-title"
            >
              <div class="flex flex-wrap items-center justify-between gap-3">
                <h2 id="operations-task-title" class="text-14-medium text-text-strong">
                  {c().taskTitle}
                </h2>
                <Button
                  size="small"
                  variant="ghost"
                  disabled={
                    state.saving ||
                    !state.tasks.some((task) => task.status === "completed" || task.status === "cancelled")
                  }
                  onClick={clearTerminalTasks}
                >
                  {ui("Clear terminal Tasks…", "清理已结束任务…", "清理已結束任務…")}
                </Button>
              </div>
              <p class="text-12-regular text-text-weak">{c().taskDescription}</p>
              <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
                <TextField
                  label={ui("Task title", "任务标题", "任務標題")}
                  value={state.taskTitle}
                  onChange={(value) => setState("taskTitle", value)}
                  placeholder={ui("Implement authentication", "实现身份认证", "實作身分驗證")}
                  disabled={blocked("tasks")}
                />
                <TextField
                  label={ui("Claim owner", "领取者")}
                  value={state.taskOwner}
                  onChange={(value) => setState("taskOwner", value)}
                  placeholder="worker-1"
                  disabled={blocked("tasks")}
                />
              </div>
              <TextField
                label={ui("Description", "描述")}
                multiline
                value={state.taskDescription}
                onChange={(value) => setState("taskDescription", value)}
                placeholder={ui(
                  "Acceptance criteria and implementation notes.",
                  "验收标准与实现说明。",
                  "驗收標準與實作說明。",
                )}
                disabled={blocked("tasks")}
              />
              <Show when={state.tasks.some((task) => task.status !== "completed" && task.status !== "cancelled")}>
                <fieldset class="flex flex-col gap-2">
                  <legend class="mb-1 text-12-medium text-text-strong">
                    {ui("Blocked by existing Tasks (optional)", "前置任务（可选）", "前置任務（選填）")}
                  </legend>
                  <For each={state.tasks.filter((task) => task.status !== "completed" && task.status !== "cancelled")}>
                    {(task) => (
                      <Checkbox
                        checked={state.taskBlockers.includes(task.id)}
                        onChange={(checked) => toggleTaskBlocker(task.id, checked)}
                        disabled={blocked("tasks")}
                      >
                        {task.title}
                      </Checkbox>
                    )}
                  </For>
                </fieldset>
              </Show>
              <div class="flex flex-wrap gap-2">
                <Show
                  when={state.taskEditingID}
                  fallback={
                    <Button
                      type="button"
                      size="small"
                      variant="primary"
                      disabled={blocked("tasks") || !state.taskTitle.trim()}
                      onClick={createTask}
                    >
                      {ui("Create Task", "创建任务", "建立任務")}
                    </Button>
                  }
                >
                  <Button
                    type="button"
                    size="small"
                    variant="primary"
                    disabled={blocked("tasks") || !state.taskTitle.trim()}
                    onClick={updateTask}
                  >
                    {ui("Save Task", "保存任务", "儲存任務")}
                  </Button>
                  <Button type="button" size="small" variant="ghost" disabled={blocked("tasks")} onClick={cancelTaskEdit}>
                    {language.t("common.cancel")}
                  </Button>
                </Show>
              </div>
              <div class="flex flex-col gap-2">
                <For each={state.tasks}>
                  {(task) => (
                    <article class="flex flex-col gap-2 rounded-md border border-border-weak-base p-3">
                      <div class="flex flex-wrap items-start justify-between gap-3">
                        <div class="min-w-0">
                          <div class="text-13-medium text-text-strong">{task.title}</div>
                          <div class="text-11-regular text-text-weak">
                            {taskStatus(task.status)} · {ui("revision", "版本", "版本")} {task.revision}
                            <Show when={task.owner}>
                              {" "}
                              · {ui("owner", "领取者", "領取者")} {task.owner}
                            </Show>
                            <Show when={task.unresolvedBlockers > 0}>
                              {" "}
                              · {task.unresolvedBlockers}{" "}
                              {ui("unresolved blocker(s)", "个前置任务未完成", "個前置任務未完成")}
                            </Show>
                          </div>
                        </div>
                        <div class="flex flex-wrap gap-2">
                          <Button
                            type="button"
                            size="small"
                            variant="ghost"
                            disabled={blocked("tasks") || state.taskEditingID === task.id}
                            onClick={() => editTask(task)}
                          >
                            {language.t("common.edit")}
                          </Button>
                          <Show when={task.status === "pending"}>
                            <Button
                              size="small"
                              variant="secondary"
                              disabled={blocked("tasks") || task.unresolvedBlockers > 0 || !state.taskOwner.trim()}
                              onClick={() => claimTask(task)}
                            >
                              {ui("Claim", "领取")}
                            </Button>
                          </Show>
                          <Show when={task.status === "in_progress"}>
                            <Button
                              size="small"
                              variant="ghost"
                              disabled={blocked("tasks")}
                              onClick={() => releaseTask(task)}
                            >
                              {ui("Release", "释放")}
                            </Button>
                          </Show>
                          <Show when={task.status === "pending" || task.status === "in_progress"}>
                            <Button
                              size="small"
                              variant="secondary"
                              disabled={blocked("tasks")}
                              onClick={() => completeTask(task)}
                            >
                              {ui("Complete", "完成")}
                            </Button>
                            <Button
                              size="small"
                              variant="ghost"
                              disabled={blocked("tasks")}
                              onClick={() => cancelTask(task)}
                            >
                              {language.t("common.cancel")}…
                            </Button>
                          </Show>
                          <Button size="small" variant="ghost" disabled={blocked("tasks")} onClick={() => deleteTask(task)}>
                            {language.t("common.delete")}…
                          </Button>
                        </div>
                      </div>
                      <Show when={task.description}>
                        <p class="whitespace-pre-wrap break-words text-12-regular text-text-weak">{task.description}</p>
                      </Show>
                      <Show when={task.blockedBy.length > 0}>
                        <p class="text-11-regular text-text-weak">
                          {ui("Blocked by:", "阻塞项：", "阻塞項：")}{" "}
                          {task.blockedBy
                            .map((id) => state.tasks.find((candidate) => candidate.id === id)?.title ?? id)
                            .join(", ")}
                        </p>
                      </Show>
                    </article>
                  )}
                </For>
                <Show when={!state.loading && state.tasks.length === 0}>
                  <p class="text-12-regular text-text-weak">
                    {ui("No durable Tasks.", "当前没有持久任务。", "目前沒有持久任務。")}
                  </p>
                </Show>
              </div>
            </section>
          </Show>

          <Show when={props.value === "session-checkpoint"}>
            <section
              class="flex flex-col gap-3 border-t border-border-weak-base pt-5"
              aria-labelledby="operations-checkpoint-title"
            >
              <h2 id="operations-checkpoint-title" class="text-14-medium text-text-strong">
                {c().checkpointTitle}
              </h2>
              <p class="text-12-regular text-text-weak">{c().checkpointDescription}</p>
              <div class="flex items-end gap-2">
                <div class="min-w-0 flex-1">
                  <TextField
                    label={ui("Checkpoint label", "检查点标签", "檢查點標籤")}
                    value={state.checkpointLabel}
                    onChange={(value) => setState("checkpointLabel", value)}
                    placeholder={ui("Before experiment", "实验前", "實驗前")}
                    disabled={blocked("checkpoints") || state.active}
                  />
                </div>
                <Button
                  size="small"
                  variant="secondary"
                  disabled={blocked("checkpoints") || state.active || !state.checkpointLabel.trim()}
                  onClick={createCheckpoint}
                >
                  {ui("Create", "创建", "建立")}
                </Button>
              </div>
              <div class="flex flex-col gap-2">
                <For each={state.checkpoints}>
                  {(checkpoint) => (
                    <article class="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border-weak-base p-3">
                      <div>
                        <div class="text-13-medium text-text-strong">{checkpoint.label}</div>
                        <div class="text-11-regular text-text-weak">
                          {ui("Sequence", "序号", "序號")} {checkpoint.sequence} · {formatTime(checkpoint.time.created)}
                        </div>
                      </div>
                      <Button
                        size="small"
                        variant="ghost"
                        disabled={blocked("checkpoints") || state.active || !props.sync}
                        onClick={() => void previewRewind(checkpoint)}
                      >
                        {ui("Preview Rewind", "预览 Rewind", "預覽 Rewind")}
                      </Button>
                    </article>
                  )}
                </For>
              </div>
              <Show when={!state.loading && !state.error && state.checkpoints.length === 0}>
                <p role="status" class="arforge-management-empty">
                  {ui("No checkpoints yet. Create one before your next change.", "暂无检查点。可在下次变更前创建。", "暫無檢查點。可在下次變更前建立。")}
                </p>
              </Show>
              <Show when={!props.sync}>
                <p role="status" class="arforge-management-empty">
                  {ui("Open this page from the source Session to preview and apply a rewind.", "请从来源会话打开此页，以预览和应用回退。", "請從來源 Session 開啟此頁，以預覽和套用回退。")}
                </p>
              </Show>
              <Show when={state.preview}>
                {(preview) => (
                  <div
                    class="flex flex-col gap-3 rounded-md border border-border-warning p-3"
                    data-testid="rewind-preview"
                  >
                    <div class="text-13-medium text-text-strong">
                      {ui(
                        `${preview().affectedMessages} message(s) will leave the active conversation.`,
                        `${preview().affectedMessages} 条消息将离开当前对话。`,
                        `${preview().affectedMessages} 則訊息將離開目前對話。`,
                      )}
                    </div>
                    <p class="text-12-regular text-text-weak">
                      {ui(
                        `Files, commands, Git history, and external side effects remain unchanged. The preview is protected by sequence token ${preview().expectedLastSequence}.`,
                        `文件、命令效果、Git 历史和外部副作用保持不变。预览由序列令牌 ${preview().expectedLastSequence} 保护。`,
                        `檔案、命令效果、Git 歷史與外部副作用維持不變。預覽由序列權杖 ${preview().expectedLastSequence} 保護。`,
                      )}
                    </p>
                    <div class="flex flex-wrap gap-2">
                      <Button
                        size="small"
                        variant="primary"
                        disabled={blocked("checkpoints") || state.active || !props.sync}
                        onClick={applyRewind}
                      >
                        {ui("Confirm conversation Rewind…", "确认对话 Rewind…", "確認對話 Rewind…")}
                      </Button>
                      <Button
                        size="small"
                        variant="ghost"
                        disabled={blocked("checkpoints")}
                        onClick={() => setState("preview", undefined)}
                      >
                        {language.t("common.cancel")}
                      </Button>
                    </div>
                  </div>
                )}
              </Show>
            </section>
          </Show>
        </Show>
      </div>
    </TabsV2.Content>
  )
}

function publicError(error: unknown) {
  if (error instanceof Error) return error.message
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string")
    return error.message
  return "The operation failed. Refresh and try again."
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function triggerItemsFrom(value: unknown): TriggerItem[] {
  if (Array.isArray(value)) return value.filter(isRecord)
  if (isRecord(value) && Array.isArray(value.items)) return value.items.filter(isRecord)
  return isRecord(value) ? [value] : []
}

function resultItem(value: unknown): TriggerItem | undefined {
  return isRecord(value) ? value : undefined
}

function formatTime(value: string | number | Date) {
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString()
}

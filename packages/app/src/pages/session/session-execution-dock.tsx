import type { JSX } from "solid-js"
import { For, Index, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { Portal } from "solid-js/web"
import { Icon } from "@arforge-ai/ui/icon"
import { IconButtonV2 } from "@arforge-ai/ui/v2/icon-button-v2"
import { useLanguage } from "@/context/language"
import { useSync } from "@/context/sync"
import { useSessionLayout } from "@/pages/session/session-layout"
import {
  buildExecutionTrace,
  executionMascotForm,
  type ExecutionMascotForm,
  type ExecutionTraceKind,
  type ExecutionTraceStep,
} from "./execution-trace-model"
import {
  clampPetPosition,
  executionDragonState,
  nextPetFacing,
  nextPetIdleTask,
  parsePetFreeRoam,
  parsePetPosition,
  petDragonClip,
  pointerWakesPet,
  type PetIdleActivity,
} from "./execution-animation-model"
import { dragonRigAsset, type DragonRigPart } from "./execution-dragon-rig"
import "./session-execution-dock.css"
import "@/components/preview/workbench-review.css"
import { ExecutionStepDetail } from "./execution-step-detail"

type Copy = ReturnType<typeof copy>
const petPositionStorageKey = "arforge.execution-pet.position.v1"
const petFreeRoamStorageKey = "arforge.execution-pet.free-roam.v1"

function copy(locale: string) {
  const chinese = locale === "zh" || locale === "zht"
  return chinese
    ? {
        title: "可视化执行",
        expand: "展开可视化执行",
        collapse: "收起可视化执行",
        idle: "等待下一项任务",
        running: "正在实时执行",
        victory: "问题已解决",
        retry: "正在重试",
        complete: "本轮执行完成",
        empty: "开始执行后，这里会实时展示推理摘要、工具调用和文件变更。",
        detail: "查看详情",
        hideDetail: "收起详情",
        resizeTimeline: "拖动以调节上下区域高度；方向键可微调",
        completed: "已完成",
        failed: "失败",
        current: "进行中",
        pending: "等待中",
        forms: ["Default", "High", "Max"] as const,
        formLabel: "当前形态",
        subagents: "真实子 Agent",
        active: "活跃",
        used: "本轮",
        dragPet: "拖动小金龙，方向键可微调位置",
        freeRoam: "小金龙自由活动",
        enableFreeRoam: "开启小金龙自由活动",
        disableFreeRoam: "关闭小金龙自由活动",
        petActivities: {
          roam: "小金龙正在寻找新地方",
          observe: "小金龙正在观察四周",
          pose: "小金龙正在摆姿势",
          play: "小金龙正在自己玩耍",
          nap: "小金龙正在打盹",
          sleep: "小金龙已经睡着了",
          wake: "小金龙被鼠标唤醒了",
        } satisfies Record<PetIdleActivity, string>,
        problem: "待解决问题",
        solved: "已攻克",
        kinds: {
          reasoning: "分析任务",
          context: "检索上下文",
          command: "执行命令",
          edit: "修改文件",
          agent: "调度子 Agent",
          verify: "验证结果",
          tool: "调用工具",
          answer: "生成答复",
          retry: "重试请求",
        } satisfies Record<ExecutionTraceKind, string>,
      }
    : {
        title: "Visual execution",
        expand: "Expand visual execution",
        collapse: "Collapse visual execution",
        idle: "Waiting for the next task",
        running: "Executing live",
        victory: "Problem solved",
        retry: "Retrying",
        complete: "Execution complete",
        empty: "Reasoning summaries, tool calls, and file changes will appear here as the task runs.",
        detail: "Show details",
        hideDetail: "Hide details",
        resizeTimeline: "Drag to resize the upper area; use arrow keys for fine adjustments",
        completed: "Completed",
        failed: "Failed",
        current: "In progress",
        pending: "Pending",
        forms: ["Default", "High", "Max"] as const,
        formLabel: "Current form",
        subagents: "Live Subagents",
        active: "active",
        used: "this turn",
        dragPet: "Drag the golden dragon; use arrow keys to adjust its position",
        freeRoam: "Golden dragon free roaming",
        enableFreeRoam: "Enable free roaming for the golden dragon",
        disableFreeRoam: "Disable free roaming for the golden dragon",
        petActivities: {
          roam: "The golden dragon is finding a new spot",
          observe: "The golden dragon is looking around",
          pose: "The golden dragon is striking a pose",
          play: "The golden dragon is playing",
          nap: "The golden dragon is taking a nap",
          sleep: "The golden dragon is asleep",
          wake: "The pointer woke the golden dragon",
        } satisfies Record<PetIdleActivity, string>,
        problem: "Problem",
        solved: "Solved",
        kinds: {
          reasoning: "Analyze task",
          context: "Inspect context",
          command: "Run commands",
          edit: "Modify files",
          agent: "Coordinate agents",
          verify: "Verify result",
          tool: "Use tool",
          answer: "Deliver answer",
          retry: "Retry request",
        } satisfies Record<ExecutionTraceKind, string>,
      }
}

function stepIcon(kind: ExecutionTraceKind): JSX.Element {
  const name = {
    reasoning: "brain",
    context: "magnifying-glass",
    command: "console",
    edit: "pencil-line",
    agent: "subagent",
    verify: "checklist",
    tool: "status",
    answer: "prompt",
    retry: "warning",
  } as const
  return <Icon name={name[kind]} size="small" />
}

function statusLabel(step: ExecutionTraceStep, words: Copy) {
  if (step.status === "completed") return words.completed
  if (step.status === "error") return words.failed
  if (step.status === "running") return words.current
  return words.pending
}

function elapsed(step: ExecutionTraceStep) {
  if (step.startedAt === undefined || step.endedAt === undefined || step.endedAt < step.startedAt) return undefined
  const duration = step.endedAt - step.startedAt
  if (duration < 1_000) return `${Math.round(duration)} ms`
  if (duration < 60_000) return `${(duration / 1_000).toFixed(duration < 10_000 ? 1 : 0)} s`
  return `${Math.floor(duration / 60_000)}m ${Math.round((duration % 60_000) / 1_000)}s`
}

function DragonPuppet(props: { form: ExecutionMascotForm; class?: string }) {
  const partStyle = (part: DragonRigPart) => ({
    "background-image": `url("${dragonRigAsset(props.form, part)}")`,
  })
  return (
    <div class={`execution-dragon-puppet ${props.class ?? ""}`} data-form={props.form} aria-hidden="true">
      <div class="execution-dragon-rig" data-rig-version="1">
        <i
          class="execution-dragon-rig__part execution-dragon-rig__tail execution-dragon-puppet__tail"
          style={partStyle("tail")}
        />
        <i
          class="execution-dragon-rig__part execution-dragon-rig__mane execution-dragon-puppet__core"
          style={partStyle("mane")}
        />
        <i
          class="execution-dragon-rig__part execution-dragon-rig__torso execution-dragon-puppet__core"
          style={partStyle("torso")}
        />
        <i
          class="execution-dragon-rig__part execution-dragon-rig__hind-left execution-dragon-puppet__feet"
          style={partStyle("hind-left")}
        />
        <i
          class="execution-dragon-rig__part execution-dragon-rig__hind-right execution-dragon-puppet__feet"
          style={partStyle("hind-right")}
        />
        <i
          class="execution-dragon-rig__part execution-dragon-rig__arm-left execution-dragon-puppet__arm"
          style={partStyle("arm-left")}
        />
        <i
          class="execution-dragon-rig__part execution-dragon-rig__arm-right execution-dragon-puppet__arm"
          style={partStyle("arm-right")}
        />
        <div class="execution-dragon-rig__head execution-dragon-puppet__head">
          <i class="execution-dragon-rig__part execution-dragon-rig__head-art" style={partStyle("head")} />
          <i
            class="execution-dragon-rig__part execution-dragon-rig__eye execution-dragon-rig__eye-left"
            style={partStyle("eye-left")}
          />
          <i
            class="execution-dragon-rig__part execution-dragon-rig__eye execution-dragon-rig__eye-right"
            style={partStyle("eye-right")}
          />
          <i class="execution-dragon-rig__part execution-dragon-rig__eyelids" style={partStyle("eyelids")} />
          <i class="execution-dragon-rig__part execution-dragon-rig__mouth" style={partStyle("mouth")} />
        </div>
      </div>
    </div>
  )
}

export function SessionExecutionDock(props: { opened: boolean; onOpenChange: (opened: boolean) => void }) {
  const language = useLanguage()
  const sync = useSync()
  const { params, sessionKey } = useSessionLayout()
  const words = createMemo(() => copy(language.locale()))
  const [mascotHeight, setMascotHeight] = createSignal<number>()
  const [dividerResizing, setDividerResizing] = createSignal(false)
  const [state, setState] = createStore({
    expanded: {} as Record<string, boolean>,
    selectedStep: undefined as string | null | undefined,
    selectionScope: "",
    turn: undefined as string | undefined,
    runningTurn: undefined as string | undefined,
    celebratedTurn: undefined as string | undefined,
    celebrating: false,
    reducedMotion: false,
    petFreeRoam: true,
    petX: 20,
    petY: 76,
    petFacing: 1 as -1 | 1,
    petActivity: "observe" as PetIdleActivity,
    petPose: 0 as 0 | 1 | 2,
    petMoveDuration: 3_800,
    petDragging: false,
    petDragPointer: undefined as number | undefined,
    petDragOffsetX: 0,
    petDragOffsetY: 0,
  })
  let dockElement: HTMLElement | undefined
  let mascotElement: HTMLElement | undefined
  let dividerPointer: number | undefined
  let dividerStartY = 0
  let dividerStartHeight = 0
  let dividerMaxHeight = 350
  let petElement: HTMLElement | undefined
  let celebrationTimer = 0

  const messages = createMemo(() => {
    const sessionID = params.id
    return sessionID ? (sync().data.message[sessionID] ?? []) : []
  })
  const trace = createMemo(() => {
    const sessionID = params.id
    return buildExecutionTrace({
      messages: messages(),
      parts: (messageID) => sync().data.part[messageID] ?? [],
      status: sessionID ? (sync().data.session_status[sessionID] ?? { type: "idle" }) : { type: "idle" },
    })
  })
  const running = createMemo(() => trace().status !== "idle")
  const activeStep = createMemo(() =>
    trace().steps.findLast((step) => step.status === "running" || step.status === "pending"),
  )
  const currentStep = createMemo(() => activeStep() ?? trace().steps.at(-1))
  const selectedStep = createMemo(() => state.selectedStep === null ? undefined :
    trace().steps.find((step) => step.id === state.selectedStep || step.sections?.some((section) => section.source === state.selectedStep)) ?? currentStep())
  createEffect(() => {
    const scope = sessionKey() + "\u0000" + (trace().userMessageID ?? "")
    if (state.selectionScope === scope) return
    setState({ selectionScope: scope, selectedStep: undefined })
  })
  const currentVariant = createMemo(() => {
    const user = messages().findLast((message) => message.role === "user")
    return user?.role === "user" ? user.model.variant : undefined
  })
  const mascotForm = createMemo<ExecutionMascotForm>(() => executionMascotForm(currentVariant()))
  const turnStartedAt = createMemo(() => messages().findLast((message) => message.role === "user")?.time.created ?? 0)
  const turnChildren = createMemo(() => {
    const sessionID = params.id
    if (!sessionID) return []
    const linked = new Set(trace().steps.flatMap((step) => (step.agentSessionID ? [step.agentSessionID] : [])))
    return sync().data.session.filter((session) => {
      if (session.parentID !== sessionID) return false
      if (linked.has(session.id)) return true
      return (session.time?.created ?? 0) >= turnStartedAt()
    })
  })
  const activeSubagents = createMemo(() =>
    turnChildren().filter((session) => (sync().data.session_status[session.id] ?? { type: "idle" }).type !== "idle"),
  )
  const usedSubagents = createMemo(() => turnChildren().length)
  const dragonState = createMemo(() =>
    executionDragonState({
      running: running(),
      celebrating: state.celebrating,
      kind: currentStep()?.kind,
    }),
  )
  const visualMode = createMemo(() => dragonState().mode)
  const headline = createMemo(() => {
    if (trace().status === "retry") return words().retry
    if (visualMode() === "victory") return words().victory
    if (running()) return words().running
    return words().idle
  })
  const actionLabel = createMemo(() => {
    if (visualMode() === "idle") return headline()
    const step = currentStep()
    if (!step) return headline()
    return `${words().kinds[step.kind]}${step.count > 1 ? ` × ${step.count}` : ""}`
  })

  const mascotHeightValue = () => mascotHeight() ?? mascotElement?.getBoundingClientRect().height ?? 300
  const maxMascotHeight = () => Math.max(180, (dockElement?.getBoundingClientRect().height ?? 534) - 64 - 140)
  const setBoundedMascotHeight = (height: number, max = maxMascotHeight()) => {
    setMascotHeight(Math.round(Math.min(Math.max(height, 180), max)))
  }

  const beginDividerResize = (event: PointerEvent & { currentTarget: HTMLDivElement }) => {
    if (event.button !== 0) return
    event.preventDefault()
    dividerPointer = event.pointerId
    dividerStartY = event.clientY
    dividerStartHeight = mascotHeightValue()
    dividerMaxHeight = maxMascotHeight()
    event.currentTarget.setPointerCapture(event.pointerId)
    setDividerResizing(true)
  }

  const moveDividerResize = (event: PointerEvent) => {
    if (event.pointerId !== dividerPointer) return
    setBoundedMascotHeight(dividerStartHeight + event.clientY - dividerStartY, dividerMaxHeight)
  }

  const finishDividerResize = (event: PointerEvent & { currentTarget: HTMLDivElement }) => {
    if (event.pointerId !== dividerPointer) return
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
    dividerPointer = undefined
    setDividerResizing(false)
  }

  const resizeMascotWithKeyboard = (event: KeyboardEvent) => {
    const step = event.shiftKey ? 32 : 16
    const delta = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : undefined
    if (delta === undefined) return
    event.preventDefault()
    setBoundedMascotHeight(mascotHeightValue() + delta)
  }

  const beginPetDrag = (event: PointerEvent & { currentTarget: HTMLDivElement }) => {
    if (!state.petFreeRoam || event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    setState({
      petDragging: true,
      petActivity: "observe",
      petDragPointer: event.pointerId,
      petDragOffsetX: event.clientX - state.petX,
      petDragOffsetY: event.clientY - state.petY,
    })
  }

  const persistPetPosition = (x = state.petX, y = state.petY, facing = state.petFacing) => {
    try {
      localStorage.setItem(petPositionStorageKey, JSON.stringify({ x, y, facing }))
    } catch {}
  }

  const movePetWithKeyboard = (event: KeyboardEvent) => {
    if (!state.petFreeRoam) return
    const offset = {
      ArrowLeft: [-16, 0],
      ArrowRight: [16, 0],
      ArrowUp: [0, -16],
      ArrowDown: [0, 16],
    }[event.key]
    if (!offset) return
    event.preventDefault()
    const point = clampPetPosition({
      x: state.petX + offset[0],
      y: state.petY + offset[1],
      width: window.innerWidth,
      height: window.innerHeight,
    })
    setState({
      petX: point.x,
      petY: point.y,
      petFacing: offset[0] === 0 ? state.petFacing : nextPetFacing(state.petX, point.x),
    })
    persistPetPosition(point.x, point.y, offset[0] === 0 ? state.petFacing : nextPetFacing(state.petX, point.x))
  }

  const togglePetFreeRoam = () => {
    const enabled = !state.petFreeRoam
    const pointer = state.petDragPointer
    if (!enabled && pointer !== undefined && petElement?.hasPointerCapture(pointer)) {
      petElement.releasePointerCapture(pointer)
    }
    setState({
      petFreeRoam: enabled,
      petActivity: "observe",
      petMoveDuration: 0,
      petDragging: false,
      petDragPointer: undefined,
    })
    try {
      localStorage.setItem(petFreeRoamStorageKey, String(enabled))
    } catch {}
  }

  createEffect(() => {
    const turn = trace().userMessageID
    if (turn === state.turn) return
    setState({ expanded: {}, turn })
  })

  createEffect(() => {
    const turn = trace().userMessageID
    if (running()) {
      if (celebrationTimer) window.clearTimeout(celebrationTimer)
      setState({ runningTurn: turn, celebrating: false })
      return
    }
    if (!turn || state.runningTurn !== turn || state.celebratedTurn === turn) return
    setState({ celebratedTurn: turn, celebrating: trace().failed === 0 })
    if (trace().failed > 0) return
    celebrationTimer = window.setTimeout(() => setState("celebrating", false), 2_600)
  })

  createEffect(() => {
    if (visualMode() === "idle" || !state.petDragging) return
    const pointer = state.petDragPointer
    if (pointer !== undefined && petElement?.hasPointerCapture(pointer)) petElement.releasePointerCapture(pointer)
    setState({ petDragging: false, petDragPointer: undefined })
  })

  onCleanup(() => {
    if (celebrationTimer) window.clearTimeout(celebrationTimer)
  })

  onMount(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)")
    let frame = 0
    let resizeFrame = 0
    let idleTimer = 0
    let pendingPointer: PointerEvent | undefined

    try {
      setState("petFreeRoam", parsePetFreeRoam(localStorage.getItem(petFreeRoamStorageKey)))
      const restored = parsePetPosition(localStorage.getItem(petPositionStorageKey), {
        width: window.innerWidth,
        height: window.innerHeight,
      })
      if (restored) setState({ petX: restored.x, petY: restored.y, petFacing: restored.facing })
    } catch {}

    function scheduleIdleTask(delay: number) {
      if (idleTimer) window.clearTimeout(idleTimer)
      idleTimer = window.setTimeout(runIdleTask, delay)
    }

    function runIdleTask() {
      if (!props.opened || visualMode() !== "idle" || !state.petFreeRoam || state.petDragging) {
        if (!state.petFreeRoam) setState({ petActivity: "observe", petMoveDuration: 0 })
        scheduleIdleTask(900)
        return
      }
      if (reduced.matches) {
        setState({ petActivity: "observe", petMoveDuration: 0 })
        scheduleIdleTask(4_000)
        return
      }
      const task = nextPetIdleTask({ width: window.innerWidth, height: window.innerHeight })
      const destination = task.destination
      setState({
        petActivity: task.activity,
        petPose: task.pose,
        petMoveDuration: task.durationMs,
        petFacing: destination ? nextPetFacing(state.petX, destination.x) : state.petFacing,
        petX: destination?.x ?? state.petX,
        petY: destination?.y ?? state.petY,
      })
      scheduleIdleTask(task.durationMs + (task.activity === "roam" ? 450 : 0))
    }

    const updateReducedMotion = () => {
      setState("reducedMotion", reduced.matches)
      if (reduced.matches) setState({ petActivity: "observe", petMoveDuration: 0 })
      scheduleIdleTask(600)
    }
    const move = (event: PointerEvent) => {
      pendingPointer = event
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        const pointer = pendingPointer
        pendingPointer = undefined
        if (!pointer) return
        const element = petElement
        if (!state.petFreeRoam || !element || visualMode() !== "idle" || !props.opened) return
        if (state.petDragging && state.petDragPointer === pointer.pointerId) {
          const point = clampPetPosition({
            x: pointer.clientX - state.petDragOffsetX,
            y: pointer.clientY - state.petDragOffsetY,
            width: window.innerWidth,
            height: window.innerHeight,
          })
          setState({
            petFacing: point.x === state.petX ? state.petFacing : nextPetFacing(state.petX, point.x),
            petX: point.x,
            petY: point.y,
          })
          return
        }
        const rect = element.getBoundingClientRect()
        if (state.petActivity === "nap" || state.petActivity === "sleep") {
          if (
            !pointerWakesPet({
              pointerX: pointer.clientX,
              pointerY: pointer.clientY,
              left: rect.left,
              top: rect.top,
              right: rect.right,
              bottom: rect.bottom,
            })
          )
            return
          setState({ petActivity: "wake", petMoveDuration: 0 })
          scheduleIdleTask(1_050)
          return
        }
        if (reduced.matches || state.petActivity === "wake") return
        const x = Math.max(
          -1,
          Math.min(1, (pointer.clientX - (rect.left + rect.width / 2)) / Math.max(rect.width / 2, 1)),
        )
        const y = Math.max(
          -1,
          Math.min(1, (pointer.clientY - (rect.top + rect.height / 2)) / Math.max(rect.height / 2, 1)),
        )
        element.style.setProperty("--pet-head-look-x", `${(x * 2.8 * state.petFacing).toFixed(2)}px`)
        element.style.setProperty("--pet-head-look-y", `${(y * 1.8).toFixed(2)}px`)
        element.style.setProperty("--pet-head-look-tilt", `${(x * 1.2 * state.petFacing).toFixed(2)}deg`)
      })
    }
    const finishDrag = (event: PointerEvent) => {
      if (!state.petDragging || state.petDragPointer !== event.pointerId) return
      if (petElement?.hasPointerCapture(event.pointerId)) petElement.releasePointerCapture(event.pointerId)
      setState({ petDragging: false, petDragPointer: undefined, petActivity: "observe" })
      persistPetPosition()
      scheduleIdleTask(900)
    }
    const resize = () => {
      if (resizeFrame) return
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = 0
        const point = clampPetPosition({
          x: state.petX,
          y: state.petY,
          width: window.innerWidth,
          height: window.innerHeight,
        })
        setState({ petX: point.x, petY: point.y })
      })
    }
    updateReducedMotion()
    window.addEventListener("pointermove", move, { passive: true })
    window.addEventListener("pointerup", finishDrag)
    window.addEventListener("pointercancel", finishDrag)
    window.addEventListener("resize", resize, { passive: true })
    reduced.addEventListener("change", updateReducedMotion)
    onCleanup(() => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", finishDrag)
      window.removeEventListener("pointercancel", finishDrag)
      window.removeEventListener("resize", resize)
      reduced.removeEventListener("change", updateReducedMotion)
      if (idleTimer) window.clearTimeout(idleTimer)
      if (frame) cancelAnimationFrame(frame)
      if (resizeFrame) cancelAnimationFrame(resizeFrame)
    })
  })

  createEffect(() => {
    if (!props.opened) return
    const id = activeStep()?.id
    if (!id) return
    queueMicrotask(() => {
      const escaped = typeof CSS === "undefined" ? id : CSS.escape(id)
      document.querySelector(`[data-execution-step="${escaped}"]`)?.scrollIntoView({ block: "nearest" })
    })
  })

  return (
    <aside
      id="execution-trace-panel"
      ref={(element) => (dockElement = element)}
      class="arforge-review-workbench execution-dock shrink-0 min-h-0 h-full rounded-l-[16px] rounded-r-none border border-r-0 border-v2-border-border-muted bg-v2-background-bg-base overflow-hidden"
      classList={{ "execution-dock--open": props.opened, "execution-dock--running": running() }}
      aria-label={words().title}
    >
      <Show when={props.opened && visualMode() === "idle" && state.petFreeRoam}>
        <Portal>
          <div class="execution-pet-layer">
            <div
              class="execution-pet-layer__roam"
              classList={{ "is-dragging": state.petDragging }}
              data-activity={state.petActivity}
              data-clip={petDragonClip(state.petActivity, state.petDragging)}
              data-pose={state.petPose}
              style={{
                transform: `translate3d(${state.petX}px, ${state.petY}px, 0)`,
                "--pet-travel-ms": `${state.petMoveDuration}ms`,
              }}
            >
              <div
                ref={(element) => (petElement = element)}
                class="execution-pet-layer__gaze"
                data-facing={state.petFacing}
                role="button"
                tabIndex={0}
                aria-label={`${words().dragPet}。${words().petActivities[state.petActivity]}`}
                onPointerDown={beginPetDrag}
                onKeyDown={movePetWithKeyboard}
              >
                <div class="execution-pet-layer__body">
                  <DragonPuppet form={mascotForm()} />
                  <span class="execution-pet-layer__shadow" />
                </div>
                <div class="execution-pet-layer__thought">
                  <i />
                  <i />
                  <i />
                </div>
                <div class="execution-pet-layer__sleep" aria-hidden="true">
                  <i>Z</i>
                  <i>z</i>
                </div>
              </div>
            </div>
          </div>
        </Portal>
      </Show>
      <Show
        when={props.opened}
        fallback={
          <button
            type="button"
            class="execution-dock__rail"
            onClick={() => props.onOpenChange(true)}
            aria-label={words().expand}
            aria-expanded="false"
            aria-controls="execution-trace-content"
          >
            <span class="execution-dock__rail-indicator" data-status={running() ? "running" : "idle"}>
              <img src={`/assets/mascot/arforge-form-${mascotForm()}.webp`} alt="" />
            </span>
            <span class="execution-dock__rail-label">{words().title}</span>
            <Show when={trace().steps.length > 0}>
              <span class="execution-dock__rail-count">{trace().steps.length}</span>
            </Show>
          </button>
        }
      >
        <div id="execution-trace-content" class="execution-dock__content">
          <header class="execution-dock__header">
            <div class="min-w-0">
              <div class="flex items-center gap-2">
                <span class="execution-dock__brand-mark" aria-hidden="true">
                  <img src="/assets/mascot/arforge-mascot-mark.webp" alt="" />
                </span>
                <h2 class="truncate text-[14px] font-[600] leading-5 text-v2-text-text-base">{words().title}</h2>
              </div>
              <p class="mt-0.5 truncate text-[12px] leading-4 text-v2-text-text-muted" aria-live="polite">
                {headline()}
              </p>
            </div>
            <div class="execution-dock__header-actions">
              <IconButtonV2
                type="button"
                class="execution-dock__pet-toggle"
                classList={{ "execution-dock__pet-toggle--active": state.petFreeRoam }}
                variant="ghost-muted"
                size="normal"
                aria-label={words().freeRoam}
                aria-pressed={state.petFreeRoam}
                title={state.petFreeRoam ? words().disableFreeRoam : words().enableFreeRoam}
                onClick={togglePetFreeRoam}
                icon={<Icon name={state.petFreeRoam ? "window-cursor" : "circle-ban-sign"} size="small" />}
              />
              <IconButtonV2
                type="button"
                variant="ghost-muted"
                size="normal"
                aria-label={words().collapse}
                aria-expanded="true"
                aria-controls="execution-trace-content"
                onClick={() => props.onOpenChange(false)}
                icon={<Icon name="chevron-double-right" size="small" />}
              />
            </div>
          </header>

          <section
            ref={(element) => (mascotElement = element)}
            class="execution-mascot"
            classList={{
              "execution-mascot--running": visualMode() === "battle",
              "execution-mascot--victory": visualMode() === "victory",
              "execution-mascot--pet-fixed": visualMode() === "idle" && !state.petFreeRoam,
            }}
            data-form={mascotForm()}
            data-action={currentStep()?.kind ?? "idle"}
            data-clip={dragonState().clip}
            data-state={visualMode()}
            aria-label={`${words().formLabel} ${mascotForm()}: ${actionLabel()}`}
            style={{ height: mascotHeight() ? `${mascotHeight()}px` : undefined }}
          >
            <div class="execution-mascot__halo" aria-hidden="true" />
            <div class="execution-mascot__particles" aria-hidden="true">
              <i />
              <i />
              <i />
              <i />
              <i />
            </div>
            <div class="execution-mascot__figures" aria-hidden="true">
              <Show when={visualMode() !== "idle" || !state.petFreeRoam}>
                <Show when={mascotForm()} keyed>
                  {(form) => (
                    <div class="execution-mascot__figure-frame">
                      <div class="execution-mascot__figure-position">
                        <DragonPuppet form={form} class="execution-mascot__figure" />
                      </div>
                    </div>
                  )}
                </Show>
              </Show>
            </div>
            <Show when={visualMode() === "idle" && state.petFreeRoam && !state.reducedMotion}>
              <div class="execution-mascot__patrol" aria-hidden="true">
                <img src="/assets/mascot/arforge-mascot-mark.webp" alt="" />
                <span>{words().petActivities[state.petActivity]}</span>
              </div>
            </Show>
            <Show when={visualMode() !== "idle" && currentStep()?.kind}>
              {(kind) => (
                <div class="execution-mascot__tool-prop" aria-hidden="true">
                  {stepIcon(kind())}
                </div>
              )}
            </Show>
            <Show when={visualMode() !== "idle"}>
              <div class="execution-mascot__enemy" data-state={visualMode()} aria-hidden="true">
                <div class="execution-mascot__enemy-core">
                  {visualMode() === "victory" ? (
                    <Icon name="checklist" size="small" />
                  ) : (
                    <Icon name="warning" size="small" />
                  )}
                </div>
                <div class="execution-mascot__enemy-cracks">
                  <i />
                  <i />
                  <i />
                </div>
                <span>{visualMode() === "victory" ? words().solved : words().problem}</span>
              </div>
              <div class="execution-mascot__impact" aria-hidden="true">
                <i />
                <i />
                <i />
                <i />
              </div>
            </Show>
            <div class="execution-mascot__gate" aria-hidden="true">
              <i />
              <i />
              <i />
            </div>
            <Show when={activeSubagents().length > 0}>
              <div class="execution-mascot__agents" aria-hidden="true">
                <For each={activeSubagents()}>
                  {(_, index) => (
                    <img
                      src={`/assets/mascot/arforge-form-${mascotForm()}.webp`}
                      alt=""
                      style={{ "--agent-index": index() }}
                    />
                  )}
                </For>
              </div>
            </Show>
            <div class="execution-mascot__action" aria-live="polite">
              <span class="execution-mascot__action-dot" data-status={running() ? "running" : "idle"} />
              <span>{actionLabel()}</span>
              <span class="execution-mascot__agent-count">
                {words().subagents} · {words().active} {activeSubagents().length} · {words().used} {usedSubagents()}
              </span>
            </div>
            <div class="execution-mascot__forms" aria-hidden="true">
              <For each={words().forms}>
                {(label, index) => (
                  <div classList={{ "is-active": mascotForm() === index() + 1 }}>
                    <span>{index() + 1}</span>
                    <small>{label}</small>
                  </div>
                )}
              </For>
            </div>
          </section>

          <div
            class="execution-dock__splitter"
            data-resizing={dividerResizing()}
            role="separator"
            aria-orientation="horizontal"
            aria-label={words().resizeTimeline}
            aria-valuemin={180}
            aria-valuemax={Math.round(maxMascotHeight())}
            aria-valuenow={Math.round(mascotHeightValue())}
            tabIndex={0}
            onPointerDown={beginDividerResize}
            onPointerMove={moveDividerResize}
            onPointerUp={finishDividerResize}
            onPointerCancel={finishDividerResize}
            onKeyDown={resizeMascotWithKeyboard}
          >
            <span aria-hidden="true" />
          </div>

          <Show when={trace().steps.length > 0} fallback={<div class="execution-dock__empty">{words().empty}</div>}>
            <div class="execution-dock__summary">
              <span>
                {words().completed} {trace().completed}/{trace().steps.length}
              </span>
              <Show when={trace().failed > 0}>
                <span class="execution-dock__failed">
                  {words().failed} {trace().failed}
                </span>
              </Show>
            </div>
            <div class="execution-workbench">
            <ol class="execution-dock__steps" aria-label={words().title}>
              {/* Trace objects are rebuilt for every streaming packet. Preserve each existing DOM slot so its
                  entrance animation runs once instead of replaying across the whole list. */}
              <Index each={trace().steps}>
                {(step, index) => {
                  const expandable = () => !!step().detail
                  const expanded = () => selectedStep()?.id === step().id
                  const label = () => `${words().kinds[step().kind]}${step().count > 1 ? ` × ${step().count}` : ""}`
                  return (
                    <li
                      class="execution-step"
                      classList={{
                        "execution-step--active": step().status === "running" || step().status === "pending",
                      }}
                      data-status={step().status}
                      data-execution-step={step().id}
                      style={{ "--execution-index": Math.min(index, 8) }}
                    >
                      <span class="execution-step__marker" aria-hidden="true">
                        {stepIcon(step().kind)}
                      </span>
                      <button
                        type="button"
                        class="execution-step__button"
                        disabled={!expandable()}
                        aria-expanded={expandable() ? expanded() : undefined}
                        aria-label={
                          expandable() ? `${expanded() ? words().hideDetail : words().detail}: ${label()}` : label()
                        }
                        onClick={() => expandable() && setState("selectedStep", expanded() ? null : step().sections?.[0]?.source ?? step().id)}
                      >
                        <span class="execution-step__topline">
                          <span class="execution-step__title">{label()}</span>
                          <span class="execution-step__status" data-status={step().status}>
                            {statusLabel(step(), words())}
                          </span>
                        </span>
                        <Show when={step().preview}>
                          <span class="execution-step__preview">{step().preview}</span>
                        </Show>
                        <span class="execution-step__meta">
                          <Show when={step().title}>
                            <span>{step().title}</span>
                          </Show>
                          <Show when={elapsed(step())}>{(duration) => <span>{duration()}</span>}</Show>
                          <Show when={expandable()}>
                            <Icon name={expanded() ? "chevron-down" : "chevron-right"} size="small" />
                          </Show>
                        </span>
                      </button>
                    </li>
                  )
                }}
              </Index>
            </ol>
            <Show when={selectedStep()}>{(step) => <ExecutionStepDetail step={step()} chinese={language.locale().startsWith("zh")} />}</Show>
            </div>
          </Show>
        </div>
      </Show>
    </aside>
  )
}

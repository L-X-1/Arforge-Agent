import type { Session } from "@arforge-ai/sdk/v2/client"
import { Avatar } from "@arforge-ai/ui/avatar"
import { Icon as IconV2 } from "@arforge-ai/ui/v2/icon"
import { IconButton } from "@arforge-ai/ui/icon-button"
import { Spinner } from "@arforge-ai/ui/spinner"
import { Tooltip } from "@arforge-ai/ui/tooltip"
import { TooltipV2 } from "@arforge-ai/ui/v2/tooltip-v2"
import { getFilename } from "@arforge-ai/core/util/path"
import { A, useParams } from "@solidjs/router"
import {
  type Accessor,
  createEffect,
  createMemo,
  For,
  type JSX,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
} from "solid-js"
import { createStore } from "solid-js/store"
import { useServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { getAvatarColors, type LocalProject, useLayout } from "@/context/layout"
import { useNotification } from "@/context/notification"
import { usePermission } from "@/context/permission"
import { messageAgentColor } from "@/utils/agent"
import { sessionTitle } from "@/utils/session-title"
import { sessionPermissionRequest } from "../session/composer/session-request-tree"
import { childSessionOnPath, getProjectAvatarSource } from "./helpers"
import { clampSessionArchiveOffset, SESSION_ARCHIVE_REVEAL_PX, shouldRevealSessionArchive } from "./sidebar-swipe"
import { sidebarPrimaryActionLabelIsTruncated } from "./sidebar-primary-action-overflow"
import { resolveSessionStatus, type SessionStatus } from "./sidebar-status"
import "./sidebar-items.css"

export type ProjectStatus = "unread" | "permission" | "error"

export const ProjectIcon = (props: {
  project: LocalProject
  class?: string
  status?: ProjectStatus
  working?: boolean
}): JSX.Element => {
  const name = createMemo(() => props.project.name || getFilename(props.project.worktree))

  return (
    <div class={`relative size-8 shrink-0 rounded-[8px] ${props.class ?? ""}`}>
      <div class="size-full rounded-[8px] overflow-clip">
        <Avatar
          fallback={name()}
          src={getProjectAvatarSource(props.project.id, props.project.icon)}
          {...getAvatarColors(props.project.icon?.color)}
          class="size-full rounded-[8px]"
          classList={{ "badge-mask": !!props.status }}
        />
      </div>
      <div
        aria-hidden="true"
        class="pointer-events-none absolute inset-0 rounded-[8px]"
        style={{ "box-shadow": "inset 0 0.5px 0 var(--v2-alpha-light-14)" }}
      />
      <Show when={props.status}>{(status) => <span aria-hidden="true" data-project-status={status()} />}</Show>
      <Show when={props.working}>
        <div aria-hidden="true" data-project-working>
          <Spinner class="size-3" />
        </div>
      </Show>
    </div>
  )
}

export type SessionItemProps = {
  session: Session
  list: Session[]
  navList?: Accessor<Session[]>
  slug: string
  mobile?: boolean
  dense?: boolean
  showTooltip?: boolean
  tooltipOverflowOnly?: boolean
  showChild?: boolean
  level?: number
  baseIndent?: number
  sidebarExpanded: Accessor<boolean>
  clearHoverProjectSoon: () => void
  prefetchSession: (session: Session, priority?: "high" | "low") => void
  archiveSession: (session: Session) => Promise<void>
}

const SessionRow = (props: {
  session: Session
  slug: string
  mobile?: boolean
  dense?: boolean
  tint: Accessor<string | undefined>
  status: Accessor<SessionStatus | undefined>
  statusLabel: Accessor<string | undefined>
  clearHoverProjectSoon: () => void
  sidebarOpened: Accessor<boolean>
  warmPress: () => void
  warmFocus: () => void
  consumeSwipeClick: () => boolean
  titleRef?: (element: HTMLSpanElement) => void
}): JSX.Element => {
  const title = () => sessionTitle(props.session.title)

  return (
    <A
      href={`/${props.slug}/session/${props.session.id}`}
      data-sidebar-session-row
      data-dense={!!props.dense}
      class="flex items-center gap-2 min-w-0 w-full text-left focus:outline-none"
      onPointerDown={props.warmPress}
      onFocus={props.warmFocus}
      onClick={(event) => {
        if (props.consumeSwipeClick()) {
          event.preventDefault()
          event.stopPropagation()
          return
        }
        if (props.sidebarOpened()) return
        props.clearHoverProjectSoon()
      }}
    >
      <div
        aria-hidden="true"
        data-sidebar-session-status-lane
        data-status-replacement="immediate"
        data-state={props.status() ?? "idle"}
        style={{
          color:
            props.status() === "working" ? (props.tint() ?? "var(--sidebar-session-status-working-color)") : undefined,
        }}
      >
        <Switch>
          <Match when={props.status() === "working"}>
            <span data-sidebar-session-status="working">
              <Spinner class="size-3" />
            </span>
          </Match>
          <Match when={props.status() === "permission"}>
            <span data-sidebar-session-status="permission" />
          </Match>
          <Match when={props.status() === "error"}>
            <span data-sidebar-session-status="error" />
          </Match>
          <Match when={props.status() === "unread"}>
            <span data-sidebar-session-status="unread" />
          </Match>
        </Switch>
      </div>
      <span
        ref={(element) => props.titleRef?.(element)}
        data-sidebar-session-title
        class="text-14-regular min-w-0 flex-1 truncate"
      >
        {title()}
      </span>
      <Show when={props.statusLabel()}>{(label) => <span class="sr-only">, {label()}</span>}</Show>
    </A>
  )
}

export const SessionItem = (props: SessionItemProps): JSX.Element => {
  const params = useParams()
  const layout = useLayout()
  const language = useLanguage()
  const notification = useNotification()
  const permission = usePermission()
  const serverSync = useServerSync()
  const unseenCount = createMemo(() => notification.session.unseenCount(props.session.id))
  const hasError = createMemo(() => notification.session.unseenHasError(props.session.id))
  const [sessionStore] = serverSync().child(props.session.directory)
  const hasPermissions = createMemo(() => {
    return !!sessionPermissionRequest(
      sessionStore.session,
      serverSync().session.data.permission,
      props.session.id,
      (item) => {
        return !permission.autoResponds(item, props.session.directory)
      },
    )
  })
  const isWorking = createMemo(() => serverSync().session.data.session_working(props.session.id))
  const status = createMemo(() =>
    resolveSessionStatus({
      hasPermissions: hasPermissions(),
      hasError: hasError(),
      isWorking: isWorking(),
      unseenCount: unseenCount(),
    }),
  )
  const statusLabel = createMemo(() => {
    if (status() === "working") return language.t("common.loading")
    if (status() === "permission") return language.t("notification.permission.title")
    if (status() === "error") return language.t("notification.session.error.title")
    if (status() === "unread") {
      return language.t("sidebar.session.status.unread", { count: unseenCount() })
    }
  })

  const tint = createMemo(() =>
    messageAgentColor(serverSync().session.data.message[props.session.id], sessionStore.agent),
  )
  const tooltip = createMemo(() => props.showTooltip ?? (props.mobile || !props.sidebarExpanded()))
  const [swipe, setSwipe] = createStore({
    offset: 0,
    revealed: false,
    dragging: false,
    titleTruncated: false,
  })
  let titleLabel: HTMLSpanElement | undefined
  let titleObserver: ResizeObserver | undefined
  const measureTitleOverflow = () => {
    if (!props.tooltipOverflowOnly) return
    const next = sidebarPrimaryActionLabelIsTruncated(titleLabel)
    if (next === swipe.titleTruncated) return
    setSwipe("titleTruncated", next)
  }
  const setTitleLabel = (element: HTMLSpanElement) => {
    if (titleLabel) titleObserver?.unobserve(titleLabel)
    titleLabel = element
    if (!props.tooltipOverflowOnly) return
    titleObserver?.observe(element)
    queueMicrotask(measureTitleOverflow)
  }

  createEffect(() => {
    if (!props.tooltipOverflowOnly) return
    sessionTitle(props.session.title)
    queueMicrotask(measureTitleOverflow)
  })

  onMount(() => {
    if (!props.tooltipOverflowOnly) return
    measureTitleOverflow()
    window.addEventListener("resize", measureTitleOverflow)
    if (typeof ResizeObserver === "undefined") return
    titleObserver = new ResizeObserver(measureTitleOverflow)
    if (titleLabel) titleObserver.observe(titleLabel)
  })

  onCleanup(() => {
    titleObserver?.disconnect()
    window.removeEventListener("resize", measureTitleOverflow)
  })
  const currentChild = createMemo(() => {
    if (!props.showChild) return
    return childSessionOnPath(sessionStore.session, props.session.id, params.id)
  })
  // Solid assigns this variable through the compiled JSX ref directive.
  // oxlint-disable-next-line eslint/no-unassigned-vars
  let swipeRoot: HTMLDivElement | undefined
  let gesture:
    | {
        pointerId: number
        startX: number
        startY: number
        startOffset: number
        lastX: number
        lastTime: number
        velocity: number
        axis?: "horizontal" | "vertical"
      }
    | undefined
  let suppressSwipeClick = false
  let suppressTimer: number | undefined

  const settleSwipe = (revealed: boolean) => {
    setSwipe({
      revealed,
      dragging: false,
      offset: revealed ? -SESSION_ARCHIVE_REVEAL_PX : 0,
    })
  }

  const closeSwipe = () => settleSwipe(false)

  const deferSwipeClickReset = () => {
    if (suppressTimer !== undefined) window.clearTimeout(suppressTimer)
    suppressTimer = window.setTimeout(() => {
      suppressSwipeClick = false
      suppressTimer = undefined
    }, 0)
  }

  const finishSwipe = (event: PointerEvent, cancelled = false) => {
    if (!gesture || event.pointerId !== gesture.pointerId) return

    const horizontal = gesture.axis === "horizontal"
    const reveal = !cancelled && horizontal && shouldRevealSessionArchive(swipe.offset, gesture.velocity)
    gesture = undefined

    if (!horizontal) return
    settleSwipe(reveal)
    deferSwipeClickReset()
  }

  const onSwipePointerDown: JSX.EventHandlerUnion<HTMLDivElement, PointerEvent> = (event) => {
    if (props.level || event.pointerType !== "touch") return
    if ((event.target as HTMLElement).closest("[data-sidebar-session-archive-action]")) return

    if (suppressTimer !== undefined) {
      window.clearTimeout(suppressTimer)
      suppressTimer = undefined
    }

    gesture = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startOffset: swipe.revealed ? -SESSION_ARCHIVE_REVEAL_PX : 0,
      lastX: event.clientX,
      lastTime: event.timeStamp,
      velocity: 0,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const onSwipePointerMove: JSX.EventHandlerUnion<HTMLDivElement, PointerEvent> = (event) => {
    if (!gesture || event.pointerId !== gesture.pointerId) return

    const deltaX = event.clientX - gesture.startX
    const deltaY = event.clientY - gesture.startY

    if (!gesture.axis) {
      if (Math.max(Math.abs(deltaX), Math.abs(deltaY)) < 6) return
      gesture.axis = Math.abs(deltaX) > Math.abs(deltaY) ? "horizontal" : "vertical"
    }

    if (gesture.axis !== "horizontal") return

    const elapsed = Math.max(1, event.timeStamp - gesture.lastTime)
    gesture.velocity = (event.clientX - gesture.lastX) / elapsed
    gesture.lastX = event.clientX
    gesture.lastTime = event.timeStamp
    suppressSwipeClick = true
    setSwipe({
      dragging: true,
      offset: clampSessionArchiveOffset(gesture.startOffset, deltaX),
    })
    event.preventDefault()
  }

  createEffect(() => {
    if (!swipe.revealed) return

    const closeFromOutside = (event: PointerEvent) => {
      if (swipeRoot?.contains(event.target as Node)) return
      closeSwipe()
    }

    document.addEventListener("pointerdown", closeFromOutside)
    onCleanup(() => document.removeEventListener("pointerdown", closeFromOutside))
  })

  onCleanup(() => {
    if (suppressTimer !== undefined) window.clearTimeout(suppressTimer)
  })

  const warm = (span: number, priority: "high" | "low") => {
    const nav = props.navList?.()
    const list = nav?.some((item) => item.id === props.session.id && item.directory === props.session.directory)
      ? nav
      : props.list

    props.prefetchSession(props.session, priority)

    const idx = list.findIndex((item) => item.id === props.session.id && item.directory === props.session.directory)
    if (idx === -1) return

    for (let step = 1; step <= span; step++) {
      const next = list[idx + step]
      if (next) props.prefetchSession(next, step === 1 ? "high" : priority)

      const prev = list[idx - step]
      if (prev) props.prefetchSession(prev, step === 1 ? "high" : priority)
    }
  }

  const item = (
    <SessionRow
      session={props.session}
      slug={props.slug}
      mobile={props.mobile}
      dense={props.dense}
      tint={tint}
      status={status}
      statusLabel={statusLabel}
      clearHoverProjectSoon={props.clearHoverProjectSoon}
      sidebarOpened={layout.sidebar.opened}
      warmPress={() => warm(2, "high")}
      warmFocus={() => warm(2, "high")}
      titleRef={setTitleLabel}
      consumeSwipeClick={() => {
        if (suppressSwipeClick) {
          suppressSwipeClick = false
          return true
        }
        if (!swipe.revealed) return false
        closeSwipe()
        return true
      }}
    />
  )

  return (
    <>
      <div
        data-session-id={props.session.id}
        data-sidebar-session-item
        data-swipe-dragging={swipe.dragging}
        data-swipe-revealed={swipe.revealed}
        ref={swipeRoot}
        class="group/session relative w-full min-w-0 cursor-default pr-3"
        style={{
          "padding-left": `${(props.baseIndent ?? 8) + (props.level ?? 0) * 16}px`,
          "--session-swipe-offset": `${swipe.offset}px`,
          "--session-swipe-progress": String(Math.abs(swipe.offset) / SESSION_ARCHIVE_REVEAL_PX),
        }}
        onPointerDown={onSwipePointerDown}
        onPointerMove={onSwipePointerMove}
        onPointerUp={(event) => finishSwipe(event)}
        onPointerCancel={(event) => finishSwipe(event, true)}
        onKeyDown={(event) => {
          if (event.key !== "Escape" || !swipe.revealed) return
          event.preventDefault()
          closeSwipe()
        }}
      >
        <Show when={!props.level}>
          <div data-sidebar-session-archive-action>
            <Tooltip value={language.t("common.archive")} placement="top">
              <IconButton
                icon="archive"
                variant="ghost"
                class="rounded-md"
                aria-label={language.t("common.archive")}
                onClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  closeSwipe()
                  void props.archiveSession(props.session)
                }}
              />
            </Tooltip>
          </div>
        </Show>

        <div data-sidebar-session-surface class="flex min-w-0 items-center gap-1">
          <div class="min-w-0 flex-1">
            <Show
              when={!tooltip()}
              fallback={
                <TooltipV2
                  placement={props.mobile ? "bottom" : "right"}
                  value={sessionTitle(props.session.title)}
                  gutter={10}
                  inactive={props.tooltipOverflowOnly && !swipe.titleTruncated}
                  flip
                  slide
                  overflowPadding={8}
                  class="min-w-0 w-full"
                  contentStyle={{
                    "max-width": "min(288px, calc(100vw - 16px))",
                    "white-space": "normal",
                    "overflow-wrap": "anywhere",
                    "text-align": "start",
                  }}
                >
                  {item}
                </TooltipV2>
              }
            >
              {item}
            </Show>
          </div>
        </div>
      </div>
      <Show when={currentChild()} keyed>
        {(child) => (
          <div class="w-full">
            <SessionItem {...props} session={child} level={(props.level ?? 0) + 1} />
          </div>
        )}
      </Show>
    </>
  )
}

export const NewSessionItem = (props: {
  slug: string
  mobile?: boolean
  dense?: boolean
  baseIndent?: number
  leadingSize?: number
  sidebarExpanded: Accessor<boolean>
  clearHoverProjectSoon: () => void
}): JSX.Element => {
  const layout = useLayout()
  const language = useLanguage()
  const label = language.t("command.session.new")
  const tooltip = () => props.mobile || !props.sidebarExpanded()
  const item = (
    <A
      href={`/${props.slug}/session`}
      end
      data-sidebar-session-row
      data-dense={!!props.dense}
      class="flex items-center gap-2 min-w-0 w-full text-left focus:outline-none"
      onClick={() => {
        if (layout.sidebar.opened()) return
        props.clearHoverProjectSoon()
      }}
    >
      <div
        class="shrink-0 flex items-center justify-center"
        style={{
          width: `${props.leadingSize ?? 24}px`,
          height: `${props.leadingSize ?? 24}px`,
        }}
      >
        <IconV2 name="edit" size="small" class="text-icon-weak" />
      </div>
      <span data-sidebar-session-title class="text-14-regular min-w-0 flex-1 truncate">
        {label}
      </span>
    </A>
  )

  return (
    <div
      data-sidebar-session-item
      class="group/session relative w-full min-w-0 cursor-default pr-3"
      style={{ "padding-left": `${props.baseIndent ?? 8}px` }}
    >
      <div data-sidebar-session-surface>
        <Show
          when={!tooltip()}
          fallback={
            <Tooltip placement={props.mobile ? "bottom" : "right"} value={label} gutter={10} class="min-w-0 w-full">
              {item}
            </Tooltip>
          }
        >
          {item}
        </Show>
      </div>
    </div>
  )
}

export const SessionSkeleton = (props: { count?: number; baseIndent?: number }): JSX.Element => {
  const language = useLanguage()
  const items = Array.from({ length: props.count ?? 4 }, (_, index) => index)
  const titleWidths = [54, 42, 58, 46]

  return (
    <div data-sidebar-session-skeleton class="flex flex-col gap-1" role="status">
      <span class="sr-only">{language.t("common.loading")}</span>
      <For each={items}>
        {(index) => (
          <div
            data-sidebar-session-skeleton-row
            aria-hidden="true"
            class="flex items-center gap-2 min-w-0 w-full pr-3"
            style={{ "padding-left": `${props.baseIndent ?? 8}px` }}
          >
            <div data-sidebar-session-status-lane>
              <Show when={index === 0}>
                <span data-sidebar-session-skeleton-spinner>
                  <Spinner class="size-3" />
                </span>
              </Show>
            </div>
            <span
              data-sidebar-session-skeleton-title
              style={{ width: `${titleWidths[index % titleWidths.length]}%` }}
            />
          </div>
        )}
      </For>
    </div>
  )
}

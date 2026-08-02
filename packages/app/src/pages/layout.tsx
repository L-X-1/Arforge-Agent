import {
  createEffect,
  createMemo,
  createResource,
  For,
  on,
  onCleanup,
  onMount,
  ParentProps,
  Show,
  untrack,
  type Accessor,
} from "solid-js"
import { makeEventListener } from "@solid-primitives/event-listener"
import { useNavigate, useParams } from "@solidjs/router"
import { useLayout, LocalProject } from "@/context/layout"
import { useServerSync } from "@/context/server-sync"
import { Persist, persisted } from "@/utils/persist"
import { base64Encode } from "@arforge-ai/core/util/encode"
import { decode64 } from "@/utils/base64"
import { ResizeHandle } from "@arforge-ai/ui/resize-handle"
import { Button } from "@arforge-ai/ui/button"
import { Icon } from "@arforge-ai/ui/icon"
import { Spinner } from "@arforge-ai/ui/spinner"
import { Icon as IconV2 } from "@arforge-ai/ui/v2/icon"
import { IconButton } from "@arforge-ai/ui/icon-button"
import { Tooltip } from "@arforge-ai/ui/tooltip"
import { DropdownMenu } from "@arforge-ai/ui/dropdown-menu"
import { Dialog } from "@arforge-ai/ui/dialog"
import { getFilename } from "@arforge-ai/core/util/path"
import { Session } from "@arforge-ai/sdk/v2/client"
import { usePlatform } from "@/context/platform"
import { useSettings } from "@/context/settings"
import { createStore, produce, reconcile } from "solid-js/store"
import { DragDropProvider, DragDropSensors, DragOverlay, SortableProvider, closestCenter } from "@thisbeyond/solid-dnd"
import type { DragEvent } from "@thisbeyond/solid-dnd"
import { useProviders } from "@/hooks/use-providers"
import { toaster } from "@arforge-ai/ui/toast"
import { setV2Toast, showToast, ToastRegion } from "@/utils/toast"
import { feedbackUrl } from "@/utils/external-links"
import { useServerSDK } from "@/context/server-sdk"
import { normalizeProjectInfo } from "@/context/global-sync/utils"
import { clearWorkspaceTerminals } from "@/context/terminal"
import { pickSessionCacheEvictions } from "@/context/global-sync/session-cache"
import { useNotification } from "@/context/notification"
import { usePermission } from "@/context/permission"
import { Binary } from "@arforge-ai/core/util/binary"
import { retry } from "@arforge-ai/core/util/retry"
import { playSoundById } from "@/utils/sound"
import { createAim } from "@/utils/aim"
import { setNavigate } from "@/utils/notification-click"
import { Worktree as WorktreeState } from "@/utils/worktree"
import { setSessionHandoff } from "@/pages/session/handoff"
import { SessionRouteKey, SessionStateKey } from "@/utils/server-scope"
import { listAllSessions } from "@/utils/session"

import { useDialog } from "@arforge-ai/ui/context/dialog"
import { useTheme, type ColorScheme } from "@arforge-ai/ui/theme/context"
import { useCommand, type CommandOption } from "@/context/command"
import { ConstrainDragXAxis, getDraggableId } from "@/utils/solid-dnd"
import { DebugBar } from "@/components/debug-bar"
import { TabsInfoPopup } from "@/components/help-button"
import { Titlebar, type TitlebarUpdate } from "@/components/titlebar"
import { useDirectoryPicker } from "@/components/directory-picker"
import { ServerConnection, useServer } from "@/context/server"
import { useLanguage, type Locale } from "@/context/language"
import { pathKey } from "@/utils/path-key"
import {
  displayName,
  effectiveWorkspaceOrder,
  errorMessage,
  latestRootSession,
  sidebarHeaderCollapsed,
  sortedRootSessions,
} from "./layout/helpers"
import {
  collectNewSessionDeepLinks,
  collectOpenProjectDeepLinks,
  deepLinkEvent,
  drainPendingDeepLinks,
} from "./layout/deep-links"
import { createInlineEditorController } from "./layout/inline-editor"
import {
  LocalWorkspace,
  SortableWorkspace,
  WorkspaceDragOverlay,
  type WorkspaceSidebarContext,
} from "./layout/sidebar-workspace"
import { ProjectDragOverlay, SortableProject, type ProjectSidebarContext } from "./layout/sidebar-project"
import { SIDEBAR_RAIL_WIDTH, SidebarContent } from "./layout/sidebar-shell"
import {
  workspaceExpansionKeys,
  workspaceExpansionValue,
  type WorkspaceExpansionByProject,
} from "./layout/workspace-expansion"
import { createSidebarScrollbarController } from "./layout/sidebar-scrollbar"
import { sessionRevealDelta, sessionScrollDelta } from "./layout/session-scroll"
import {
  createSidebarScrollMemory,
  sidebarScrollMemoryKey,
  type SidebarScrollSurface,
} from "./layout/sidebar-scroll-memory"
import { createSidebarScrollAnchorController } from "./layout/sidebar-scroll-anchor"
import {
  firstSidebarNewSessionTarget,
  mergeSidebarNewSessionIDs,
  scrollSidebarNewSessionIntoView,
  sidebarNewSessionTargetReached,
  sidebarNewSessionVisualCount,
  visibleSidebarNewSessionIDs,
} from "./layout/sidebar-new-session-notice"
import {
  runWorkspaceCreation,
  workspaceCreationAnnouncement,
  workspaceCreationCommandDisabled,
} from "./layout/workspace-creation"
import { SidebarPrimaryActionTooltip } from "./layout/sidebar-primary-action-tooltip"
import "./layout/sidebar-panel.css"

export default function LegacyLayout(props: ParentProps) {
  const serverSDK = useServerSDK()
  const [store, setStore, , ready] = persisted(
    Persist.serverGlobal(serverSDK().scope, "layout.page", ["layout.page.v1"]),
    createStore({
      lastProjectSession: {} as { [directory: string]: { directory: string; id: string; at: number } },
      activeProject: undefined as string | undefined,
      activeWorkspace: undefined as string | undefined,
      workspaceOrder: {} as Record<string, string[]>,
      workspaceName: {} as Record<string, string>,
      workspaceBranchName: {} as Record<string, Record<string, string>>,
      workspaceExpanded: {} as Record<string, boolean>,
      workspaceExpandedByProject: {} as WorkspaceExpansionByProject,
      gettingStartedDismissed: false,
    }),
  )

  const pageReady = createMemo(() => ready())

  const scrollContainerRefs = new Set<HTMLDivElement>()
  const scrollAnchorSuppressors = new Set<() => void>()
  const scrollSessionKeys = new WeakMap<HTMLDivElement, string>()
  const sessionRevealCleanups = new WeakMap<HTMLDivElement, () => void>()
  const scrollRestoreCleanups = new WeakMap<HTMLDivElement, () => void>()
  const sidebarScrollMemory = createSidebarScrollMemory()
  const cancelSessionReveal = (container: HTMLDivElement) => {
    const cleanup = sessionRevealCleanups.get(container)
    if (!cleanup) return
    cleanup()
    if (sessionRevealCleanups.get(container) === cleanup) sessionRevealCleanups.delete(container)
  }
  const cancelScrollRestore = (container: HTMLDivElement) => {
    const cleanup = scrollRestoreCleanups.get(container)
    if (!cleanup) return
    cleanup()
    if (scrollRestoreCleanups.get(container) === cleanup) scrollRestoreCleanups.delete(container)
  }
  const registerScrollContainer = (element: HTMLDivElement) => {
    scrollContainerRefs.add(element)
    return () => {
      cancelSessionReveal(element)
      cancelScrollRestore(element)
      scrollContainerRefs.delete(element)
      scrollSessionKeys.delete(element)
    }
  }
  const sidebarScrollbar = createSidebarScrollbarController()
  onCleanup(sidebarScrollbar.dispose)
  let dialogRun = 0
  let dialogDead = false

  const params = useParams()
  const serverSync = useServerSync()
  const layout = useLayout()
  const layoutReady = createMemo(() => layout.ready())
  const platform = usePlatform()
  const pickDirectory = useDirectoryPicker()
  const settings = useSettings()
  const server = useServer()
  const notification = useNotification()
  const permission = usePermission()
  const navigate = useNavigate()
  setNavigate(navigate)
  const providers = useProviders()
  const dialog = useDialog()
  const command = useCommand()
  const theme = useTheme()
  const language = useLanguage()
  createEffect(() => setV2Toast(false))
  const initialDirectory = decode64(params.dir)
  const route = createMemo(() => {
    const slug = params.dir
    if (!slug) return { slug, dir: "" }
    const dir = decode64(slug)
    if (!dir) return { slug, dir: "" }
    const store = serverSync().peek(dir, { bootstrap: false })
    return {
      slug,
      store,
      dir: store[0].path.directory || dir,
    }
  })
  const availableThemeEntries = createMemo(() => theme.ids().map((id) => [id, theme.themes()[id]] as const))
  const colorSchemeOrder: ColorScheme[] = ["system", "light", "dark"]
  const colorSchemeKey: Record<ColorScheme, "theme.scheme.system" | "theme.scheme.light" | "theme.scheme.dark"> = {
    system: "theme.scheme.system",
    light: "theme.scheme.light",
    dark: "theme.scheme.dark",
  }
  const colorSchemeLabel = (scheme: ColorScheme) => language.t(colorSchemeKey[scheme])
  const currentDir = createMemo(() => route().dir)

  const [state, setState] = createStore({
    autoselect: !initialDirectory,
    busyWorkspaces: {} as Record<string, boolean>,
    creatingWorkspaces: {} as Record<string, boolean>,
    hoverProject: undefined as string | undefined,
    nav: undefined as HTMLElement | undefined,
    sortNow: Date.now(),
    sizing: false,
    peek: undefined as string | undefined,
    peeked: false,
    debugTools: false,
  })
  const debugToolsEnabled = import.meta.env.DEV && import.meta.env.VITE_ARFORGE_DEBUG_TOOLS === "1"

  const updateVersion = () => {
    const state = platform.updater?.state()
    if (state?.status !== "ready") return
    return state.version
  }
  const installUpdate = () => void platform.updater?.install()
  const titlebarUpdate: TitlebarUpdate = {
    version: updateVersion,
    installing: () => platform.updater?.state().status === "installing",
    install: installUpdate,
  }

  const editor = createInlineEditorController()
  const setBusy = (directory: string, value: boolean) => {
    const key = pathKey(directory)
    if (value) {
      setState("busyWorkspaces", key, true)
      return
    }
    setState(
      "busyWorkspaces",
      produce((draft) => {
        delete draft[key]
      }),
    )
  }
  const isBusy = (directory: string) => !!state.busyWorkspaces[pathKey(directory)]
  const pendingWorkspaceCreations = new Set<string>()
  const setWorkspaceCreating = (key: string, value: boolean) => {
    if (value) {
      setState("creatingWorkspaces", key, true)
      return
    }
    setState(
      "creatingWorkspaces",
      produce((draft) => {
        delete draft[key]
      }),
    )
  }
  const isWorkspaceCreating = (directory: string) => !!state.creatingWorkspaces[pathKey(directory)]
  const navLeave = { current: undefined as number | undefined }
  const sortNow = () => state.sortNow
  let sizet: number | undefined
  let sortNowInterval: ReturnType<typeof setInterval> | undefined
  const sortNowTimeout = setTimeout(
    () => {
      setState("sortNow", Date.now())
      sortNowInterval = setInterval(() => setState("sortNow", Date.now()), 60_000)
    },
    60_000 - (Date.now() % 60_000),
  )

  const aim = createAim({
    enabled: () => !layout.sidebar.opened(),
    active: () => state.hoverProject,
    el: () => state.nav?.querySelector<HTMLElement>("[data-component='sidebar-rail']") ?? state.nav,
    onActivate: (directory) => {
      serverSync().child(directory)
      setState("hoverProject", directory)
    },
  })

  onCleanup(() => {
    dialogDead = true
    dialogRun += 1
    if (navLeave.current !== undefined) clearTimeout(navLeave.current)
    clearTimeout(sortNowTimeout)
    if (sortNowInterval) clearInterval(sortNowInterval)
    if (sizet !== undefined) clearTimeout(sizet)
    if (peekt !== undefined) clearTimeout(peekt)
    aim.reset()
  })

  onMount(() => {
    const stop = () => setState("sizing", false)
    const blur = () => reset()
    const hide = () => {
      if (document.visibilityState !== "hidden") return
      reset()
    }
    makeEventListener(window, "pointerup", stop)
    makeEventListener(window, "pointercancel", stop)
    makeEventListener(window, "blur", stop)
    makeEventListener(window, "blur", blur)
    makeEventListener(document, "visibilitychange", hide)
  })

  const sidebarHovering = createMemo(() => !layout.sidebar.opened() && state.hoverProject !== undefined)
  const sidebarExpanded = createMemo(() => layout.sidebar.opened() || sidebarHovering())
  const setHoverProject = (value: string | undefined) => {
    setState("hoverProject", value)
    if (value !== undefined) return
    aim.reset()
  }
  const clearHoverProjectSoon = () => queueMicrotask(() => setHoverProject(undefined))

  const disarm = () => {
    if (navLeave.current === undefined) return
    clearTimeout(navLeave.current)
    navLeave.current = undefined
  }

  const reset = () => {
    disarm()
    setHoverProject(undefined)
  }

  const arm = () => {
    if (layout.sidebar.opened()) return
    if (state.hoverProject === undefined) return
    disarm()
    navLeave.current = window.setTimeout(() => {
      navLeave.current = undefined
      setHoverProject(undefined)
    }, 300)
  }

  let peekt: number | undefined

  const hoverProjectData = createMemo(() => {
    const id = state.hoverProject
    if (!id) return
    return layout.projects.list().find((project) => project.worktree === id)
  })

  const peekProject = createMemo(() => {
    const id = state.peek
    if (!id) return
    return layout.projects.list().find((project) => project.worktree === id)
  })

  createEffect(() => {
    const p = hoverProjectData()
    if (p) {
      if (peekt !== undefined) {
        clearTimeout(peekt)
        peekt = undefined
      }
      setState("peek", p.worktree)
      setState("peeked", true)
      return
    }

    setState("peeked", false)
    if (state.peek === undefined) return
    if (peekt !== undefined) clearTimeout(peekt)
    peekt = window.setTimeout(() => {
      peekt = undefined
      setState("peek", undefined)
    }, 180)
  })

  createEffect(() => {
    if (!layout.sidebar.opened()) return
    setHoverProject(undefined)
  })

  createEffect(() => {
    if (!state.autoselect) return
    const dir = params.dir
    if (!dir) return
    const directory = decode64(dir)
    if (!directory) return
    setState("autoselect", false)
  })

  const editorOpen = editor.editorOpen
  const openEditor = editor.openEditor
  const closeEditor = editor.closeEditor
  const setEditor = editor.setEditor
  const InlineEditor = editor.InlineEditor

  const clearSidebarHoverState = () => {
    if (layout.sidebar.opened()) return
    reset()
  }

  const navigateWithSidebarReset = (href: string) => {
    clearSidebarHoverState()
    navigate(href)
    layout.mobileSidebar.hide()
  }

  function cycleTheme(direction = 1) {
    const ids = availableThemeEntries().map(([id]) => id)
    if (ids.length === 0) return
    const currentIndex = ids.indexOf(theme.themeId())
    const nextIndex = currentIndex === -1 ? 0 : (currentIndex + direction + ids.length) % ids.length
    const nextThemeId = ids[nextIndex]
    theme.setTheme(nextThemeId)
    showToast({
      title: language.t("toast.theme.title"),
      description: theme.name(nextThemeId),
    })
  }

  function cycleColorScheme(direction = 1) {
    const current = theme.colorScheme()
    const currentIndex = colorSchemeOrder.indexOf(current)
    const nextIndex =
      currentIndex === -1 ? 0 : (currentIndex + direction + colorSchemeOrder.length) % colorSchemeOrder.length
    const next = colorSchemeOrder[nextIndex]
    theme.setColorScheme(next)
    showToast({
      title: language.t("toast.scheme.title"),
      description: colorSchemeLabel(next),
    })
  }

  function setLocale(next: Locale) {
    if (next === language.locale()) return
    language.setLocale(next)
    showToast({
      title: language.t("toast.language.title"),
      description: language.t("toast.language.description", { language: language.label(next) }),
    })
  }

  function cycleLanguage(direction = 1) {
    const locales = language.locales
    const currentIndex = locales.indexOf(language.locale())
    const nextIndex = currentIndex === -1 ? 0 : (currentIndex + direction + locales.length) % locales.length
    const next = locales[nextIndex]
    if (!next) return
    setLocale(next)
  }

  const useSDKNotificationToasts = () =>
    onMount(() => {
      const toastBySession = new Map<string, number>()
      const alertedAtBySession = new Map<string, number>()
      const cooldownMs = 5000

      const dismissSessionAlert = (sessionKey: string) => {
        const toastId = toastBySession.get(sessionKey)
        if (toastId === undefined) return
        toaster.dismiss(toastId)
        toastBySession.delete(sessionKey)
        alertedAtBySession.delete(sessionKey)
      }

      const unsub = serverSDK().event.listen((e) => {
        if (e.details?.type === "worktree.ready") {
          setBusy(e.name, false)
          WorktreeState.ready(serverSDK().scope, e.name)
          return
        }

        if (e.details?.type === "worktree.failed") {
          setBusy(e.name, false)
          WorktreeState.failed(
            serverSDK().scope,
            e.name,
            e.details.properties?.message ?? language.t("common.requestFailed"),
          )
          return
        }

        if (
          e.details?.type === "question.replied" ||
          e.details?.type === "question.rejected" ||
          e.details?.type === "permission.replied"
        ) {
          const props = e.details.properties as { sessionID: string }
          const sessionKey = `${e.name}:${props.sessionID}`
          dismissSessionAlert(sessionKey)
          return
        }

        if (e.details?.type !== "permission.asked" && e.details?.type !== "question.asked") return
        const title =
          e.details.type === "permission.asked"
            ? language.t("notification.permission.title")
            : language.t("notification.question.title")
        const icon = e.details.type === "permission.asked" ? ("checklist" as const) : ("bubble-5" as const)
        const directory = e.name
        const props = e.details.properties
        if (e.details.type === "permission.asked" && permission.autoResponds(e.details.properties, directory)) return

        const [store] = serverSync().child(directory, { bootstrap: false })
        const session = store.session.find((s) => s.id === props.sessionID)
        const sessionKey = `${directory}:${props.sessionID}`

        const sessionTitle = session?.title ?? language.t("command.session.new")
        const projectName = getFilename(directory)
        const description =
          e.details.type === "permission.asked"
            ? language.t("notification.permission.description", { sessionTitle, projectName })
            : language.t("notification.question.description", { sessionTitle, projectName })
        const href = `/${base64Encode(directory)}/session/${props.sessionID}`

        const now = Date.now()
        const lastAlerted = alertedAtBySession.get(sessionKey) ?? 0
        if (now - lastAlerted < cooldownMs) return
        alertedAtBySession.set(sessionKey, now)

        if (e.details.type === "permission.asked") {
          if (settings.sounds.permissionsEnabled()) {
            void playSoundById(settings.sounds.permissions())
          }
          if (settings.notifications.permissions()) {
            void platform.notify(title, description, href)
          }
        }

        if (e.details.type === "question.asked") {
          if (settings.notifications.agent()) {
            void platform.notify(title, description, href)
          }
        }

        const currentSession = params.id
        if (pathKey(directory) === pathKey(currentDir()) && props.sessionID === currentSession) return
        if (pathKey(directory) === pathKey(currentDir()) && session?.parentID === currentSession) return

        dismissSessionAlert(sessionKey)

        const toastId = showToast({
          persistent: true,
          icon,
          title,
          description,
          actions: [
            {
              label: language.t("notification.action.goToSession"),
              onClick: () => navigate(href),
            },
            {
              label: language.t("common.dismiss"),
              onClick: "dismiss",
            },
          ],
        })
        toastBySession.set(sessionKey, toastId)
      })
      onCleanup(unsub)

      createEffect(() => {
        const currentSession = params.id
        if (!currentDir() || !currentSession) return
        const sessionKey = `${currentDir()}:${currentSession}`
        dismissSessionAlert(sessionKey)
        const [store] = serverSync().child(currentDir(), { bootstrap: false })
        const childSessions = store.session.filter((s) => s.parentID === currentSession)
        for (const child of childSessions) {
          dismissSessionAlert(`${currentDir()}:${child.id}`)
        }
      })
    })

  useSDKNotificationToasts()

  function revealSessionAfterScroll(container: HTMLDivElement, element: HTMLElement) {
    cancelSessionReveal(container)

    let waiting = true
    let fallback = 0
    let finish = () => {}
    const scheduleFallback = (delay: number) => {
      window.clearTimeout(fallback)
      fallback = window.setTimeout(finish, delay)
    }
    const onScroll = () => scheduleFallback(120)
    const stopWaiting = () => {
      if (!waiting) return
      waiting = false
      window.clearTimeout(fallback)
      container.removeEventListener("scroll", onScroll)
      container.removeEventListener("scrollend", finish)
    }
    const cancelWait = () => stopWaiting()

    finish = () => {
      if (!waiting || sessionRevealCleanups.get(container) !== cancelWait) return
      stopWaiting()
      sessionRevealCleanups.delete(container)

      const activeRow = element.querySelector<HTMLElement>("[data-sidebar-session-row].active")
      const surface = element.querySelector<HTMLElement>("[data-sidebar-session-surface]")
      if (!element.isConnected || !activeRow || !surface) return

      let pulseFallback = 0
      let onAnimationEnd: (event: AnimationEvent) => void = () => {}
      const cleanupPulse = () => {
        window.clearTimeout(pulseFallback)
        surface.removeEventListener("animationend", onAnimationEnd)
        element.removeAttribute("data-session-auto-reveal")
        if (sessionRevealCleanups.get(container) === cleanupPulse) sessionRevealCleanups.delete(container)
      }
      onAnimationEnd = (event) => {
        if (event.animationName !== "sidebar-session-auto-reveal") return
        cleanupPulse()
      }

      surface.addEventListener("animationend", onAnimationEnd)
      sessionRevealCleanups.set(container, cleanupPulse)
      element.setAttribute("data-session-auto-reveal", "")
      pulseFallback = window.setTimeout(cleanupPulse, 300)
    }

    container.addEventListener("scroll", onScroll, { passive: true })
    container.addEventListener("scrollend", finish)
    sessionRevealCleanups.set(container, cancelWait)
    scheduleFallback(600)
  }

  function scrollToSession(sessionId: string, sessionKey: string) {
    for (const suppress of scrollAnchorSuppressors) suppress()
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    for (const container of scrollContainerRefs) {
      if (container.hasAttribute("data-sidebar-scroll-restoring")) continue
      if (scrollSessionKeys.get(container) === sessionKey) continue
      cancelSessionReveal(container)
      const element = [...container.querySelectorAll<HTMLElement>("[data-session-id]")].find(
        (item) => item.dataset.sessionId === sessionId,
      )
      if (!element) continue

      const containerRect = container.getBoundingClientRect()
      const elementRect = element.getBoundingClientRect()
      if (containerRect.height <= 0 || elementRect.height <= 0) continue

      const delta = sessionRevealDelta({
        containerTop: containerRect.top,
        containerBottom: containerRect.bottom,
        targetTop: elementRect.top,
        targetBottom: elementRect.bottom,
        inset: 8,
      })
      scrollSessionKeys.set(container, sessionKey)
      if (delta === 0) continue
      const scrollDelta = sessionScrollDelta({
        scrollTop: container.scrollTop,
        requestedDelta: delta,
        scrollHeight: container.scrollHeight,
        clientHeight: container.clientHeight,
      })
      if (scrollDelta === 0) continue
      if (!reducedMotion) revealSessionAfterScroll(container, element)
      container.scrollBy({
        top: scrollDelta,
        left: 0,
        behavior: reducedMotion ? "auto" : "smooth",
      })
    }
  }

  const currentProject = createMemo(() => {
    const directory = currentDir()
    if (!directory) return
    const key = pathKey(directory)

    const projects = layout.projects.list()

    const sandbox = projects.find((p) => p.sandboxes?.some((item) => pathKey(item) === key))
    if (sandbox) return sandbox

    const direct = projects.find((p) => pathKey(p.worktree) === key)
    if (direct) return direct

    const [child] = serverSync().child(directory, { bootstrap: false })
    const id = child.project
    if (!id) return

    const meta = serverSync().data.project.find((p) => p.id === id)
    const root = meta?.worktree
    if (!root) return

    return projects.find((p) => p.worktree === root)
  })
  const currentWorkspaceCreating = () => {
    const project = currentProject()
    return project ? isWorkspaceCreating(project.worktree) : false
  }

  const [autoselecting] = createResource(async () => {
    await ready.promise
    await layout.ready.promise
    if (!untrack(() => state.autoselect)) return

    const list = layout.projects.list()
    const last = server.projects.last()

    if (list.length === 0) {
      if (!last) return
      await openProject(last, true)
    } else {
      const next = list.find((project) => project.worktree === last) ?? list[0]
      if (!next) return
      await openProject(next.worktree, true)
    }
  })

  const workspaceName = (directory: string, projectId?: string, branch?: string) => {
    const key = pathKey(directory)
    const direct = store.workspaceName[key] ?? store.workspaceName[directory]
    if (direct) return direct
    if (!projectId) return
    if (!branch) return
    return store.workspaceBranchName[projectId]?.[branch]
  }

  const setWorkspaceName = (directory: string, next: string, projectId?: string, branch?: string) => {
    const key = pathKey(directory)
    setStore("workspaceName", key, next)
    if (!projectId) return
    if (!branch) return
    if (!store.workspaceBranchName[projectId]) {
      setStore("workspaceBranchName", projectId, {})
    }
    setStore("workspaceBranchName", projectId, branch, next)
  }

  const workspaceLabel = (directory: string, branch?: string, projectId?: string) =>
    workspaceName(directory, projectId, branch) ?? branch ?? getFilename(directory)

  const isWorkspaceExpanded = (project: string, directory: string, local: boolean) =>
    workspaceExpansionValue({
      byProject: store.workspaceExpandedByProject,
      legacy: store.workspaceExpanded,
      project,
      directory,
      local,
    })

  const setProjectWorkspaceExpanded = (project: string, directory: string, value: boolean) => {
    const keys = workspaceExpansionKeys(project, directory)
    if (!store.workspaceExpandedByProject[keys.project]) {
      setStore("workspaceExpandedByProject", keys.project, {})
    }
    setStore("workspaceExpandedByProject", keys.project, keys.directory, value)
  }

  const workspaceSetting = createMemo(() => {
    const project = currentProject()
    if (!project) return false
    if (project.vcs !== "git") return false
    return layout.sidebar.workspaces(project.worktree)()
  })

  const visibleSessionDirs = createMemo(() => {
    const project = currentProject()
    if (!project) return [] as string[]
    if (!workspaceSetting()) return [project.worktree]

    const activeDir = currentDir()
    return workspaceIds(project).filter((directory) => {
      const expanded = isWorkspaceExpanded(project.worktree, directory, directory === project.worktree)
      const active = pathKey(directory) === pathKey(activeDir)
      return expanded || active
    })
  })

  const currentSessions = createMemo(() => {
    const now = Date.now()
    const dirs = visibleSessionDirs()
    if (dirs.length === 0) return [] as Session[]

    const result: Session[] = []
    for (const dir of dirs) {
      const [dirStore] = serverSync().child(dir, { bootstrap: true })
      const dirSessions = sortedRootSessions(dirStore, now)
      result.push(...dirSessions)
    }
    return result
  })

  createEffect(() => {
    const id = params.id
    const directory = currentDir()
    if (!id || !directory) return
    const [sessionStore] = serverSync().child(directory, { bootstrap: false })
    if (!sessionStore.session.some((session) => session.id === id)) return

    const frame = requestAnimationFrame(() => scrollToSession(id, `${directory}:${id}`))
    onCleanup(() => cancelAnimationFrame(frame))
  })

  type PrefetchQueue = {
    inflight: Set<string>
    pending: string[]
    pendingSet: Set<string>
    running: number
  }

  const prefetchChunk = 200
  const prefetchConcurrency = 2
  const prefetchPendingLimit = 10
  const span = 4
  const prefetchToken = { value: 0 }
  const prefetchQueues = new Map<string, PrefetchQueue>()

  const PREFETCH_MAX_SESSIONS_PER_DIR = 10
  const prefetchedByDir = new Map<string, Set<string>>()

  const lruFor = (directory: string) => {
    const existing = prefetchedByDir.get(directory)
    if (existing) return existing
    const created = new Set<string>()
    prefetchedByDir.set(directory, created)
    return created
  }

  const markPrefetched = (directory: string, sessionID: string) => {
    const lru = lruFor(directory)
    return pickSessionCacheEvictions({
      seen: lru,
      keep: sessionID,
      limit: PREFETCH_MAX_SESSIONS_PER_DIR,
      preserve: params.id && pathKey(directory) === pathKey(currentDir()) ? [params.id] : undefined,
    })
  }

  createEffect(() => {
    const active = new Set(visibleSessionDirs())
    for (const directory of prefetchedByDir.keys()) {
      if (active.has(directory)) continue
      prefetchedByDir.delete(directory)
    }
  })

  createEffect(() => {
    route()
    serverSDK().url

    prefetchToken.value += 1
    prefetchQueues.clear()
  })

  createEffect(() => {
    const visible = new Set(visibleSessionDirs())
    for (const [directory, q] of prefetchQueues) {
      if (visible.has(directory)) continue
      q.pending.length = 0
      q.pendingSet.clear()
      if (q.running === 0) prefetchQueues.delete(directory)
    }
  })

  const queueFor = (directory: string) => {
    const existing = prefetchQueues.get(directory)
    if (existing) return existing

    const created: PrefetchQueue = {
      inflight: new Set(),
      pending: [],
      pendingSet: new Set(),
      running: 0,
    }
    prefetchQueues.set(directory, created)
    return created
  }

  async function prefetchMessages(directory: string, sessionID: string, token: number) {
    await serverSync()
      .session.prefetch(sessionID, prefetchChunk)
      .catch(() => {})
    if (prefetchToken.value !== token) return
    for (const stale of markPrefetched(directory, sessionID)) serverSync().session.evict(stale)
  }

  const pumpPrefetch = (directory: string) => {
    const q = queueFor(directory)
    if (q.running >= prefetchConcurrency) return

    const sessionID = q.pending.shift()
    if (!sessionID) return

    q.pendingSet.delete(sessionID)
    q.inflight.add(sessionID)
    q.running += 1

    const token = prefetchToken.value

    void prefetchMessages(directory, sessionID, token).finally(() => {
      q.running -= 1
      q.inflight.delete(sessionID)
      pumpPrefetch(directory)
    })
  }

  const prefetchSession = (session: Session, priority: "high" | "low" = "low") => {
    const directory = session.directory
    if (!directory) return

    const cached = untrack(() => !serverSync().session.shouldPrefetch(session.id, prefetchChunk))
    if (cached) return

    const q = queueFor(directory)
    if (q.inflight.has(session.id)) return
    if (q.pendingSet.has(session.id)) {
      if (priority !== "high") return
      const index = q.pending.indexOf(session.id)
      if (index > 0) {
        q.pending.splice(index, 1)
        q.pending.unshift(session.id)
      }
      return
    }

    const lru = lruFor(directory)
    const known = lru.has(session.id)
    if (!known && lru.size >= PREFETCH_MAX_SESSIONS_PER_DIR && priority !== "high") return

    if (priority === "high") q.pending.unshift(session.id)
    if (priority !== "high") q.pending.push(session.id)
    q.pendingSet.add(session.id)

    while (q.pending.length > prefetchPendingLimit) {
      const dropped = q.pending.pop()
      if (!dropped) continue
      q.pendingSet.delete(dropped)
    }

    pumpPrefetch(directory)
  }

  const warm = (sessions: Session[], index: number) => {
    for (let offset = 1; offset <= span; offset++) {
      const next = sessions[index + offset]
      if (next) prefetchSession(next, offset === 1 ? "high" : "low")

      const prev = sessions[index - offset]
      if (prev) prefetchSession(prev, offset === 1 ? "high" : "low")
    }
  }

  createEffect(() => {
    const sessions = currentSessions()
    if (sessions.length === 0) return

    const index = params.id ? sessions.findIndex((s) => s.id === params.id) : 0
    if (index === -1) return

    if (!params.id) {
      const first = sessions[index]
      if (first) prefetchSession(first, "high")
    }

    warm(sessions, index)
  })

  function navigateSessionByOffset(offset: number) {
    const sessions = currentSessions()
    if (sessions.length === 0) return

    const sessionIndex = params.id ? sessions.findIndex((s) => s.id === params.id) : -1

    let targetIndex: number
    if (sessionIndex === -1) {
      targetIndex = offset > 0 ? 0 : sessions.length - 1
    } else {
      targetIndex = (sessionIndex + offset + sessions.length) % sessions.length
    }

    const session = sessions[targetIndex]
    if (!session) return

    prefetchSession(session, "high")
    warm(sessions, targetIndex)

    navigateToSession(session)
  }

  function navigateProjectByOffset(offset: number) {
    const projects = layout.projects.list()
    if (projects.length === 0) return

    const current = currentProject()?.worktree
    const fallback = currentDir() ? projectRoot(currentDir()) : undefined
    const active = current ?? fallback
    const index = active ? projects.findIndex((project) => project.worktree === active) : -1

    const target =
      index === -1
        ? offset > 0
          ? projects[0]
          : projects[projects.length - 1]
        : projects[(index + offset + projects.length) % projects.length]
    if (!target) return

    // warm up child store to prevent flicker
    serverSync().child(target.worktree)
    void openProject(target.worktree)
  }

  function navigateToProjectIndex(index: number) {
    const projects = layout.projects.list()
    const target = projects[index]
    if (!target) return

    serverSync().child(target.worktree)
    void openProject(target.worktree)
  }

  function navigateSessionByUnseen(offset: number) {
    const sessions = currentSessions()
    if (sessions.length === 0) return

    const hasUnseen = sessions.some((session) => notification.session.unseenCount(session.id) > 0)
    if (!hasUnseen) return

    const activeIndex = params.id ? sessions.findIndex((s) => s.id === params.id) : -1
    const start = activeIndex === -1 ? (offset > 0 ? -1 : 0) : activeIndex

    for (let i = 1; i <= sessions.length; i++) {
      const index = offset > 0 ? (start + i) % sessions.length : (start - i + sessions.length) % sessions.length
      const session = sessions[index]
      if (!session) continue
      if (notification.session.unseenCount(session.id) === 0) continue

      prefetchSession(session, "high")
      warm(sessions, index)

      navigateToSession(session)
      return
    }
  }

  async function archiveSession(session: Session) {
    const [store, setStore] = serverSync().child(session.directory)
    const sessions = store.session ?? []
    const index = sessions.findIndex((s) => s.id === session.id)
    const nextSession = sessions[index + 1] ?? sessions[index - 1]

    await serverSDK().api.session.archive({ sessionID: session.id, directory: session.directory })
    setStore(
      produce((draft) => {
        const match = Binary.search(draft.session, session.id, (s) => s.id)
        if (match.found) draft.session.splice(match.index, 1)
      }),
    )
    if (session.id === params.id) {
      if (nextSession) {
        navigate(`/${params.dir}/session/${nextSession.id}`)
      } else {
        navigate(`/${params.dir}/session`)
      }
    }
  }

  command.register("layout", () => {
    const commands: CommandOption[] = [
      {
        id: "sidebar.toggle",
        title: language.t("command.sidebar.toggle"),
        category: language.t("command.category.view"),
        keybind: "mod+b",
        onSelect: () => layout.sidebar.toggle(),
      },
      {
        id: "project.open",
        title: language.t("command.project.open"),
        category: language.t("command.category.project"),
        keybind: "mod+o",
        onSelect: () => chooseProject(),
      },
      {
        id: "project.previous",
        title: language.t("command.project.previous"),
        category: language.t("command.category.project"),
        keybind: "mod+alt+arrowup",
        onSelect: () => navigateProjectByOffset(-1),
      },
      {
        id: "project.next",
        title: language.t("command.project.next"),
        category: language.t("command.category.project"),
        keybind: "mod+alt+arrowdown",
        onSelect: () => navigateProjectByOffset(1),
      },
      {
        id: "provider.connect",
        title: language.t("command.provider.connect"),
        category: language.t("command.category.provider"),
        onSelect: () => connectProvider(),
      },
      {
        id: "server.switch",
        title: language.t("command.server.switch"),
        category: language.t("command.category.server"),
        onSelect: () => openServer(),
      },
      {
        id: "settings.open",
        title: language.t("command.settings.open"),
        category: language.t("command.category.settings"),
        keybind: "mod+comma",
        onSelect: () => openSettings(),
      },
      {
        id: "session.previous",
        title: language.t("command.session.previous"),
        category: language.t("command.category.session"),
        keybind: "alt+arrowup",
        onSelect: () => navigateSessionByOffset(-1),
      },
      {
        id: "session.next",
        title: language.t("command.session.next"),
        category: language.t("command.category.session"),
        keybind: "alt+arrowdown",
        onSelect: () => navigateSessionByOffset(1),
      },
      {
        id: "session.previous.unseen",
        title: language.t("command.session.previous.unseen"),
        category: language.t("command.category.session"),
        keybind: "shift+alt+arrowup",
        onSelect: () => navigateSessionByUnseen(-1),
      },
      {
        id: "session.next.unseen",
        title: language.t("command.session.next.unseen"),
        category: language.t("command.category.session"),
        keybind: "shift+alt+arrowdown",
        onSelect: () => navigateSessionByUnseen(1),
      },
      {
        id: "session.archive",
        title: language.t("command.session.archive"),
        category: language.t("command.category.session"),
        keybind: "mod+shift+backspace",
        disabled: !params.dir || !params.id,
        onSelect: () => {
          const session = currentSessions().find((s) => s.id === params.id)
          if (session) void archiveSession(session)
        },
      },
      {
        id: "workspace.new",
        title: language.t("workspace.new"),
        category: language.t("command.category.workspace"),
        keybind: "mod+shift+w",
        disabled: workspaceCreationCommandDisabled(workspaceSetting(), currentWorkspaceCreating()),
        onSelect: () => {
          const project = currentProject()
          if (!project) return
          return createWorkspace(project)
        },
      },
      {
        id: "workspace.toggle",
        title: language.t("command.workspace.toggle"),
        description: language.t("command.workspace.toggle.description"),
        category: language.t("command.category.workspace"),
        slash: "workspace",
        disabled: !currentProject() || currentProject()?.vcs !== "git",
        onSelect: () => {
          const project = currentProject()
          if (!project) return
          if (project.vcs !== "git") return
          const wasEnabled = layout.sidebar.workspaces(project.worktree)()
          layout.sidebar.toggleWorkspaces(project.worktree)
          showToast({
            title: wasEnabled
              ? language.t("toast.workspace.disabled.title")
              : language.t("toast.workspace.enabled.title"),
            description: wasEnabled
              ? language.t("toast.workspace.disabled.description")
              : language.t("toast.workspace.enabled.description"),
          })
        },
      },
      {
        id: "theme.cycle",
        title: language.t("command.theme.cycle"),
        category: language.t("command.category.theme"),
        keybind: "mod+shift+t",
        onSelect: () => cycleTheme(1),
      },
    ]

    Array.from({ length: 9 }, (_, i) => {
      const index = i
      const number = index + 1
      commands.push({
        id: `project.${number}`,
        category: language.t("command.category.project"),
        title: `Open Project {number}`,
        keybind: `mod+${number}`,
        disabled: layout.projects.list().length <= index,
        hidden: true,
        onSelect: () => navigateToProjectIndex(index),
      })
    })

    for (const [id] of availableThemeEntries()) {
      commands.push({
        id: `theme.set.${id}`,
        title: language.t("command.theme.set", { theme: theme.name(id) }),
        category: language.t("command.category.theme"),
        onSelect: () => theme.commitPreview(),
        onHighlight: () => {
          theme.previewTheme(id)
          return () => theme.cancelPreview()
        },
      })
    }

    commands.push({
      id: "theme.scheme.cycle",
      title: language.t("command.theme.scheme.cycle"),
      category: language.t("command.category.theme"),
      keybind: "mod+shift+s",
      onSelect: () => cycleColorScheme(1),
    })

    for (const scheme of colorSchemeOrder) {
      commands.push({
        id: `theme.scheme.${scheme}`,
        title: language.t("command.theme.scheme.set", { scheme: colorSchemeLabel(scheme) }),
        category: language.t("command.category.theme"),
        onSelect: () => theme.commitPreview(),
        onHighlight: () => {
          theme.previewColorScheme(scheme)
          return () => theme.cancelPreview()
        },
      })
    }

    commands.push({
      id: "language.cycle",
      title: language.t("command.language.cycle"),
      category: language.t("command.category.language"),
      onSelect: () => cycleLanguage(1),
    })

    for (const locale of language.locales) {
      commands.push({
        id: `language.set.${locale}`,
        title: language.t("command.language.set", { language: language.label(locale) }),
        category: language.t("command.category.language"),
        onSelect: () => setLocale(locale),
      })
    }

    return commands
  })

  function connectProvider() {
    const run = ++dialogRun
    void import("@/components/dialog-connect-provider").then((x) => {
      if (dialogDead || dialogRun !== run) return
      void dialog.show(() => <x.DialogConnectProvider />)
    })
  }

  function openServer() {
    const run = ++dialogRun
    void import("@/components/dialog-select-server").then((x) => {
      if (dialogDead || dialogRun !== run) return
      dialog.show(() => <x.DialogSelectServer />)
    })
  }

  function openSettings(defaultValue?: string) {
    const run = ++dialogRun
    if (settings.general.newLayoutDesigns()) {
      void import("@/components/settings-v2").then((module) => {
        if (dialogDead || dialogRun !== run) return
        dialog.show(() => <module.DialogSettings defaultValue={defaultValue} permission={permission} />)
      })
      return
    }
    void import("@/components/dialog-settings").then((module) => {
      if (dialogDead || dialogRun !== run) return
      dialog.show(() => <module.DialogSettings defaultValue={defaultValue} />)
    })
  }

  function projectRoot(directory: string) {
    const key = pathKey(directory)
    const project = layout.projects
      .list()
      .find((item) => pathKey(item.worktree) === key || item.sandboxes?.some((sandbox) => pathKey(sandbox) === key))
    if (project) return project.worktree

    const known = Object.entries(store.workspaceOrder).find(
      ([root, dirs]) => pathKey(root) === key || dirs.some((item) => pathKey(item) === key),
    )
    if (known) return known[0]

    const [child] = serverSync().child(directory, { bootstrap: false })
    const id = child.project
    if (!id) return directory

    const meta = serverSync().data.project.find((item) => item.id === id)
    return meta?.worktree ?? directory
  }

  function activeProjectRoot(directory: string) {
    return currentProject()?.worktree ?? projectRoot(directory)
  }

  function rememberSessionRoute(directory: string, id: string, root = activeProjectRoot(directory)) {
    setStore("lastProjectSession", root, { directory, id, at: Date.now() })
    return root
  }

  function clearLastProjectSession(root: string) {
    if (!store.lastProjectSession[root]) return
    setStore(
      "lastProjectSession",
      produce((draft) => {
        delete draft[root]
      }),
    )
  }

  function syncSessionRoute(directory: string, id: string, root = activeProjectRoot(directory)) {
    rememberSessionRoute(directory, id, root)
    notification.session.markViewed(id)
    const expanded = untrack(() => isWorkspaceExpanded(root, directory, pathKey(root) === pathKey(directory)))
    if (!expanded) {
      setProjectWorkspaceExpanded(root, directory, true)
    }
    requestAnimationFrame(() => scrollToSession(id, `${directory}:${id}`))
    return root
  }

  async function navigateToProject(directory: string | undefined) {
    if (!directory) return
    const root = projectRoot(directory)
    server.projects.touch(root)
    const project = layout.projects.list().find((item) => item.worktree === root)
    let dirs = project
      ? effectiveWorkspaceOrder(root, [root, ...(project.sandboxes ?? [])], store.workspaceOrder[root])
      : [root]
    const canOpen = (value: string | undefined) => {
      if (!value) return false
      return dirs.some((item) => pathKey(item) === pathKey(value))
    }
    const refreshDirs = async (target?: string) => {
      if (!target || target === root || canOpen(target)) return canOpen(target)
      const listed = await Promise.resolve(
        project?.id ?? serverSDK().api.project.current({ location: { directory: root } }),
      )
        .then((value) => (typeof value === "string" ? value : value.id))
        .then((projectID) => serverSDK().api.project.directories({ projectID, location: { directory: root } }))
        .then((items) => items.map((item) => item.directory).filter((item) => pathKey(item) !== pathKey(root)))
        .catch(() => [] as string[])
      dirs = effectiveWorkspaceOrder(root, [root, ...listed], store.workspaceOrder[root])
      return canOpen(target)
    }
    const openSession = async (target: { directory: string; id: string }) => {
      if (!canOpen(target.directory)) return false
      const sync = serverSync().ensureDirSyncContext(target.directory)
      if (sync.session.get(target.id)) {
        setStore("lastProjectSession", root, { directory: target.directory, id: target.id, at: Date.now() })
        navigateWithSidebarReset(`/${base64Encode(target.directory)}/session/${target.id}`)
        return true
      }
      const resolved = await sync.session
        .sync(target.id)
        .then(() => sync.session.get(target.id))
        .catch(() => undefined)
      if (!resolved?.directory) return false
      if (!canOpen(resolved.directory)) return false
      setStore("lastProjectSession", root, { directory: resolved.directory, id: resolved.id, at: Date.now() })
      navigateWithSidebarReset(`/${base64Encode(resolved.directory)}/session/${resolved.id}`)
      return true
    }

    const projectSession = store.lastProjectSession[root]
    if (projectSession?.id) {
      await refreshDirs(projectSession.directory)
      const opened = await openSession(projectSession)
      if (opened) return
      clearLastProjectSession(root)
    }

    const latest = latestRootSession(
      dirs.map((item) => serverSync().child(item, { bootstrap: false })[0]),
      Date.now(),
    )
    if (latest && (await openSession(latest))) {
      return
    }

    const fetched = latestRootSession(
      await Promise.all(
        dirs.map(async (item) => ({
          path: { directory: item },
          session: await listAllSessions(serverSDK().api.session, {
            directory: item,
            parentID: null,
            order: "desc",
          }).catch(() => []),
        })),
      ),
      Date.now(),
    )
    if (fetched && (await openSession(fetched))) {
      return
    }

    navigateWithSidebarReset(`/${base64Encode(root)}/session`)
  }

  function navigateToSession(session: Session | undefined) {
    if (!session) return
    navigateWithSidebarReset(`/${base64Encode(session.directory)}/session/${session.id}`)
  }

  function openProject(directory: string, navigate = true) {
    layout.projects.open(directory)
    if (navigate) return navigateToProject(directory)
  }

  const handleDeepLinks = (urls: string[]) => {
    if (!server.isLocal()) return

    for (const directory of collectOpenProjectDeepLinks(urls)) {
      void openProject(directory)
    }

    for (const link of collectNewSessionDeepLinks(urls)) {
      void openProject(link.directory, false)
      const slug = base64Encode(link.directory)
      if (link.prompt) {
        setSessionHandoff(SessionStateKey.from(server.scope(), SessionRouteKey.fromLegacy(slug)), {
          prompt: link.prompt,
        })
      }
      const href = link.prompt ? `/${slug}/session?prompt=${encodeURIComponent(link.prompt)}` : `/${slug}/session`
      navigateWithSidebarReset(href)
    }
  }

  onMount(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ urls: string[] }>).detail
      const urls = detail?.urls ?? []
      if (urls.length === 0) return
      handleDeepLinks(urls)
    }

    handleDeepLinks(drainPendingDeepLinks(window))
    makeEventListener(window, deepLinkEvent, handler as EventListener)
  })

  async function renameProject(project: LocalProject, next: string) {
    const current = displayName(project)
    if (next === current) return
    const name = next === getFilename(project.worktree) ? "" : next

    if (project.id && project.id !== "global") {
      const result = await serverSDK().api.project.update({ projectID: project.id, name })
      serverSync().set("project", (items) =>
        items.map((item) => (item.id === result.id ? normalizeProjectInfo(result) : item)),
      )
      return
    }

    serverSync().project.meta(project.worktree, { name })
  }

  const renameWorkspace = (directory: string, next: string, projectId?: string, branch?: string) => {
    const current = workspaceName(directory, projectId, branch) ?? branch ?? getFilename(directory)
    if (current === next) return
    setWorkspaceName(directory, next, projectId, branch)
  }

  function closeProject(directory: string) {
    const list = layout.projects.list()
    const key = pathKey(directory)
    const index = list.findIndex((x) => pathKey(x.worktree) === key)
    const active = pathKey(currentProject()?.worktree ?? "") === key
    if (index === -1) return

    if (!active) {
      layout.projects.close(directory)
      return
    }

    if (list.length === 1) {
      layout.projects.close(directory)
      navigate("/")
      return
    }

    const next = list[index + 1] ?? list[index - 1]

    navigateWithSidebarReset(`/${base64Encode(next.worktree)}/session`)
    layout.projects.close(directory)
    queueMicrotask(() => {
      void navigateToProject(next.worktree)
    })
  }

  function toggleProjectWorkspaces(project: LocalProject) {
    const enabled = layout.sidebar.workspaces(project.worktree)()
    if (enabled) {
      layout.sidebar.toggleWorkspaces(project.worktree)
      return
    }
    if (project.vcs !== "git") return
    layout.sidebar.toggleWorkspaces(project.worktree)
  }

  const showEditProjectDialog = (conn: ServerConnection.Any, project: LocalProject) => {
    const run = ++dialogRun
    void import("@/components/dialog-edit-project").then((x) => {
      if (dialogDead || dialogRun !== run) return
      dialog.show(() => <x.DialogEditProject server={conn} project={project} />)
    })
  }

  function chooseProject() {
    const conn = server.current
    if (!conn) return
    function resolve(result: string | string[] | null) {
      if (Array.isArray(result)) {
        for (const directory of result) {
          void openProject(directory, false)
        }
        void navigateToProject(result[0])
      } else if (result) {
        void openProject(result)
      }
    }

    pickDirectory({
      server: conn,
      title: language.t("command.project.open"),
      multiple: true,
      onSelect: resolve,
    })
  }

  const deleteWorkspace = async (root: string, directory: string, leaveDeletedWorkspace = false) => {
    if (directory === root) return

    const current = currentDir()
    const currentKey = pathKey(current)
    const deletedKey = pathKey(directory)
    const shouldLeave = leaveDeletedWorkspace || (!!params.dir && currentKey === deletedKey)
    if (!leaveDeletedWorkspace && shouldLeave) {
      navigateWithSidebarReset(`/${base64Encode(root)}/session`)
    }

    setBusy(directory, true)

    const result = await serverSDK()
      .client.worktree.remove({ directory: root, worktreeRemoveInput: { directory } })
      .then((x) => x.data)
      .catch((err) => {
        showToast({
          title: language.t("workspace.delete.failed.title"),
          description: errorMessage(err, language.t("common.requestFailed")),
        })
        return false
      })

    setBusy(directory, false)

    if (!result) return

    if (pathKey(store.lastProjectSession[root]?.directory ?? "") === pathKey(directory)) {
      clearLastProjectSession(root)
    }

    serverSync().set(
      "project",
      produce((draft) => {
        const project = draft.find((item) => item.worktree === root)
        if (!project) return
        project.sandboxes = (project.sandboxes ?? []).filter((sandbox) => sandbox !== directory)
      }),
    )
    setStore("workspaceOrder", root, (order) => (order ?? []).filter((workspace) => workspace !== directory))

    layout.projects.close(directory)
    layout.projects.open(root)

    if (shouldLeave) return

    const nextCurrent = currentDir()
    const nextKey = pathKey(nextCurrent)
    const project = layout.projects.list().find((item) => item.worktree === root)
    const dirs = project
      ? effectiveWorkspaceOrder(root, [root, ...(project.sandboxes ?? [])], store.workspaceOrder[root])
      : [root]
    const valid = dirs.some((item) => pathKey(item) === nextKey)

    if (params.dir && projectRoot(nextCurrent) === root && !valid) {
      navigateWithSidebarReset(`/${base64Encode(root)}/session`)
    }
  }

  const resetWorkspace = async (root: string, directory: string) => {
    if (directory === root) return
    setBusy(directory, true)

    const progress = showToast({
      persistent: true,
      title: language.t("workspace.resetting.title"),
      description: language.t("workspace.resetting.description"),
    })
    const dismiss = () => toaster.dismiss(progress)

    const sessions = await listAllSessions(serverSDK().api.session, { directory, order: "desc" }).catch(() => [])

    clearWorkspaceTerminals(
      directory,
      sessions.map((s) => s.id),
      platform,
      serverSDK().scope,
    )
    await serverSDK()
      .client.instance.dispose({ directory })
      .catch(() => undefined)

    const result = await serverSDK()
      .client.worktree.reset({ directory: root, worktreeResetInput: { directory } })
      .then((x) => x.data)
      .catch((err) => {
        showToast({
          title: language.t("workspace.reset.failed.title"),
          description: errorMessage(err, language.t("common.requestFailed")),
        })
        return false
      })

    if (!result) {
      setBusy(directory, false)
      dismiss()
      return
    }

    await Promise.all(
      sessions
        .filter((session) => session.time.archived === undefined)
        .map((session) =>
          serverSDK()
            .api.session.archive({ sessionID: session.id, directory: session.directory })
            .catch(() => undefined),
        ),
    )

    setBusy(directory, false)
    dismiss()

    showToast({
      title: language.t("workspace.reset.success.title"),
      description: language.t("workspace.reset.success.description"),
      actions: [
        {
          label: language.t("command.session.new"),
          onClick: () => {
            const href = `/${base64Encode(directory)}/session`
            navigate(href)
            layout.mobileSidebar.hide()
          },
        },
        {
          label: language.t("common.dismiss"),
          onClick: "dismiss",
        },
      ],
    })
  }

  function DialogDeleteWorkspace(props: { root: string; directory: string }) {
    const name = createMemo(() => getFilename(props.directory))
    const [data, setData] = createStore({
      status: "loading" as "loading" | "ready" | "error",
      dirty: false,
    })

    onMount(() => {
      serverSDK()
        .api.vcs.status({ location: { directory: props.directory } })
        .then((result) => {
          const files = result.data
          const dirty = files.length > 0
          setData({ status: "ready", dirty })
        })
        .catch(() => {
          setData({ status: "error", dirty: false })
        })
    })

    const handleDelete = () => {
      const leaveDeletedWorkspace = !!params.dir && pathKey(currentDir()) === pathKey(props.directory)
      if (leaveDeletedWorkspace) {
        navigateWithSidebarReset(`/${base64Encode(props.root)}/session`)
      }
      dialog.close()
      void deleteWorkspace(props.root, props.directory, leaveDeletedWorkspace)
    }

    const description = () => {
      if (data.status === "loading") return language.t("workspace.status.checking")
      if (data.status === "error") return language.t("workspace.status.error")
      if (!data.dirty) return language.t("workspace.status.clean")
      return language.t("workspace.status.dirty")
    }

    return (
      <Dialog title={language.t("workspace.delete.title")} fit>
        <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
          <div class="flex flex-col gap-1">
            <span class="text-14-regular text-text-strong">
              {language.t("workspace.delete.confirm", { name: name() })}
            </span>
            <span class="text-12-regular text-text-weak">{description()}</span>
          </div>
          <div class="flex justify-end gap-2">
            <Button variant="ghost" size="large" onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </Button>
            <Button variant="primary" size="large" disabled={data.status === "loading"} onClick={handleDelete}>
              {language.t("workspace.delete.button")}
            </Button>
          </div>
        </div>
      </Dialog>
    )
  }

  function DialogResetWorkspace(props: { root: string; directory: string }) {
    const name = createMemo(() => getFilename(props.directory))
    const [state, setState] = createStore({
      status: "loading" as "loading" | "ready" | "error",
      dirty: false,
      sessions: [] as Session[],
    })

    const refresh = async () => {
      const sessions = await listAllSessions(serverSDK().api.session, {
        directory: props.directory,
        order: "desc",
      }).catch(() => [])
      const active = sessions.filter((session) => session.time.archived === undefined)
      setState({ sessions: active })
    }

    onMount(() => {
      serverSDK()
        .api.vcs.status({ location: { directory: props.directory } })
        .then((result) => {
          const files = result.data
          const dirty = files.length > 0
          setState({ status: "ready", dirty })
          void refresh()
        })
        .catch(() => {
          setState({ status: "error", dirty: false })
        })
    })

    const handleReset = () => {
      dialog.close()
      void resetWorkspace(props.root, props.directory)
    }

    const archivedCount = () => state.sessions.length

    const description = () => {
      if (state.status === "loading") return language.t("workspace.status.checking")
      if (state.status === "error") return language.t("workspace.status.error")
      if (!state.dirty) return language.t("workspace.status.clean")
      return language.t("workspace.status.dirty")
    }

    const archivedLabel = () => {
      const count = archivedCount()
      if (count === 0) return language.t("workspace.reset.archived.none")
      if (count === 1) return language.t("workspace.reset.archived.one")
      return language.t("workspace.reset.archived.many", { count })
    }

    return (
      <Dialog title={language.t("workspace.reset.title")} fit>
        <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
          <div class="flex flex-col gap-1">
            <span class="text-14-regular text-text-strong">
              {language.t("workspace.reset.confirm", { name: name() })}
            </span>
            <span class="text-12-regular text-text-weak">
              {description()} {archivedLabel()} {language.t("workspace.reset.note")}
            </span>
          </div>
          <div class="flex justify-end gap-2">
            <Button variant="ghost" size="large" onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </Button>
            <Button variant="primary" size="large" disabled={state.status === "loading"} onClick={handleReset}>
              {language.t("workspace.reset.button")}
            </Button>
          </div>
        </div>
      </Dialog>
    )
  }

  const activeRoute = {
    session: "",
    sessionProject: "",
    directory: "",
  }

  createEffect(
    on(
      () => {
        return [pageReady(), route().slug, params.id, currentProject()?.worktree, currentDir()] as const
      },
      ([ready, slug, id, root, dir]) => {
        if (!ready || !slug || !dir) {
          activeRoute.session = ""
          activeRoute.sessionProject = ""
          activeRoute.directory = ""
          return
        }

        if (!id) {
          activeRoute.session = ""
          activeRoute.sessionProject = ""
          activeRoute.directory = ""
          return
        }

        const session = `${slug}/${id}`

        if (!root) {
          activeRoute.session = session
          activeRoute.directory = dir
          activeRoute.sessionProject = ""
          return
        }

        if (server.projects.last() !== root) server.projects.touch(root)

        const changed = session !== activeRoute.session || dir !== activeRoute.directory
        if (changed) {
          activeRoute.session = session
          activeRoute.directory = dir
          activeRoute.sessionProject = syncSessionRoute(dir, id, root)
          return
        }

        if (root === activeRoute.sessionProject) return
        activeRoute.directory = dir
        activeRoute.sessionProject = rememberSessionRoute(dir, id, root)
      },
    ),
  )

  createEffect(() => {
    document.documentElement.style.setProperty(
      "--dialog-left-margin",
      `${layout.sidebar.opened() ? layout.sidebar.width() : SIDEBAR_RAIL_WIDTH}px`,
    )
  })

  const side = createMemo(() => Math.max(layout.sidebar.width(), 244))
  const panel = createMemo(() => Math.max(side() - SIDEBAR_RAIL_WIDTH, 0))

  const loadedSessionDirs = new Set<string>()

  createEffect(
    on(
      visibleSessionDirs,
      (dirs) => {
        if (dirs.length === 0) {
          loadedSessionDirs.clear()
          return
        }

        const next = new Set(dirs)
        for (const directory of next) {
          if (loadedSessionDirs.has(directory)) continue
          void serverSync().project.loadSessions(directory)
        }

        loadedSessionDirs.clear()
        for (const directory of next) {
          loadedSessionDirs.add(directory)
        }
      },
      { defer: true },
    ),
  )

  function handleDragStart(event: unknown) {
    const id = getDraggableId(event)
    if (!id) return
    setHoverProject(undefined)
    setStore("activeProject", id)
  }

  function handleDragOver(event: DragEvent) {
    const { draggable, droppable } = event
    if (draggable && droppable) {
      const projects = layout.projects.list()
      const fromIndex = projects.findIndex((p) => p.worktree === draggable.id.toString())
      const toIndex = projects.findIndex((p) => p.worktree === droppable.id.toString())
      if (fromIndex !== toIndex && toIndex !== -1) {
        layout.projects.move(draggable.id.toString(), toIndex)
      }
    }
  }

  function handleDragEnd() {
    setStore("activeProject", undefined)
  }

  function workspaceIds(project: LocalProject | undefined) {
    if (!project) return []
    const local = project.worktree
    const dirs = [local, ...(project.sandboxes ?? [])]
    const active = currentProject()
    const directory = pathKey(active?.worktree ?? "") === pathKey(project.worktree) ? currentDir() : undefined
    const extra =
      directory && pathKey(directory) !== pathKey(local) && !dirs.some((item) => pathKey(item) === pathKey(directory))
        ? directory
        : undefined
    const pending = extra ? WorktreeState.get(serverSDK().scope, extra)?.status === "pending" : false

    const ordered = effectiveWorkspaceOrder(local, dirs, store.workspaceOrder[project.worktree])
    if (pending && extra) return [local, extra, ...ordered.filter((item) => item !== local)]
    if (!extra) return ordered
    if (pending) return ordered
    return [...ordered, extra]
  }

  const sidebarProject = createMemo(() => {
    if (layout.sidebar.opened()) return currentProject()
    const hovered = hoverProjectData()
    if (hovered) return hovered
    return currentProject()
  })

  function handleWorkspaceDragStart(event: unknown) {
    const id = getDraggableId(event)
    if (!id) return
    setStore("activeWorkspace", id)
  }

  function handleWorkspaceDragOver(event: DragEvent) {
    const { draggable, droppable } = event
    if (!draggable || !droppable) return

    const project = sidebarProject()
    if (!project) return

    const ids = workspaceIds(project)
    const fromIndex = ids.findIndex((dir) => dir === draggable.id.toString())
    const toIndex = ids.findIndex((dir) => dir === droppable.id.toString())
    if (fromIndex === -1 || toIndex === -1) return
    if (fromIndex === toIndex) return

    const result = ids.slice()
    const [item] = result.splice(fromIndex, 1)
    if (!item) return
    result.splice(toIndex, 0, item)
    setStore(
      "workspaceOrder",
      project.worktree,
      result.filter((directory) => pathKey(directory) !== pathKey(project.worktree)),
    )
  }

  function handleWorkspaceDragEnd() {
    setStore("activeWorkspace", undefined)
  }

  const createWorkspace = (project: LocalProject) =>
    runWorkspaceCreation(
      pendingWorkspaceCreations,
      pathKey(project.worktree),
      async () => {
        clearSidebarHoverState()
        const created = await serverSDK()
          .client.worktree.create({ directory: project.worktree })
          .then((x) => x.data)
          .catch((err) => {
            showToast({
              title: language.t("workspace.create.failed.title"),
              description: errorMessage(err, language.t("common.requestFailed")),
            })
            return undefined
          })

        if (!created?.directory) return

        setWorkspaceName(
          created.directory,
          created.branch ?? getFilename(created.directory),
          project.id,
          created.branch,
        )

        const local = project.worktree
        const key = pathKey(created.directory)
        const root = pathKey(local)

        setBusy(created.directory, true)
        WorktreeState.pending(serverSDK().scope, created.directory)
        setProjectWorkspaceExpanded(local, created.directory, true)
        setStore("workspaceOrder", project.worktree, (prev) => {
          const existing = prev ?? []
          const next = existing.filter((item) => {
            const id = pathKey(item)
            return id !== root && id !== key
          })
          return [created.directory, ...next]
        })

        serverSync().child(created.directory)
        navigateWithSidebarReset(`/${base64Encode(created.directory)}/session`)
      },
      setWorkspaceCreating,
    )

  const workspaceSidebarCtx: WorkspaceSidebarContext = {
    currentDir,
    navList: currentSessions,
    sidebarExpanded,
    sidebarHovering,
    clearHoverProjectSoon,
    prefetchSession,
    archiveSession,
    workspaceName,
    renameWorkspace,
    editorOpen,
    openEditor,
    closeEditor,
    setEditor,
    InlineEditor,
    isBusy,
    workspaceExpanded: isWorkspaceExpanded,
    setWorkspaceExpanded: setProjectWorkspaceExpanded,
    showResetWorkspaceDialog: (root, directory) =>
      dialog.show(() => <DialogResetWorkspace root={root} directory={directory} />),
    showDeleteWorkspaceDialog: (root, directory) =>
      dialog.show(() => <DialogDeleteWorkspace root={root} directory={directory} />),
    registerScrollContainer,
    preserveScrollAnchor: () => undefined,
    suppressScrollAnchor: () => undefined,
  }

  const projectSidebarCtx: ProjectSidebarContext = {
    currentDir,
    currentProject,
    sidebarOpened: () => layout.sidebar.opened(),
    sidebarHovering,
    hoverProject: () => state.hoverProject,
    onProjectMouseEnter: (worktree, event) => aim.enter(worktree, event),
    onProjectMouseLeave: (worktree) => aim.leave(worktree),
    onProjectFocus: (worktree) => aim.activate(worktree),
    onHoverOpenChanged: (worktree, hoverOpen) => {
      if (!hoverOpen && state.hoverProject && state.hoverProject !== worktree) return
      setState("hoverProject", hoverOpen ? worktree : undefined)
    },
    navigateToProject,
    openSidebar: () => layout.sidebar.open(),
    closeProject,
    showEditProjectDialog: (proj) => showEditProjectDialog(server.current!, proj),
    toggleProjectWorkspaces,
    workspacesEnabled: (project) => project.vcs === "git" && layout.sidebar.workspaces(project.worktree)(),
    workspaceIds,
    workspaceLabel,
    sessionProps: {
      navList: currentSessions,
      sidebarExpanded,
      clearHoverProjectSoon,
      prefetchSession,
      archiveSession,
    },
  }

  const SidebarPanel = (panelProps: {
    project: Accessor<LocalProject | undefined>
    mobile?: boolean
    merged?: boolean
  }) => {
    const [headerState, setHeaderState] = createStore({
      collapsed: false,
    })
    const creatingWorkspace = () => {
      const directory = panelProps.project()?.worktree
      return directory ? isWorkspaceCreating(directory) : false
    }
    const [newSessionNotice, setNewSessionNotice] = createStore<{
      visible: boolean
      container?: HTMLDivElement
      target?: HTMLElement
      ids: string[]
      count: number
      previousCount?: number
      countTransitioning: boolean
    }>({
      visible: false,
      ids: [],
      count: 0,
      countTransitioning: false,
    })
    let newSessionArrivalCleanup: (() => void) | undefined
    let newSessionCountTransitionTimer = 0
    const cancelNewSessionArrival = () => {
      newSessionArrivalCleanup?.()
      newSessionArrivalCleanup = undefined
    }
    onCleanup(() => {
      cancelNewSessionArrival()
      window.clearTimeout(newSessionCountTransitionTimer)
    })
    const clearNewSessionNotice = () => {
      window.clearTimeout(newSessionCountTransitionTimer)
      newSessionCountTransitionTimer = 0
      setNewSessionNotice({
        visible: false,
        container: undefined,
        target: undefined,
        ids: [],
        count: 0,
        previousCount: undefined,
        countTransitioning: false,
      })
    }
    const showNewSessionNotice = (container: HTMLDivElement, ids: string[], fallbackTarget?: HTMLElement) => {
      const continuing = newSessionNotice.visible && newSessionNotice.container === container
      const previousCount = continuing ? newSessionNotice.count : undefined
      const count = ids.length
      const reducedMotion =
        typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
      const countTransitioning =
        !reducedMotion &&
        previousCount !== undefined &&
        sidebarNewSessionVisualCount(previousCount) !== sidebarNewSessionVisualCount(count)
      const target = firstSidebarNewSessionTarget(container, ids) ?? fallbackTarget
      window.clearTimeout(newSessionCountTransitionTimer)
      newSessionCountTransitionTimer = 0
      setNewSessionNotice({
        visible: true,
        container,
        target,
        ids,
        count,
        previousCount: countTransitioning ? previousCount : undefined,
        countTransitioning,
      })
      if (!countTransitioning) return
      newSessionCountTransitionTimer = window.setTimeout(() => {
        newSessionCountTransitionTimer = 0
        setNewSessionNotice({
          previousCount: undefined,
          countTransitioning: false,
        })
      }, 180)
    }
    const confirmNewSessionAfterScroll = (container: HTMLDivElement, target: HTMLElement) => {
      cancelNewSessionArrival()

      const item = target.closest<HTMLElement>("[data-sidebar-session-item]")
      const surface = item?.querySelector<HTMLElement>("[data-sidebar-session-surface]")
      if (!item?.isConnected || !surface) return

      let waiting = true
      let fallback = 0
      let finish = () => {}
      const scheduleFallback = (delay: number) => {
        window.clearTimeout(fallback)
        fallback = window.setTimeout(finish, delay)
      }
      const onScroll = () => scheduleFallback(120)
      const stopWaiting = () => {
        if (!waiting) return
        waiting = false
        window.clearTimeout(fallback)
        container.removeEventListener("scroll", onScroll)
        container.removeEventListener("scrollend", finish)
      }
      const cancelWait = () => {
        stopWaiting()
        if (newSessionArrivalCleanup === cancelWait) newSessionArrivalCleanup = undefined
      }

      finish = () => {
        if (!waiting || newSessionArrivalCleanup !== cancelWait) return
        stopWaiting()
        newSessionArrivalCleanup = undefined
        if (!item.isConnected || !target.isConnected || !container.contains(target)) return

        const containerRect = container.getBoundingClientRect()
        const targetRect = target.getBoundingClientRect()
        if (
          !sidebarNewSessionTargetReached({
            containerTop: containerRect.top,
            containerBottom: containerRect.bottom,
            targetTop: targetRect.top,
            targetBottom: targetRect.bottom,
          })
        ) {
          return
        }
        if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return
        if (window.matchMedia("(forced-colors: active)").matches) return

        let pulseFallback = 0
        let onAnimationEnd: (event: AnimationEvent) => void = () => {}
        const cleanupPulse = () => {
          window.clearTimeout(pulseFallback)
          surface.removeEventListener("animationend", onAnimationEnd)
          item.removeAttribute("data-session-new-arrival")
          if (newSessionArrivalCleanup === cleanupPulse) newSessionArrivalCleanup = undefined
        }
        onAnimationEnd = (event) => {
          if (event.animationName !== "sidebar-session-new-arrival") return
          cleanupPulse()
        }

        surface.addEventListener("animationend", onAnimationEnd)
        newSessionArrivalCleanup = cleanupPulse
        item.setAttribute("data-session-new-arrival", "")
        pulseFallback = window.setTimeout(cleanupPulse, 300)
      }

      container.addEventListener("scroll", onScroll, { passive: true })
      container.addEventListener("scrollend", finish)
      newSessionArrivalCleanup = cancelWait
      scheduleFallback(120)
    }
    const updateNewSessionNotice = (container: HTMLDivElement) => {
      if (!newSessionNotice.visible || newSessionNotice.container !== container) return
      const target = firstSidebarNewSessionTarget(container, newSessionNotice.ids) ?? newSessionNotice.target
      if (!target?.isConnected || !container.contains(target)) {
        clearNewSessionNotice()
        return
      }
      if (target !== newSessionNotice.target) setNewSessionNotice("target", target)

      const visibleIDs = visibleSidebarNewSessionIDs(container, newSessionNotice.ids)
      if (!visibleIDs.length) return
      const visible = new Set(visibleIDs)
      const pendingIDs = newSessionNotice.ids.filter((id) => !visible.has(id))
      const targetID = target.closest<HTMLElement>("[data-session-id]")?.dataset.sessionId
      const targetReached = targetID !== undefined && visible.has(targetID)
      if (!pendingIDs.length) {
        clearNewSessionNotice()
      } else {
        showNewSessionNotice(container, pendingIDs)
      }
      if (targetReached) confirmNewSessionAfterScroll(container, target)
    }
    const scrollToNewSessionNotice = () => {
      const container = newSessionNotice.container
      const target = container
        ? (firstSidebarNewSessionTarget(container, newSessionNotice.ids) ?? newSessionNotice.target)
        : undefined
      if (!container || !target?.isConnected || !container.contains(target)) {
        clearNewSessionNotice()
        return
      }
      if (target !== newSessionNotice.target) setNewSessionNotice("target", target)

      const reducedMotion =
        typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
      scrollSidebarNewSessionIntoView(container, target, reducedMotion)
      requestAnimationFrame(() => updateNewSessionNotice(container))
    }
    const project = panelProps.project
    const merged = createMemo(() => panelProps.mobile || (panelProps.merged ?? layout.sidebar.opened()))
    const hover = createMemo(() => !panelProps.mobile && panelProps.merged === false && !layout.sidebar.opened())
    const empty = createMemo(() => !params.dir && layout.projects.list().length === 0)
    const projectName = createMemo(() => {
      const item = project()
      if (!item) return ""
      return item.name || getFilename(item.worktree)
    })
    const projectId = createMemo(() => project()?.id ?? "")
    const worktree = createMemo(() => project()?.worktree ?? "")
    const slug = createMemo(() => {
      const dir = worktree()
      if (!dir) return ""
      return base64Encode(dir)
    })
    const workspaces = createMemo(() => {
      const item = project()
      if (!item) return [] as string[]
      return workspaceIds(item)
    })
    const unseenCount = createMemo(() =>
      workspaces().reduce((total, directory) => total + notification.project.unseenCount(directory), 0),
    )
    const clearNotifications = () =>
      workspaces()
        .filter((directory) => notification.project.unseenCount(directory) > 0)
        .forEach((directory) => notification.project.markViewed(directory))
    const workspacesEnabled = createMemo(() => {
      const item = project()
      if (!item) return false
      if (item.vcs !== "git") return false
      return layout.sidebar.workspaces(item.worktree)()
    })
    const canToggle = createMemo(() => {
      const item = project()
      if (!item) return false
      return item.vcs === "git" || layout.sidebar.workspaces(item.worktree)()
    })
    const homedir = createMemo(() => serverSync().data.path.home)
    const updateHeader = (scrollTop: number) => {
      const collapsed = sidebarHeaderCollapsed(headerState.collapsed, scrollTop)
      if (collapsed === headerState.collapsed) return
      setHeaderState("collapsed", collapsed)
    }
    const surface: SidebarScrollSurface | undefined = panelProps.mobile
      ? "mobile"
      : panelProps.merged === false
        ? undefined
        : "desktop"
    const scrollAnchorController = createSidebarScrollAnchorController({
      enabled: () => !!surface,
      onScrollTopChange: updateHeader,
      onNewSessionsAbove: (notice) => {
        cancelNewSessionArrival()
        const continuing = newSessionNotice.visible && newSessionNotice.container === notice.container
        const ids = mergeSidebarNewSessionIDs(continuing ? newSessionNotice.ids : [], notice.ids)
        showNewSessionNotice(notice.container, ids, notice.target)
      },
    })
    scrollAnchorSuppressors.add(scrollAnchorController.suppress)
    onCleanup(() => scrollAnchorSuppressors.delete(scrollAnchorController.suppress))
    onCleanup(scrollAnchorController.dispose)
    const scrollMemoryKey = createMemo(() => {
      const directory = worktree()
      if (!surface || !directory) return
      return sidebarScrollMemoryKey(surface, pathKey(directory))
    })
    const panelScrollElements = new Set<HTMLDivElement>()
    let activeScrollMemoryKey = scrollMemoryKey()

    const restorePanelScroll = (element: HTMLDivElement, key: string | undefined) => {
      if (newSessionNotice.container === element) clearNewSessionNotice()
      cancelNewSessionArrival()
      scrollAnchorController.suppress()
      cancelScrollRestore(element)
      cancelSessionReveal(element)
      scrollSessionKeys.delete(element)
      if (!key) return

      let frame = 0
      let disposed = false
      const cleanup = () => {
        if (disposed) return
        disposed = true
        cancelAnimationFrame(frame)
        element.removeAttribute("data-sidebar-scroll-restoring")
        if (scrollRestoreCleanups.get(element) === cleanup) scrollRestoreCleanups.delete(element)
      }

      element.setAttribute("data-sidebar-scroll-restoring", "")
      scrollRestoreCleanups.set(element, cleanup)
      frame = requestAnimationFrame(() => {
        if (disposed) return
        if (activeScrollMemoryKey !== key) {
          cleanup()
          return
        }
        const restored = sidebarScrollMemory.restore(key, element.scrollHeight, element.clientHeight)
        element.scrollTop = restored
        updateHeader(restored)

        frame = requestAnimationFrame(() => {
          if (disposed) return
          if (activeScrollMemoryKey !== key) {
            cleanup()
            return
          }
          cleanup()

          const id = params.id
          const directory = currentDir()
          if (!id || !directory || pathKey(projectRoot(directory)) !== pathKey(worktree())) return
          scrollToSession(id, `${directory}:${id}`)
        })
      })
    }

    const registerPanelScrollContainer = (element: HTMLDivElement) => {
      panelScrollElements.add(element)
      const unregister = registerScrollContainer(element)
      const unregisterAnchor = scrollAnchorController.register(element)
      const suppressAnchor = () => scrollAnchorController.suppress()
      const suppressPointerMove = (event: PointerEvent) => {
        if (event.buttons !== 0) scrollAnchorController.suppress()
      }
      element.addEventListener("pointerdown", suppressAnchor, { capture: true, passive: true })
      element.addEventListener("pointermove", suppressPointerMove, { capture: true, passive: true })
      element.addEventListener("wheel", suppressAnchor, { capture: true, passive: true })
      element.addEventListener("touchstart", suppressAnchor, { capture: true, passive: true })
      element.addEventListener("touchmove", suppressAnchor, { capture: true, passive: true })
      element.addEventListener("keydown", suppressAnchor, true)
      const remember = () => {
        if (element.hasAttribute("data-sidebar-scroll-restoring")) return
        const key = activeScrollMemoryKey
        if (key) sidebarScrollMemory.remember(key, element.scrollTop)
      }
      const handleScroll = () => {
        remember()
        updateNewSessionNotice(element)
      }
      element.addEventListener("scroll", handleScroll, { passive: true })
      restorePanelScroll(element, activeScrollMemoryKey)

      return () => {
        remember()
        if (newSessionNotice.container === element) clearNewSessionNotice()
        cancelNewSessionArrival()
        element.removeEventListener("pointerdown", suppressAnchor, true)
        element.removeEventListener("pointermove", suppressPointerMove, true)
        element.removeEventListener("wheel", suppressAnchor, true)
        element.removeEventListener("touchstart", suppressAnchor, true)
        element.removeEventListener("touchmove", suppressAnchor, true)
        element.removeEventListener("keydown", suppressAnchor, true)
        unregisterAnchor()
        element.removeEventListener("scroll", handleScroll)
        panelScrollElements.delete(element)
        unregister()
      }
    }

    createEffect(() => {
      const next = scrollMemoryKey()
      const previous = activeScrollMemoryKey
      if (previous === next) return

      for (const element of panelScrollElements) {
        if (previous && !element.hasAttribute("data-sidebar-scroll-restoring")) {
          sidebarScrollMemory.remember(previous, element.scrollTop)
        }
      }
      activeScrollMemoryKey = next
      for (const element of panelScrollElements) {
        restorePanelScroll(element, next)
      }
    })
    const panelWorkspaceSidebarCtx: WorkspaceSidebarContext = {
      ...workspaceSidebarCtx,
      archiveSession: async (session) => {
        scrollAnchorController.suppress()
        return workspaceSidebarCtx.archiveSession(session)
      },
      setWorkspaceExpanded: (project, directory, value) => {
        scrollAnchorController.suppress()
        workspaceSidebarCtx.setWorkspaceExpanded(project, directory, value)
      },
      registerScrollContainer: registerPanelScrollContainer,
      preserveScrollAnchor: scrollAnchorController.preserve,
      suppressScrollAnchor: scrollAnchorController.suppress,
    }

    createEffect(
      on(
        () => `${params.dir ?? ""}:${params.id ?? ""}`,
        () => {
          clearNewSessionNotice()
          cancelNewSessionArrival()
          scrollAnchorController.suppress()
        },
        { defer: true },
      ),
    )

    createEffect(
      on(
        worktree,
        () => {
          setHeaderState("collapsed", false)
        },
        { defer: true },
      ),
    )

    const newSessionNoticeLabel = (count: number) =>
      count > 1
        ? language.t("sidebar.session.newAvailableCount", { count })
        : language.t("sidebar.session.newAvailable")
    const newSessionNoticeVisualLabel = (count: number) =>
      count > 1
        ? language.t("sidebar.session.newAvailableCount", { count: sidebarNewSessionVisualCount(count) })
        : language.t("sidebar.session.newAvailable")
    const NewSessionNotice = () => {
      const label = () => newSessionNoticeLabel(newSessionNotice.count)
      const visualLabel = () => newSessionNoticeVisualLabel(newSessionNotice.count)
      return (
        <>
          <span class="sr-only" role="status" aria-live="polite" aria-atomic="true">
            {newSessionNotice.visible ? label() : ""}
          </span>
          <div
            data-sidebar-new-session-notice
            data-visible={newSessionNotice.visible}
            aria-hidden={!newSessionNotice.visible}
          >
            <button
              type="button"
              tabIndex={newSessionNotice.visible ? 0 : -1}
              aria-label={label()}
              onClick={scrollToNewSessionNotice}
            >
              <span data-sidebar-new-session-pill>
                <span
                  data-sidebar-new-session-labels
                  data-transitioning={newSessionNotice.countTransitioning}
                  aria-hidden="true"
                >
                  <Show when={newSessionNotice.countTransitioning && newSessionNotice.previousCount !== undefined}>
                    <span data-sidebar-new-session-label="previous">
                      {newSessionNoticeVisualLabel(newSessionNotice.previousCount ?? 0)}
                    </span>
                  </Show>
                  <span data-sidebar-new-session-label="current">{visualLabel()}</span>
                </span>
              </span>
            </button>
          </div>
        </>
      )
    }

    return (
      <div
        classList={{
          "flex flex-col min-h-0 min-w-0 box-border rounded-tl-[12px] px-3": true,
          "border border-b-0 border-border-weak-base": !merged(),
          "border-l border-t border-border-weaker-base": merged(),
          "bg-background-base": merged() || hover(),
          "bg-background-stronger": !merged() && !hover(),
          "flex-1 min-w-0": panelProps.mobile,
          "max-w-full overflow-hidden": panelProps.mobile,
        }}
        style={{
          width: panelProps.mobile ? undefined : `${panel()}px`,
        }}
      >
        <Show
          when={project()}
          fallback={
            <Show when={empty()}>
              <div class="flex-1 min-h-0 -mt-4 flex items-center justify-center px-6 pb-64 text-center">
                <div class="mt-8 flex max-w-60 flex-col items-center gap-6 text-center">
                  <div class="flex flex-col gap-3">
                    <div class="text-14-medium text-text-strong">{language.t("sidebar.empty.title")}</div>
                    <div class="text-14-regular text-text-base" style={{ "line-height": "var(--line-height-normal)" }}>
                      {language.t("sidebar.empty.description")}
                    </div>
                  </div>
                  <Button size="large" icon="folder-add-left" onClick={chooseProject}>
                    {language.t("command.project.open")}
                  </Button>
                </div>
              </div>
            </Show>
          }
          keyed
        >
          {(project) => (
            <>
              <div data-sidebar-project-header data-collapsed={headerState.collapsed}>
                <div class="group/project flex size-full items-center justify-between gap-2">
                  <div data-sidebar-project-title class="flex min-w-0 flex-col">
                    <InlineEditor
                      id={`project:${projectId()}`}
                      value={projectName}
                      onSave={(next) => {
                        void renameProject(project, next)
                      }}
                      class="text-14-medium text-text-strong truncate"
                      displayClass="text-14-medium text-text-strong truncate"
                      stopPropagation
                    />

                    <Tooltip
                      placement="bottom"
                      gutter={2}
                      value={worktree()}
                      class="shrink-0"
                      contentStyle={{
                        "max-width": "640px",
                        transform: `translate3d(${SIDEBAR_RAIL_WIDTH}px, 0, 0)`,
                      }}
                    >
                      <span data-sidebar-project-path class="text-12-regular text-text-base truncate select-text">
                        {worktree().replace(homedir(), "~")}
                      </span>
                    </Tooltip>
                  </div>

                  <DropdownMenu modal={!sidebarHovering()}>
                    <DropdownMenu.Trigger
                      as={IconButton}
                      icon="dot-grid"
                      variant="ghost"
                      data-action="project-menu"
                      data-project={slug()}
                      class="shrink-0 size-6 rounded-md transition-opacity data-[expanded]:bg-surface-base-active"
                      classList={{
                        "opacity-100": panelProps.mobile || merged(),
                        "opacity-0 group-hover/project:opacity-100 group-focus-within/project:opacity-100 data-[expanded]:opacity-100":
                          !panelProps.mobile && !merged(),
                      }}
                      aria-label={language.t("common.moreOptions")}
                    />
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content class="mt-1">
                        <DropdownMenu.Item
                          onSelect={() => {
                            showEditProjectDialog(server.current!, project)
                          }}
                        >
                          <DropdownMenu.ItemLabel>{language.t("common.edit")}</DropdownMenu.ItemLabel>
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                          data-action="project-workspaces-toggle"
                          data-project={slug()}
                          disabled={!canToggle()}
                          onSelect={() => {
                            toggleProjectWorkspaces(project)
                          }}
                        >
                          <DropdownMenu.ItemLabel>
                            {workspacesEnabled()
                              ? language.t("sidebar.workspaces.disable")
                              : language.t("sidebar.workspaces.enable")}
                          </DropdownMenu.ItemLabel>
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                          data-action="project-clear-notifications"
                          data-project={slug()}
                          disabled={unseenCount() === 0}
                          onSelect={clearNotifications}
                        >
                          <DropdownMenu.ItemLabel>
                            {language.t("sidebar.project.clearNotifications")}
                          </DropdownMenu.ItemLabel>
                        </DropdownMenu.Item>
                        <DropdownMenu.Separator />
                        <DropdownMenu.Item
                          data-action="project-close-menu"
                          data-project={slug()}
                          onSelect={() => {
                            const dir = worktree()
                            if (!dir) return
                            closeProject(dir)
                          }}
                        >
                          <DropdownMenu.ItemLabel>{language.t("common.close")}</DropdownMenu.ItemLabel>
                        </DropdownMenu.Item>
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu>
                </div>
              </div>

              <div class="flex-1 min-h-0 flex flex-col">
                <Show
                  when={workspacesEnabled()}
                  fallback={
                    <>
                      <div data-sidebar-primary-action-dock>
                        <SidebarPrimaryActionTooltip value={language.t("command.session.new")}>
                          <Button
                            variant="ghost"
                            size="large"
                            type="button"
                            data-sidebar-primary-action
                            onClick={() => {
                              const dir = worktree()
                              if (!dir) return
                              navigateWithSidebarReset(`/${base64Encode(dir)}/session`)
                            }}
                          >
                            <IconV2 name="edit" size="small" />
                            <span data-sidebar-primary-action-label>{language.t("command.session.new")}</span>
                          </Button>
                        </SidebarPrimaryActionTooltip>
                      </div>
                      <div class="relative flex-1 min-h-0">
                        <NewSessionNotice />
                        <LocalWorkspace
                          ctx={panelWorkspaceSidebarCtx}
                          project={project}
                          sortNow={sortNow}
                          mobile={panelProps.mobile}
                          onScrollTopChange={updateHeader}
                        />
                      </div>
                    </>
                  }
                >
                  <>
                    <div data-sidebar-primary-action-dock>
                      <span class="sr-only" role="status" aria-live="polite" aria-atomic="true">
                        {workspaceCreationAnnouncement(creatingWorkspace(), language.t("workspace.creating"))}
                      </span>
                      <SidebarPrimaryActionTooltip value={language.t("workspace.new")}>
                        <Button
                          variant="ghost"
                          size="large"
                          type="button"
                          data-sidebar-primary-action
                          aria-busy={creatingWorkspace()}
                          aria-disabled={creatingWorkspace()}
                          onClick={() => {
                            if (creatingWorkspace()) return
                            void createWorkspace(project)
                          }}
                        >
                          <span
                            aria-hidden="true"
                            data-sidebar-primary-action-icon-slot
                            data-pending={creatingWorkspace()}
                          >
                            <span data-sidebar-primary-action-icon>
                              <Icon name="plus-small" size="small" />
                            </span>
                            <span data-sidebar-primary-action-spinner>
                              <Spinner class="size-3" />
                            </span>
                          </span>
                          <span data-sidebar-primary-action-label>{language.t("workspace.new")}</span>
                        </Button>
                      </SidebarPrimaryActionTooltip>
                    </div>
                    <div class="relative flex-1 min-h-0">
                      <NewSessionNotice />
                      <DragDropProvider
                        onDragStart={handleWorkspaceDragStart}
                        onDragEnd={handleWorkspaceDragEnd}
                        onDragOver={handleWorkspaceDragOver}
                        collisionDetector={closestCenter}
                      >
                        <DragDropSensors />
                        <ConstrainDragXAxis />
                        <div
                          ref={(el) => {
                            onCleanup(registerPanelScrollContainer(el))
                            sidebarScrollbar.observe(el)
                            onCleanup(() => sidebarScrollbar.unobserve(el))
                          }}
                          data-sidebar-workspace-scroll
                          data-sidebar-scrollbar
                          class="size-full flex flex-col py-2 gap-4 overflow-y-auto [overflow-anchor:none]"
                          onScroll={(event) => {
                            if (
                              !event.currentTarget.hasAttribute("data-sidebar-scroll-restoring") &&
                              !event.currentTarget.hasAttribute("data-sidebar-scroll-anchoring")
                            ) {
                              sidebarScrollbar.showScrolling(event.currentTarget)
                            }
                            updateHeader(event.currentTarget.scrollTop)
                          }}
                        >
                          <SortableProvider ids={workspaces()}>
                            <For each={workspaces()}>
                              {(directory) => (
                                <SortableWorkspace
                                  ctx={panelWorkspaceSidebarCtx}
                                  directory={directory}
                                  project={project}
                                  sortNow={sortNow}
                                  mobile={panelProps.mobile}
                                />
                              )}
                            </For>
                          </SortableProvider>
                        </div>
                        <DragOverlay>
                          <WorkspaceDragOverlay
                            sidebarProject={sidebarProject}
                            activeWorkspace={() => store.activeWorkspace}
                            workspaceLabel={workspaceLabel}
                          />
                        </DragOverlay>
                      </DragDropProvider>
                    </div>
                  </>
                </Show>
              </div>
            </>
          )}
        </Show>

        <div
          class="shrink-0 px-3 py-3"
          classList={{
            hidden: store.gettingStartedDismissed || !(providers.all().size > 0 && providers.paid().length === 0),
          }}
        >
          <div class="rounded-xl bg-background-base shadow-xs-border-base" data-component="getting-started">
            <div class="p-3 flex flex-col gap-6">
              <div class="flex flex-col gap-2">
                <div class="text-14-medium text-text-strong">{language.t("sidebar.gettingStarted.title")}</div>
                <div class="text-14-regular text-text-base" style={{ "line-height": "var(--line-height-normal)" }}>
                  {language.t("sidebar.gettingStarted.line1")}
                </div>
                <div class="text-14-regular text-text-base" style={{ "line-height": "var(--line-height-normal)" }}>
                  {language.t("sidebar.gettingStarted.line2")}
                </div>
              </div>
              <div data-component="getting-started-actions">
                <Button size="large" icon="plus-small" onClick={connectProvider}>
                  {language.t("command.provider.connect")}
                </Button>
                <Button size="large" variant="ghost" onClick={() => setStore("gettingStartedDismissed", true)}>
                  {language.t("toast.update.action.notYet")}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  const projects = () => layout.projects.list()
  const projectOverlay = () => <ProjectDragOverlay projects={projects} activeProject={() => store.activeProject} />
  const sidebarContent = (mobile?: boolean) => (
    <SidebarContent
      mobile={mobile}
      opened={() => layout.sidebar.opened()}
      aimMove={aim.move}
      projects={projects}
      renderProject={(project) => (
        <SortableProject ctx={projectSidebarCtx} project={project} sortNow={sortNow} mobile={mobile} />
      )}
      handleDragStart={handleDragStart}
      handleDragEnd={handleDragEnd}
      handleDragOver={handleDragOver}
      openProjectLabel={language.t("command.project.open")}
      openProjectKeybind={() => command.keybind("project.open")}
      onOpenProject={chooseProject}
      renderProjectOverlay={projectOverlay}
      settingsLabel={() => language.t("sidebar.settings")}
      settingsKeybind={() => command.keybind("settings.open")}
      onOpenSettings={openSettings}
      moreLabel={() => language.t("common.moreOptions")}
      shortcutsLabel={() => language.t("settings.tab.shortcuts")}
      onOpenShortcuts={() => openSettings("shortcuts")}
      helpLabel={() => language.t("sidebar.help")}
      onOpenHelp={() => {
        if (feedbackUrl) return platform.openLink(feedbackUrl)
        showToast({ title: "Feedback unavailable", description: "Configure VITE_ARFORGE_FEEDBACK_URL." })
      }}
      renderPanel={() =>
        mobile ? <SidebarPanel project={currentProject} mobile /> : <SidebarPanel project={currentProject} merged />
      }
    />
  )

  return (
    <div
      data-arforge-atmosphere
      class="relative flex-1 min-h-0 min-w-0 flex flex-col select-none [&_input]:select-text [&_textarea]:select-text [&_[contenteditable]]:select-text"
    >
      {autoselecting() ?? ""}
      <Titlebar
        update={titlebarUpdate}
        debugTools={
          debugToolsEnabled
            ? { visible: state.debugTools, toggle: () => setState("debugTools", (value) => !value) }
            : undefined
        }
      />
      <Show when={updateVersion() !== undefined}>
        <UpdateAvailableToast version={updateVersion() ?? ""} install={installUpdate} language={language} />
      </Show>
      <div class="flex-1 min-h-0 min-w-0 flex">
        <div class="flex-1 min-h-0 relative">
          <div class="size-full relative overflow-x-hidden">
            <nav
              aria-label={language.t("sidebar.nav.projectsAndSessions")}
              data-component="sidebar-nav-desktop"
              data-arforge-material="sidebar"
              classList={{
                "hidden xl:block": true,
                "absolute inset-y-0 left-0": true,
                "z-10": true,
              }}
              style={{ width: `${side()}px` }}
              ref={(el) => {
                setState("nav", el)
              }}
              onMouseEnter={() => {
                disarm()
              }}
              onMouseLeave={() => {
                aim.reset()
                if (!sidebarHovering()) return

                arm()
              }}
            >
              <div class="@container w-full h-full contain-strict">{sidebarContent()}</div>
            </nav>

            <Show when={layout.sidebar.opened()}>
              <div
                class="hidden xl:block absolute inset-y-0 z-30 w-0 overflow-visible"
                style={{ left: `${side()}px` }}
                onPointerDown={() => setState("sizing", true)}
              >
                <ResizeHandle
                  direction="horizontal"
                  size={layout.sidebar.width()}
                  min={244}
                  max={typeof window === "undefined" ? 1000 : window.innerWidth * 0.3 + SIDEBAR_RAIL_WIDTH}
                  onResize={(w) => {
                    setState("sizing", true)
                    if (sizet !== undefined) clearTimeout(sizet)
                    sizet = window.setTimeout(() => setState("sizing", false), 120)
                    layout.sidebar.resize(w)
                  }}
                />
              </div>
            </Show>

            <div
              class="hidden xl:block pointer-events-none absolute top-0 right-0 z-0 border-t border-border-weaker-base"
              style={{ left: `calc(${SIDEBAR_RAIL_WIDTH}px + 12px)` }}
            />

            <div class="xl:hidden">
              <div
                classList={{
                  "fixed inset-x-0 top-11 bottom-0 z-40 bg-black/15 backdrop-blur-[2px] transition-opacity duration-200": true,
                  "opacity-100 pointer-events-auto": layout.mobileSidebar.opened(),
                  "opacity-0 pointer-events-none": !layout.mobileSidebar.opened(),
                }}
                onClick={(e) => {
                  if (e.target === e.currentTarget) layout.mobileSidebar.hide()
                }}
              />
              <nav
                aria-label={language.t("sidebar.nav.projectsAndSessions")}
                data-component="sidebar-nav-mobile"
                data-arforge-material="sidebar"
                classList={{
                  "@container fixed top-11 bottom-0 left-0 z-50 w-full max-w-[400px] overflow-hidden border-r transition-transform duration-240 ease-out": true,
                  "translate-x-0": layout.mobileSidebar.opened(),
                  "-translate-x-full": !layout.mobileSidebar.opened(),
                }}
                onClick={(e) => e.stopPropagation()}
              >
                {sidebarContent(true)}
              </nav>
            </div>

            <div
              classList={{
                "absolute inset-0": true,
                "xl:inset-y-0 xl:right-0 xl:left-[var(--main-left)]": true,
                "z-20": true,
                "transition-[left] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[left] motion-reduce:transition-none":
                  !state.sizing,
              }}
              style={{
                "--main-left": layout.sidebar.opened() ? `${side()}px` : `${SIDEBAR_RAIL_WIDTH}px`,
              }}
            >
              <main
                data-arforge-material="main"
                classList={{
                  "size-full overflow-x-hidden flex flex-col items-start contain-strict border-t xl:border-l xl:rounded-tl-[16px]": true,
                }}
              >
                <Show when={!autoselecting.loading} fallback={<div class="size-full" />}>
                  {props.children}
                </Show>
              </main>
            </div>

            <div
              classList={{
                "hidden xl:flex absolute inset-y-0 z-30": true,
                "opacity-100 translate-x-0 pointer-events-auto": state.peeked && !layout.sidebar.opened(),
                "opacity-0 -translate-x-2 pointer-events-none": !state.peeked || layout.sidebar.opened(),
                "transition-[opacity,transform] motion-reduce:transition-none": true,
                "duration-180 ease-out": state.peeked && !layout.sidebar.opened(),
                "duration-120 ease-in": !state.peeked || layout.sidebar.opened(),
              }}
              style={{ left: `${SIDEBAR_RAIL_WIDTH}px` }}
              onMouseMove={disarm}
              onMouseEnter={() => {
                disarm()
                aim.reset()
              }}
              onPointerDown={disarm}
              onMouseLeave={() => {
                arm()
              }}
            >
              <Show when={peekProject()}>
                <SidebarPanel project={peekProject} merged={false} />
              </Show>
            </div>

            <div
              classList={{
                "hidden xl:block pointer-events-none absolute inset-y-0 right-0 z-25 overflow-hidden": true,
                "opacity-100 translate-x-0": state.peeked && !layout.sidebar.opened(),
                "opacity-0 -translate-x-2": !state.peeked || layout.sidebar.opened(),
                "transition-[opacity,transform] motion-reduce:transition-none": true,
                "duration-180 ease-out": state.peeked && !layout.sidebar.opened(),
                "duration-120 ease-in": !state.peeked || layout.sidebar.opened(),
              }}
              style={{ left: `calc(${SIDEBAR_RAIL_WIDTH}px + ${panel()}px)` }}
            >
              <div class="h-full w-px" style={{ "box-shadow": "var(--shadow-sidebar-overlay)" }} />
            </div>
          </div>
        </div>
        {debugToolsEnabled && state.debugTools && <DebugBar />}
      </div>
      <TabsInfoPopup />
      <ToastRegion v2={false} />
    </div>
  )
}

function UpdateAvailableToast(props: {
  version: string
  install: () => void
  language: ReturnType<typeof useLanguage>
}) {
  let toastId: number | undefined

  onMount(() => {
    toastId = showToast({
      persistent: true,
      icon: "download",
      title: props.language.t("toast.update.title"),
      description: props.language.t("toast.update.description", { version: props.version }),
      actions: [
        {
          label: props.language.t("toast.update.action.installRestart"),
          onClick: props.install,
        },
        {
          label: props.language.t("toast.update.action.notYet"),
          onClick: "dismiss",
        },
      ],
    })
  })

  onCleanup(() => {
    if (toastId === undefined) return
    toaster.dismiss(toastId)
  })

  return null
}

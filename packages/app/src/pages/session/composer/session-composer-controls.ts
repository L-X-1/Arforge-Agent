import { base64Encode } from "@arforge-ai/core/util/encode"
import { createQuery } from "@tanstack/solid-query"
import { useNavigate, useSearchParams } from "@solidjs/router"
import { type Accessor, createEffect, createMemo } from "solid-js"
import type { PromptInputControls } from "@/components/prompt-input/contracts"
import type { PromptProject, PromptProjectControls } from "@/components/prompt-project-selector"
import { useDirectoryPicker } from "@/components/directory-picker"
import { useGlobal } from "@/context/global"
import { useLayout } from "@/context/layout"
import { useLocal, type ModelSelection } from "@/context/local"
import type { QueryOptionsApi } from "@/context/server-sync"
import { useServerSDK } from "@/context/server-sdk"
import { serverName, ServerConnection, useServer } from "@/context/server"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { useTabs } from "@/context/tabs"
import { useProviders } from "@/hooks/use-providers"
import { pathKey } from "@/utils/path-key"
import { canSubmitDraftDirectory } from "@/pages/home-compose/home-draft-state"
import { directoryAccessReason } from "@/context/directory-access"
import { useLanguage } from "@/context/language"
import { unavailableAgentReason } from "@/context/local-agent"

type ReadyPromptInputControls = PromptInputControls & {
  session: PromptInputControls["session"] & { canSubmit: Accessor<boolean> }
}

export function createPromptInputController(input: {
  sessionKey: Accessor<string>
  sessionID: Accessor<string | undefined>
  queryOptions: Pick<QueryOptionsApi, "agents" | "providers" | "path">
  model?: ModelSelection
}) {
  const layout = useLayout()
  const local = useLocal()
  const language = useLanguage()
  const sdk = useSDK()
  const providers = useProviders(() => sdk().directory)
  const sync = useSync()
  const serverSDK = useServerSDK()
  const global = useGlobal()
  const directoryAccess = () => global.ensureServerCtx(serverSDK().server).sync.directoryAccess
  createEffect(() => { void directoryAccess().check(sdk().directory) })
  const view = layout.view(input.sessionKey)
  const agentsQuery = createQuery(() => input.queryOptions.agents(pathKey(sdk().directory)))
  const globalProvidersQuery = createQuery(() => input.queryOptions.providers(null))
  const providersQuery = createQuery(() => input.queryOptions.providers(pathKey(sdk().directory)))
  const pathQuery = createQuery(() => ({
    ...input.queryOptions.path(pathKey(sdk().directory)),
    enabled: !input.sessionID(),
  }))
  const canSubmit = () => {
    if (!local.session.ready() || agentsQuery.isLoading || !local.agent.current()) return false
    const readable = directoryAccess().get(sdk().directory)?.status === "ready"
    const healthy = global.servers.health[ServerConnection.key(serverSDK().server)]?.healthy
    if (!readable || healthy === false) return false
    if (input.sessionID()) return true
    // Reading Solid Query's data while pending/error suspends the composer.
    // Keep its draft/editor mounted while path validation controls only Send.
    if (pathQuery.isFetching || !pathQuery.isSuccess) return false
    return canSubmitDraftDirectory({
      directory: sdk().directory,
      pathDirectory: pathQuery.data?.directory,
      pending: false,
      success: true,
      healthy,
      readable,
    })
  }

  return createMemo<ReadyPromptInputControls>(() => ({
    agents: {
      available: sync().data.agent,
      options: local.agent.list().map((agent) => agent.name),
      current: local.agent.selected() ?? "",
      unavailable: unavailableAgentReason(
        local.agent.unavailable(),
        local.session.ready() && agentsQuery.isSuccess && !agentsQuery.isFetching,
        language.locale(),
      ),
      loading: agentsQuery.isLoading || !local.session.ready(),
      visible: local.agent.visible() || local.agent.unavailable() !== undefined,
      select: local.agent.set,
    },
    model: {
      selection: input.model ?? local.model,
      paid: providers.paid().length > 0,
      loading:
        (local.agent.visible() && agentsQuery.isLoading) || providersQuery.isLoading || globalProvidersQuery.isLoading,
    },
    session: {
      id: input.sessionID(),
      canSubmit,
      tabs: layout.tabs(input.sessionKey),
      reviewPanel: view.reviewPanel,
    },
  }))
}

export function createPromptProjectControls() {
  const language = useLanguage()
  const navigate = useNavigate()
  const layout = useLayout()
  const server = useServer()
  const serverSDK = useServerSDK()
  const sdk = useSDK()
  const tabs = useTabs()
  const global = useGlobal()
  const pickDirectory = useDirectoryPicker()
  const [search] = useSearchParams<{ draftId?: string }>()
  const projectServer = () => serverSDK().server
  const projectServerCtx = createMemo(() => global.ensureServerCtx(projectServer()))
  const projects = createMemo<PromptProject[]>(() => {
    if (server.list.length <= 1) {
      return search.draftId ? projectServerCtx().projects.list() : layout.projects.list()
    }
    return server.list.flatMap((conn) => {
      const item = { key: ServerConnection.key(conn), name: serverName(conn) }
      return global
        .ensureServerCtx(conn)
        .projects.list()
        .map((project) => ({ ...project, server: item }))
    })
  })
  const accessFor = (key?: string) => {
    const conn = key ? server.list.find((item) => ServerConnection.key(item) === key) : projectServer()
    return conn ? global.ensureServerCtx(conn).sync.directoryAccess : undefined
  }
  const refresh = (force = false) => {
    for (const project of projects()) void accessFor(project.server?.key)?.check(project.worktree, { force })
  }
  createEffect(() => refresh())
  const selectProject = (worktree: string, serverKey?: string) => {
    const conn = serverKey ? server.list.find((conn) => ServerConnection.key(conn) === serverKey) : projectServer()
    if (!conn || global.servers.health[ServerConnection.key(conn)]?.healthy === false) return
    if (global.ensureServerCtx(conn).sync.directoryAccess.get(worktree)?.status === "unavailable") return
    if (search.draftId) {
      const target = global.ensureServerCtx(conn)
      target.projects.open(worktree)
      target.projects.touch(worktree)
      tabs.updateDraft(search.draftId, { server: ServerConnection.key(conn), directory: worktree })
      return
    }

    if (!serverKey) {
      layout.projects.open(worktree)
      server.projects.touch(worktree)
      navigate(`/${base64Encode(worktree)}/session`)
      return
    }

    const target = global.ensureServerCtx(conn)
    target.projects.open(worktree)
    target.projects.touch(worktree)
    server.setActive(ServerConnection.key(conn))
    navigate(`/${base64Encode(worktree)}/session`)
  }

  const addProject = (title: string, serverKey?: string) => {
    const conn = serverKey ? server.list.find((conn) => ServerConnection.key(conn) === serverKey) : projectServer()
    if (!conn || global.servers.health[ServerConnection.key(conn)]?.healthy === false) return
    const requestedServer = ServerConnection.key(conn)
    pickDirectory({
      server: conn,
      title,
      onSelect: (result) => {
        const directory = Array.isArray(result) ? result[0] : result
        if (directory) selectProject(directory, requestedServer)
      },
    })
  }

  return createMemo<PromptProjectControls>(() => ({
    available: projects().map((project) => ({
      ...project,
      unavailable: directoryAccessReason(accessFor(project.server?.key)?.get(project.worktree), project.worktree, language.locale()),
    })),
    directory: sdk().directory,
    server: server.list.length > 1 ? ServerConnection.key(projectServer()) : undefined,
    select: selectProject,
    add: addProject,
    refresh: () => refresh(true),
  }))
}

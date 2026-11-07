import { createEffect, createMemo, Show } from "solid-js"
import { useDirectoryPicker } from "@/components/directory-picker"
import {
  PromptProjectAddButton,
  PromptProjectSelector,
  createPromptProjectController,
} from "@/components/prompt-project-selector"
import { ServerConnection, serverName } from "@/context/server"
import type { HomeController } from "./home-controller"
import { directoryAccessReason } from "@/context/directory-access"
import { useLanguage } from "@/context/language"

export function HomeProjectPicker(props: { home: HomeController }) {
  const pickDirectory = useDirectoryPicker()
  const language = useLanguage()
  const refresh = (force = false) => {
    for (const conn of props.home.server.list()) {
      const access = props.home.server.context(conn).sync.directoryAccess
      for (const project of props.home.project.forServer(conn)) void access.check(project.worktree, { force })
    }
  }
  createEffect(() => refresh())
  const controls = createMemo(() => ({
    available: props.home.server.list().flatMap((conn) =>
      props.home.project.forServer(conn).map((project) => ({
        ...project,
        unavailable: directoryAccessReason(props.home.server.context(conn).sync.directoryAccess.get(project.worktree), project.worktree, language.locale()),
        server: { key: ServerConnection.key(conn), name: serverName(conn) },
      })),
    ),
    directory: props.home.project.newSession()?.worktree ?? "",
    server: props.home.selection.value().server,
    select: (directory: string, key?: string) => {
      const conn = props.home.server.list().find((item) => ServerConnection.key(item) === key)
      if (!conn || props.home.server.health(conn)?.healthy === false) return
      props.home.server.context(conn).projects.touch(directory)
      props.home.selection.set({ server: ServerConnection.key(conn), directory })
    },
    add: (title: string, key?: string) => {
      const conn = key
        ? props.home.server.list().find((item) => ServerConnection.key(item) === key)
        : props.home.server.focused()
      if (!conn || props.home.server.health(conn)?.healthy === false) return
      pickDirectory({
        server: conn,
        title,
        onSelect: (result) => {
          if (!result) return
          props.home.project.add(conn, Array.isArray(result) ? result : [result])
        },
      })
    },
    refresh: () => refresh(true),
  }))
  const controller = createPromptProjectController({ controls, onDone: () => {} })
  return (
    <div class="flex min-h-11 min-w-0 items-center justify-center text-v2-text-text-muted">
      <Show when={props.home.project.newSession()} fallback={<PromptProjectAddButton controller={controller} />}>
        <PromptProjectSelector controller={controller} />
      </Show>
    </div>
  )
}

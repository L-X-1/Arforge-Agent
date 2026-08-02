import type { HomeProjectsController } from "./home-projects-controller"
import { HomeProjectsView } from "./home-projects-view"
import type { HomeScrollController } from "./home-scroll-controller"
import type { Accessor } from "solid-js"

export function HomeProjects(props: {
  projects: HomeProjectsController
  scroll: HomeScrollController
  archiveSelected: Accessor<boolean>
  archiveCount: Accessor<number>
  onOpenArchive: () => void
  onOpenSessions: () => void
}) {
  return (
    <HomeProjectsView
      language={props.projects.copy.language}
      servers={props.projects.server.list}
      projects={props.projects.project.list}
      recentlyClosed={props.projects.project.recentlyClosed}
      selection={props.projects.selection.value}
      homedir={props.projects.project.homedir}
      serverHealth={props.projects.server.health}
      projectsForServer={props.projects.server.projects}
      collapsed={props.projects.server.collapsed}
      canDefaultServer={props.projects.server.canDefault}
      defaultServerKey={props.projects.server.defaultKey}
      canRevealProject={props.projects.project.canReveal}
      unseenCount={props.projects.project.unseenCount}
      archiveSelected={props.archiveSelected}
      archiveCount={props.archiveCount}
      onWheel={props.scroll.viewport.containWheel}
      onChooseProject={(server) => {
        props.onOpenSessions()
        props.projects.project.choose(server)
      }}
      onFocusServer={(server) => {
        props.onOpenSessions()
        props.projects.server.focus(server)
      }}
      onToggleCollapsed={props.projects.server.toggleCollapsed}
      onEditServer={props.projects.server.edit}
      onSetDefaultServer={props.projects.server.setDefault}
      onRemoveServer={props.projects.server.remove}
      onMoveProject={props.projects.project.move}
      onSelectProject={(server, directory) => {
        props.onOpenSessions()
        props.projects.project.select(server, directory)
      }}
      onAddProjects={(server, directories) => {
        props.onOpenSessions()
        props.projects.project.add(server, directories)
      }}
      onOpenProjectNewSession={(server, directory) => {
        props.onOpenSessions()
        props.projects.project.openNewSession(server, directory)
      }}
      onEditProject={props.projects.project.edit}
      onRevealProject={props.projects.project.reveal}
      onClearNotifications={props.projects.project.clearNotifications}
      onCloseProject={props.projects.project.close}
      onOpenArchive={props.onOpenArchive}
      onOpenSettings={props.projects.utility.settings}
      onOpenHelp={props.projects.utility.help}
    />
  )
}

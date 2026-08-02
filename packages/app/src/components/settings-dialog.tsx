import { useParams } from "@solidjs/router"
import { onCleanup } from "solid-js"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { usePermission } from "@/context/permission"
import type { useSync } from "@/context/sync"
import { useDialog } from "@arforge-ai/ui/context/dialog"

type SettingsDialogOptions = {
  sync?: ReturnType<typeof useSync>
}

export function useSettingsDialog(defaultValue?: string, options: SettingsDialogOptions = {}) {
  const dialog = useDialog()
  const params = useParams<{ id?: string }>()
  const permission = usePermission()
  let run = 0
  let dead = false

  onCleanup(() => {
    dead = true
  })

  return () => {
    const current = ++run
    const sessionID = params.id
    void import("@/components/settings-v2").then((module) => {
      if (dead || run !== current) return
      void dialog.show(() => (
        <module.DialogSettings
          sessionID={sessionID}
          defaultValue={defaultValue}
          sync={options.sync}
          permission={permission}
        />
      ))
    })
  }
}

export function useSettingsCommand(options: SettingsDialogOptions = {}) {
  const command = useCommand()
  const language = useLanguage()
  const show = useSettingsDialog(undefined, options)

  command.register("settings", () => [
    {
      id: "settings.open",
      title: language.t("command.settings.open"),
      category: language.t("command.category.settings"),
      keybind: "mod+comma",
      onSelect: show,
    },
  ])

  return show
}

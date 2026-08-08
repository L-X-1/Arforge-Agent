import { usePermission } from "@/context/permission"
import { useSearchParams } from "@solidjs/router"
import { createSignal } from "solid-js"
import { SettingsWorkspace } from "@/components/settings-v2"

export default function SettingsPage() {
  const permission = usePermission()
  const [search] = useSearchParams<{ tab?: string }>()
  const [initial] = createSignal(search.tab)
  return (
    <div
      data-component="settings-page"
      data-arforge-material="main"
      class="relative min-h-0 flex-1 self-stretch overflow-hidden rounded-[16px]"
    >
      <SettingsWorkspace permission={permission} defaultValue={initial()} />
    </div>
  )
}

import { usePermission } from "@/context/permission"
import { useNavigate, useSearchParams } from "@solidjs/router"
import { createSignal } from "solid-js"
import { IconButtonV2 } from "@arforge-ai/ui/v2/icon-button-v2"
import { Icon as IconV2 } from "@arforge-ai/ui/v2/icon"
import { TooltipV2 } from "@arforge-ai/ui/v2/tooltip-v2"
import { useLanguage } from "@/context/language"
import { SettingsWorkspace } from "@/components/settings-v2"

export default function SettingsPage() {
  const permission = usePermission()
  const language = useLanguage()
  const navigate = useNavigate()
  const [search] = useSearchParams<{ tab?: string; sessionID?: string }>()
  const [initial] = createSignal(search.tab)
  const closeLabel = () => {
    const locale = language.locale()
    if (locale === "zh") return "关闭设置"
    if (locale === "zht") return "關閉設定"
    return "Close settings"
  }
  return (
    <div
      data-component="settings-page"
      data-arforge-material="main"
      class="relative min-h-0 flex-1 self-stretch overflow-hidden rounded-[16px]"
    >
      <div class="pointer-events-none absolute inset-x-0 top-0 z-20 flex h-11 items-center justify-end">
        <TooltipV2 placement="bottom" value={closeLabel()}>
          <IconButtonV2
            type="button"
            variant="ghost-muted"
            size="large"
            class="pointer-events-auto mr-2 shrink-0"
            icon={<IconV2 name="xmark-small" />}
            onClick={() => navigate("/")}
            aria-label={closeLabel()}
          />
        </TooltipV2>
      </div>
      <SettingsWorkspace permission={permission} sessionID={search.sessionID} defaultValue={initial()} />
    </div>
  )
}

import { Show } from "solid-js"
import { ButtonV2 } from "@arforge-ai/ui/v2/button-v2"
import { useSettings } from "@/context/settings"
import { useLanguage } from "@/context/language"
import { useTheme } from "@arforge-ai/ui/theme/context"

export function SettingsPersistenceStatus() {
  const settings = useSettings()
  const language = useLanguage()
  const theme = useTheme()
  const failed = () => !!settings.persistence?.failed() || !!theme.persistence?.failed() || !!language.persistence?.failed()
  const retrying = () => !!settings.persistence?.retrying() || !!theme.persistence?.retrying() || !!language.persistence?.retrying()
  const retry = () => Promise.all([settings.persistence, theme.persistence, language.persistence].flatMap((item) => item?.failed() ? [item.retry()] : []))
  const copy = () => language.locale().startsWith("zh")
    ? { message: "这些设置修改尚未保存。当前窗口保留你的修改，恢复存储后可以重试保存。", retry: "重试保存" }
    : { message: "These settings changes are not saved. Your edits remain in this window; retry when storage is available.", retry: "Retry save" }
  return <Show when={failed()}>
    <div class="arforge-management-status" data-state="error" role="alert">
      <p>{copy().message}</p>
      <ButtonV2 variant="ghost" disabled={retrying()} onClick={() => void retry()}>{copy().retry}</ButtonV2>
    </div>
  </Show>
}

import { createMemo, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { DropdownMenu } from "@arforge-ai/ui/dropdown-menu"
import { Icon } from "@arforge-ai/ui/icon"
import { useSDK } from "@/context/sdk"
import { useLanguage } from "@/context/language"
import { useOpenInApp } from "@/components/session/open-in-app"
import type { PreviewBytes } from "./document-preview-model"
import { previewDownloadBytes, previewDownloadName, previewLocalPath } from "./preview-export"

export function FilePreviewActions(props: { path: string; content?: PreviewBytes; disabled?: boolean }) {
  const sdk = useSDK()
  const language = useLanguage()
  const t = (zh: string, en: string) => (language.locale().startsWith("zh") ? zh : en)
  const nativePath = createMemo(() => previewLocalPath(sdk().directory, props.path))
  const external = useOpenInApp({ directory: () => nativePath() ?? "" })
  const [state, setState] = createStore({ error: "" })
  const urls = new Set<string>()
  onCleanup(() => urls.forEach((url) => URL.revokeObjectURL(url)))
  const download = () => {
    if (!props.content || props.disabled) return
    setState("error", "")
    try {
      const bytes = previewDownloadBytes(props.content)
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }))
      urls.add(url)
      const link = document.createElement("a")
      link.href = url
      link.download = previewDownloadName(props.path)
      link.click()
      setTimeout(() => {
        URL.revokeObjectURL(url)
        urls.delete(url)
      }, 1000)
    } catch (error) {
      setState("error", error instanceof Error ? error.message : String(error))
    }
  }
  return (
    <div data-slot="workbench-file-actions">
      <button
        type="button"
        disabled={props.disabled || !props.content}
        onClick={download}
        aria-label={t("下载当前文件快照", "Download file snapshot")}
        title={t("下载当前文件快照", "Download file snapshot")}
      >
        <Icon name="download" size="small" />
        {t("下载", "Download")}
      </button>
      <Show when={external.canOpen() && nativePath()}>
        <DropdownMenu gutter={4} placement="bottom-end">
          <DropdownMenu.Trigger
            as="button"
            type="button"
            data-workbench-file-more=""
            aria-label={t("更多文件操作", "More file actions")}
            disabled={props.disabled}
          >
            <Icon name="dot-grid" size="small" />
            <span>{t("更多", "More")}</span>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content data-workbench-file-menu="">
              <DropdownMenu.Item
                disabled={props.disabled || external.opening()}
                onSelect={() => external.openDir("finder")}
              >
                <DropdownMenu.ItemLabel>
                  {external.opening() ? t("正在打开…", "Opening...") : t("在外部应用打开", "Open externally")}
                </DropdownMenu.ItemLabel>
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu>
      </Show>
      <Show when={state.error}>
        <p role="alert">{state.error}</p>
      </Show>
    </div>
  )
}

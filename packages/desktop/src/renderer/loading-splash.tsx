import { Spinner } from "@arforge-ai/ui/spinner"
import { t } from "./i18n"

export function LoadingSplash() {
  return (
    <main
      class="h-dvh w-screen bg-background-base flex items-center justify-center"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <div class="flex flex-col items-center gap-4 px-6 text-center">
        <span class="text-24-medium text-text-strong">Arforge</span>
        <div class="flex items-center gap-2 text-13-regular text-text-weak">
          <Spinner class="size-4" />
          <span>{t("common.loading")}</span>
        </div>
      </div>
    </main>
  )
}

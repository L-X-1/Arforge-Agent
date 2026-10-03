import { useBeforeLeave, useLocation } from "@solidjs/router"
import { useLanguage } from "@/context/language"
import { textDocumentCloseGuard } from "./text-document-close-guard"

export function useTextDocumentNavigationGuard() {
  const location = useLocation()
  const language = useLanguage()
  useBeforeLeave((event) => {
    if (event.defaultPrevented) return
    if (typeof event.to === "string") {
      const target = new URL(event.to, window.location.href)
      // In-page anchors and identical routes do not leave the editing context.
      if (target.pathname === location.pathname && target.search === location.search) return
    }
    if (!textDocumentCloseGuard.confirm(undefined, language.locale().startsWith("zh"), true)) {
      event.preventDefault()
    }
  })
}

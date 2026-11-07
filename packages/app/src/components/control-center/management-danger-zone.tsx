import { managementErrorText } from "@/components/settings-v2/management-state"
import { type JSX } from "solid-js"
import { useLanguage } from "@/context/language"
import "./control-center.css"

/** Presents only the same public object/source already shown by its owner. */
export function ManagementDangerZone(props: { scope: string; children: JSX.Element }) {
  const language = useLanguage()
  const copy = () => language.locale().startsWith("zh")
    ? { title: "高影响操作", scope: "作用范围" }
    : { title: "High-impact actions", scope: "Applies to" }
  return (
    <footer class="arforge-management-danger-zone" aria-label={copy().title}>
      <p class="arforge-management-danger-scope"><strong>{copy().title}</strong><span>{copy().scope}: {managementErrorText(props.scope, "").replaceAll("\u0000", " · ")}</span></p>
      <div class="arforge-management-danger-actions">{props.children}</div>
    </footer>
  )
}

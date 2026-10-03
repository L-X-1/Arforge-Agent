import { createMemo, createResource, Show } from "solid-js"
import { useMarked } from "@arforge-ai/ui/context/marked"
import { sanitizeMarkdown } from "@arforge-ai/session-ui/markdown-cache"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { markdownPreviewLink, MARKDOWN_PREVIEW_MAX_CHARACTERS } from "./markdown-preview-model"

const blockedTags = new Set(["FORM", "INPUT", "BUTTON", "TEXTAREA", "SELECT", "OPTION", "AUDIO", "VIDEO", "SOURCE", "TRACK", "IFRAME", "OBJECT", "EMBED", "LINK", "META", "BASE"])
const resourceAttributes = new Set(["src", "srcset", "poster", "background", "ping", "action", "formaction", "xlink:href", "download"])
const safeColor = /^(?:var\(--[\w-]+\)|#[\da-f]{3,8}|[a-z]+)$/i

function documentMarkup(html: string, imageLabel: string) {
  // Template contents stay inert until every resource URL and active control
  // has been removed. Never insert the parser's unsanitized output into the UI.
  const template = document.createElement("template")
  template.innerHTML = sanitizeMarkdown(html)
  let images = 0
  for (const node of Array.from(template.content.querySelectorAll<HTMLElement>("*"))) {
    if (blockedTags.has(node.tagName)) {
      node.remove()
      continue
    }
    if (node.tagName === "IMG") {
      const placeholder = document.createElement("span")
      placeholder.textContent = `[${imageLabel}: ${node.getAttribute("alt") || node.getAttribute("src") || "image"}]`
      node.replaceWith(placeholder)
      images++
      continue
    }
    const color = node.style?.getPropertyValue("color") ?? ""
    node.removeAttribute("style")
    if (safeColor.test(color)) node.style.setProperty("color", color)
    for (const attribute of Array.from(node.attributes)) {
      if (resourceAttributes.has(attribute.name) || attribute.name.startsWith("data-") || attribute.name.startsWith("on")) {
        node.removeAttribute(attribute.name)
      }
    }
    if (node.tagName === "A") {
      const href = markdownPreviewLink(node.getAttribute("href") ?? "")
      if (href) {
        node.setAttribute("href", href)
        node.setAttribute("target", "_blank")
        node.setAttribute("rel", "noopener noreferrer")
      } else {
        node.removeAttribute("href")
        node.removeAttribute("target")
      }
    } else {
      node.removeAttribute("href")
    }
  }
  return { html: template.innerHTML, images }
}

export function MarkdownPreview(props: { text: string }) {
  const marked = useMarked()
  const language = useLanguage()
  const platform = usePlatform()
  const labels = createMemo(() => language.locale().startsWith("zh") ? {
    image: "\u56fe\u7247",
    images: "\u56fe\u7247\u6682\u4ee5\u5360\u4f4d\u7b26\u663e\u793a\uff0c\u4e0d\u4f1a\u81ea\u52a8\u8bbf\u95ee\u672c\u5730\u6216\u8fdc\u7a0b\u8d44\u6e90\u3002",
    large: "\u6587\u4ef6\u8d85\u8fc7\u9996\u7248\u9884\u89c8\u7684 500,000 \u5b57\u7b26\u9650\u5236\uff0c\u8bf7\u5207\u6362\u5230\u6e90\u7801\u67e5\u770b\u3002",
    empty: "\u6587\u6863\u4e3a\u7a7a\u3002",
  } : {
    image: "Image", images: "Images are shown as placeholders. Local and remote resources are not loaded automatically.",
    large: "This document exceeds the initial 500,000-character preview limit. Use Source to view it.", empty: "This document is empty.",
  })
  const oversized = () => props.text.length > MARKDOWN_PREVIEW_MAX_CHARACTERS
  const [content] = createResource(
    () => !oversized() && { text: props.text, imageLabel: labels().image },
    async (input) => documentMarkup(await marked.parse(input.text), input.imageLabel),
  )

  return (
    <div data-component="markdown-file-preview" aria-busy={content.loading} class="px-6 py-4">
      <Show when={!oversized()} fallback={<p role="status" class="text-text-weak">{labels().large}</p>}>
        <Show when={!content.loading} fallback={<p role="status" class="text-text-weak">{language.t("common.loading")}...</p>}>
          <Show when={props.text} fallback={<p class="text-text-weak">{labels().empty}</p>}>
            <Show when={(content()?.images ?? 0) > 0}>
              <p role="note" class="mb-4 text-12 text-text-weak">{labels().images}</p>
            </Show>
            <div
              data-component="markdown"
              class="min-w-0 break-words select-text"
              innerHTML={content()?.html ?? ""}
              onClick={(event) => {
                const link = event.target instanceof Element ? event.target.closest("a") : null
                if (!link) return
                event.preventDefault()
                event.stopPropagation()
                const href = markdownPreviewLink(link.getAttribute("href") ?? "")
                if (href) platform.openLink(href)
              }}
            />
          </Show>
        </Show>
      </Show>
    </div>
  )
}

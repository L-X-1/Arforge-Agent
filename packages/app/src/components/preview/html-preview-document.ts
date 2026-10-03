import createDOMPurify from "dompurify"
import { PreviewResource } from "@arforge-ai/schema/preview-resource"
import { escapePreviewText, HTML_PREVIEW_CSP, htmlPreviewFits, isEmbeddedRasterImage } from "./html-preview-policy"

const blockedElements = new Set([
  "SCRIPT", "IFRAME", "FRAME", "FRAMESET", "OBJECT", "EMBED", "LINK", "META", "BASE",
  "TEMPLATE", "NOSCRIPT", "SVG", "MATH", "PORTAL", "AUDIO", "VIDEO", "SOURCE", "TRACK",
])
const resourceAttributes = new Set([
  "href", "xlink:href", "srcset", "poster", "background", "ping", "action", "formaction",
  "srcdoc", "download", "target", "manifest", "autofocus", "is",
])
const tags = [
  "a", "abbr", "address", "article", "aside", "b", "bdi", "bdo", "blockquote", "br", "button",
  "caption", "cite", "code", "col", "colgroup", "data", "dd", "del", "details", "dfn", "div", "dl", "dt",
  "em", "fieldset", "figcaption", "figure", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup",
  "hr", "i", "img", "input", "ins", "kbd", "label", "legend", "li", "main", "mark", "menu", "meter", "nav",
  "ol", "optgroup", "option", "output", "p", "pre", "progress", "q", "rp", "rt", "ruby", "s", "samp",
  "section", "select", "small", "span", "strong", "style", "sub", "summary", "sup", "table", "tbody",
  "td", "textarea", "tfoot", "th", "thead", "time", "tr", "u", "ul", "var", "wbr",
]
const attributes = [
  "id", "class", "style", "title", "lang", "dir", "role", "alt", "src", "width", "height", "hidden",
  "tabindex", "type", "value", "placeholder", "disabled", "readonly", "checked", "selected", "multiple",
  "min", "max", "step", "low", "high", "optimum", "rows", "cols", "colspan", "rowspan", "scope",
  "open", "start", "reversed", "for", "datetime", "span", "label", "wrap",
]

// A private instance keeps HTML-preview policy separate from Markdown rendering.
let purifier: ReturnType<typeof createDOMPurify> | undefined

export function buildHtmlPreview(source: string, title: string, resourceBase?: string): string {
  if (!htmlPreviewFits(source)) throw new Error("HTML preview is limited to 500,000 characters. Source editing remains available.")
  const base = resourceBase ? PreviewResource.safeBaseURL(resourceBase) : undefined
  if (resourceBase && !base) throw new Error("Invalid local resource grant.")
  const template = document.createElement("template")
  // Fragment parsing is inert: never attach this untrusted tree to the host DOM.
  // Document-wrapper attributes are intentionally not imported in this first adapter.
  template.innerHTML = source
  for (const node of Array.from(template.content.querySelectorAll("*"))) {
    const href = node.getAttribute("href") ?? ""
    const stylesheet = base && node.tagName === "LINK" && node.getAttribute("rel")?.toLowerCase() === "stylesheet"
      ? PreviewResource.resourceURL(href, base) : undefined
    const safeStylesheet = stylesheet && new URL(stylesheet).pathname.toLowerCase().endsWith(".css") ? stylesheet : undefined
    const src = node.getAttribute("src") ?? ""
    const image = node.tagName === "IMG"
      ? isEmbeddedRasterImage(src) ? src : base ? PreviewResource.resourceURL(src, base) : undefined
      : undefined
    if (blockedElements.has(node.tagName) && !safeStylesheet) {
      node.remove()
      continue
    }
    for (const attribute of Array.from(node.attributes)) {
      const name = attribute.name.toLowerCase()
      if (
        resourceAttributes.has(name) || name.startsWith("on") ||
        name === "src"
      ) node.removeAttribute(attribute.name)
    }
    if (image) { node.setAttribute("src", image); node.setAttribute("crossorigin", "anonymous") }
    if (safeStylesheet) {
      node.setAttribute("href", safeStylesheet)
      node.setAttribute("rel", "stylesheet")
      node.setAttribute("crossorigin", "anonymous")
    }
    if (node.tagName === "BUTTON") node.setAttribute("type", "button")
    if (node.tagName === "INPUT" && /^(?:file|image|submit)$/i.test(node.getAttribute("type") ?? ""))
      node.setAttribute("type", "text")
  }
  purifier ??= createDOMPurify(window)
  // This is the final untrusted-markup transformation before the sandbox sink.
  const clean = purifier.sanitize(template.content, {
    ALLOWED_TAGS: base ? [...tags, "link"] : tags,
    ALLOWED_ATTR: base ? [...attributes, "href", "rel", "crossorigin"] : attributes,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: true,
    FORCE_BODY: true,
    RETURN_TRUSTED_TYPE: false,
  })
  const csp = base ? HTML_PREVIEW_CSP
    .replace("style-src 'unsafe-inline'", `style-src 'unsafe-inline' ${base}`)
    .replace("img-src data:", `img-src data: ${base}`)
    .replace("base-uri 'none'", `base-uri ${base}`) : HTML_PREVIEW_CSP
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}">${base ? `<base href="${escapePreviewText(base)}">` : ""}<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escapePreviewText(title)}</title><style>html{color-scheme:light}body{margin:16px;color:#202020;background:#fff;font-family:sans-serif}img{max-width:100%}*{box-sizing:border-box}</style></head><body>${clean}</body></html>`
}

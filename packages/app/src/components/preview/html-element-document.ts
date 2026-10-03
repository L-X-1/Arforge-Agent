import { defaultTreeAdapter, html, parse, serialize, type DefaultTreeAdapterMap } from "parse5"
import { buildHtmlPreview } from "./html-preview-document"
import { HTML_ELEMENT_ATTRIBUTE, mapHtmlElements, visitHtmlElements, type HtmlSourceElement } from "./html-element-model"

// This string is application code, never source document code. The only
// interpolated configuration is validated random IDs and a content digest.
const bridge = String.raw`
const attribute = "data-arforge-source";
const nodes = Array.from(document.querySelectorAll("[" + attribute + "]"));
const byID = new Map(nodes.map(node => [node.getAttribute(attribute), node]));
let selected;
let hovered;
let scheduled = 0;
const host = document.createElement("div");
host.setAttribute("data-arforge-overlay", "");
host.setAttribute("aria-hidden", "true");
for (const [name, value] of Object.entries({all:"initial",position:"fixed",inset:"0",zIndex:"2147483647",pointerEvents:"none"})) {
  const property = name.replace(/[A-Z]/g, letter => "-" + letter.toLowerCase());
  host.style.setProperty(property, value, "important");
}
const shadow = host.attachShadow({mode:"closed"});
const box = document.createElement("div");
box.style.cssText = "position:absolute;display:none;box-sizing:border-box;border:2px solid #2d92c8;border-radius:3px;pointer-events:none;background:rgba(45,146,200,.08)";
const label = document.createElement("div");
label.style.cssText = "position:absolute;left:0;top:0;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:12px/20px monospace;color:#fff;background:#145571;padding:0 5px";
box.append(label);
shadow.append(box);
document.documentElement.append(host);
function emit(kind, id) {
  parent.postMessage({type:"arforge.html-element",frameID:config.frameID,revision:config.revision,kind,id}, "*");
}
function draw() {
  scheduled = 0;
  const target = hovered || selected;
  if (!target || !target.isConnected) { box.style.display = "none"; return; }
  const rect = target.getBoundingClientRect();
  if (!Number.isFinite(rect.x) || !Number.isFinite(rect.y)) return;
  box.style.display = "block";
  box.style.left = rect.x + "px";
  box.style.top = rect.y + "px";
  box.style.width = rect.width + "px";
  box.style.height = rect.height + "px";
  label.textContent = target.tagName.toLowerCase() + (target.id ? "#" + target.id.slice(0,64) : "");
}
function schedule() { if (!scheduled) scheduled = requestAnimationFrame(draw); }
function choose(node, scroll) {
  if (!node || !byID.has(node.getAttribute(attribute))) return;
  selected = node;
  hovered = undefined;
  if (scroll) node.scrollIntoView({block:"nearest",inline:"nearest"});
  schedule();
  emit("select", node.getAttribute(attribute));
}
document.addEventListener("pointermove", event => {
  hovered = event.target instanceof Element ? event.target.closest("[" + attribute + "]") : undefined;
  schedule();
}, true);
document.addEventListener("pointerleave", () => { hovered = undefined; schedule(); }, true);
document.addEventListener("click", event => {
  event.preventDefault();
  event.stopImmediatePropagation();
  if (event.target instanceof Element) choose(event.target.closest("[" + attribute + "]"), false);
}, true);
document.addEventListener("submit", event => { event.preventDefault(); event.stopImmediatePropagation(); }, true);
document.addEventListener("keydown", event => {
  if (event.key === "Escape") { event.preventDefault(); emit("cancel"); return; }
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const current = nodes.indexOf(selected);
    const index = current < 0 ? 0 : Math.max(0, Math.min(nodes.length - 1, current + (event.key === "ArrowDown" ? 1 : -1)));
    choose(nodes[index], true);
  } else if (event.key === "Enter" && (hovered || selected)) {
    event.preventDefault(); choose(hovered || selected, false);
  }
}, true);
addEventListener("message", event => {
  const data = event.data;
  if (event.source !== parent || !data || typeof data !== "object" || data.type !== "arforge.html-element-focus" || data.frameID !== config.frameID || data.revision !== config.revision || typeof data.id !== "string") return;
  choose(byID.get(data.id), true);
});
addEventListener("scroll", schedule, true);
addEventListener("resize", schedule);
emit("ready");
`

export function buildHtmlElementDocument(input: {
  source: string; path: string; resourceBase?: string; frameID: string; revision: string; nonce: string; marker: string
}) {
  if (!/^[a-f0-9-]{36}$/.test(input.frameID) || !/^[a-f0-9]{64}$/.test(input.revision) || !/^[a-f0-9]{32}$/.test(input.nonce)) throw new Error("Invalid HTML selection session.")
  const mapped = mapHtmlElements(input.source, input.marker)
  // The existing safe renderer remains the single owner of HTML/resource
  // sanitization. A temporary plain-text title transports source identities
  // through that boundary; user titles are restored as text attributes only.
  const document = parse(buildHtmlPreview(mapped.markup, input.path, input.resourceBase))
  const indexed = new Map(mapped.elements.map((element) => [mapped.markerPrefix + element.id, element]))
  const found: { node: DefaultTreeAdapterMap["element"]; element: HtmlSourceElement }[] = []
  let policy: DefaultTreeAdapterMap["element"] | undefined
  let body: DefaultTreeAdapterMap["element"] | undefined
  visitHtmlElements(document, (node) => {
    node.attrs = node.attrs.filter((attribute) => !attribute.name.startsWith("data-arforge-"))
    if (node.tagName === "body") body = node
    if (node.tagName === "meta" && node.attrs.some((attribute) => attribute.name === "http-equiv" && attribute.value.toLowerCase() === "content-security-policy")) policy = node
    const title = node.attrs.find((attribute) => attribute.name === "title")
    const element = title && indexed.get(title.value)
    if (!element || element.tag !== node.tagName) return
    node.attrs = node.attrs.filter((attribute) => attribute.name !== "title")
    if (element.originalTitle !== undefined) node.attrs.push({ name: "title", value: element.originalTitle })
    found.push({ node, element })
  })
  if (!policy || !body) throw new Error("The safe HTML document shell is unavailable.")
  const content = policy.attrs.find((attribute) => attribute.name === "content")
  if (!content || !content.value.includes("script-src 'none'")) throw new Error("The safe HTML script policy is unavailable.")
  content.value = content.value.replace("script-src 'none'", `script-src 'nonce-${input.nonce}'`) + "; script-src-attr 'none'"
  const counts = new Map<string, number>()
  for (const item of found) counts.set(item.element.id, (counts.get(item.element.id) ?? 0) + 1)
  const elements: HtmlSourceElement[] = []
  for (const { node, element } of found) {
    if (counts.get(element.id) !== 1) continue
    node.attrs.push({ name: HTML_ELEMENT_ATTRIBUTE, value: element.id })
    elements.push(element)
  }
  const script = defaultTreeAdapter.createElement("script", html.NS.HTML, [{ name: "nonce", value: input.nonce }])
  defaultTreeAdapter.insertText(script, `(() => { const config = ${JSON.stringify({ frameID: input.frameID, revision: input.revision })};\n${bridge}\n})();`)
  defaultTreeAdapter.appendChild(body, script)
  return { document: serialize(document), elements, limited: mapped.limited }
}

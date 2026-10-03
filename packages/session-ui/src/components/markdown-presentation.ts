/** Size the native marker column without rewriting numbering or list semantics. */
export function decorateMarkdownLists(root: ParentNode) {
  for (const list of root.querySelectorAll<HTMLOListElement>("ol")) {
    const items = Array.from(list.children).filter((item): item is HTMLLIElement => item.tagName === "LI")
    const step = list.reversed ? -1 : 1
    let value = list.hasAttribute("start") ? list.start : list.reversed ? items.length : 1
    let digits = 1
    for (const item of items) {
      if (item.hasAttribute("value")) value = item.value
      digits = Math.max(digits, String(value).length)
      value += step
    }
    list.style.setProperty("--arforge-list-marker-width", `max(24px, ${digits + 1}ch)`)
  }
}

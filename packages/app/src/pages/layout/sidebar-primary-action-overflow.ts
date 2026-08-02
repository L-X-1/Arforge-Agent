type LabelMetrics = Pick<HTMLElement, "clientWidth" | "scrollWidth">

export function sidebarPrimaryActionLabelIsTruncated(label: LabelMetrics | null | undefined) {
  return !!label && label.scrollWidth > label.clientWidth
}

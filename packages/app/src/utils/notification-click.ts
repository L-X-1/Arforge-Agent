let nav: ((href: string) => void) | undefined
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/
const MAX_NOTIFICATION_HREF_LENGTH = 2_048

export const setNavigate = (fn: ((href: string) => void) | undefined) => {
  nav = fn
}

/** Notifications may only re-enter an internal renderer route. */
export const safeNotificationHref = (href: unknown) => {
  if (typeof href !== "string" || href.length === 0 || href.length > MAX_NOTIFICATION_HREF_LENGTH) return
  if (!href.startsWith("/") || href.startsWith("//") || href.includes("\\") || CONTROL_CHARACTERS.test(href)) return
  return href
}

export const handleNotificationClick = (href?: string) => {
  window.focus()
  const safeHref = safeNotificationHref(href)
  if (!safeHref) return false
  if (nav) {
    nav(safeHref)
    return true
  }
  console.warn("notification-click: navigate function not set, falling back to window.location.assign")
  window.location.assign(safeHref)
  return true
}

/** Wait for the virtualized message, not just a changed route/hash. */
export function waitForHistoryTarget(
  target: () => HTMLElement | null,
  viewport: () => HTMLElement | undefined,
  current: () => boolean,
  timeout = 1500,
): Promise<boolean> {
  const started = performance.now()
  return new Promise((resolve) => {
    const check = () => {
      if (!current()) return resolve(false)
      const element = target()
      const scroller = viewport()
      if (element?.isConnected && scroller?.isConnected) {
        const bounds = element.getBoundingClientRect()
        const visible = scroller.getBoundingClientRect()
        if (bounds.height > 0 && bounds.bottom > visible.top && bounds.top < visible.bottom) return resolve(true)
      }
      if (performance.now() - started >= timeout) return resolve(false)
      requestAnimationFrame(check)
    }
    requestAnimationFrame(check)
  })
}

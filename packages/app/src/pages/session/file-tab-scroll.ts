type Input = {
  prevScrollWidth: number
  scrollWidth: number
  clientWidth: number
  prevContextOpen: boolean
  contextOpen: boolean
}

export const nextTabListScrollLeft = (input: Input) => {
  if (input.scrollWidth <= input.prevScrollWidth) return
  if (!input.prevContextOpen && input.contextOpen) return 0
  if (input.scrollWidth <= input.clientWidth) return
  return input.scrollWidth - input.clientWidth
}

export const createFileTabListSync = (input: { el: HTMLDivElement; contextOpen: () => boolean }) => {
  let frame: number | undefined
  let prevScrollWidth = input.el.scrollWidth
  let prevContextOpen = input.contextOpen()

  const update = () => {
    const scrollWidth = input.el.scrollWidth
    const clientWidth = input.el.clientWidth
    const contextOpen = input.contextOpen()
    const left = nextTabListScrollLeft({
      prevScrollWidth,
      scrollWidth,
      clientWidth,
      prevContextOpen,
      contextOpen,
    })

    if (left !== undefined) {
      input.el.scrollTo({
        left,
        behavior: "smooth",
      })
    }

    if (left === undefined) {
      const active = input.el.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
      if (active) {
        const viewport = input.el.getBoundingClientRect()
        const rect = active.getBoundingClientRect()
        if (rect.left < viewport.left) input.el.scrollLeft += rect.left - viewport.left
        else if (rect.right > viewport.right) input.el.scrollLeft += rect.right - viewport.right
      }
    }

    prevScrollWidth = scrollWidth
    prevContextOpen = contextOpen
  }

  const schedule = () => {
    if (frame !== undefined) cancelAnimationFrame(frame)
    frame = requestAnimationFrame(() => {
      frame = undefined
      update()
    })
  }

  const onWheel = (e: WheelEvent) => {
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return
    input.el.scrollLeft += e.deltaY > 0 ? 50 : -50
    e.preventDefault()
  }

  input.el.addEventListener("wheel", onWheel, { passive: false })
  const observer = new MutationObserver((records) => {
    // Dirty indicators change nested children, not the actual set of tabs.
    if (records.some((record) => record.type === "attributes" || record.target === input.el)) schedule()
  })
  observer.observe(input.el, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-selected"] })
  const resize = new ResizeObserver(schedule)
  resize.observe(input.el)

  return () => {
    input.el.removeEventListener("wheel", onWheel)
    observer.disconnect()
    resize.disconnect()
    if (frame !== undefined) cancelAnimationFrame(frame)
  }
}

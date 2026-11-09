import { createEffect, For, on, onCleanup, onMount } from "solid-js"
import { paintStrengthNetwork } from "./model-strength-network"
import "./model-strength-dial.css"

const center = 150
const radius = 114.55
const startAngle = (3 * Math.PI) / 4
const sweep = (3 * Math.PI) / 2
const turn = 2 * Math.PI
const morphDuration = 720

type DialCapture = {
  preview: (index: number) => void
  commit: (index: number) => void
  cancel: () => void
}

export function ModelStrengthDial(props: {
  stops: readonly { key: string; label: string }[]
  selection: number
  hasOff: boolean
  disabled: boolean
  paused: boolean
  reducedMotion: boolean
  begin: (index: number) => DialCapture | undefined
}) {
  let ring!: SVGSVGElement
  let canvas!: HTMLCanvasElement
  let targetX = 0
  let targetY = 0
  let gesture:
    | { pointer: number; x: number; y: number; index: number; moved: boolean; capture: DialCapture }
    | undefined
  onCleanup(() => gesture?.capture.cancel())
  const angleAt = (index: number) => startAngle + (index / (props.stops.length - 1)) * sweep
  const targetLevel = () => {
    const index = props.selection
    if (index < 0 || (props.hasOff && index === 0)) return 0
    if (index === props.stops.length - 1) return 3
    const first = props.hasOff ? 1 : 0
    return 1 + (2 * (index - first)) / (props.stops.length - 1 - first)
  }

  onMount(() => {
    const ctx = canvas.getContext?.("2d")
    if (!ctx) return
    const forced = window.matchMedia("(forced-colors: active)")
    const root = document.documentElement
    let inView = typeof IntersectionObserver === "undefined"
    let frame: number | undefined
    let lastFrame = 0
    let time = 0
    let spin = 0
    let tiltX = 0
    let tiltY = 0
    let selected = targetLevel()
    let shown = selected
    let from = selected
    let morphElapsed = morphDuration
    const visible = () =>
      inView && canvas.isConnected && canvas.width > 0 && canvas.height > 0 && !document.hidden && !forced.matches
    const moving = () => !props.paused && !props.reducedMotion
    const shouldAnimate = () => moving() && (selected > 0 || morphElapsed < morphDuration)
    const paint = () => {
      const fraction = morphElapsed / morphDuration
      shown = fraction === 1 ? selected : from + (selected - from) * (1 - (1 - fraction) ** 3)
      paintStrengthNetwork(ctx, {
        level: shown,
        time,
        tiltX: props.reducedMotion ? 0 : tiltX,
        tiltY: props.reducedMotion ? 0 : tiltY,
        dark: root.dataset.colorScheme === "dark",
        wave: selected === 3 ? fraction : 1,
        spin,
      })
    }
    const animate = (now: number) => {
      frame = undefined
      if (!visible() || !shouldAnimate()) return
      const delta = now - lastFrame
      if (delta >= 24 || (selected === 0 && morphElapsed + delta >= morphDuration)) {
        const elapsed = Math.min(delta, 40) / 1000
        time += elapsed
        spin += elapsed * 0.54 * Math.max(0, shown - 2)
        tiltX += (targetX - tiltX) * 0.09
        tiltY += (targetY - tiltY) * 0.09
        morphElapsed = Math.min(morphDuration, morphElapsed + delta)
        lastFrame = now
        paint()
      }
      if (shouldAnimate()) frame = requestAnimationFrame(animate)
    }
    const stop = () => {
      if (frame !== undefined) cancelAnimationFrame(frame)
      frame = undefined
    }
    const sync = () => {
      stop()
      if (!visible()) return
      lastFrame = performance.now()
      paint()
      if (shouldAnimate()) frame = requestAnimationFrame(animate)
    }
    const resize = () => {
      const { width, height } = canvas.getBoundingClientRect()
      const ratio = Math.min(window.devicePixelRatio || 1, 2)
      const pixelsWide = Math.round(width * ratio)
      const pixelsHigh = Math.round(height * ratio)
      if (canvas.width === pixelsWide && canvas.height === pixelsHigh) return
      canvas.width = pixelsWide
      canvas.height = pixelsHigh
      sync()
    }
    const visibility =
      typeof IntersectionObserver === "undefined"
        ? undefined
        : new IntersectionObserver(
            ([entry]) => {
              inView = entry.isIntersecting && entry.intersectionRatio >= 0.1
              sync()
            },
            { threshold: 0.1 },
          )
    const dimensions = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(resize)
    const theme = new MutationObserver(sync)
    visibility?.observe(canvas)
    dimensions?.observe(canvas)
    theme.observe(root, { attributes: true, attributeFilter: ["data-color-scheme"] })
    document.addEventListener("visibilitychange", sync)
    forced.addEventListener("change", sync)
    resize()
    createEffect(
      on(targetLevel, (level) => {
        if (level === selected) return
        from = shown
        selected = level
        morphElapsed = visible() && moving() ? 0 : morphDuration
        sync()
      }),
    )
    createEffect(
      on([() => props.paused, () => props.reducedMotion], ([, reduced]) => {
        if (reduced) morphElapsed = morphDuration
        sync()
      }),
    )
    onCleanup(() => {
      stop()
      visibility?.disconnect()
      dimensions?.disconnect()
      theme.disconnect()
      document.removeEventListener("visibilitychange", sync)
      forced.removeEventListener("change", sync)
    })
  })

  const point = (event: PointerEvent) => {
    const box = ring.getBoundingClientRect()
    return {
      x: ((event.clientX - box.left) / box.width) * 300 - center,
      y: ((event.clientY - box.top) / box.height) * 300 - center,
    }
  }
  const nearest = ({ x, y }: { x: number; y: number }) => {
    const angle = (Math.atan2(y, x) - startAngle + turn) % turn
    const distance = angle <= sweep ? angle : angle > (sweep + turn) / 2 ? 0 : sweep
    return Math.round((distance / sweep) * (props.stops.length - 1))
  }
  const pointerdown = (event: PointerEvent & { currentTarget: HTMLDivElement }) => {
    if (props.disabled || event.button !== 0 || gesture) return
    const stop = (event.target as Element).closest<HTMLElement>("[data-index]")
    const ringHit = (event.target as Element).closest("[data-ring-hit]")
    if (!stop && !ringHit) return
    const p = point(event)
    const index = stop ? Number(stop.dataset.index) : nearest(p)
    const capture = props.begin(index)
    if (!capture) return
    gesture = { pointer: event.pointerId, ...p, index, moved: false, capture }
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const pointermove = (event: PointerEvent) => {
    const p = point(event)
    if (event.pointerType === "mouse") {
      targetX = Math.min(1, Math.max(-1, p.x / center))
      targetY = Math.min(1, Math.max(-1, p.y / center))
    }
    if (!gesture || gesture.pointer !== event.pointerId || props.disabled) return
    gesture.moved ||= Math.hypot(p.x - gesture.x, p.y - gesture.y) > 6
    if (!gesture.moved || Math.hypot(p.x, p.y) <= 60) return
    const index = nearest(p)
    if (index === gesture.index) return
    gesture.index = index
    gesture.capture.preview(index)
  }
  const end = (event: PointerEvent, commit: boolean) => {
    if (!gesture || gesture.pointer !== event.pointerId) return
    const { index, capture } = gesture
    gesture = undefined
    if (commit && !props.disabled) capture.commit(index)
    else capture.cancel()
  }

  return (
    <div
      class="arforge-strength-dial"
      data-slot="model-strength-dial"
      data-many-stops={props.stops.length > 7 ? true : undefined}
      data-motion-paused={props.paused ? true : undefined}
      aria-hidden="true"
      onPointerDown={pointerdown}
      onPointerMove={pointermove}
      onPointerUp={(event) => end(event, true)}
      onPointerCancel={(event) => end(event, false)}
      onLostPointerCapture={(event) => end(event, false)}
      onPointerLeave={() => {
        targetX = 0
        targetY = 0
      }}
    >
      <div class="arforge-strength-dial__layout">
        <div class="arforge-strength-dial__face">
          <svg ref={ring} class="arforge-strength-dial__ring" viewBox="0 0 300 300">
            <circle
              class="arforge-strength-dial__ticks"
              cx={center}
              cy={center}
              r="126"
              pathLength="100"
              stroke-dasharray=".15 2.35"
            />
            <circle class="arforge-strength-dial__track" cx={center} cy={center} r={radius} />
            <circle
              class="arforge-strength-dial__progress"
              cx={center}
              cy={center}
              r={radius}
              pathLength="100"
              transform="rotate(135 150 150)"
              opacity={props.selection > 0 ? 1 : 0}
              stroke-dasharray={`${(75 * Math.max(0, props.selection)) / (props.stops.length - 1)} 100`}
            />
            <circle class="arforge-strength-dial__hit" data-ring-hit cx={center} cy={center} r={radius} />
          </svg>
          <canvas ref={canvas} class="arforge-strength-dial__network" />
        </div>
        <div class="arforge-strength-dial__stops">
          <For each={props.stops}>
            {(stop, index) => {
              const x = () => Math.cos(angleAt(index()))
              const y = () => Math.sin(angleAt(index()))
              return (
                <span
                  class="arforge-strength-dial__stop"
                  data-slot="model-strength-stop"
                  data-index={index()}
                  data-variant-key={stop.key}
                  data-selected={props.selection === index() ? true : undefined}
                  title={stop.label}
                  style={{
                    "--stop-x": `${((center + x() * radius) / 300) * 100}%`,
                    "--stop-y": `${((center + y() * radius) / 300) * 100}%`,
                    "--stop-dx": `${x() * 23}px`,
                    "--stop-dy": `${y() * 22}px`,
                  }}
                >
                  <span class="arforge-strength-dial__label">{stop.label}</span>
                </span>
              )
            }}
          </For>
        </div>
      </div>
    </div>
  )
}

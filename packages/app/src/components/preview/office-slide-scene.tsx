import { createMemo, For, onCleanup, onMount, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import type { OfficeBlock, OfficeSlide } from "./office-document"
import "./office-slide-scene.css"

const EMU_PER_CSS_PIXEL = 9525
type SlideContent = { slide: OfficeSlide; label: string; renderBlock: (block: OfficeBlock) => JSX.Element }

export function OfficeSlidePage(props: SlideContent) {
  return (
    <div
      data-component="office-slide-page"
      role="group"
      aria-label={props.label}
      style={{
        width: `${props.slide.width / EMU_PER_CSS_PIXEL}px`,
        height: `${props.slide.height / EMU_PER_CSS_PIXEL}px`,
        background: props.slide.background,
      }}
    >
      <For each={props.slide.items}>
        {(item) => (
          <div
            data-slide-kind={item.kind}
            style={{
              left: `${item.x / EMU_PER_CSS_PIXEL}px`,
              top: `${item.y / EMU_PER_CSS_PIXEL}px`,
              width: `${item.width / EMU_PER_CSS_PIXEL}px`,
              height: `${item.height / EMU_PER_CSS_PIXEL}px`,
              transform: `rotate(${item.rotation ?? 0}deg) scale(${item.flipH ? -1 : 1}, ${item.flipV ? -1 : 1})`,
              background: item.fill,
              border: item.border ? `1px solid ${item.border}` : undefined,
              "border-radius":
                item.kind === "shape"
                  ? item.geometry === "ellipse"
                    ? "50%"
                    : item.geometry === "roundRect"
                      ? "8%"
                      : undefined
                  : undefined,
            }}
          >
            {item.kind === "text" ? (
              <For each={item.blocks}>{props.renderBlock}</For>
            ) : item.kind === "image" ? (
              <img src={item.source} alt={props.label} loading="lazy" />
            ) : null}
          </div>
        )}
      </For>
    </div>
  )
}

export function OfficeSlideThumbnail(props: SlideContent) {
  return (
    <svg
      data-slot="office-slide-thumbnail"
      aria-hidden="true"
      viewBox={`0 0 ${props.slide.width / EMU_PER_CSS_PIXEL} ${props.slide.height / EMU_PER_CSS_PIXEL}`}
    >
      <foreignObject width={props.slide.width / EMU_PER_CSS_PIXEL} height={props.slide.height / EMU_PER_CSS_PIXEL}>
        <OfficeSlidePage {...props} />
      </foreignObject>
    </svg>
  )
}

export function OfficeSlideStage(props: SlideContent & { zoom: number; fit: boolean }) {
  let root!: HTMLDivElement
  const [bounds, setBounds] = createStore({ width: 0, height: 0 })
  onMount(() => {
    const measure = () => setBounds({ width: root.clientWidth, height: root.clientHeight })
    const observer = new ResizeObserver(measure)
    observer.observe(root)
    measure()
    onCleanup(() => observer.disconnect())
  })
  const geometry = createMemo(() => {
    const width = props.slide.width / EMU_PER_CSS_PIXEL,
      height = props.slide.height / EMU_PER_CSS_PIXEL
    const fit = Math.min(bounds.width / width, bounds.height / height)
    const scale = props.fit ? (fit > 0 ? fit : 1) : props.zoom
    return { width: width * scale, height: height * scale, scale }
  })
  return (
    <div ref={root} data-slot="office-slide-stage" aria-busy={!bounds.width || !bounds.height}>
      <div
        data-slot="office-slide-sized-page"
        style={{
          width: `${geometry().width}px`,
          height: `${geometry().height}px`,
          "margin-block-start": `${props.fit ? Math.max(0, (bounds.height - geometry().height) / 2) : 0}px`,
        }}
      >
        <div style={{ transform: `scale(${geometry().scale})`, "transform-origin": "top left" }}>
          <OfficeSlidePage {...props} />
        </div>
      </div>
    </div>
  )
}

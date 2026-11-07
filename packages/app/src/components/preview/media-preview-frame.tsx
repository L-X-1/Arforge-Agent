import { createEffect, on, onCleanup, onMount, Show, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import "./media-preview-frame.css"

export function MediaPreviewFrame(props: {
  path: string
  version: string | number | undefined
  snapshot: unknown
  kind: "image" | "audio" | "video"
  mimeType?: string
  children: JSX.Element
}) {
  const language = useLanguage()
  const t = (zh: string, en: string) => (language.locale().startsWith("zh") ? zh : en)
  const [state, setState] = createStore({
    fit: true,
    width: undefined as number | undefined,
    height: undefined as number | undefined,
    duration: undefined as number | undefined,
  })
  let root!: HTMLElement
  let generation = 0
  let path = props.path
  const read = () => {
    const media = root?.querySelector("img,audio,video")
    if (!media) return
    const expected =
      media instanceof HTMLImageElement
        ? media.src
        : media instanceof HTMLMediaElement
          ? media.src || media.querySelector("source")?.src
          : undefined
    const source = media instanceof HTMLImageElement || media instanceof HTMLMediaElement ? media.currentSrc : undefined
    // A changed <source> may still expose the previous decoder until it loads.
    // Never label that previous media's metadata as the new file snapshot.
    if (expected && source && expected !== source) return
    if (media instanceof HTMLImageElement && media.complete && media.naturalWidth > 0) {
      setState({ width: media.naturalWidth, height: media.naturalHeight, duration: undefined })
    } else if (media instanceof HTMLMediaElement && media.readyState >= HTMLMediaElement.HAVE_METADATA) {
      setState({
        duration: Number.isFinite(media.duration) && media.duration >= 0 ? media.duration : undefined,
        width: media instanceof HTMLVideoElement && media.videoWidth > 0 ? media.videoWidth : undefined,
        height: media instanceof HTMLVideoElement && media.videoHeight > 0 ? media.videoHeight : undefined,
      })
    }
  }
  createEffect(
    on(
      () => [props.path, props.version, props.snapshot] as const,
      () => {
        const request = ++generation
        setState({ width: undefined, height: undefined, duration: undefined })
        if (path !== props.path) {
          path = props.path
          setState("fit", true)
        }
        queueMicrotask(() => {
          if (request === generation) read()
        })
      },
    ),
  )
  onMount(() => {
    const events = ["load", "loadedmetadata", "durationchange"]
    events.forEach((event) => root.addEventListener(event, read, true))
    read()
    onCleanup(() => {
      generation++
      events.forEach((event) => root.removeEventListener(event, read, true))
    })
  })
  const duration = () => {
    if (state.duration === undefined) return t("时长未知", "Duration unavailable")
    const seconds = Math.floor(state.duration)
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
  }
  return (
    <section ref={root} data-component="media-preview-frame" data-image-fit={state.fit ? "fit" : "original"}>
      <Show when={props.kind === "image"}>
        <div data-slot="media-preview-toolbar" role="group" aria-label={t("图像视图", "Image view")}>
          <button
            type="button"
            class="workbench-preview-button"
            disabled={!state.width}
            aria-pressed={!state.fit}
            onClick={() => setState("fit", false)}
          >
            {t("原始尺寸", "Original size")}
          </button>
          <button
            type="button"
            class="workbench-preview-button"
            disabled={!state.width}
            aria-pressed={state.fit}
            onClick={() => setState("fit", true)}
          >
            {t("适合视口", "Fit to viewport")}
          </button>
        </div>
      </Show>
      <p data-slot="media-preview-metadata" data-duration={state.duration} role="status">
        <span>{props.mimeType || props.kind}</span>
        <span>
          {state.width && state.height
            ? `${state.width} × ${state.height}`
            : props.kind === "audio"
              ? ""
              : t("尺寸未知", "Dimensions unavailable")}
        </span>
        <Show when={props.kind !== "image"}>
          <span>{duration()}</span>
        </Show>
      </p>
      <div data-slot="media-preview-viewport" data-scrollable tabIndex={0} role="region" aria-label={props.path}>
        {props.children}
      </div>
    </section>
  )
}

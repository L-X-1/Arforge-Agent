import { createEffect, createMemo, For, on, onCleanup, onMount, Show, Switch, Match } from "solid-js"
import { createStore } from "solid-js/store"
import { Icon } from "@arforge-ai/ui/icon"
import { useLanguage } from "@/context/language"
import OfficeArchiveWorker from "./office-archive.worker?worker"
import { decodePreviewBytes, type PreviewBytes } from "./document-preview-model"
import { officeFormat } from "./office-format"
import { parseOfficeDocument, officeColumn, type OfficeDocument, type OfficeBlock } from "./office-document"
import type { OfficeParts } from "./office-archive"
import "./office-preview.css"
import { PreviewLoading } from "./preview-loading"
import { OfficeSlideStage, OfficeSlideThumbnail } from "./office-slide-scene"
import { WorkbenchActionTooltip } from "./workbench-action-tooltip"

export function OfficePreview(props: {
  path: string
  sourceKey?: string
  content: PreviewBytes & { mimeType?: string }
}) {
  const language = useLanguage()
  const t = (zh: string, en: string) => (language.locale().startsWith("zh") ? zh : en)
  const [state, setState] = createStore({
    document: undefined as OfficeDocument | undefined,
    page: 0,
    loading: true,
    error: "",
    attempt: 0,
    zoom: 1,
    fitSlides: true,
  })
  const page = createMemo(() => state.document?.pages[state.page])
  const slideTitle = (item: OfficeDocument["pages"][number]) =>
    item.blocks
      .flatMap((block) => (block.kind === "paragraph" ? [block.runs.map((run) => run.text).join("")] : []))
      .find((text) => text.trim()) || item.label
  const headings = createMemo(
    () =>
      page()?.blocks.flatMap((block, index) =>
        block.kind === "paragraph" && block.heading
          ? [{ index, level: block.headingLevel ?? 1, text: block.outlineText ?? block.runs.map((run) => run.text).join("") }]
          : [],
      ) ?? [],
  )
  const info = createMemo(() => {
    const result = { paragraphs: 0, tables: 0, images: 0 }
    const count = (blocks: OfficeBlock[]) => {
      for (const block of blocks) {
        if (block.kind === "paragraph") result.paragraphs++
        else if (block.kind === "image") result.images++
        else {
          result.tables++
          for (const row of block.cellBlocks ?? []) for (const cell of row) count(cell)
        }
      }
    }
    for (const page of state.document?.pages ?? []) count(page.blocks)
    return result
  })
  const [navigation, setNavigation] = createStore({ wide: false, opened: false, touched: false, active: -1 })
  let documentLayout!: HTMLDivElement
  let viewport!: HTMLDivElement
  const headingTargets = new Map<number, HTMLParagraphElement>()
  let successfulOwner: string | undefined
  onMount(() => {
    const observer = new ResizeObserver(([entry]) => {
      const wide = entry.contentRect.width >= 720
      setNavigation("wide", wide)
      if (!navigation.touched) setNavigation("opened", wide)
    })
    observer.observe(documentLayout)
    onCleanup(() => observer.disconnect())
  })
  const goToHeading = (index: number) => {
    const target = headingTargets.get(index)
    if (!target?.isConnected || !viewport?.contains(target)) return
    viewport.scrollTop += target.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 12
    target.focus({ preventScroll: true })
    setNavigation("active", index)
  }
  const failure = (error: unknown) =>
    error instanceof Error && /limit|too-large/.test(error.message)
      ? t(
          "\u6587\u6863\u8d85\u51fa\u5b89\u5168\u9884\u89c8\u9650\u5236\uff08\u539f\u6587\u4ef6 25 MiB\uff0c\u89e3\u538b\u5185\u5bb9 32 MiB\uff09\u3002",
          "Document exceeds safe preview limits (25 MiB input, 32 MiB extracted content).",
        )
      : t(
          "\u65e0\u6cd5\u9884\u89c8\u6b64 Office \u6587\u4ef6\uff0c\u5b83\u53ef\u80fd\u5df2\u635f\u574f\u3001\u52a0\u5bc6\u3001\u542b\u5b8f\u6216\u4f7f\u7528\u4e0d\u652f\u6301\u7684\u7ed3\u6784\u3002",
          "Cannot preview this Office file. It may be damaged, encrypted, macro-enabled or use unsupported structures.",
        )
  createEffect(
    on(
      () => [props.path, props.content, props.sourceKey, state.attempt] as const,
      ([path, content, sourceKey]) => {
        let alive = true
        let worker: Worker | undefined
        let timeout: ReturnType<typeof setTimeout> | undefined
        const owner = sourceKey ? JSON.stringify([sourceKey, path]) : undefined
        const retained = !!owner && owner === successfulOwner && !!state.document
        const sheetLabel =
          retained && state.document?.format === "xlsx" ? state.document.pages[state.page]?.label : undefined
        if (!retained) {
          successfulOwner = undefined
          headingTargets.clear()
          setState({ document: undefined, page: 0, zoom: 1 })
        }
        setState({ loading: true, error: "" })
        const stop = () => {
          if (timeout) clearTimeout(timeout)
          worker?.terminate()
        }
        try {
          const format = officeFormat(path, content.mimeType)
          if (!format) throw new Error("office-unsupported-format")
          const bytes = decodePreviewBytes(content)
          worker = new OfficeArchiveWorker()
          timeout = setTimeout(() => {
            if (!alive) return
            alive = false
            stop()
            setState({
              loading: false,
              error: t(
                "\u6587\u6863\u89e3\u6790\u8d85\u65f6\uff0c\u8bf7\u4f7f\u7528\u672c\u5730 Office \u5e94\u7528\u6253\u5f00\u3002",
                "Document parsing timed out. Open it in a local Office application.",
              ),
            })
          }, 15_000)
          worker.onmessage = (event: MessageEvent<{ files?: OfficeParts; error?: string }>) => {
            if (!alive) return
            stop()
            try {
              if (event.data.error || !event.data.files) throw new Error(event.data.error || "office-invalid-archive")
              const document = parseOfficeDocument(event.data.files, format)
              const sheetIndex =
                sheetLabel === undefined ? -1 : document.pages.findIndex((page) => page.label === sheetLabel)
              headingTargets.clear()
              successfulOwner = owner
              setState({
                document,
                page: sheetIndex >= 0 ? sheetIndex : Math.min(state.page, Math.max(0, document.pages.length - 1)),
                loading: false,
              })
            } catch (error) {
              setState({ loading: false, error: failure(error) })
            }
          }
          worker.onerror = (event) => {
            event.preventDefault()
            if (!alive) return
            stop()
            setState({ loading: false, error: failure(new Error("office-worker")) })
          }
          worker.postMessage(bytes, [bytes.buffer])
        } catch (error) {
          stop()
          setState({ loading: false, error: failure(error) })
        }
        onCleanup(() => {
          alive = false
          stop()
        })
      },
    ),
  )
  createEffect(
    on(
      () => state.page,
      () => {
        if (viewport) viewport.scrollTop = 0
      },
    ),
  )
  const Block = (props: { block: OfficeBlock; index?: number }) => (
    <Switch>
      <Match when={props.block.kind === "paragraph" && props.block}>
        {(block) => {
          const value = () => block() as Extract<OfficeBlock, { kind: "paragraph" }>
          return (
            <p
              ref={(element) => {
                if (props.index !== undefined) headingTargets.set(props.index, element)
              }}
              data-office-block={props.index}
              role={value().heading ? "heading" : undefined}
              aria-level={value().heading ? (value().headingLevel ?? 1) : undefined}
              tabIndex={value().heading ? -1 : undefined}
              style={{ "text-align": value().align }}
              classList={{ "office-heading": value().heading }}
            >
              <For each={value().runs}>
                {(run) => (
                  <span
                    style={{
                      "font-weight": run.bold ? "700" : undefined,
                      "font-style": run.italic ? "italic" : undefined,
                      "font-size": run.fontSize ? `${(run.fontSize * 96) / 72}px` : undefined,
                      color: run.color,
                    }}
                  >
                    {run.text}
                  </span>
                )}
              </For>
            </p>
          )
        }}
      </Match>
      <Match when={props.block.kind === "image" && props.block}>
        {(block) => (
          <img
            src={(block() as Extract<OfficeBlock, { kind: "image" }>).source}
            alt={t("\u6587\u6863\u5185\u5d4c\u56fe\u7247", "Embedded document image")}
            loading="lazy"
          />
        )}
      </Match>
      <Match when={props.block.kind === "table" && props.block}>
        {(block) => {
          const value = () => block() as Extract<OfficeBlock, { kind: "table" }>
          const spans = createMemo(() => {
            const anchors = new Map<number, { rowSpan: number; colSpan: number }>()
            const covered = new Set<number>()
            for (const merge of value().merges ?? []) {
              const key = merge.row * value().columns + merge.column
              anchors.set(key, merge)
              for (let row = merge.row; row < merge.row + merge.rowSpan; row++)
                for (let column = merge.column; column < merge.column + merge.colSpan; column++) {
                  const cell = row * value().columns + column
                  if (cell !== key) covered.add(cell)
                }
            }
            return { anchors, covered }
          })
          return (
            <div
              class="office-table-scroll"
              data-scrollable
              tabIndex={0}
              role="region"
              aria-label={t("\u8868\u683c", "Table")}
            >
              <table style={value().sheet ? { "--office-sheet-columns": value().columns } : undefined}>
                <Show when={value().sheet}>
                  <thead>
                    <tr>
                      <th aria-label={t("\u884c", "Row")} />
                      <For each={Array.from({ length: value().columns }, (_, index) => officeColumn(index))}>
                        {(column) => <th scope="col">{column}</th>}
                      </For>
                    </tr>
                  </thead>
                </Show>
                <tbody>
                  <For each={value().rows}>
                    {(row, index) => (
                      <tr>
                        <Show when={value().sheet}>
                          <th scope="row">{index() + 1}</th>
                        </Show>
                        <For each={row}>
                          {(cell, column) => {
                            const key = () => index() * value().columns + column()
                            return (
                              <Show when={!spans().covered.has(key())}>
                                <td
                                  data-row={index()}
                                  data-column={column()}
                                  rowSpan={spans().anchors.get(key())?.rowSpan}
                                  colSpan={spans().anchors.get(key())?.colSpan}
                                >
                                  <Show when={value().cellBlocks?.[index()]?.[column()]} fallback={cell}>
                                    {(blocks) => <For each={blocks()}>{(block) => <Block block={block} />}</For>}
                                  </Show>
                                </td>
                              </Show>
                            )
                          }}
                        </For>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          )
        }}
      </Match>
    </Switch>
  )
  return (
    <section data-component="office-file-preview" data-office-format={state.document?.format} aria-busy={state.loading}>
      <details data-slot="office-preview-details">
        <summary>{t("只读内容预览 · 格式与安全说明", "Read-only content preview · Format and safety")}</summary>
        <Show when={state.document}>
          <dl data-slot="office-document-info">
            <div>
              <dt>{t("文件", "File")}</dt>
              <dd>{props.path}</dd>
            </div>
            <div>
              <dt>{t("格式", "Format")}</dt>
              <dd>{state.document?.format.toUpperCase()}</dd>
            </div>
            <Show when={state.document?.format === "docx"}>
              <div>
                <dt>{t("预览内容", "Preview content")}</dt>
                <dd>
                  {t(
                    `${headings().length} 个标题 · ${info().paragraphs} 个段落 · ${info().tables} 个表格 · ${info().images} 张图片`,
                    `${headings().length} headings · ${info().paragraphs} paragraphs · ${info().tables} table${info().tables === 1 ? "" : "s"} · ${info().images} images`,
                  )}
                </dd>
              </div>
              <div>
                <dt>{t("分页", "Pagination")}</dt>
                <dd>
                  {t(
                    "内容重新排版，不提供 Office 原生页码。",
                    "Reflowed content; native Office page numbers are unavailable.",
                  )}
                </dd>
              </div>
            </Show>
          </dl>
        </Show>
        <p class="office-notice">
          {t(
            "\u672c\u5730\u53ea\u8bfb\u5185\u5bb9\u9884\u89c8\uff0c\u4e0d\u4e0a\u4f20\u6587\u4ef6\u3002\u4e0d\u6267\u884c\u5b8f\u3001\u516c\u5f0f\u3001\u5916\u94fe\u6216\u5916\u90e8\u8d44\u6e90\u3002",
            "Local read-only content preview; no uploads. Macros, formulas, links and external resources are not executed.",
          )}
        </p>
        <p class="office-notice">
          {t(
            "\u5185\u5bb9\u4f1a\u91cd\u65b0\u6392\u7248\uff0c\u4e0d\u8fd8\u539f\u590d\u6742\u7248\u5f0f\u3001\u9875\u7709\u9875\u811a\u3001\u56fe\u8868\u3001\u6570\u5b57\u683c\u5f0f\u6216\u52a8\u753b\u3002\u4ec5\u663e\u793a\u5185\u5d4c PNG/JPEG \u56fe\u7247\u3002",
            "Content is reflowed, not a page-perfect reproduction. Complex layouts, headers/footers, charts, number formatting and animations are not reproduced. Only embedded PNG/JPEG images are shown.",
          )}
        </p>
        <Show when={state.document?.format === "xlsx"}>
          <p class="office-notice">
            {t(
              "\u6bcf\u4e2a\u5de5\u4f5c\u8868\u6700\u591a\u663e\u793a\u524d 200 \u884c\u300150 \u5217\uff1b\u516c\u5f0f\u4ec5\u663e\u793a\u4fdd\u5b58\u7684\u7ed3\u679c\uff0c\u65e0\u7ed3\u679c\u65f6\u663e\u793a\u516c\u5f0f\u6587\u672c\u3002",
              "Up to the first 200 rows and 50 columns per sheet. Formulas show saved results, or formula text when no result is saved.",
            )}
          </p>
        </Show>
      </details>
      <Show when={state.document?.limited}>
        <p role="status" class="office-notice">
          {t(
            "\u90e8\u5206\u5185\u5bb9\u56e0\u9884\u89c8\u9650\u5236\u5df2\u7701\u7565\uff0c\u8bf7\u7528\u672c\u5730 Office \u67e5\u770b\u5b8c\u6574\u6587\u4ef6\u3002",
            "Some content was omitted due to preview limits. Use a local Office application for the complete document.",
          )}
        </p>
      </Show>
      <Show when={state.document && (state.loading || state.error)}>
        <p role="status" class="office-notice" data-slot="document-refresh-status">
          {state.loading
            ? t("正在刷新；当前显示上次成功预览。", "Refreshing; showing the previous successful preview.")
            : t(
                "刷新失败；当前显示上次成功预览。下载操作使用最近读取的文件。",
                "Refresh failed; showing the previous successful preview. Downloads use the latest file read.",
              )}
        </p>
      </Show>
      <Show when={state.loading && !state.document}>
        <PreviewLoading
          kind={officeFormat(props.path, props.content.mimeType) === "xlsx" ? "sheet" : "office"}
          label={t("\u6b63\u5728\u89e3\u6790 Office \u6587\u6863...", "Reading Office document...")}
        />
      </Show>
      <Show when={state.error}>
        <div data-component="office-preview-error" role="alert" class="office-notice">
          <p>{state.error}</p>
          <button type="button" onClick={() => setState("attempt", state.attempt + 1)}>
            {t("\u91cd\u8bd5 Office \u9884\u89c8", "Retry Office preview")}
          </button>
        </div>
      </Show>
      <Show when={state.document}>
        <div
          class="office-controls"
          role="group"
          aria-label={t("Office \u9884\u89c8\u63a7\u5236", "Office preview controls")}
        >
          <span>{state.document?.format.toUpperCase()}</span>
          <label title={t("文档缩放", "Document zoom")}>
            <select
              aria-label={t("文档缩放", "Document zoom")}
              value={state.document?.format === "pptx" && state.fitSlides && page()?.slide ? 0 : state.zoom}
              onChange={(event) => {
                const zoom = Number(event.currentTarget.value)
                setState("fitSlides", zoom === 0)
                if (zoom > 0) setState("zoom", zoom)
              }}
            >
              <Show when={state.document?.format === "pptx"}>
                <option value={0} disabled={!page()?.slide}>
                  {t("适合页面", "Fit page")}
                </option>
              </Show>
              <For each={[0.5, 0.75, 1, 1.25, 1.5, 2]}>
                {(zoom) => <option value={zoom}>{Math.round(zoom * 100)}%</option>}
              </For>
            </select>
          </label>
          <Show when={state.document?.format !== "docx"}>
            <WorkbenchActionTooltip label={t("上一项", "Previous item")} class="workbench-document-icon-hint">
              <button
                type="button"
                disabled={state.page <= 0}
                onClick={() => setState("page", state.page - 1)}
                aria-label={t("上一项", "Previous item")}
              >
                <Icon name="chevron-left" size="small" />
              </button>
            </WorkbenchActionTooltip>
            <select
              aria-label={
                state.document?.format === "xlsx"
                  ? t("\u5de5\u4f5c\u8868", "Worksheet")
                  : t("\u5e7b\u706f\u7247", "Slide")
              }
              value={state.page}
              onChange={(event) => setState("page", Number(event.currentTarget.value))}
            >
              <For each={state.document?.pages}>{(item, index) => <option value={index()}>{item.label}</option>}</For>
            </select>
            <span>
              {state.page + 1} / {state.document?.pages.length}
            </span>
            <WorkbenchActionTooltip label={t("下一项", "Next item")} class="workbench-document-icon-hint">
              <button
                type="button"
                disabled={state.page >= (state.document?.pages.length ?? 1) - 1}
                onClick={() => setState("page", state.page + 1)}
                aria-label={t("下一项", "Next item")}
              >
                <Icon name="chevron-right" size="small" />
              </button>
            </WorkbenchActionTooltip>
          </Show>
        </div>
      </Show>
      <div ref={documentLayout} data-slot="office-document-layout" data-word-outline-open={navigation.opened}>
        <Show when={state.document?.format === "docx"}>
          <details
            data-slot="office-word-outline"
            open={navigation.opened}
            onToggle={(event) => {
              if (event.currentTarget.open !== navigation.opened)
                setNavigation({ opened: event.currentTarget.open, touched: true })
            }}
          >
            <summary>
              {t("大纲", "Outline")} ({headings().length})
            </summary>
            <nav aria-label={t("文档大纲", "Document outline")}>
              <For each={headings()}>
                {(heading) => (
                  <button
                    type="button"
                    title={heading.text}
                    aria-label={heading.text}
                    aria-current={navigation.active === heading.index ? "location" : undefined}
                    style={{ "padding-inline-start": `${12 + (heading.level - 1) * 12}px` }}
                    onClick={() => goToHeading(heading.index)}
                  >
                    {heading.text}
                  </button>
                )}
              </For>
              <Show when={!headings().length}>
                <p class="office-notice">{t("文档没有可用标题。", "This document has no headings.")}</p>
              </Show>
            </nav>
          </details>
        </Show>
        <Show when={state.document?.format === "pptx"}>
          <nav data-slot="office-slide-outline" aria-label={t("幻灯片内容导航", "Slide content navigation")}>
            <For each={state.document?.pages}>
              {(item, index) => (
                <button
                  type="button"
                  aria-current={state.page === index() ? "page" : undefined}
                  aria-label={`${index() + 1}. ${slideTitle(item)}`}
                  title={slideTitle(item)}
                  onClick={() => setState("page", index())}
                >
                  <Show when={item.slide}>
                    {(slide) => (
                      <OfficeSlideThumbnail
                        slide={slide()}
                        label={item.label}
                        renderBlock={(block) => <Block block={block} />}
                      />
                    )}
                  </Show>
                  <span>
                    {index() + 1}. {slideTitle(item)}
                  </span>
                  <small>
                    {item.blocks
                      .slice(1)
                      .flatMap((block) => (block.kind === "paragraph" ? block.runs.map((run) => run.text) : []))
                      .join(" ")
                      .slice(0, 160)}
                  </small>
                </button>
              )}
            </For>
          </nav>
        </Show>
        <div
          ref={viewport}
          data-slot="office-preview-viewport"
          data-scrollable
          tabIndex={0}
          role="region"
          aria-label={t("Office \u6587\u6863\u5185\u5bb9", "Office document content")}
        >
          <Show when={page()} keyed>
            {(item) => (
              <Show
                when={item.slide}
                fallback={
                  <>
                    <Show when={state.document?.format === "pptx"}>
                      <p data-slot="office-slide-layout-unavailable" role="status">
                        {t(
                          "原文件缺少可呈现的页几何，以下为真实提取内容，不是幻灯片页面还原。",
                          "Page geometry is unavailable. The extracted content below is not a rendered slide page.",
                        )}
                      </p>
                    </Show>
                    <article class="office-paper" data-office-page={item.label} style={{ zoom: String(state.zoom) }}>
                      <For each={item.blocks}>{(block, index) => <Block block={block} index={index()} />}</For>
                    </article>
                  </>
                }
              >
                {(slide) => (
                  <OfficeSlideStage
                    slide={slide()}
                    label={item.label}
                    zoom={state.zoom}
                    fit={state.fitSlides}
                    renderBlock={(block) => <Block block={block} />}
                  />
                )}
              </Show>
            )}
          </Show>
        </div>
      </div>
      <Show when={state.document?.format === "pptx" && page()?.slide}>
        <details data-slot="office-slide-extracted-content">
          <summary>{t("提取内容与支持范围", "Extracted content and preview support")}</summary>
          <p class="office-notice">
            {t(
              "页面按原尺寸与可支持对象的位置呈现。主题字体、复杂形状、图表、动画和部分版式可能不同；全部提取内容仍可在此阅读。",
              "Pages use source dimensions and supported object positions. Theme fonts, complex shapes, charts, animations and some layout details may differ. All extracted content remains readable here.",
            )}
          </p>
          <div class="office-paper">
            <For each={page()?.blocks}>{(block) => <Block block={block} />}</For>
          </div>
        </details>
      </Show>
      <Show when={state.document?.format === "xlsx"}>
        <nav data-slot="office-sheet-tabs" aria-label={t("工作表", "Worksheets")}>
          <For each={state.document?.pages}>
            {(item, index) => (
              <WorkbenchActionTooltip label={item.label}>
                <button
                  type="button"
                  aria-current={state.page === index() ? "page" : undefined}
                  aria-label={item.label}
                  onClick={() => setState("page", index())}
                >
                  {item.label}
                </button>
              </WorkbenchActionTooltip>
            )}
          </For>
        </nav>
      </Show>
    </section>
  )
}

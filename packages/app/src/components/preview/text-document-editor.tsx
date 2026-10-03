import { basicSetup, EditorView } from "codemirror"
import { markdown } from "@codemirror/lang-markdown"
import { createEffect, createSignal, ErrorBoundary, lazy, onCleanup, onMount, Show, Suspense } from "solid-js"
import { createStore } from "solid-js/store"
import { TextDocument } from "@arforge-ai/schema/text-document"
import { TextDocumentRequestError, type TextDocumentApi } from "@/utils/text-document-api"
import { acknowledgeSave, isDirty, textDraftKey, textDrafts, type TextDraft } from "./text-document-draft"
import { isHtmlDocument } from "./html-preview-policy"
import "./html-preview.css"

const HtmlPreview = lazy(() => import("./html-preview").then((module) => ({ default: module.HtmlPreview })))
const MarkdownPreview = lazy(() => import("./markdown-preview").then((module) => ({ default: module.MarkdownPreview })))

function CodeEditor(props: { text: string; path: string; onChange: (text: string) => void }) {
  let host!: HTMLDivElement
  let view: EditorView | undefined
  onMount(() => {
    view = new EditorView({
      parent: host,
      doc: props.text,
      extensions: [
        basicSetup,
        ...(/\.(?:md|markdown)$/i.test(props.path) ? [markdown()] : []),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ "aria-label": props.path, spellcheck: "false" }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) props.onChange(update.state.doc.toString())
        }),
        EditorView.theme({
          "&": { height: "100%", color: "var(--text-base)", backgroundColor: "var(--background-base)" },
          ".cm-scroller": { overflow: "auto", fontFamily: "var(--font-family-mono, monospace)" },
          ".cm-content": { minHeight: "240px", caretColor: "var(--text-strong)" },
          ".cm-gutters": { color: "var(--text-weak)", backgroundColor: "var(--background-weak)", border: "none" },
          ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "var(--surface-base-hover)" },
          "&.cm-focused": { outline: "none" },
        }),
      ],
    })
    view.focus()
  })
  createEffect(() => {
    const text = props.text
    if (!view || view.state.doc.toString() === text) return
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } })
  })
  onCleanup(() => view?.destroy())
  return <div data-slot="text-editor-code" ref={host} />
}

export default function TextDocumentEditor(props: {
  path: string
  directory: string
  scope: string
  api: TextDocumentApi
  chinese: boolean
  onSaved: () => Promise<void>
  onClose: () => void
}) {
  const key = textDraftKey(props.scope, props.directory, props.path)
  const [draft, setDraft] = createSignal<TextDraft>()
  const [loading, setLoading] = createSignal(true)
  const [saving, setSaving] = createSignal(false)
  const [error, setError] = createSignal("")
  const [warning, setWarning] = createSignal("")
  const [conflict, setConflict] = createSignal(false)
  const [restored, setRestored] = createSignal(false)
  const [saved, setSaved] = createSignal(false)
  const [confirm, setConfirm] = createSignal<"close" | "reload">()
  const [revision, setRevision] = createSignal(0)
  const [display, setDisplay] = createStore({ livePreview: true })
  const [comparison, setComparison] = createStore({ disk: undefined as TextDocument.Info | undefined })
  const supportsPreview = () => isHtmlDocument(props.path) || /\.(?:md|markdown)$/i.test(props.path)
  let timer: ReturnType<typeof setTimeout> | undefined
  let alive = true
  const t = (zh: string, en: string) => props.chinese ? zh : en
  const dirty = () => isDirty(draft())
  const tooLarge = () => (draft()?.text.length ?? 0) > TextDocument.MAX_TEXT_LENGTH

  const persist = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    try {
      textDrafts.flush(key)
      if (alive) setWarning("")
    } catch (cause) {
      if (alive) setWarning(`${t("草稿仅保留在内存中，请勿退出：", "Draft retained in memory only; do not exit: ")}${String(cause)}`)
    }
  }

  const remember = (value: TextDraft, immediately = false) => {
    textDrafts.remember(key, isDirty(value) ? value : null)
    if (timer !== undefined) clearTimeout(timer)
    if (immediately) persist()
    else timer = setTimeout(persist, 200)
  }

  const load = async (discard = false) => {
    setLoading(true)
    setError("")
    try {
      const current = await props.api.read({ directory: props.directory, path: props.path })
      if (!alive) return
      const existing = discard ? undefined : draft()
      const next: TextDraft = existing && existing.text !== current.text
        ? existing
        : { format: 1, base: current, text: current.text }
      setDraft(next)
      setConflict(next.base.version !== current.version)
      setComparison("disk", next.base.version !== current.version ? current : undefined)
      setSaved(false)
      setRevision((value) => value + 1)
      remember(next, true)
    } catch (cause) {
      if (alive) setError(String(cause))
    } finally {
      if (alive) setLoading(false)
    }
  }

  onMount(() => {
    try {
      const recovered = textDrafts.restore(key)
      if (recovered && recovered.base.path === props.path) {
        setDraft(recovered)
        setRestored(true)
      }
    } catch (cause) {
      setWarning(`${t("无法恢复本地草稿：", "Could not restore the local draft: ")}${String(cause)}`)
    }
    void load()
  })

  const save = async (close = false) => {
    const value = draft()
    if (!value || saving() || loading() || conflict() || tooLarge()) return
    if (!isDirty(value)) {
      if (close) props.onClose()
      return
    }
    setSaving(true)
    setError("")
    try {
      const result = await props.api.save({
        directory: props.directory,
        path: props.path,
        baseVersion: value.base.version,
        text: value.text,
      })
      const next = acknowledgeSave(draft() ?? value, result)
      // Also complete persistence if the user switched tabs during the request.
      setDraft(next)
      remember(next, true)
      if (!alive) return
      setSaved(true)
      setRestored(false)
      try {
        await props.onSaved()
      } catch (cause) {
        if (alive) setWarning(`${t("文件已保存，但预览刷新失败：", "File saved, but preview refresh failed: ")}${String(cause)}`)
      }
      if (alive && close && !isDirty(draft())) props.onClose()
    } catch (cause) {
      if (!alive) return
      setConflict(cause instanceof TextDocumentRequestError && cause.status === 409)
      setError(String(cause))
      if (cause instanceof TextDocumentRequestError && cause.status === 409) {
        try {
          const current = await props.api.read({ directory: props.directory, path: props.path })
          if (alive) setComparison("disk", current)
        } catch (readError) {
          if (alive) setWarning(`${t("无法读取磁盘版本进行对照：", "Could not read the disk version for comparison: ")}${String(readError)}`)
        }
      }
    } finally {
      if (alive) setSaving(false)
    }
  }

  const requestClose = () => {
    if (saving() || loading()) return
    if (dirty()) setConfirm("close")
    else props.onClose()
  }

  const discard = async () => {
    const action = confirm()
    setConfirm(undefined)
    if (action === "reload") {
      await load(true)
      return
    }
    textDrafts.remember(key, null)
    persist()
    props.onClose()
  }

  onCleanup(() => {
    persist()
    alive = false
  })

  return (
    <section
      data-component="text-document-editor"
      data-dirty={dirty() ? "true" : "false"}
      aria-busy={loading() || saving()}
      onKeyDown={(event) => {
        if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== "s") return
        event.preventDefault()
        event.stopPropagation()
        void save()
      }}
    >
      <header data-slot="text-editor-toolbar">
        <span title={props.path}>{props.path}</span>
        <span role="status">{saving() ? t("正在保存…", "Saving...") : dirty() ? t("未保存", "Unsaved") : saved() ? t("已保存", "Saved") : t("未修改", "Unchanged")}</span>
        <button type="button" disabled={!dirty() || saving() || loading() || conflict() || tooLarge()} onClick={() => void save()}>
          {t("保存", "Save")}
        </button>
        <button type="button" disabled={saving() || loading()} onClick={requestClose}>{t("返回预览", "Back to preview")}</button>
        <Show when={supportsPreview()}>
          <button type="button" aria-pressed={display.livePreview} onClick={() => setDisplay("livePreview", !display.livePreview)}>
            {t("\u5b9e\u65f6\u9884\u89c8", "Live preview")}
          </button>
        </Show>
      </header>
      <p data-slot="text-editor-hint">{t("Ctrl/Cmd+S 保存；Ctrl/Cmd+F 查找。关闭标签后草稿仍保留，重新点击“编辑文件”可恢复。", "Ctrl/Cmd+S saves; Ctrl/Cmd+F searches. Drafts survive tab closure; use Edit file to restore them.")}</p>
      <Show when={restored()}><p role="status">{t("已恢复未保存草稿。", "Unsaved draft restored.")}</p></Show>
      <Show when={warning()}><p role="alert">{warning()}</p></Show>
      <Show when={error()}><p role="alert">{error()}</p></Show>
      <Show when={conflict()}>
        <div role="alert">
          <p>{t("磁盘文件已被其他操作修改。草稿已保留，保存已暂停，不会覆盖外部改动。", "The file changed on disk. Your draft is retained and saving is paused to protect external changes.")}</p>
          <Show when={comparison.disk}>
            <div data-slot="text-editor-conflict">
              <section><h3>{t("当前草稿", "Your draft")}</h3><pre>{draft()?.text}</pre></section>
              <section><h3>{t("磁盘版本", "Disk version")}</h3><pre>{comparison.disk?.text}</pre></section>
            </div>
          </Show>
          <button type="button" disabled={loading() || saving()} onClick={() => setConfirm("reload")}>{t("重新读取磁盘文件", "Reload disk file")}</button>
        </div>
      </Show>
      <Show when={tooLarge()}><p role="alert">{t("超过 500,000 字符，缩短内容后才能保存。", "Over 500,000 characters; shorten the content before saving.")}</p></Show>
      <Show when={confirm()}>
        <div role="alertdialog" aria-label={t("处理未保存的修改", "Unsaved changes")} tabIndex={-1}>
          <p>{t("是否丢弃当前草稿？取消将继续保留编辑内容。", "Discard the current draft? Cancel keeps your edits.")}</p>
          <Show when={confirm() === "close"}>
            <button type="button" disabled={saving() || conflict() || tooLarge()} onClick={() => { setConfirm(undefined); void save(true) }}>
              {t("保存并返回", "Save and close")}
            </button>
          </Show>
          <button type="button" onClick={() => void discard()}>{t("丢弃草稿", "Discard draft")}</button>
          <button type="button" onClick={() => setConfirm(undefined)}>{t("取消", "Cancel")}</button>
        </div>
      </Show>
      <Show when={!loading()} fallback={<p role="status">{t("正在读取文件版本…", "Reading file version...")}</p>}>
        <Show when={draft()} fallback={<button type="button" onClick={() => void load()}>{t("重试", "Retry")}</button>}>
          <div data-component="text-editor-layout" data-preview={supportsPreview() && display.livePreview ? "true" : "false"}>
            <Show when={revision() + 1} keyed>
            {(_revision) => <CodeEditor
              text={draft()!.text}
              path={props.path}
              onChange={(text) => {
                const current = draft()
                if (!current || current.text === text) return
                const next = { ...current, text }
                setDraft(next)
                setSaved(false)
                remember(next)
              }}
            />}
            </Show>
            <Show when={supportsPreview() && display.livePreview}>
              <ErrorBoundary fallback={(error) => <p role="alert">{String(error)}</p>}>
                <Suspense fallback={<p role="status">{t("\u6b63\u5728\u52a0\u8f7d\u9884\u89c8...", "Loading preview...")}</p>}>
                  <Show when={isHtmlDocument(props.path)} fallback={<MarkdownPreview text={draft()!.text} />}>
                    <HtmlPreview path={props.path} text={draft()!.text} live />
                  </Show>
                </Suspense>
              </ErrorBoundary>
            </Show>
          </div>
          <footer>{draft()!.base.bom ? "UTF-8 BOM" : "UTF-8"} · {draft()!.base.lineEnding.toUpperCase()}</footer>
        </Show>
      </Show>
    </section>
  )
}

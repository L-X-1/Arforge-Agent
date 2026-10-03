import { createMemo, createSignal, ErrorBoundary, lazy, Show, Suspense } from "solid-js"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import { useLanguage } from "@/context/language"
import { FilePreview } from "./file-preview"
import "./text-document-editor.css"

const TextDocumentEditor = lazy(() => import("./text-document-editor"))

export function EditableFilePreview(props: Parameters<typeof FilePreview>[0]) {
  const sdk = useSDK()
  const server = useServerSDK()
  const language = useLanguage()
  const identity = createMemo(() => JSON.stringify([server().scope, sdk().directory, props.path]))
  const chinese = () => language.locale().startsWith("zh")
  const canEdit = () => {
    const content = props.state?.content
    return props.state?.loaded && content?.type === "text" && content.content.length <= 500_000 &&
      !/\.(?:pdf|docx?|xlsx?|pptx?|odt|ods|odp)$/i.test(props.path)
  }

  return (
    <Show when={identity()} keyed>
      {(_identity) => {
        const [editing, setEditing] = createSignal(false)
        const directory = sdk().directory
        const filePath = props.path
        const scope = server().scope
        const api = server().operationsApi.textDocuments
        return (
          <section data-component="editable-file-preview">
            <Show when={editing()} fallback={
              <>
                <Show when={canEdit()}>
                  <div data-slot="text-edit-entry">
                    <button type="button" onClick={() => setEditing(true)}>{chinese() ? "编辑文件" : "Edit file"}</button>
                  </div>
                </Show>
                <FilePreview {...props} />
              </>
            }>
              <ErrorBoundary fallback={(error) => (
                <div role="alert">
                  <p>{String(error)}</p>
                  <button type="button" onClick={() => setEditing(false)}>{chinese() ? "返回预览" : "Back to preview"}</button>
                </div>
              )}>
                <Suspense fallback={<p role="status">{chinese() ? "正在加载编辑器…" : "Loading editor..."}</p>}>
                  <TextDocumentEditor
                    path={filePath}
                    directory={directory}
                    scope={scope}
                    api={api}
                    chinese={chinese()}
                    onSaved={props.onRetry}
                    onClose={() => setEditing(false)}
                  />
                </Suspense>
              </ErrorBoundary>
            </Show>
          </section>
        )
      }}
    </Show>
  )
}

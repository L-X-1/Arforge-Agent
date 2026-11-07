import "./file-preview-polish.css"

/** Presentation only: actual loading/retry state remains owned by each preview. */
export function PreviewLoading(props: { kind?: string; label: string; compact?: boolean }) {
  return (
    <div
      data-component="file-preview-loading"
      data-preview-kind={props.kind ?? "text"}
      data-compact={props.compact ? "true" : undefined}
      role="status"
    >
      <p>{props.label}</p>
      <div data-slot="preview-skeleton-surface" aria-hidden="true">
        <span /><span /><span /><span /><span /><span />
      </div>
    </div>
  )
}

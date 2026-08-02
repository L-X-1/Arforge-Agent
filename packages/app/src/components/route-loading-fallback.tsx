export function RouteLoadingFallback() {
  return (
    <section
      data-component="route-loading-fallback"
      class="h-full w-full min-h-0 p-3 flex flex-col"
      role="status"
      aria-live="polite"
      aria-label="Arforge 正在载入会话"
    >
      <div class="flex-1 min-h-0 rounded-lg border border-v2-border-border-muted bg-v2-background-bg-base flex flex-col">
        <div class="h-14 shrink-0 border-b border-v2-border-border-muted px-5 flex items-center">
          <div class="h-3 w-40 rounded-sm bg-v2-background-bg-strong" />
        </div>
        <div class="flex-1 min-h-0 px-6 py-8 flex flex-col gap-4">
          <div class="h-3 w-2/5 max-w-80 rounded-sm bg-v2-background-bg-strong" />
          <div class="h-3 w-3/5 max-w-xl rounded-sm bg-v2-background-bg-strong" />
          <div class="h-3 w-1/3 max-w-64 rounded-sm bg-v2-background-bg-strong" />
        </div>
        <div class="mx-auto mb-5 h-20 w-[min(720px,calc(100%-40px))] rounded-lg border border-v2-border-border-muted bg-v2-background-bg-deep px-4 flex items-center">
          <span class="text-[13px] text-v2-text-text-muted">正在载入会话，请稍候…</span>
        </div>
      </div>
    </section>
  )
}

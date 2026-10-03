import { For, Show, createEffect, on } from "solid-js"
import { createStore } from "solid-js/store"
import type { OperationsApi } from "@/utils/server"
import { useLanguage } from "@/context/language"
import { createScopeRequestGuard } from "@/utils/scope-request"
import {
  artifactActionText,
  artifactAuditChainState,
  formatArtifactBytes,
  shortArtifactIdentifier,
} from "./artifact-evidence"
import { formatRuntimeTime, runtimeInsightCopy } from "./runtime-insight-presentation"

type Catalog = Awaited<ReturnType<OperationsApi["artifacts"]["catalog"]>>
type Audit = Awaited<ReturnType<OperationsApi["artifacts"]["audit"]>>
type MaintenanceContext = Awaited<ReturnType<OperationsApi["artifacts"]["maintenanceContext"]>>
type ArtifactOwner = { readonly scope: "profile" | "tenant"; readonly id: string }

const publicError = (error: unknown) => {
  if (error instanceof Error && error.message.trim()) return error.message
  if (typeof error === "string" && error.trim()) return error
  return "artifact evidence request failed"
}

/**
 * Session-scoped, metadata-only artifact evidence. This intentionally does
 * not expose retrieval hints, local paths, or bytes; opening bytes remains a
 * separate authenticated read operation owned by the session UI.
 */
export function ArtifactEvidenceWorkbench(props: {
  api: () => OperationsApi
  sessionID?: string
  owner?: ArtifactOwner
  ready: () => boolean
}) {
  const language = useLanguage()
  const copy = () => runtimeInsightCopy(language.locale())
  const scope = () => props.owner?.scope ?? "session"
  const [state, setState] = createStore({
    loading: false,
    error: "",
    catalog: undefined as Catalog | undefined,
    audit: [] as Audit,
    maintenance: undefined as MaintenanceContext | undefined,
  })
  const evidenceScopeKey = () =>
    (props.sessionID?.trim() ?? "") +
    "\u0000" +
    (props.owner?.scope ?? "session") +
    "\u0000" +
    (props.owner?.id.trim() ?? "")
  const scopeGuard = createScopeRequestGuard(evidenceScopeKey)
  let previousScopeKey: string | undefined

  const load = async () => {
    const request = scopeGuard.capture()
    const sessionID = props.sessionID?.trim()
    const owner = props.owner && props.owner.id.trim() !== "" ? { ...props.owner, id: props.owner.id.trim() } : undefined
    if (!props.ready() || (!sessionID && !owner) || state.loading) return
    setState({ loading: true, error: "" })
    try {
      let catalog: Catalog
      let audit: Audit
      let maintenance: MaintenanceContext | undefined
      if (sessionID) {
        ;[catalog, audit] = await Promise.all([
          props.api().artifacts.catalog({ sessionID, limit: 50 }),
          props.api().artifacts.audit({ sessionID, limit: 50 }),
        ])
      } else {
        ;[catalog, audit, maintenance] = await Promise.all([
          props.api().artifacts.catalogScoped({ owner: owner!, limit: 50 }),
          props.api().artifacts.auditScoped({ owner: owner!, limit: 50 }),
          props.api().artifacts.maintenanceContext({ scope: owner!.scope }),
        ])
      }
      if (scopeGuard.isCurrent(request)) setState({ catalog, audit, maintenance, error: "" })
    } catch (error) {
      if (scopeGuard.isCurrent(request)) setState("error", publicError(error))
    } finally {
      if (scopeGuard.isCurrent(request)) setState("loading", false)
    }
  }

  createEffect(
    on(
      () => [props.ready(), props.sessionID, props.owner?.scope, props.owner?.id] as const,
      ([ready]) => {
        const scopeKey = evidenceScopeKey()
        const scopeChanged = previousScopeKey !== undefined && previousScopeKey !== scopeKey
        previousScopeKey = scopeKey
        const request = scopeGuard.current()
        if (ready) {
          setState({
            loading: scopeChanged ? false : state.loading,
            catalog: undefined,
            audit: [],
            maintenance: undefined,
            error: "",
          })
          void load()
        } else if (scopeGuard.isCurrent(request)) {
          setState({ loading: false, catalog: undefined, audit: [], maintenance: undefined, error: "" })
        }
      },
    ),
  )

  return (
    <article
      style="padding:12px 14px;border-radius:10px;background:var(--arforge-material-main);box-shadow:inset 0 0 0 0.5px var(--arforge-hairline);display:grid;gap:8px"
      data-testid="artifact-evidence-card"
      aria-busy={state.loading}
    >
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <h4 style="margin:0;font-size:13px;font-weight:600">{copy().artifactEvidenceTitle}</h4>
        <span
          style="font-size:11px;padding:1px 8px;border-radius:10px;background:rgba(99,102,241,0.14);color:#818cf8;font-weight:600"
        >
          {copy().human}
        </span>
        <button
          class="arforge-btn"
          style="margin-left:auto"
          disabled={state.loading || (!props.sessionID?.trim() && !props.owner?.id.trim())}
          onClick={() => void load()}
          data-testid="artifact-evidence-refresh"
        >
          {state.loading ? copy().refreshing : copy().refresh}
        </button>
      </div>
      <p style="margin:0;font-size:12px;color:var(--v2-text-text-muted);line-height:1.5">
        {copy().artifactEvidenceHint(scope())}
      </p>
      <Show when={!props.sessionID?.trim() && !props.owner?.id.trim()}>
        <p style="margin:0;font-size:12px;color:var(--v2-text-text-muted)" data-testid="artifact-evidence-no-session">
          {copy().artifactEvidenceNoSession}
        </p>
      </Show>
      <Show when={state.error}>
        <p style="margin:0;color:var(--color-danger,#ef4444);font-size:12px" role="alert">
          {state.error}
        </p>
      </Show>
      <Show when={state.maintenance}>
        {(maintenance) => (
          <section
            style="display:grid;gap:4px;padding:8px 10px;border-radius:8px;background:var(--arforge-material-main);box-shadow:inset 0 0 0 0.5px var(--arforge-hairline)"
            aria-label={copy().artifactEvidenceMaintenanceTitle}
            data-testid="artifact-evidence-maintenance"
          >
            <b style="font-size:12px">{copy().artifactEvidenceMaintenanceTitle}</b>
            <span style="font-size:11px;color:var(--v2-text-text-muted)">
              {copy().artifactEvidenceMaintenanceStatus(
                maintenance().canMaintain,
                maintenance().scan?.status,
                maintenance().scan?.scanComplete,
                maintenance().reason,
              )}
            </span>
            <Show when={maintenance().scan}>
              {(scan) => (
                <span style="font-size:11px;color:var(--v2-text-text-muted)">
                  {copy().artifactEvidenceMaintenanceProgress(scan().pageNumber, scan().scannedActions)}
                </span>
              )}
            </Show>
          </section>
        )}
      </Show>
      <Show when={state.catalog}>
        {(catalog) => {
          const chain = () => artifactAuditChainState(state.audit, catalog().droppedAuditEntries)
          return (
            <>
              <div
                style="display:flex;gap:8px;flex-wrap:wrap;font-size:11px;color:var(--v2-text-text-muted)"
                data-testid="artifact-evidence-summary"
              >
                <b style="color:var(--v2-text-text)" data-testid="artifact-evidence-counts">
                  {copy().artifactEvidenceSummary(catalog().entries.length, state.audit.length)}
                </b>
                <span>{copy().artifactEvidenceHead(catalog().headSequence, shortArtifactIdentifier(catalog().headHash))}</span>
                <span>{copy().artifactEvidenceChain(chain())}</span>
                <Show when={catalog().droppedAuditEntries > 0}>
                  <span>{copy().artifactEvidenceDropped(catalog().droppedAuditEntries)}</span>
                </Show>
              </div>

              <section style="display:grid;gap:5px" aria-label={copy().artifactEvidenceCatalogTitle}>
                <b style="font-size:12px">{copy().artifactEvidenceCatalogTitle}</b>
                <Show
                  when={catalog().entries.length > 0}
                  fallback={
                    <span style="font-size:11px;color:var(--v2-text-text-muted)">
                      {copy().artifactEvidenceEmpty(scope())}
                    </span>
                  }
                >
                  <For each={catalog().entries.slice(0, 12)}>
                    {(entry) => (
                      <div
                        style="font-size:11px;padding:7px 9px;border-radius:7px;background:var(--arforge-material-main);box-shadow:inset 0 0 0 0.5px var(--arforge-hairline);display:grid;gap:3px"
                        data-testid="artifact-evidence-entry"
                      >
                        <div style="display:flex;gap:7px;align-items:center;flex-wrap:wrap">
                          <b>{entry.reference.label || entry.reference.kind}</b>
                          <span style="color:var(--v2-text-text-muted)">
                            {shortArtifactIdentifier(entry.reference.artifactID)} · {formatArtifactBytes(entry.reference.sizeBytes)}
                          </span>
                          <span style="margin-left:auto;color:var(--v2-text-text-muted)">
                            {copy().artifactEvidenceReads(entry.readCount)}
                          </span>
                        </div>
                        <div style="color:var(--v2-text-text-muted);display:flex;gap:8px;flex-wrap:wrap">
                          <span title={entry.reference.digest}>
                            {shortArtifactIdentifier(entry.reference.digest)}
                          </span>
                          <span>{copy().artifactEvidenceRetention(entry.reference.retention.mode)}</span>
                          <span>{copy().artifactEvidenceCreated(formatRuntimeTime(entry.reference.createdAt, language.locale()))}</span>
                        </div>
                      </div>
                    )}
                  </For>
                </Show>
              </section>

              <section style="display:grid;gap:5px" aria-label={copy().artifactEvidenceAuditTitle}>
                <b style="font-size:12px">{copy().artifactEvidenceAuditTitle}</b>
                <Show
                  when={state.audit.length > 0}
                  fallback={
                    <span style="font-size:11px;color:var(--v2-text-text-muted)">
                      {copy().artifactEvidenceAuditEmpty(scope())}
                    </span>
                  }
                >
                  <For each={state.audit.slice(0, 12)}>
                    {(record) => (
                      <div
                        style="font-size:11px;padding:6px 9px;border-radius:7px;background:var(--arforge-material-main);box-shadow:inset 0 0 0 0.5px var(--arforge-hairline);display:flex;gap:7px;align-items:center;flex-wrap:wrap"
                        data-testid="artifact-evidence-audit"
                      >
                        <b>#{record.sequence}</b>
                        <span>{artifactActionText(record.action, language.locale())}</span>
                        <span style="color:var(--v2-text-text-muted)">{shortArtifactIdentifier(record.artifactID)}</span>
                        <span style="color:var(--v2-text-text-muted)">{record.actor}</span>
                        <Show when={record.reason}>
                          {(reason) => <span style="color:var(--v2-text-text-muted)">{reason()}</span>}
                        </Show>
                        <span style="margin-left:auto;color:var(--v2-text-text-muted)">
                          {formatRuntimeTime(record.recordedAt, language.locale())}
                        </span>
                      </div>
                    )}
                  </For>
                </Show>
              </section>
            </>
          )
        }}
      </Show>
    </article>
  )
}

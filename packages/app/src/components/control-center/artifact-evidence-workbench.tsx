import { For, Show, createEffect, createMemo, on, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { Portal } from "solid-js/web"
import { ButtonV2 } from "@arforge-ai/ui/v2/button-v2"
import { ManagementStatus } from "@/components/settings-v2/management-status"
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
import { ManagementCollection } from "./management-collection"
import { ArtifactContentPreview } from "./artifact-content-preview"
import "./artifact-evidence-workbench.css"

type Catalog = Awaited<ReturnType<OperationsApi["artifacts"]["catalog"]>>
type Audit = Awaited<ReturnType<OperationsApi["artifacts"]["audit"]>>
type MaintenanceContext = Awaited<ReturnType<OperationsApi["artifacts"]["maintenanceContext"]>>
type ArtifactOwner = { readonly scope: "profile" | "tenant"; readonly id: string }
type EvidenceItem = { kind: "receipt"; entry: Catalog["entries"][number] } | { kind: "audit"; record: Audit[number] }

const publicError = (error: unknown) => {
  if (error instanceof Error && error.message.trim()) return error.message
  if (typeof error === "string" && error.trim()) return error
  return "artifact evidence request failed"
}

/**
 * Receipt evidence and explicit authenticated content reads. Resolver hints
 * remain transport-only; no filesystem path is used for preview or download.
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
  const labels = () =>
    language.locale().startsWith("zh")
      ? {
          catalog: "产物与审计",
          receipt: "产物",
          audit: "审计",
          id: "标识",
          digest: "摘要",
          type: "类型",
          size: "大小",
          source: "来源",
          related: "关联审计",
          access: "访问边界",
          boundary: "内容只通过当前来源的鉴权产物接口读取，预览与下载都会核对摘要和大小。",
        }
      : {
          catalog: "Artifacts and audit",
          receipt: "Receipt",
          audit: "Audit",
          id: "Identifier",
          digest: "Digest",
          type: "Type",
          size: "Size",
          source: "Source",
          related: "Related audit",
          access: "Access boundary",
          boundary: "Content uses this source's authenticated artifact API. Preview and download verify digest and size.",
        }
  const [state, setState] = createStore({
    loading: false,
    error: "",
    catalog: undefined as Catalog | undefined,
    audit: [] as Audit,
    maintenance: undefined as MaintenanceContext | undefined,
    selectedArtifact: "",
    contentMount: undefined as HTMLDivElement | undefined,
  })
  const selectedReference = createMemo(() => state.catalog?.entries.find(entry => entry.reference.artifactID === state.selectedArtifact)?.reference)
  let currentAPI = props.api(), apiGeneration = 0
  const evidenceScopeKey = () => {
    if (currentAPI !== props.api()) { currentAPI = props.api(); apiGeneration++ }
    return apiGeneration + "\u0000" + (props.sessionID?.trim() ?? "") +
    "\u0000" +
    (props.owner?.scope ?? "session") +
    "\u0000" +
    (props.owner?.id.trim() ?? "")
  }
  const scopeGuard = createScopeRequestGuard(evidenceScopeKey)
  onCleanup(() => scopeGuard.invalidate())
  let previousScopeKey: string | undefined
  const evidenceItems = (): EvidenceItem[] => [
    ...(state.catalog?.entries.map((entry) => ({ kind: "receipt" as const, entry })) ?? []),
    ...state.audit.map((record) => ({ kind: "audit" as const, record })),
  ]

  const load = async () => {
    const request = scopeGuard.capture()
    const sessionID = props.sessionID?.trim()
    const owner =
      props.owner && props.owner.id.trim() !== "" ? { ...props.owner, id: props.owner.id.trim() } : undefined
    if (!props.ready() || (!sessionID && !owner) || state.loading) return
    setState({ loading: true, error: "" })
    const api = props.api()
    try {
      let catalog: Catalog
      let audit: Audit
      let maintenance: MaintenanceContext | undefined
      if (sessionID) {
        ;[catalog, audit] = await Promise.all([
          api.artifacts.catalog({ sessionID, limit: 50 }),
          api.artifacts.audit({ sessionID, limit: 50 }),
        ])
      } else {
        ;[catalog, audit, maintenance] = await Promise.all([
          api.artifacts.catalogScoped({ owner: owner!, limit: 50 }),
          api.artifacts.auditScoped({ owner: owner!, limit: 50 }),
          api.artifacts.maintenanceContext({ scope: owner!.scope }),
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
      () => [props.ready(), props.sessionID, props.owner?.scope, props.owner?.id, props.api()] as const,
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
            selectedArtifact: "",
            contentMount: undefined,
            error: "",
          })
          void load()
        } else if (scopeGuard.isCurrent(request)) {
          setState({ loading: false, catalog: undefined, audit: [], maintenance: undefined, selectedArtifact: "", contentMount: undefined, error: "" })
        }
      },
    ),
  )

  return (
    <article class="arforge-artifact-evidence" data-testid="artifact-evidence-card" aria-busy={state.loading}>
      <header class="arforge-artifact-evidence-header">
        <h4>{copy().artifactEvidenceTitle}</h4>
        <span class="arforge-artifact-evidence-badge">{copy().human}</span>
        <ButtonV2
          variant="ghost"
          disabled={state.loading || !props.ready() || (!props.sessionID?.trim() && !props.owner?.id.trim())}
          aria-busy={state.loading || undefined}
          onClick={() => void load()}
          data-testid="artifact-evidence-refresh"
        >
          {state.loading ? copy().refreshing : copy().refresh}
        </ButtonV2>
      </header>
      <p class="arforge-artifact-evidence-meta">{copy().artifactEvidenceHint(scope())}</p>
      <Show when={!props.sessionID?.trim() && !props.owner?.id.trim()}>
        <p class="arforge-artifact-evidence-meta" data-testid="artifact-evidence-no-session" role="status">
          {copy().artifactEvidenceNoSession}
        </p>
      </Show>
      <ManagementStatus
        loading={state.loading}
        initialLoading={!state.catalog}
        error={state.error}
        partial={!!state.error && !!state.catalog}
        onRetry={() => void load()}
      />
      <Show when={state.maintenance}>
        {(maintenance) => (
          <section
            class="arforge-artifact-evidence-section"
            aria-label={copy().artifactEvidenceMaintenanceTitle}
            data-testid="artifact-evidence-maintenance"
          >
            <h5>{copy().artifactEvidenceMaintenanceTitle}</h5>
            <span class="arforge-artifact-evidence-meta">
              {copy().artifactEvidenceMaintenanceStatus(
                maintenance().canMaintain,
                maintenance().scan?.status,
                maintenance().scan?.scanComplete,
                maintenance().reason,
              )}
            </span>
            <Show when={maintenance().scan}>
              {(scan) => (
                <span class="arforge-artifact-evidence-meta">
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
                class="arforge-artifact-evidence-summary arforge-artifact-evidence-meta"
                data-testid="artifact-evidence-summary"
              >
                <span data-testid="artifact-evidence-counts">
                  {copy().artifactEvidenceSummary(catalog().entries.length, state.audit.length)}
                </span>
                <span>
                  {copy().artifactEvidenceHead(catalog().headSequence, shortArtifactIdentifier(catalog().headHash))}
                </span>
                <span>{copy().artifactEvidenceChain(chain())}</span>
                <Show when={catalog().droppedAuditEntries > 0}>
                  <span>{copy().artifactEvidenceDropped(catalog().droppedAuditEntries)}</span>
                </Show>
              </div>

              <ManagementCollection<EvidenceItem>
                label={labels().catalog}
                scope={evidenceScopeKey()}
                scopeLabel={props.sessionID?.trim() ?? props.owner?.id}
                items={evidenceItems()}
                onSelect={item => setState("selectedArtifact", item.kind === "receipt" ? item.entry.reference.artifactID : "")}
                identity={(item) =>
                  item.kind === "receipt"
                    ? `receipt:${item.entry.reference.artifactID}`
                    : `audit:${item.record.sequence}`
                }
                title={(item) =>
                  item.kind === "receipt"
                    ? item.entry.reference.label || item.entry.reference.kind
                    : `#${item.record.sequence} · ${artifactActionText(item.record.action, language.locale())}`
                }
                description={(item) =>
                  item.kind === "receipt"
                    ? `${item.entry.reference.artifactID} · ${formatArtifactBytes(item.entry.reference.sizeBytes)}`
                    : `${item.record.artifactID} · ${formatRuntimeTime(item.record.recordedAt, language.locale())}`
                }
                searchText={(item) => (item.kind === "receipt" ? item.entry.reference.digest : item.record.actor)}
                emptyText={copy().artifactEvidenceEmpty(scope())}
                status={(item) => (
                  <span
                    class="arforge-artifact-evidence-meta"
                    data-testid={item.kind === "receipt" ? "artifact-evidence-entry" : "artifact-evidence-audit"}
                  >
                    {item.kind === "receipt" ? labels().receipt : labels().audit}
                  </span>
                )}
              >
                {(item) => (
                  <div class="arforge-artifact-evidence-section" data-testid="artifact-evidence-detail">
                    <dl class="arforge-management-definition">
                      <div>
                        <dt>{labels().id}</dt>
                        <dd>
                          <code>
                            {item.kind === "receipt" ? item.entry.reference.artifactID : item.record.artifactID}
                          </code>
                        </dd>
                      </div>
                      <div>
                        <dt>{labels().source}</dt>
                        <dd>
                          <code>{props.sessionID?.trim() ?? props.owner?.id}</code> · {scope()}
                        </dd>
                      </div>
                      <Show when={item.kind === "receipt" ? item.entry : undefined}>
                        {(entry) => (
                          <>
                            <div>
                              <dt>{labels().type}</dt>
                              <dd>{entry().reference.kind} · {entry().reference.mime}</dd>
                            </div>
                            <div>
                              <dt>{labels().digest}</dt>
                              <dd>
                                <code>{entry().reference.digest}</code>
                              </dd>
                            </div>
                            <div>
                              <dt>{labels().size}</dt>
                              <dd>{formatArtifactBytes(entry().reference.sizeBytes)}</dd>
                            </div>
                            <div>
                              <dt>{copy().artifactEvidenceMaintenanceTitle}</dt>
                              <dd>{copy().artifactEvidenceRetention(entry().reference.retention.mode)}</dd>
                            </div>
                            <div>
                              <dt>{copy().artifactEvidenceCatalogTitle}</dt>
                              <dd>
                                {copy().artifactEvidenceReads(entry().readCount)} ·{" "}
                                {copy().artifactEvidenceCreated(
                                  formatRuntimeTime(entry().reference.createdAt, language.locale()),
                                )}
                              </dd>
                            </div>
                          </>
                        )}
                      </Show>
                      <Show when={item.kind === "audit" ? item.record : undefined}>
                        {(record) => (
                          <>
                            <div>
                              <dt>{labels().audit}</dt>
                              <dd>
                                #{record().sequence} · {artifactActionText(record().action, language.locale())}
                              </dd>
                            </div>
                            <div>
                              <dt>{labels().source}</dt>
                              <dd>{record().actor}</dd>
                            </div>
                            <Show when={record().reason}>
                              <div>
                                <dt>{labels().audit}</dt>
                                <dd>{record().reason}</dd>
                              </div>
                            </Show>
                          </>
                        )}
                      </Show>
                    </dl>
                    <Show when={item.kind === "receipt" ? item.entry : undefined}>{entry =>
                      <div ref={element => setState("contentMount", element)} class="border-t border-border-weak-base pt-3" data-testid="artifact-content-inspector">
                        <h5>{entry().reference.label ?? entry().reference.kind} · {entry().reference.artifactID}</h5>
                      </div>
                    }</Show>
                    <p class="arforge-artifact-evidence-meta">{labels().boundary}</p>
                    <h5>{labels().related}</h5>
                    <For
                      each={state.audit.filter(
                        (record) =>
                          record.artifactID ===
                          (item.kind === "receipt" ? item.entry.reference.artifactID : item.record.artifactID),
                      )}
                      fallback={
                        <p class="arforge-artifact-evidence-meta">{copy().artifactEvidenceAuditEmpty(scope())}</p>
                      }
                    >
                      {(record) => (
                        <div class="arforge-artifact-evidence-row">
                          <span>
                            #{record.sequence} · {artifactActionText(record.action, language.locale())}
                          </span>
                          <span class="arforge-artifact-evidence-meta">
                            {record.actor} · {formatRuntimeTime(record.recordedAt, language.locale())}
                          </span>
                          <Show when={record.reason}>
                            <span class="arforge-artifact-evidence-meta">{record.reason}</span>
                          </Show>
                        </div>
                      )}
                    </For>
                  </div>
                )}
              </ManagementCollection>
              {/* Stable reader ownership, with content inside the existing collapsible details. */}
              <Show when={state.selectedArtifact} keyed>{selectedArtifact =>
                <Show when={state.contentMount}>{mount =>
                  <Show when={selectedReference()}>{reference =>
                    <Portal mount={mount()}>
                      <ArtifactContentPreview api={props.api} reference={reference()}
                        owner={props.sessionID?.trim() ? { scope: "session", id: props.sessionID.trim() } : props.owner}
                        scopeKey={evidenceScopeKey() + "\u0000" + selectedArtifact} ready={props.ready()} onRead={() => void load()} />
                    </Portal>
                  }</Show>
                }</Show>
              }</Show>
            </>
          )
        }}
      </Show>
    </article>
  )
}

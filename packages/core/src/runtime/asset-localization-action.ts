import { createHash } from "node:crypto"
import path from "node:path"
import posix from "node:path/posix"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { Cause, DateTime, Effect, Exit } from "effect"
import { ActionGateway } from "../action-gateway"
import { Egress } from "../egress"
import type { FileMutation } from "../file-mutation"
import * as MutationIntentRuntime from "./mutation-intent"
import * as AssetLocalization from "./asset-localization"

/** The single ActionGateway action name for the staged CDN localization path. */
export const ACTION_NAME = "asset-localization"

/**
 * A bounded resource marker used in the pre-fetch authorization request. The
 * exact content-addressed files are not known until the network responses are
 * validated, so the grant covers only the source HTML and the requested asset
 * directory. The adapter re-checks every final target against this prefix
 * before it records a durable mutation intent.
 */
export const filesystemPrefixResource = (discovery: AssetLocalization.AssetDiscovery): string =>
  `file-prefix:${posix.join(posix.dirname(discovery.htmlResource), discovery.assetRoot)}`

const uniqueSorted = (values: ReadonlyArray<string>): ReadonlyArray<string> =>
  [...new Set(values.filter((value) => value.length > 0))].sort()

/** Resources shown to the one ActionGateway permission request. */
export const actionResources = (discovery: AssetLocalization.AssetDiscovery): ReadonlyArray<string> =>
  uniqueSorted([...discovery.networkScope, `file:${discovery.htmlResource}`, filesystemPrefixResource(discovery)])

/**
 * Build the exact authorization plan used by the adapter. No wildcard is
 * added: the network list is the immutable discovery snapshot and the only
 * filesystem broadening is the bounded asset-root prefix described above.
 */
export const authorizationPlan = (discovery: AssetLocalization.AssetDiscovery): ActionGateway.AuthorizationPlan => ({
  requests: [{ action: ACTION_NAME, resources: actionResources(discovery) }],
  metadata: {
    schemaVersion: 1,
    discoveryDigest: discovery.requestDigest,
    networkScope: discovery.networkScope,
    filesystemScope: discovery.filesystemScope,
    filesystemPrefix: filesystemPrefixResource(discovery),
  },
})

export class AssetLocalizationBindingError extends Error {
  override readonly name = "AssetLocalizationBindingError"

  constructor(message: string) {
    super(message)
  }
}

/** Raised when durable settlement could not be recorded after files committed. */
export class AssetLocalizationSettlementUnknownError extends Error {
  override readonly name = "AssetLocalizationSettlementUnknownError"

  constructor() {
    super("Asset localization committed its files, but durable settlement is unknown; inspect before retrying.")
  }
}

export type AssetLocalizationReadFile = (target: FileMutation.Target) => Effect.Effect<Uint8Array | undefined, unknown>

/**
 * The fetcher is deliberately a callback rather than a second HTTP client.
 * The callback receives the already gateway-scoped egress authorizer and must
 * use it for the initial request and every redirect hop. The adapter repeats
 * those assertions over the returned chain before any write, which turns a
 * malformed or dishonest transport result into a fail-closed error.
 */
export type AssetLocalizationFetcher = (input: {
  readonly url: string
  readonly egress: Egress.Authorizer
}) => Effect.Effect<AssetLocalization.FetchedAsset, unknown>

export type AssetLocalizationActionResult = Readonly<{
  readonly changed: boolean
  readonly discoveryDigest: string
  readonly planDigest: string
  readonly idempotencyKey: string
  readonly targets: ReadonlyArray<string>
  readonly transactionID?: AgentRuntime.MutationTransactionID
}>

/**
 * Metadata-only progress emitted by the asset adapter.  It is deliberately
 * the same bounded update consumed by ActionGateway, so a host can either
 * persist it in the Action aggregate or observe it locally during a dry-run.
 */
export type AssetLocalizationProgress = AgentRuntime.ActionProgressUpdate

export type AssetLocalizationProgressObserver = (update: AssetLocalizationProgress) => Effect.Effect<void, unknown>

export type AssetLocalizationActionInput = Readonly<{
  /** The gateway must be the same owner used by the surrounding tool pipeline. */
  readonly gateway: Pick<ActionGateway.Interface, "execute" | "recordMutationIntent">
  readonly worktree: string
  readonly htmlResource: string
  readonly assetRoot?: string
  /** Pure callback that builds the session/control-plane Action input. */
  readonly action: (discovery: AssetLocalization.AssetDiscovery) => ActionGateway.Input
  readonly readFile: AssetLocalizationReadFile
  /** The canonical Core FileMutation owner supplied by the host adapter. */
  readonly files: Pick<FileMutation.Interface, "create" | "writeIfUnchanged" | "rollback">
  readonly fetchAsset: AssetLocalizationFetcher
  /** Derives a leaf egress guard from the exact capability verified by Gateway. */
  readonly egress: (capability: ActionGateway.AuthorizationGrantCapability) => Egress.Authorizer
  /** Profile-owned inverse-byte store; omitting it is a hard pre-mutation error. */
  readonly storeRollbackArtifact: (bytes: Uint8Array) => Effect.Effect<AgentRuntime.MutationRollbackArtifact, unknown>
  /** Optional UI/test observer; durable hosts should use ActionGateway context. */
  readonly onProgress?: AssetLocalizationProgressObserver
}>

type PreparedWrite = Readonly<{
  readonly target: FileMutation.Target
  readonly content: Uint8Array
  readonly before?: Uint8Array
  readonly entry: AgentRuntime.MutationIntentEntry
}>

type JournalEntry = FileMutation.RollbackInput

const bytesOf = (value: string | Uint8Array): Uint8Array =>
  typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value)

const digestOf = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex")

/** Local progress observers are best-effort and can never change execution. */
const notifyLocalProgress = (input: AssetLocalizationActionInput, update: AssetLocalizationProgress) =>
  input.onProgress === undefined
    ? Effect.void
    : Effect.suspend(() => input.onProgress!(update)).pipe(Effect.catch(() => Effect.void))

/** Durable progress is routed through the existing ActionGateway owner. */
const reportProgress = (
  input: AssetLocalizationActionInput,
  context: ActionGateway.OperationExecutionContext | undefined,
  update: AssetLocalizationProgress,
) =>
  Effect.gen(function* () {
    yield* notifyLocalProgress(input, update)
    if (context?.reportProgress !== undefined) yield* context.reportProgress(update)
  })

const relativeTarget = (worktree: string, resource: string): FileMutation.Target => {
  const normalized = resource.trim().replaceAll("\\", "/")
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    normalized.includes("\u0000") ||
    normalized.split("/").some((part) => part === "..") ||
    /^[A-Za-z]:\//.test(normalized)
  )
    throw new AssetLocalizationBindingError("A localization target must be workspace-relative.")
  const root = path.resolve(worktree)
  const canonical = path.resolve(root, normalized.split("/").join(path.sep))
  const relative = path.relative(root, canonical)
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`))
    throw new AssetLocalizationBindingError("A localization target escapes the active workspace.")
  return { canonical, resource: normalized }
}

const targetInsideAssetRoot = (target: string, discovery: AssetLocalization.AssetDiscovery): boolean => {
  if (target === discovery.htmlResource) return true
  const prefix = posix.join(posix.dirname(discovery.htmlResource), discovery.assetRoot)
  const relative = posix.relative(prefix, target)
  return relative.length > 0 && relative !== ".." && !relative.startsWith("../") && !relative.startsWith("/")
}

const validateActionBinding = (action: ActionGateway.Input, discovery: AssetLocalization.AssetDiscovery): void => {
  if (action.name !== ACTION_NAME)
    throw new AssetLocalizationBindingError(`The ActionGateway action must be named ${ACTION_NAME}.`)
  if (action.inputDigest !== discovery.requestDigest)
    throw new AssetLocalizationBindingError(
      "The ActionGateway inputDigest must equal the immutable asset discovery digest.",
    )
  const expected = actionResources(discovery)
  if (JSON.stringify(uniqueSorted(action.resources)) !== JSON.stringify(expected))
    throw new AssetLocalizationBindingError(
      "The ActionGateway resources do not exactly match the asset discovery network and filesystem scope.",
    )
}

const assertRedirectScope = (
  egress: Egress.Authorizer,
  fetched: AssetLocalization.FetchedAsset,
): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    let redirectFrom = fetched.url
    for (const redirect of fetched.redirects ?? []) {
      yield* egress.assert({ url: redirect, method: "GET", redirectFrom })
      redirectFrom = redirect
    }
    const finalURL = fetched.finalURL ?? fetched.redirects?.at(-1) ?? fetched.url
    if (finalURL !== redirectFrom) yield* egress.assert({ url: finalURL, method: "GET", redirectFrom })
  })

const validRollbackArtifact = (
  value: AgentRuntime.MutationRollbackArtifact,
  before: Uint8Array,
): AgentRuntime.MutationRollbackArtifact => {
  const digest = digestOf(before)
  if (
    value.version !== 1 ||
    value.digest !== digest ||
    value.byteLength !== before.byteLength ||
    value.artifactID !== `rollback-${digest}`
  )
    throw new AssetLocalizationBindingError("The rollback artifact does not bind to the observed preimage.")
  return value
}

const makeRecorder = (input: {
  readonly gateway: Pick<ActionGateway.Interface, "recordMutationIntent">
  readonly actionID: AgentRuntime.ActionID
  readonly transactionID: AgentRuntime.MutationTransactionID
  readonly entries: ReadonlyArray<AgentRuntime.MutationIntentEntry>
}) => {
  if (input.gateway.recordMutationIntent === undefined)
    throw new AssetLocalizationBindingError("Durable mutation intent recording is unavailable.")
  const manifestDigest = MutationIntentRuntime.manifestDigest(input.entries)
  if (manifestDigest === undefined)
    throw new AssetLocalizationBindingError("Localization mutation metadata is not canonically hashable.")
  const createdAt = DateTime.makeUnsafe(Date.now())
  let updatedAtMs = DateTime.toEpochMillis(createdAt)
  return {
    transactionID: input.transactionID,
    record: (phase: AgentRuntime.MutationIntentPhase, summary: string) =>
      Effect.gen(function* () {
        updatedAtMs = Math.max(Date.now(), updatedAtMs + 1)
        yield* input.gateway.recordMutationIntent!({
          actionID: input.actionID,
          transactionID: input.transactionID,
          phase,
          entries: input.entries,
          manifestDigest,
          createdAt,
          updatedAt: DateTime.makeUnsafe(updatedAtMs),
          summary,
        })
      }),
  }
}

const recoverAfterFailure = (input: {
  readonly recorder: ReturnType<typeof makeRecorder>
  readonly journal: ReadonlyArray<JournalEntry>
  readonly files: Pick<FileMutation.Interface, "rollback">
  readonly cause: Cause.Cause<unknown>
}) =>
  Effect.gen(function* () {
    const original = Cause.squash(input.cause)
    const originalError = original instanceof Error ? original : new Error(String(original))
    let rollbackPhaseRecorded = false
    const rollbackRequired = yield* input.recorder
      .record("rollback_required", "Asset localization requires compensation")
      .pipe(Effect.exit)
    rollbackPhaseRecorded = Exit.isSuccess(rollbackRequired)

    const failures: Error[] = []
    for (const entry of input.journal.toReversed()) {
      const exit = yield* input.files.rollback(entry).pipe(Effect.uninterruptible, Effect.exit)
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause)
        failures.push(error instanceof Error ? error : new Error(String(error)))
      }
    }

    if (rollbackPhaseRecorded) {
      yield* input.recorder
        .record(
          failures.length === 0 ? "rolled_back" : "rollback_blocked",
          failures.length === 0
            ? "Asset localization compensation completed"
            : "Asset localization compensation is blocked",
        )
        .pipe(Effect.exit, Effect.asVoid)
    }

    if (failures.length > 0)
      return yield* Effect.fail(
        new Error(`Asset localization failed and compensation is blocked: ${originalError.message}`),
      )
    return yield* Effect.fail(new Error(`Asset localization failed and was rolled back: ${originalError.message}`))
  })

const executeOperation =
  (input: AssetLocalizationActionInput, discovery: AssetLocalization.AssetDiscovery, actionID: AgentRuntime.ActionID) =>
  (
    capability: ActionGateway.AuthorizationGrantCapability,
    context?: ActionGateway.OperationExecutionContext,
  ): Effect.Effect<AssetLocalizationActionResult, unknown> =>
    Effect.gen(function* () {
      // The capability is intentionally not inspected here. The surrounding
      // gateway already verified it; the caller derives the leaf egress from
      // this exact capability and the adapter checks it on every hop.
      yield* reportProgress(input, context, {
        phase: "executing",
        completed: 0,
        total: discovery.networkScope.length,
        detail: "Asset localization execution admitted",
      })
      const egress = input.egress(capability)
      const htmlTarget = relativeTarget(input.worktree, discovery.htmlResource)
      const fetchedAssets: AssetLocalization.FetchedAsset[] = []
      for (const [index, url] of discovery.networkScope.entries()) {
        yield* reportProgress(input, context, {
          phase: "fetching",
          completed: index,
          total: discovery.networkScope.length,
          detail: `Fetching asset ${index + 1} of ${discovery.networkScope.length}`,
        })
        yield* egress.assert({ url, method: "GET" })
        const fetched = yield* input.fetchAsset({ url, egress })
        yield* assertRedirectScope(egress, fetched)
        fetchedAssets.push(fetched)
        yield* reportProgress(input, context, {
          phase: "fetching",
          completed: index + 1,
          total: discovery.networkScope.length,
          detail: `Fetched asset ${index + 1} of ${discovery.networkScope.length}`,
        })
      }

      const freshHTML = yield* input.readFile(htmlTarget)
      if (freshHTML === undefined)
        return yield* Effect.fail(
          new AssetLocalization.AssetLocalizationError("invalid_html", "The HTML source file was not found."),
        )
      yield* reportProgress(input, context, {
        phase: "planning",
        completed: discovery.networkScope.length,
        total: discovery.networkScope.length,
        detail: "Rebuilding the exact localization plan",
      })
      const plan = yield* Effect.try({
        try: () =>
          AssetLocalization.plan({
            htmlResource: discovery.htmlResource,
            html: freshHTML,
            assetRoot: discovery.assetRoot,
            discovery,
            fetchedAssets,
          }),
        catch: (error) => error,
      })

      for (const write of plan.writes) {
        if (!targetInsideAssetRoot(write.target, discovery))
          return yield* Effect.fail(
            new AssetLocalizationBindingError("A planned write escapes the approved asset root."),
          )
      }

      if (!plan.changed)
        yield* reportProgress(input, context, {
          phase: "settled",
          completed: discovery.networkScope.length,
          total: discovery.networkScope.length,
          detail: "No external assets needed localization",
        })
      if (!plan.changed)
        return {
          changed: false,
          discoveryDigest: discovery.requestDigest,
          planDigest: plan.inputDigest,
          idempotencyKey: plan.idempotencyKey,
          targets: [],
        }

      if (input.gateway.recordMutationIntent === undefined)
        return yield* Effect.fail(
          new AssetLocalizationBindingError("Durable mutation intent recording is unavailable."),
        )

      const prepared: PreparedWrite[] = []
      const seen = new Set<string>()
      for (const write of plan.writes) {
        if (seen.has(write.target))
          return yield* Effect.fail(
            new AssetLocalizationBindingError("The localization plan contains duplicate targets."),
          )
        seen.add(write.target)
        const target = relativeTarget(input.worktree, write.target)
        const content = bytesOf(write.content)
        if (digestOf(content) !== write.digest)
          return yield* Effect.fail(
            new AssetLocalizationBindingError("A planned write digest does not match its content."),
          )
        const before = yield* input.readFile(target)
        if (
          write.target === discovery.htmlResource &&
          (before === undefined || digestOf(before) !== discovery.htmlDigest)
        )
          return yield* Effect.fail(
            new AssetLocalization.AssetLocalizationError(
              "discovery_mismatch",
              "The HTML changed after discovery; restart asset localization.",
            ),
          )
        const entry =
          before === undefined
            ? ({
                target: target.resource,
                operation: "create",
                afterDigest: digestOf(content),
                afterByteLength: content.byteLength,
                recovery: "remove-if-matching",
              } satisfies AgentRuntime.MutationIntentEntry)
            : ({
                target: target.resource,
                operation: "write",
                beforeDigest: digestOf(before),
                afterDigest: digestOf(content),
                afterByteLength: content.byteLength,
                rollbackArtifact: validRollbackArtifact(
                  yield* input.storeRollbackArtifact(new Uint8Array(before)),
                  before,
                ),
                recovery: "restore-from-artifact",
              } satisfies AgentRuntime.MutationIntentEntry)
        prepared.push({ target, content, ...(before === undefined ? {} : { before: new Uint8Array(before) }), entry })
      }

      const transactionID = AgentRuntime.MutationTransactionID.create()
      const recorder = makeRecorder({
        gateway: input.gateway,
        actionID,
        transactionID,
        entries: prepared.map((item) => item.entry),
      })
      const journal: JournalEntry[] = []
      const files = input.files

      const result = yield* Effect.uninterruptible(
        Effect.gen(function* () {
          yield* recorder.record("prepared", "Asset localization mutation prepared")
          yield* reportProgress(input, context, {
            phase: "prepared",
            completed: 0,
            total: prepared.length,
            detail: "Mutation intent prepared",
          })
          yield* reportProgress(input, context, {
            phase: "committing",
            completed: 0,
            total: prepared.length,
            detail: "Committing localized assets with CAS",
          })
          const committed = yield* Effect.exit(
            Effect.gen(function* () {
              for (const [index, item] of prepared.entries()) {
                if (item.before === undefined) {
                  yield* files.create({ target: item.target, content: item.content })
                  journal.push({ kind: "remove-created", target: item.target, expected: item.content })
                } else {
                  yield* files.writeIfUnchanged({ target: item.target, expected: item.before, content: item.content })
                  journal.push({ kind: "restore", target: item.target, expected: item.content, content: item.before })
                }
                yield* reportProgress(input, context, {
                  phase: "committing",
                  completed: index + 1,
                  total: prepared.length,
                  detail: `Committed file ${index + 1} of ${prepared.length}`,
                })
              }
              yield* recorder.record("committed", "Asset localization files committed")
              yield* reportProgress(input, context, {
                phase: "committed",
                completed: prepared.length,
                total: prepared.length,
                detail: "Localized files committed",
              })
            }),
          )
          if (Exit.isFailure(committed))
            return yield* recoverAfterFailure({ recorder, journal, files, cause: committed.cause })

          const settled = yield* recorder.record("settled", "Asset localization transaction settled").pipe(Effect.exit)
          if (Exit.isFailure(settled)) {
            yield* recorder
              .record("outcome_unknown", "Asset localization settlement is unknown")
              .pipe(Effect.exit, Effect.asVoid)
            yield* notifyLocalProgress(input, {
              phase: "outcome_unknown",
              completed: prepared.length,
              total: prepared.length,
              detail: "Durable settlement is unknown; inspect before retrying",
            })
            return yield* Effect.fail(new AssetLocalizationSettlementUnknownError())
          }
          yield* reportProgress(input, context, {
            phase: "settled",
            completed: prepared.length,
            total: prepared.length,
            detail: "Asset localization transaction settled",
          })
          return {
            changed: true,
            discoveryDigest: discovery.requestDigest,
            planDigest: plan.inputDigest,
            idempotencyKey: plan.idempotencyKey,
            targets: plan.writes.map((write) => write.target),
            transactionID,
          }
        }),
      )
      return result
    }).pipe(
      Effect.onExit((exit) =>
        Exit.isSuccess(exit)
          ? Effect.void
          : notifyLocalProgress(input, {
              phase: Cause.hasInterruptsOnly(exit.cause) ? "cancelled" : "failed",
              completed: 0,
              total: discovery.networkScope.length,
              detail: Cause.hasInterruptsOnly(exit.cause)
                ? "Asset localization was cancelled before settlement"
                : "Asset localization failed closed",
            }),
      ),
    )

// Keeping action construction and validation local makes the operation
// independent of any session/control-plane subject implementation.
const actionForDiscovery = (input: AssetLocalizationActionInput, discovery: AssetLocalization.AssetDiscovery) => {
  const action = input.action(discovery)
  validateActionBinding(action, discovery)
  return action
}

/**
 * Execute one staged localization through the existing ActionGateway. The
 * source is discovered before authorization; downloads occur only after the
 * gateway operation starts; the fresh source is then re-planned and every
 * mutation is committed by Core FileMutation with a durable inverse manifest.
 */
export const execute = (input: AssetLocalizationActionInput): Effect.Effect<AssetLocalizationActionResult, unknown> =>
  Effect.gen(function* () {
    const htmlTarget = relativeTarget(input.worktree, input.htmlResource)
    const html = yield* input.readFile(htmlTarget)
    if (html === undefined)
      return yield* Effect.fail(
        new AssetLocalization.AssetLocalizationError("invalid_html", "The HTML source file was not found."),
      )
    const discovery = AssetLocalization.discover({
      htmlResource: input.htmlResource,
      html,
      assetRoot: input.assetRoot,
    })
    yield* notifyLocalProgress(input, {
      phase: "executing",
      completed: 0,
      total: discovery.networkScope.length,
      detail: "Asset localization request discovered",
    })
    yield* notifyLocalProgress(input, {
      phase: "fetching",
      completed: 0,
      total: discovery.networkScope.length,
      detail: "Waiting for the authorization gate",
    })
    const action = actionForDiscovery(input, discovery)
    const authorization = authorizationPlan(discovery)
    return yield* input.gateway.execute(action, {
      authorization,
      execute: (capability, context) => executeOperation(input, discovery, action.actionID)(capability, context),
      outcomeUnknownOnFailure: (error) => error instanceof AssetLocalizationSettlementUnknownError,
      successSummary: (result) =>
        result.changed
          ? `Localized ${result.targets.length} asset files atomically`
          : "No external assets needed localization",
      durableResult: {
        encode: (result) => ({
          changed: result.changed,
          discoveryDigest: result.discoveryDigest,
          planDigest: result.planDigest,
          idempotencyKey: result.idempotencyKey,
          targets: result.targets,
          ...(result.transactionID === undefined ? {} : { transactionID: result.transactionID }),
        }),
        decode: (value) => value as AssetLocalizationActionResult,
      },
    })
  })

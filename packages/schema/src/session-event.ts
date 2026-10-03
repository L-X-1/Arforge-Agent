export * as SessionEvent from "./session-event"

import { Schema } from "effect"
import { optional } from "./schema"
import { Event } from "./event"
import { ProviderMetadata, ToolContent } from "./llm"
import { Delivery } from "./session-delivery"
import { Model } from "./model"
import { DateTimeUtcFromMillis, NonNegativeInt, PositiveInt, RelativePath } from "./schema"
import { FileAttachment, Prompt } from "./prompt"
import { SessionID } from "./session-id"
import { Location } from "./location"
import { SessionMessage } from "./session-message"
import { Revert } from "./revert"
import { PrimaryDelivery } from "./primary-delivery"
import { Memory } from "./memory"
import { AgentRuntime } from "./agent-runtime"

export { FileAttachment }

export const Source = Schema.Struct({
  start: NonNegativeInt,
  end: NonNegativeInt,
  text: Schema.String,
}).annotate({
  identifier: "session.next.event.source",
})
export interface Source extends Schema.Schema.Type<typeof Source> {}

const Base = {
  timestamp: DateTimeUtcFromMillis,
  sessionID: SessionID,
}
const PromptFields = {
  ...Base,
  messageID: SessionMessage.ID,
  prompt: Prompt,
  delivery: Delivery,
}

const options = {
  durable: {
    aggregate: "sessionID",
    version: 1,
  },
} as const
const stepSettlementOptions = {
  durable: {
    aggregate: "sessionID",
    version: 2,
  },
} as const

export const UnknownError = SessionMessage.UnknownError
export type UnknownError = SessionMessage.UnknownError

export const AgentSwitched = Event.define({
  type: "session.next.agent.switched",
  ...options,
  schema: {
    ...Base,
    messageID: SessionMessage.ID,
    agent: Schema.String,
  },
})
export type AgentSwitched = typeof AgentSwitched.Type

export const ModelSwitched = Event.define({
  type: "session.next.model.switched",
  ...options,
  schema: {
    ...Base,
    messageID: SessionMessage.ID,
    model: Model.Ref,
  },
})
export type ModelSwitched = typeof ModelSwitched.Type

/** A generated proposal; projection applies it only while the original default title is unchanged. */
export const TitleGenerated = Event.define({
  type: "session.next.title.generated",
  ...options,
  schema: {
    ...Base,
    messageID: SessionMessage.ID,
    expectedTitle: Schema.String,
    title: Schema.String,
  },
})
export type TitleGenerated = typeof TitleGenerated.Type

export const Moved = Event.define({
  type: "session.next.moved",
  ...options,
  schema: {
    ...Base,
    location: Location.Ref,
    subdirectory: RelativePath.pipe(optional),
  },
})
export type Moved = typeof Moved.Type

export const Prompted = Event.define({
  type: "session.next.prompted",
  ...options,
  schema: PromptFields,
})
export type Prompted = typeof Prompted.Type

export const PromptAdmitted = Event.define({
  type: "session.next.prompt.admitted",
  ...options,
  schema: PromptFields,
})
export type PromptAdmitted = typeof PromptAdmitted.Type

export const PromptQueueUpdated = Event.define({
  type: "session.next.prompt.queue.updated",
  ...options,
  schema: {
    ...PromptFields,
    expectedAdmittedSeq: NonNegativeInt,
  },
})
export type PromptQueueUpdated = typeof PromptQueueUpdated.Type

export const PromptQueueRemoved = Event.define({
  type: "session.next.prompt.queue.removed",
  ...options,
  schema: {
    ...Base,
    messageID: SessionMessage.ID,
    expectedAdmittedSeq: NonNegativeInt,
  },
})
export type PromptQueueRemoved = typeof PromptQueueRemoved.Type

export const ContextUpdated = Event.define({
  type: "session.next.context.updated",
  ...options,
  schema: {
    ...Base,
    messageID: SessionMessage.ID,
    text: Schema.String,
  },
})
export type ContextUpdated = typeof ContextUpdated.Type

const Sha256Digest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))

export const MemoryContextPrepared = Event.define({
  type: "session.next.memory.context.prepared",
  ...options,
  schema: {
    ...Base,
    userMessageID: SessionMessage.ID,
    turnStep: NonNegativeInt,
    queryDigest: Sha256Digest,
    contextDigest: Sha256Digest,
    injectedBytes: NonNegativeInt,
    status: Schema.Literals(["prepared", "unavailable"]),
    algorithm: Schema.Literal("hybrid_bm25_hashing_vector"),
    localOnly: Schema.Literal(true),
    candidates: Schema.Array(
      Schema.Struct({
        memoryID: Memory.ID,
        rank: PositiveInt,
        score: Schema.Finite,
        lexicalScore: Schema.Finite,
        vectorScore: Schema.Finite,
      }),
    ),
  },
})
export type MemoryContextPrepared = typeof MemoryContextPrepared.Type

const FusionContextComponent = Schema.Struct({
  status: Schema.Literals(["prepared", "unavailable"]),
  contextDigest: Sha256Digest,
  injectedBytes: NonNegativeInt,
})

export const ContextFusionPrepared = Event.define({
  type: "session.next.context.fusion.prepared",
  ...options,
  schema: {
    ...Base,
    userMessageID: SessionMessage.ID,
    turnStep: NonNegativeInt,
    queryDigest: Sha256Digest,
    combinedContextDigest: Sha256Digest,
    totalInjectedBytes: NonNegativeInt,
    providerCallReady: Schema.Literal(true),
    degraded: Schema.Boolean,
    // Legacy bridge metadata remains optional so durable events written by the
    // retired Python sidecar can still be decoded and audited.
    bridgeProtocol: Schema.Literal("arforge.bridge/1.2").pipe(optional),
    assemblyProtocol: Schema.Literal("arforge.context/2").pipe(optional),
    runtimeTopology: Schema.Literals(["typescript-single-runtime", "legacy-dual-runtime"]).pipe(optional),
    memory: Schema.Struct({
      runtime: Schema.Literal("typescript-core"),
      ...FusionContextComponent.fields,
      candidateCount: NonNegativeInt,
    }),
    learning: Schema.Struct({ runtime: Schema.Literal("typescript-core"), ...FusionContextComponent.fields }),
    evolution: Schema.Struct({
      runtime: Schema.Literals(["typescript-core", "python-sidecar"]),
      ...FusionContextComponent.fields,
      activeCandidateCount: NonNegativeInt,
      injectedCandidateCount: NonNegativeInt,
    }),
  },
})
export type ContextFusionPrepared = typeof ContextFusionPrepared.Type

/**
 * Durable projection of the exact provider request boundary. The serialized
 * envelope is normalized JSON with no credential value; the digest is kept as
 * a queryable index and is verified again before replay reconstruction.
 */
export const RequestEnvelopePrepared = Event.define({
  type: "session.next.request.envelope.prepared",
  ...options,
  schema: {
    ...Base,
    runID: AgentRuntime.RunID,
    turnStep: NonNegativeInt,
    /** Optional bounded attempt identity; omitted by pre-attempt legacy events. */
    attempt: PositiveInt.pipe(optional),
    schemaVersion: Schema.Literal("1.0"),
    requestDigest: Sha256Digest,
    envelope: Schema.String,
  },
})
export type RequestEnvelopePrepared = typeof RequestEnvelopePrepared.Type

/**
 * Metadata-only mature request binding. Unlike RequestEnvelopePrepared this
 * event intentionally carries no serialized request body; it only records the
 * bounded owner/attempt identity and the digests needed for reconciliation.
 */
export const RequestBindingPrepared = Event.define({
  type: "session.next.request.binding.prepared",
  ...options,
  schema: {
    ...Base,
    runID: AgentRuntime.RunID,
    turnStep: PositiveInt,
    attempt: PositiveInt,
    schemaVersion: Schema.Literal(1),
    runtime: Schema.Literals(["native", "ai-sdk"]),
    mode: Schema.Literals(["native-envelope", "prepared-projection"]),
    requestDigest: Sha256Digest,
    contextDigest: Sha256Digest,
    toolSetRevision: Sha256Digest,
    routeConfigRevision: Sha256Digest,
    /** Optional SkillV2 snapshot identity used to assemble the request. */
    skillSnapshotDigest: Sha256Digest.pipe(optional),
    compilerRevision: Schema.String,
  },
})
export type RequestBindingPrepared = typeof RequestBindingPrepared.Type

export const Synthetic = Event.define({
  type: "session.next.synthetic",
  ...options,
  schema: {
    ...Base,
    messageID: SessionMessage.ID,
    text: Schema.String,
  },
})
export type Synthetic = typeof Synthetic.Type

export namespace Shell {
  export const Started = Event.define({
    type: "session.next.shell.started",
    ...options,
    schema: {
      ...Base,
      messageID: SessionMessage.ID,
      callID: Schema.String,
      command: Schema.String,
    },
  })
  export type Started = typeof Started.Type

  export const Ended = Event.define({
    type: "session.next.shell.ended",
    ...options,
    schema: {
      ...Base,
      callID: Schema.String,
      output: Schema.String,
    },
  })
  export type Ended = typeof Ended.Type
}

export namespace Step {
  export const Started = Event.define({
    type: "session.next.step.started",
    ...options,
    schema: {
      ...Base,
      assistantMessageID: SessionMessage.ID,
      runID: AgentRuntime.RunID.pipe(optional),
      requestDigest: Sha256Digest.pipe(optional),
      agent: Schema.String,
      model: Model.Ref,
      snapshot: Schema.String.pipe(optional),
    },
  })
  export type Started = typeof Started.Type

  export const Ended = Event.define({
    type: "session.next.step.ended",
    ...stepSettlementOptions,
    schema: {
      ...Base,
      assistantMessageID: SessionMessage.ID,
      finish: Schema.String,
      cost: Schema.Finite,
      tokens: Schema.Struct({
        input: Schema.Finite,
        output: Schema.Finite,
        reasoning: Schema.Finite,
        cache: Schema.Struct({
          read: Schema.Finite,
          write: Schema.Finite,
        }),
      }),
      snapshot: Schema.String.pipe(optional),
      files: Schema.Array(RelativePath).pipe(optional),
      structured: Schema.Record(Schema.String, Schema.Json).pipe(optional),
    },
  })
  export type Ended = typeof Ended.Type

  export const Failed = Event.define({
    type: "session.next.step.failed",
    ...stepSettlementOptions,
    schema: {
      ...Base,
      assistantMessageID: SessionMessage.ID,
      error: UnknownError,
    },
  })
  export type Failed = typeof Failed.Type
}

export namespace Text {
  export const Started = Event.define({
    type: "session.next.text.started",
    ...options,
    schema: {
      ...Base,
      assistantMessageID: SessionMessage.ID,
      textID: Schema.String,
    },
  })
  export type Started = typeof Started.Type

  // Stream fragments are live-only; Text.Ended is the replayable full-value boundary.
  export const Delta = Event.define({
    type: "session.next.text.delta",
    schema: {
      ...Base,
      assistantMessageID: SessionMessage.ID,
      textID: Schema.String,
      delta: Schema.String,
    },
  })
  export type Delta = typeof Delta.Type

  export const Ended = Event.define({
    type: "session.next.text.ended",
    ...options,
    schema: {
      ...Base,
      assistantMessageID: SessionMessage.ID,
      textID: Schema.String,
      text: Schema.String,
    },
  })
  export type Ended = typeof Ended.Type
}

export const PrimaryDelivered = Event.define({
  type: "session.next.primary.delivered",
  ...options,
  schema: {
    ...Base,
    assistantMessageID: SessionMessage.ID,
    callID: Schema.String,
    message: Schema.String,
    delivery: PrimaryDelivery.Metadata,
  },
})
export type PrimaryDelivered = typeof PrimaryDelivered.Type

export namespace Reasoning {
  export const Started = Event.define({
    type: "session.next.reasoning.started",
    ...options,
    schema: {
      ...Base,
      assistantMessageID: SessionMessage.ID,
      reasoningID: Schema.String,
      providerMetadata: ProviderMetadata.pipe(optional),
    },
  })
  export type Started = typeof Started.Type

  // Stream fragments are live-only; Reasoning.Ended is the replayable full-value boundary.
  export const Delta = Event.define({
    type: "session.next.reasoning.delta",
    schema: {
      ...Base,
      assistantMessageID: SessionMessage.ID,
      reasoningID: Schema.String,
      delta: Schema.String,
    },
  })
  export type Delta = typeof Delta.Type

  export const Ended = Event.define({
    type: "session.next.reasoning.ended",
    ...options,
    schema: {
      ...Base,
      assistantMessageID: SessionMessage.ID,
      reasoningID: Schema.String,
      text: Schema.String,
      providerMetadata: ProviderMetadata.pipe(optional),
    },
  })
  export type Ended = typeof Ended.Type
}

export namespace Tool {
  const ToolBase = {
    ...Base,
    assistantMessageID: SessionMessage.ID,
    callID: Schema.String,
  }

  export namespace Input {
    export const Started = Event.define({
      type: "session.next.tool.input.started",
      ...options,
      schema: {
        ...ToolBase,
        name: Schema.String,
      },
    })
    export type Started = typeof Started.Type

    // Stream fragments are live-only; Input.Ended is the replayable raw-input boundary.
    export const Delta = Event.define({
      type: "session.next.tool.input.delta",
      schema: {
        ...ToolBase,
        delta: Schema.String,
      },
    })
    export type Delta = typeof Delta.Type

    export const Ended = Event.define({
      type: "session.next.tool.input.ended",
      ...options,
      schema: {
        ...ToolBase,
        text: Schema.String,
      },
    })
    export type Ended = typeof Ended.Type
  }

  export const Called = Event.define({
    type: "session.next.tool.called",
    ...options,
    schema: {
      ...ToolBase,
      tool: Schema.String,
      input: Schema.Record(Schema.String, Schema.Unknown),
      provider: Schema.Struct({
        executed: Schema.Boolean,
        metadata: ProviderMetadata.pipe(optional),
      }),
    },
  })
  export type Called = typeof Called.Type

  /**
   * Replayable bounded running-tool state. Tools should checkpoint semantic
   * transitions or at a bounded cadence, not persist every stdout/stderr chunk.
   */
  export const Progress = Event.define({
    type: "session.next.tool.progress",
    ...options,
    schema: {
      ...ToolBase,
      structured: Schema.Record(Schema.String, Schema.Unknown),
      content: Schema.Array(ToolContent),
    },
  })
  export type Progress = typeof Progress.Type

  export const Success = Event.define({
    type: "session.next.tool.success",
    ...options,
    schema: {
      ...ToolBase,
      structured: Schema.Record(Schema.String, Schema.Unknown),
      content: Schema.Array(ToolContent),
      /** New storage-safe projection; outputPaths remains compatibility-only. */
      artifactRefs: Schema.Array(Schema.suspend(() => AgentRuntime.OpaqueArtifactRef)).pipe(optional),
      outputPaths: Schema.Array(Schema.String).pipe(optional),
      result: Schema.Unknown.pipe(optional),
      provider: Schema.Struct({
        executed: Schema.Boolean,
        metadata: ProviderMetadata.pipe(optional),
      }),
    },
  })
  export type Success = typeof Success.Type

  export const Failed = Event.define({
    type: "session.next.tool.failed",
    ...options,
    schema: {
      ...ToolBase,
      error: UnknownError,
      content: Schema.Array(ToolContent).pipe(optional),
      structured: Schema.Record(Schema.String, Schema.Unknown).pipe(optional),
      artifactRefs: Schema.Array(Schema.suspend(() => AgentRuntime.OpaqueArtifactRef)).pipe(optional),
      outputPaths: Schema.Array(Schema.String).pipe(optional),
      result: Schema.Unknown.pipe(optional),
      provider: Schema.Struct({
        executed: Schema.Boolean,
        metadata: ProviderMetadata.pipe(optional),
      }),
    },
  })
  export type Failed = typeof Failed.Type
}

export const RetryError = Schema.Struct({
  message: Schema.String,
  statusCode: Schema.Finite.pipe(optional),
  isRetryable: Schema.Boolean,
  responseHeaders: Schema.Record(Schema.String, Schema.String).pipe(optional),
  responseBody: Schema.String.pipe(optional),
  metadata: Schema.Record(Schema.String, Schema.String).pipe(optional),
}).annotate({
  identifier: "session.next.retry_error",
})
export interface RetryError extends Schema.Schema.Type<typeof RetryError> {}

export const Retried = Event.define({
  type: "session.next.retried",
  ...options,
  schema: {
    ...Base,
    attempt: Schema.Finite,
    error: RetryError,
  },
})
export type Retried = typeof Retried.Type

export namespace Compaction {
  /** Current durable preparation evidence; not a visible conversation message. */
  export const RequestPrepared = Event.define({
    type: "session.next.compaction.request.prepared",
    ...options,
    schema: {
      ...Base,
      messageID: SessionMessage.ID,
      requestDigest: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
      envelope: Schema.String,
    },
  })
  export type RequestPrepared = typeof RequestPrepared.Type

  export const Started = Event.define({
    type: "session.next.compaction.started",
    ...options,
    schema: {
      ...Base,
      messageID: SessionMessage.ID,
      reason: Schema.Union([Schema.Literal("auto"), Schema.Literal("manual")]),
    },
  })
  export type Started = typeof Started.Type

  export const Delta = Event.define({
    type: "session.next.compaction.delta",
    schema: {
      ...Base,
      messageID: SessionMessage.ID,
      text: Schema.String,
    },
  })
  export type Delta = typeof Delta.Type

  export const Ended = Event.define({
    type: "session.next.compaction.ended",
    ...options,
    schema: {
      ...Base,
      messageID: SessionMessage.ID,
      reason: Started.data.fields.reason,
      text: Schema.String,
      recent: Schema.String,
      /** Normalized provider usage consumed by the compaction request. Older
       * events omit this field and remain replay-compatible. */
      usage: Schema.Struct({
        cost: Schema.Finite,
        tokens: Schema.Struct({
          input: Schema.Finite,
          output: Schema.Finite,
          reasoning: Schema.Finite,
          cache: Schema.Struct({ read: Schema.Finite, write: Schema.Finite }),
        }),
      }).pipe(optional),
      /** Durable identity used to reconcile a crash between Session settlement
       * publication and the final semantic checkpoint. Optional for v1 events
       * written before transactional compaction was introduced. */
      operationID: Schema.NonEmptyString.pipe(optional),
      candidateDigest: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)).pipe(optional),
    },
  })
  export type Ended = typeof Ended.Type
}

export namespace RevertEvent {
  export const Staged = Event.define({
    type: "session.next.revert.staged",
    ...options,
    schema: { ...Base, revert: Revert.State },
  })
  export const Cleared = Event.define({ type: "session.next.revert.cleared", ...options, schema: Base })
  export const Committed = Event.define({
    type: "session.next.revert.committed",
    ...options,
    schema: { ...Base, messageID: SessionMessage.ID },
  })
}

export const DurableDefinitions = Event.inventory(
  TitleGenerated,
  AgentSwitched,
  ModelSwitched,
  Moved,
  Prompted,
  PromptAdmitted,
  PromptQueueUpdated,
  PromptQueueRemoved,
  ContextUpdated,
  MemoryContextPrepared,
  ContextFusionPrepared,
  RequestEnvelopePrepared,
  RequestBindingPrepared,
  Synthetic,
  Shell.Started,
  Shell.Ended,
  Step.Started,
  Step.Ended,
  Step.Failed,
  Text.Started,
  Text.Ended,
  PrimaryDelivered,
  Tool.Input.Started,
  Tool.Input.Ended,
  Tool.Called,
  Tool.Progress,
  Tool.Success,
  Tool.Failed,
  Reasoning.Started,
  Reasoning.Ended,
  Retried,
  Compaction.Started,
  Compaction.RequestPrepared,
  Compaction.Ended,
  RevertEvent.Staged,
  RevertEvent.Cleared,
  RevertEvent.Committed,
)

export const Definitions = Event.inventory(
  TitleGenerated,
  AgentSwitched,
  ModelSwitched,
  Moved,
  Prompted,
  PromptAdmitted,
  PromptQueueUpdated,
  PromptQueueRemoved,
  ContextUpdated,
  MemoryContextPrepared,
  ContextFusionPrepared,
  RequestEnvelopePrepared,
  RequestBindingPrepared,
  Synthetic,
  Shell.Started,
  Shell.Ended,
  Step.Started,
  Step.Ended,
  Step.Failed,
  Text.Started,
  Text.Delta,
  Text.Ended,
  PrimaryDelivered,
  Reasoning.Started,
  Reasoning.Delta,
  Reasoning.Ended,
  Tool.Input.Started,
  Tool.Input.Delta,
  Tool.Input.Ended,
  Tool.Called,
  Tool.Progress,
  Tool.Success,
  Tool.Failed,
  Retried,
  Compaction.Started,
  Compaction.RequestPrepared,
  Compaction.Delta,
  Compaction.Ended,
  RevertEvent.Staged,
  RevertEvent.Cleared,
  RevertEvent.Committed,
)

export const Durable = Schema.Union(DurableDefinitions, { mode: "oneOf" })
  .pipe(Schema.toTaggedUnion("type"))
  .annotate({ identifier: "SessionDurableEvent" })
export type DurableEvent = typeof Durable.Type

export const All = Schema.Union(Definitions, { mode: "oneOf" }).pipe(Schema.toTaggedUnion("type"))
export type Event = typeof All.Type
export type Type = Event["type"]

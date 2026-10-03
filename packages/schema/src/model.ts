export * as Model from "./model"

import { Schema } from "effect"
import { DateTimeUtcFromMillis, NonNegativeInt, optional } from "./schema"
import { Provider } from "./provider"
import { statics } from "./schema"
import { Billing } from "./billing"

export const ID = Schema.String.pipe(Schema.brand("ModelV2.ID"))
export type ID = typeof ID.Type

export const VariantID = Schema.String.pipe(Schema.brand("VariantID"))
export type VariantID = typeof VariantID.Type

export const Ref = Schema.Struct({
  id: ID,
  providerID: Provider.ID,
  variant: VariantID.pipe(optional),
}).annotate({ identifier: "Model.Ref" })
export interface Ref extends Schema.Schema.Type<typeof Ref> {}

export const Family = Schema.String.pipe(Schema.brand("Family"))
export type Family = typeof Family.Type

export interface Capabilities extends Schema.Schema.Type<typeof Capabilities> {}
export const Capabilities = Schema.Struct({
  tools: Schema.Boolean,
  input: Schema.Array(Schema.String),
  output: Schema.Array(Schema.String),
}).annotate({ identifier: "Model.Capabilities" })

export interface Cost extends Schema.Schema.Type<typeof Cost> {}
export const Cost = Schema.Struct({
  tier: Schema.Struct({
    type: Schema.Literal("context"),
    size: Schema.Int,
  }).pipe(optional),
  input: Schema.Finite,
  output: Schema.Finite,
  cache: Schema.Struct({
    read: Schema.Finite,
    write: Schema.Finite,
  }),
}).annotate({ identifier: "Model.Cost" })

/**
 * ModelProfile V1 is an additive, evidence-aware capability contract. Keep the
 * legacy `capabilities`, `limit`, and `cost` fields on `Info` during migration;
 * this profile is the canonical place for new model-runtime metadata.
 */
export const ProfileVersion = Schema.Literal("v1")
export type ProfileVersion = typeof ProfileVersion.Type

export const Modality = Schema.Literals(["text", "image", "audio", "video", "document"])
export type Modality = typeof Modality.Type

export const CapabilitySupport = Schema.Literals(["supported", "unsupported", "unknown"])
export type CapabilitySupport = typeof CapabilitySupport.Type

export const StructuredOutputSupport = Schema.Literals(["native", "synthetic_tool", "unsupported", "unknown"])
export type StructuredOutputSupport = typeof StructuredOutputSupport.Type

export const ReasoningSupport = Schema.Literals(["none", "effort", "budget", "provider_defined", "unknown"])
export type ReasoningSupport = typeof ReasoningSupport.Type

export const CacheSupport = Schema.Literals(["none", "implicit", "explicit", "provider_defined", "unknown"])
export type CacheSupport = typeof CacheSupport.Type

export interface ModalityProfile extends Schema.Schema.Type<typeof ModalityProfile> {}
export const ModalityProfile = Schema.Struct({
  input: Schema.Array(Modality),
  output: Schema.Array(Modality),
}).annotate({ identifier: "Model.ModalityProfile" })

export interface ProfileLimits extends Schema.Schema.Type<typeof ProfileLimits> {}
export const ProfileLimits = Schema.Struct({
  context: NonNegativeInt,
  input: optional(NonNegativeInt),
  output: NonNegativeInt,
}).annotate({ identifier: "Model.ProfileLimits" })

export interface ProfileCapabilities extends Schema.Schema.Type<typeof ProfileCapabilities> {}
export const ProfileCapabilities = Schema.Struct({
  tools: CapabilitySupport,
  structured: StructuredOutputSupport,
  reasoning: ReasoningSupport,
  cache: CacheSupport,
}).annotate({ identifier: "Model.ProfileCapabilities" })

export const ObservationKind = Schema.Literals(["latency", "error", "capability"])
export type ObservationKind = typeof ObservationKind.Type

export const ObservationStatus = Schema.Literals(["pass", "fail", "inconclusive"])
export type ObservationStatus = typeof ObservationStatus.Type

export const ObservationSource = Schema.Literals(["catalog", "recorded", "local", "live"])
export type ObservationSource = typeof ObservationSource.Type

export interface Observation extends Schema.Schema.Type<typeof Observation> {}
export const Observation = Schema.Struct({
  kind: ObservationKind,
  status: ObservationStatus,
  source: ObservationSource,
  sourceID: Schema.String,
  observedAt: DateTimeUtcFromMillis,
  expiresAt: optional(DateTimeUtcFromMillis),
  value: Schema.Json,
}).annotate({ identifier: "Model.Observation" })

export const RegionPolicyMode = Schema.Literals(["allowlist", "provider_default", "unknown"])
export type RegionPolicyMode = typeof RegionPolicyMode.Type

export interface RegionPolicy extends Schema.Schema.Type<typeof RegionPolicy> {}
export const RegionPolicy = Schema.Struct({
  mode: RegionPolicyMode,
  regions: Schema.Array(Schema.String),
}).annotate({ identifier: "Model.RegionPolicy" })

export const EgressPolicyMode = Schema.Literals(["provider", "proxy", "direct", "unknown"])
export type EgressPolicyMode = typeof EgressPolicyMode.Type

export interface EgressPolicy extends Schema.Schema.Type<typeof EgressPolicy> {}
export const EgressPolicy = Schema.Struct({
  mode: EgressPolicyMode,
  origins: Schema.Array(Schema.String),
}).annotate({ identifier: "Model.EgressPolicy" })

export const DataRetentionPolicy = Schema.Literals(["ephemeral", "provider_defined", "unknown"])
export type DataRetentionPolicy = typeof DataRetentionPolicy.Type

export const DataTrainingPolicy = Schema.Literals(["excluded", "provider_defined", "unknown"])
export type DataTrainingPolicy = typeof DataTrainingPolicy.Type

export interface DataPolicy extends Schema.Schema.Type<typeof DataPolicy> {}
export const DataPolicy = Schema.Struct({
  retention: DataRetentionPolicy,
  training: DataTrainingPolicy,
}).annotate({ identifier: "Model.DataPolicy" })

export interface ProfilePolicy extends Schema.Schema.Type<typeof ProfilePolicy> {}
export const ProfilePolicy = Schema.Struct({
  region: RegionPolicy,
  egress: EgressPolicy,
  data: DataPolicy,
}).annotate({ identifier: "Model.ProfilePolicy" })

export interface Profile extends Schema.Schema.Type<typeof Profile> {}
export const Profile = Schema.Struct({
  version: ProfileVersion,
  providerID: Provider.ID,
  modelID: ID,
  modality: ModalityProfile,
  limits: ProfileLimits,
  capabilities: ProfileCapabilities,
  tokenizer: Schema.String,
  estimator: Schema.String,
  priceCatalogRevision: Schema.String,
  observations: Schema.Array(Observation),
  policy: ProfilePolicy,
}).annotate({ identifier: "Model.Profile" })

export const Api = Schema.Union([
  Schema.Struct({
    id: ID,
    ...Provider.AISDK.fields,
  }),
  Schema.Struct({
    id: ID,
    ...Provider.Native.fields,
  }),
])
  .pipe(Schema.toTaggedUnion("type"))
  .annotate({ identifier: "Model.Api" })
export type Api = typeof Api.Type

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: ID,
  providerID: Provider.ID,
  family: Family.pipe(optional),
  name: Schema.String,
  api: Api,
  profile: Profile.pipe(optional),
  capabilities: Capabilities,
  request: Schema.Struct({
    ...Provider.Request.fields,
    variant: Schema.String.pipe(optional),
  }),
  variants: Schema.Struct({
    id: VariantID,
    ...Provider.Request.fields,
  }).pipe(Schema.Array),
  time: Schema.Struct({
    released: Schema.Finite,
  }),
  cost: Schema.Array(Cost),
  /** Optional verified catalog used by durable runtime metering. */
  priceCatalog: Billing.PriceCatalog.pipe(optional),
  status: Schema.Literals(["alpha", "beta", "deprecated", "active"]),
  enabled: Schema.Boolean,
  limit: Schema.Struct({
    context: Schema.Int,
    input: Schema.Int.pipe(optional),
    output: Schema.Int,
  }),
})
  .annotate({ identifier: "ModelV2.Info" })
  .pipe(
    statics((schema) => ({
      empty: (providerID: Provider.ID, modelID: ID) =>
        schema.make({
          id: modelID,
          providerID,
          name: modelID,
          api: { id: modelID, type: "native", settings: {} },
          capabilities: { tools: false, input: [], output: [] },
          request: { headers: {}, body: {} },
          variants: [],
          time: { released: 0 },
          cost: [],
          priceCatalog: undefined,
          status: "active",
          enabled: true,
          limit: { context: 0, output: 0 },
        }),
    })),
  )

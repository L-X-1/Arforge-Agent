import type { ArforgeEventEncoded } from "@arforge-ai/protocol/groups/event"

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<JsonValue>
  | { readonly [key: string]: JsonValue }

export type UnauthorizedError = { readonly _tag: "UnauthorizedError"; readonly message: string }
export const isUnauthorizedError = (value: unknown): value is UnauthorizedError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "UnauthorizedError"

export type InvalidRequestError = {
  readonly _tag: "InvalidRequestError"
  readonly message: string
  readonly kind?: string | undefined
  readonly field?: string | undefined
}
export const isInvalidRequestError = (value: unknown): value is InvalidRequestError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "InvalidRequestError"

export type InvalidCursorError = { readonly _tag: "InvalidCursorError"; readonly message: string }
export const isInvalidCursorError = (value: unknown): value is InvalidCursorError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "InvalidCursorError"

export type SessionNotFoundError = {
  readonly _tag: "SessionNotFoundError"
  readonly sessionID: string
  readonly message: string
}
export const isSessionNotFoundError = (value: unknown): value is SessionNotFoundError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "SessionNotFoundError"

export type ConflictError = {
  readonly _tag: "ConflictError"
  readonly message: string
  readonly resource?: string | undefined
}
export const isConflictError = (value: unknown): value is ConflictError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "ConflictError"

export type CheckpointNotFoundError = {
  readonly _tag: "CheckpointNotFoundError"
  readonly sessionID: string
  readonly checkpointID: string
  readonly message: string
}
export const isCheckpointNotFoundError = (value: unknown): value is CheckpointNotFoundError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "CheckpointNotFoundError"

export type MessageNotFoundError = {
  readonly _tag: "MessageNotFoundError"
  readonly sessionID: string
  readonly messageID: string
  readonly message: string
}
export const isMessageNotFoundError = (value: unknown): value is MessageNotFoundError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "MessageNotFoundError"

export type ServiceUnavailableError = {
  readonly _tag: "ServiceUnavailableError"
  readonly message: string
  readonly service?: string | undefined
}
export const isServiceUnavailableError = (value: unknown): value is ServiceUnavailableError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "ServiceUnavailableError"

export type UnknownError = {
  readonly _tag: "UnknownError"
  readonly message: string
  readonly ref?: string | undefined
}
export const isUnknownError = (value: unknown): value is UnknownError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "UnknownError"

export type ForbiddenError = { readonly _tag: "ForbiddenError"; readonly message: string }
export const isForbiddenError = (value: unknown): value is ForbiddenError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "ForbiddenError"

export type RateLimitedError = {
  readonly _tag: "RateLimitedError"
  readonly message: string
  readonly retryAfterSeconds: number
}
export const isRateLimitedError = (value: unknown): value is RateLimitedError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "RateLimitedError"

export type SubagentControlNotFoundError = {
  readonly _tag: "SubagentControlNotFoundError"
  readonly parentRunID: string
  readonly childRunID: string
  readonly requestID: string
  readonly message: string
}
export const isSubagentControlNotFoundError = (value: unknown): value is SubagentControlNotFoundError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "SubagentControlNotFoundError"

export type GoalNotFoundError = {
  readonly _tag: "GoalNotFoundError"
  readonly sessionID: string
  readonly goalID: string
  readonly message: string
}
export const isGoalNotFoundError = (value: unknown): value is GoalNotFoundError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "GoalNotFoundError"

export type ScheduledPromptNotFoundError = {
  readonly _tag: "ScheduledPromptNotFoundError"
  readonly sessionID: string
  readonly scheduleID: string
  readonly message: string
}
export const isScheduledPromptNotFoundError = (value: unknown): value is ScheduledPromptNotFoundError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "ScheduledPromptNotFoundError"

export type TaskNotFoundError = {
  readonly _tag: "TaskNotFoundError"
  readonly sessionID: string
  readonly taskID: string
  readonly message: string
}
export const isTaskNotFoundError = (value: unknown): value is TaskNotFoundError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "TaskNotFoundError"

export type TeamNotFoundError = {
  readonly _tag: "TeamNotFoundError"
  readonly sessionID: string
  readonly message: string
}
export const isTeamNotFoundError = (value: unknown): value is TeamNotFoundError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "TeamNotFoundError"

export type TeamMemberNotFoundError = {
  readonly _tag: "TeamMemberNotFoundError"
  readonly sessionID: string
  readonly member: string
  readonly message: string
}
export const isTeamMemberNotFoundError = (value: unknown): value is TeamMemberNotFoundError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "TeamMemberNotFoundError"

export type WaitNotFoundError = {
  readonly _tag: "WaitNotFoundError"
  readonly sessionID: string
  readonly message: string
}
export const isWaitNotFoundError = (value: unknown): value is WaitNotFoundError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "WaitNotFoundError"

export type TriggerRequestError = {
  readonly _tag: "TriggerRequestError"
  readonly code: string
  readonly message: string
}
export const isTriggerRequestError = (value: unknown): value is TriggerRequestError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "TriggerRequestError"

export type MemoryNotFoundError = {
  readonly _tag: "MemoryNotFoundError"
  readonly memoryID: string
  readonly message: string
}
export const isMemoryNotFoundError = (value: unknown): value is MemoryNotFoundError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "MemoryNotFoundError"

export type McpServerNotFoundError = {
  readonly _tag: "McpServerNotFoundError"
  readonly server: string
  readonly message: string
}
export const isMcpServerNotFoundError = (value: unknown): value is McpServerNotFoundError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "McpServerNotFoundError"

export type ProviderNotFoundError = {
  readonly _tag: "ProviderNotFoundError"
  readonly providerID: string
  readonly message: string
}
export const isProviderNotFoundError = (value: unknown): value is ProviderNotFoundError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "ProviderNotFoundError"

export type PermissionNotFoundError = {
  readonly _tag: "PermissionNotFoundError"
  readonly requestID: string
  readonly message: string
}
export const isPermissionNotFoundError = (value: unknown): value is PermissionNotFoundError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "PermissionNotFoundError"

export type TextDocumentError = { readonly name: "TextDocumentError"; readonly data: { readonly message: string } }
export const isTextDocumentError = (value: unknown): value is TextDocumentError =>
  typeof value === "object" && value !== null && "name" in value && value["name"] === "TextDocumentError"

export type TextDocumentConflict = {
  readonly name: "TextDocumentConflict"
  readonly data: { readonly message: string }
}
export const isTextDocumentConflict = (value: unknown): value is TextDocumentConflict =>
  typeof value === "object" && value !== null && "name" in value && value["name"] === "TextDocumentConflict"

export type PtyNotFoundError = { readonly _tag: "PtyNotFoundError"; readonly ptyID: string; readonly message: string }
export const isPtyNotFoundError = (value: unknown): value is PtyNotFoundError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "PtyNotFoundError"

export type QuestionNotFoundError = {
  readonly _tag: "QuestionNotFoundError"
  readonly requestID: string
  readonly message: string
}
export const isQuestionNotFoundError = (value: unknown): value is QuestionNotFoundError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "QuestionNotFoundError"

export type ProjectCopyError = {
  readonly name: "ProjectCopyError"
  readonly data: { readonly message: string; readonly forceRequired?: boolean | undefined }
}
export const isProjectCopyError = (value: unknown): value is ProjectCopyError =>
  typeof value === "object" && value !== null && "name" in value && value["name"] === "ProjectCopyError"

export type PersonalJobNotFoundError = {
  readonly _tag: "PersonalJobNotFoundError"
  readonly sessionID: string
  readonly jobID: string
  readonly message: string
}
export const isPersonalJobNotFoundError = (value: unknown): value is PersonalJobNotFoundError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "PersonalJobNotFoundError"

export type HealthGetOutput = { readonly healthy: true; readonly protocol: "v2" }

export type LocationGetInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type LocationGetOutput = {
  readonly directory: string
  readonly workspaceID?: string
  readonly project: { readonly id: string; readonly directory: string }
}

export type AgentsListInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type AgentsListOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: ReadonlyArray<{
    readonly id: string
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
    readonly request: {
      readonly headers: { readonly [x: string]: string }
      readonly body: { readonly [x: string]: JsonValue }
    }
    readonly system?: string
    readonly description?: string
    readonly mode: "subagent" | "primary" | "all"
    readonly hidden: boolean
    readonly color?: string | "primary" | "secondary" | "accent" | "success" | "warning" | "error" | "info"
    readonly steps?: number
    readonly permissions: ReadonlyArray<{
      readonly action: string
      readonly resource: string
      readonly effect: "allow" | "deny" | "ask"
    }>
  }>
}

export type SessionsListInput = {
  readonly workspace?: {
    readonly workspace?: string | undefined
    readonly limit?: number | undefined
    readonly order?: "asc" | "desc" | undefined
    readonly search?: string | undefined
    readonly tags?: string | undefined
    readonly directory?: string | undefined
    readonly project?: string | undefined
    readonly subpath?: string | undefined
    readonly cursor?: string | undefined
  }["workspace"]
  readonly limit?: {
    readonly workspace?: string | undefined
    readonly limit?: number | undefined
    readonly order?: "asc" | "desc" | undefined
    readonly search?: string | undefined
    readonly tags?: string | undefined
    readonly directory?: string | undefined
    readonly project?: string | undefined
    readonly subpath?: string | undefined
    readonly cursor?: string | undefined
  }["limit"]
  readonly order?: {
    readonly workspace?: string | undefined
    readonly limit?: number | undefined
    readonly order?: "asc" | "desc" | undefined
    readonly search?: string | undefined
    readonly tags?: string | undefined
    readonly directory?: string | undefined
    readonly project?: string | undefined
    readonly subpath?: string | undefined
    readonly cursor?: string | undefined
  }["order"]
  readonly search?: {
    readonly workspace?: string | undefined
    readonly limit?: number | undefined
    readonly order?: "asc" | "desc" | undefined
    readonly search?: string | undefined
    readonly tags?: string | undefined
    readonly directory?: string | undefined
    readonly project?: string | undefined
    readonly subpath?: string | undefined
    readonly cursor?: string | undefined
  }["search"]
  readonly tags?: {
    readonly workspace?: string | undefined
    readonly limit?: number | undefined
    readonly order?: "asc" | "desc" | undefined
    readonly search?: string | undefined
    readonly tags?: string | undefined
    readonly directory?: string | undefined
    readonly project?: string | undefined
    readonly subpath?: string | undefined
    readonly cursor?: string | undefined
  }["tags"]
  readonly directory?: {
    readonly workspace?: string | undefined
    readonly limit?: number | undefined
    readonly order?: "asc" | "desc" | undefined
    readonly search?: string | undefined
    readonly tags?: string | undefined
    readonly directory?: string | undefined
    readonly project?: string | undefined
    readonly subpath?: string | undefined
    readonly cursor?: string | undefined
  }["directory"]
  readonly project?: {
    readonly workspace?: string | undefined
    readonly limit?: number | undefined
    readonly order?: "asc" | "desc" | undefined
    readonly search?: string | undefined
    readonly tags?: string | undefined
    readonly directory?: string | undefined
    readonly project?: string | undefined
    readonly subpath?: string | undefined
    readonly cursor?: string | undefined
  }["project"]
  readonly subpath?: {
    readonly workspace?: string | undefined
    readonly limit?: number | undefined
    readonly order?: "asc" | "desc" | undefined
    readonly search?: string | undefined
    readonly tags?: string | undefined
    readonly directory?: string | undefined
    readonly project?: string | undefined
    readonly subpath?: string | undefined
    readonly cursor?: string | undefined
  }["subpath"]
  readonly cursor?: {
    readonly workspace?: string | undefined
    readonly limit?: number | undefined
    readonly order?: "asc" | "desc" | undefined
    readonly search?: string | undefined
    readonly tags?: string | undefined
    readonly directory?: string | undefined
    readonly project?: string | undefined
    readonly subpath?: string | undefined
    readonly cursor?: string | undefined
  }["cursor"]
}

export type SessionsListOutput = {
  readonly data: ReadonlyArray<{
    readonly id: string
    readonly parentID?: string
    readonly projectID: string
    readonly agent?: string
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
    readonly cost: number
    readonly tokens: {
      readonly input: number
      readonly output: number
      readonly reasoning: number
      readonly cache: { readonly read: number; readonly write: number }
    }
    readonly time: { readonly created: number; readonly updated: number; readonly archived?: number }
    readonly title: string
    readonly location: { readonly directory: string; readonly workspaceID?: string }
    readonly subpath?: string
    readonly revert?: {
      readonly messageID: string
      readonly partID?: string
      readonly snapshot?: string
      readonly diff?: string
      readonly files?: ReadonlyArray<{
        readonly path: string
        readonly status: "added" | "modified" | "deleted"
        readonly additions: number
        readonly deletions: number
        readonly patch: string
      }>
    }
    readonly tags?: ReadonlyArray<string>
  }>
  readonly cursor: { readonly previous?: string | null; readonly next?: string | null }
}

export type SessionsCreateInput = {
  readonly id?: {
    readonly id?: string | null
    readonly agent?: string | null
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
    readonly location?: { readonly directory: string; readonly workspaceID?: string } | null
  }["id"]
  readonly agent?: {
    readonly id?: string | null
    readonly agent?: string | null
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
    readonly location?: { readonly directory: string; readonly workspaceID?: string } | null
  }["agent"]
  readonly model?: {
    readonly id?: string | null
    readonly agent?: string | null
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
    readonly location?: { readonly directory: string; readonly workspaceID?: string } | null
  }["model"]
  readonly location?: {
    readonly id?: string | null
    readonly agent?: string | null
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
    readonly location?: { readonly directory: string; readonly workspaceID?: string } | null
  }["location"]
}

export type SessionsCreateOutput = {
  readonly data: {
    readonly id: string
    readonly parentID?: string
    readonly projectID: string
    readonly agent?: string
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
    readonly cost: number
    readonly tokens: {
      readonly input: number
      readonly output: number
      readonly reasoning: number
      readonly cache: { readonly read: number; readonly write: number }
    }
    readonly time: { readonly created: number; readonly updated: number; readonly archived?: number }
    readonly title: string
    readonly location: { readonly directory: string; readonly workspaceID?: string }
    readonly subpath?: string
    readonly revert?: {
      readonly messageID: string
      readonly partID?: string
      readonly snapshot?: string
      readonly diff?: string
      readonly files?: ReadonlyArray<{
        readonly path: string
        readonly status: "added" | "modified" | "deleted"
        readonly additions: number
        readonly deletions: number
        readonly patch: string
      }>
    }
    readonly tags?: ReadonlyArray<string>
  }
}["data"]

export type SessionsActiveOutput = { readonly data: { readonly [x: string]: { readonly type: "running" } } }["data"]

export type SessionsGetInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type SessionsGetOutput = {
  readonly data: {
    readonly id: string
    readonly parentID?: string
    readonly projectID: string
    readonly agent?: string
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
    readonly cost: number
    readonly tokens: {
      readonly input: number
      readonly output: number
      readonly reasoning: number
      readonly cache: { readonly read: number; readonly write: number }
    }
    readonly time: { readonly created: number; readonly updated: number; readonly archived?: number }
    readonly title: string
    readonly location: { readonly directory: string; readonly workspaceID?: string }
    readonly subpath?: string
    readonly revert?: {
      readonly messageID: string
      readonly partID?: string
      readonly snapshot?: string
      readonly diff?: string
      readonly files?: ReadonlyArray<{
        readonly path: string
        readonly status: "added" | "modified" | "deleted"
        readonly additions: number
        readonly deletions: number
        readonly patch: string
      }>
    }
    readonly tags?: ReadonlyArray<string>
  }
}["data"]

export type SessionsTagsUpdateInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly tags: { readonly tags: ReadonlyArray<string> }["tags"]
}

export type SessionsTagsUpdateOutput = { readonly data: ReadonlyArray<string> }["data"]

export type SessionsCheckpointCreateInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly label: { readonly label: string }["label"]
}

export type SessionsCheckpointCreateOutput = {
  readonly data: {
    readonly id: string
    readonly sessionID: string
    readonly label: string
    readonly sequence: number
    readonly messageID?: string
    readonly time: { readonly created: number }
  }
}["data"]

export type SessionsCheckpointListInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type SessionsCheckpointListOutput = {
  readonly data: ReadonlyArray<{
    readonly id: string
    readonly sessionID: string
    readonly label: string
    readonly sequence: number
    readonly messageID?: string
    readonly time: { readonly created: number }
  }>
}["data"]

export type SessionsRewindPreviewInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly checkpointID: { readonly checkpointID: string }["checkpointID"]
}

export type SessionsRewindPreviewOutput = {
  readonly data: {
    readonly checkpoint: {
      readonly id: string
      readonly sessionID: string
      readonly label: string
      readonly sequence: number
      readonly messageID?: string
      readonly time: { readonly created: number }
    }
    readonly affectedMessages: number
    readonly expectedLastSequence: number
    readonly workspaceEffectsUnchanged: true
  }
}["data"]

export type SessionsRewindApplyInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly checkpointID: { readonly checkpointID: string; readonly expectedLastSequence: number }["checkpointID"]
  readonly expectedLastSequence: {
    readonly checkpointID: string
    readonly expectedLastSequence: number
  }["expectedLastSequence"]
}

export type SessionsRewindApplyOutput = {
  readonly data: {
    readonly checkpoint: {
      readonly id: string
      readonly sessionID: string
      readonly label: string
      readonly sequence: number
      readonly messageID?: string
      readonly time: { readonly created: number }
    }
    readonly rewoundMessages: number
    readonly lastSequence: number
    readonly workspaceEffectsUnchanged: true
  }
}["data"]

export type SessionsSwitchAgentInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly agent: { readonly agent: string }["agent"]
}

export type SessionsSwitchAgentOutput = void

export type SessionsSwitchModelInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly model: {
    readonly model: { readonly id: string; readonly providerID: string; readonly variant?: string }
  }["model"]
}

export type SessionsSwitchModelOutput = void

export type SessionsPromptInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly id?: {
    readonly id?: string | null
    readonly prompt: {
      readonly text: string
      readonly files?: ReadonlyArray<{
        readonly uri: string
        readonly mime?: string
        readonly name?: string
        readonly description?: string
        readonly source?: { readonly start: number; readonly end: number; readonly text: string }
      }>
      readonly agents?: ReadonlyArray<{
        readonly name: string
        readonly source?: { readonly start: number; readonly end: number; readonly text: string }
      }>
      readonly scheduledTasks?: ReadonlyArray<{
        readonly id: string
        readonly prompt: string
        readonly description: string
        readonly agent: string
        readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
        readonly command?: string
      }>
      readonly system?: { readonly text: string; readonly source: "request"; readonly scope: "turn" }
      readonly route?: {
        readonly agent?: string
        readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
      }
      readonly command?: { readonly name: string; readonly arguments: string }
      readonly format?:
        | { readonly type: "text" }
        | {
            readonly type: "json_schema"
            readonly schema: { readonly [x: string]: JsonValue }
            readonly retryCount?: number | null | null
          }
    }
    readonly delivery?: "steer" | "queue" | null
    readonly resume?: boolean | null
  }["id"]
  readonly prompt: {
    readonly id?: string | null
    readonly prompt: {
      readonly text: string
      readonly files?: ReadonlyArray<{
        readonly uri: string
        readonly mime?: string
        readonly name?: string
        readonly description?: string
        readonly source?: { readonly start: number; readonly end: number; readonly text: string }
      }>
      readonly agents?: ReadonlyArray<{
        readonly name: string
        readonly source?: { readonly start: number; readonly end: number; readonly text: string }
      }>
      readonly scheduledTasks?: ReadonlyArray<{
        readonly id: string
        readonly prompt: string
        readonly description: string
        readonly agent: string
        readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
        readonly command?: string
      }>
      readonly system?: { readonly text: string; readonly source: "request"; readonly scope: "turn" }
      readonly route?: {
        readonly agent?: string
        readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
      }
      readonly command?: { readonly name: string; readonly arguments: string }
      readonly format?:
        | { readonly type: "text" }
        | {
            readonly type: "json_schema"
            readonly schema: { readonly [x: string]: JsonValue }
            readonly retryCount?: number | null | null
          }
    }
    readonly delivery?: "steer" | "queue" | null
    readonly resume?: boolean | null
  }["prompt"]
  readonly delivery?: {
    readonly id?: string | null
    readonly prompt: {
      readonly text: string
      readonly files?: ReadonlyArray<{
        readonly uri: string
        readonly mime?: string
        readonly name?: string
        readonly description?: string
        readonly source?: { readonly start: number; readonly end: number; readonly text: string }
      }>
      readonly agents?: ReadonlyArray<{
        readonly name: string
        readonly source?: { readonly start: number; readonly end: number; readonly text: string }
      }>
      readonly scheduledTasks?: ReadonlyArray<{
        readonly id: string
        readonly prompt: string
        readonly description: string
        readonly agent: string
        readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
        readonly command?: string
      }>
      readonly system?: { readonly text: string; readonly source: "request"; readonly scope: "turn" }
      readonly route?: {
        readonly agent?: string
        readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
      }
      readonly command?: { readonly name: string; readonly arguments: string }
      readonly format?:
        | { readonly type: "text" }
        | {
            readonly type: "json_schema"
            readonly schema: { readonly [x: string]: JsonValue }
            readonly retryCount?: number | null | null
          }
    }
    readonly delivery?: "steer" | "queue" | null
    readonly resume?: boolean | null
  }["delivery"]
  readonly resume?: {
    readonly id?: string | null
    readonly prompt: {
      readonly text: string
      readonly files?: ReadonlyArray<{
        readonly uri: string
        readonly mime?: string
        readonly name?: string
        readonly description?: string
        readonly source?: { readonly start: number; readonly end: number; readonly text: string }
      }>
      readonly agents?: ReadonlyArray<{
        readonly name: string
        readonly source?: { readonly start: number; readonly end: number; readonly text: string }
      }>
      readonly scheduledTasks?: ReadonlyArray<{
        readonly id: string
        readonly prompt: string
        readonly description: string
        readonly agent: string
        readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
        readonly command?: string
      }>
      readonly system?: { readonly text: string; readonly source: "request"; readonly scope: "turn" }
      readonly route?: {
        readonly agent?: string
        readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
      }
      readonly command?: { readonly name: string; readonly arguments: string }
      readonly format?:
        | { readonly type: "text" }
        | {
            readonly type: "json_schema"
            readonly schema: { readonly [x: string]: JsonValue }
            readonly retryCount?: number | null | null
          }
    }
    readonly delivery?: "steer" | "queue" | null
    readonly resume?: boolean | null
  }["resume"]
}

export type SessionsPromptOutput = {
  readonly data: {
    readonly admittedSeq: number
    readonly id: string
    readonly sessionID: string
    readonly prompt: {
      readonly text: string
      readonly files?: ReadonlyArray<{
        readonly uri: string
        readonly mime: string
        readonly name?: string
        readonly description?: string
        readonly source?: { readonly start: number; readonly end: number; readonly text: string }
      }>
      readonly agents?: ReadonlyArray<{
        readonly name: string
        readonly source?: { readonly start: number; readonly end: number; readonly text: string }
      }>
      readonly scheduledTasks?: ReadonlyArray<{
        readonly id: string
        readonly prompt: string
        readonly description: string
        readonly agent: string
        readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
        readonly command?: string
      }>
      readonly system?: { readonly text: string; readonly source: "request"; readonly scope: "turn" }
      readonly route?: {
        readonly agent?: string
        readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
      }
      readonly command?: { readonly name: string; readonly arguments: string }
      readonly format?:
        | { readonly type: "text" }
        | {
            readonly type: "json_schema"
            readonly schema: { readonly [x: string]: JsonValue }
            readonly retryCount?: number | null | null
          }
    }
    readonly delivery: "steer" | "queue"
    readonly timeCreated: number
    readonly promotedSeq?: number
  }
}["data"]

export type SessionsPromptQueueListInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type SessionsPromptQueueListOutput = {
  readonly data: ReadonlyArray<{
    readonly admittedSeq: number
    readonly id: string
    readonly sessionID: string
    readonly prompt: {
      readonly text: string
      readonly files?: ReadonlyArray<{
        readonly uri: string
        readonly mime: string
        readonly name?: string
        readonly description?: string
        readonly source?: { readonly start: number; readonly end: number; readonly text: string }
      }>
      readonly agents?: ReadonlyArray<{
        readonly name: string
        readonly source?: { readonly start: number; readonly end: number; readonly text: string }
      }>
      readonly scheduledTasks?: ReadonlyArray<{
        readonly id: string
        readonly prompt: string
        readonly description: string
        readonly agent: string
        readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
        readonly command?: string
      }>
      readonly system?: { readonly text: string; readonly source: "request"; readonly scope: "turn" }
      readonly route?: {
        readonly agent?: string
        readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
      }
      readonly command?: { readonly name: string; readonly arguments: string }
      readonly format?:
        | { readonly type: "text" }
        | {
            readonly type: "json_schema"
            readonly schema: { readonly [x: string]: JsonValue }
            readonly retryCount?: number | null | null
          }
    }
    readonly delivery: "steer" | "queue"
    readonly timeCreated: number
    readonly promotedSeq?: number
  }>
}["data"]

export type SessionsPromptQueueUpdateInput = {
  readonly sessionID: { readonly sessionID: string; readonly messageID: string }["sessionID"]
  readonly messageID: { readonly sessionID: string; readonly messageID: string }["messageID"]
  readonly expectedAdmittedSeq: {
    readonly expectedAdmittedSeq: number
    readonly prompt: {
      readonly text: string
      readonly files?: ReadonlyArray<{
        readonly uri: string
        readonly mime?: string
        readonly name?: string
        readonly description?: string
        readonly source?: { readonly start: number; readonly end: number; readonly text: string }
      }>
      readonly agents?: ReadonlyArray<{
        readonly name: string
        readonly source?: { readonly start: number; readonly end: number; readonly text: string }
      }>
      readonly scheduledTasks?: ReadonlyArray<{
        readonly id: string
        readonly prompt: string
        readonly description: string
        readonly agent: string
        readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
        readonly command?: string
      }>
      readonly system?: { readonly text: string; readonly source: "request"; readonly scope: "turn" }
      readonly route?: {
        readonly agent?: string
        readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
      }
      readonly command?: { readonly name: string; readonly arguments: string }
      readonly format?:
        | { readonly type: "text" }
        | {
            readonly type: "json_schema"
            readonly schema: { readonly [x: string]: JsonValue }
            readonly retryCount?: number | null | null
          }
    }
  }["expectedAdmittedSeq"]
  readonly prompt: {
    readonly expectedAdmittedSeq: number
    readonly prompt: {
      readonly text: string
      readonly files?: ReadonlyArray<{
        readonly uri: string
        readonly mime?: string
        readonly name?: string
        readonly description?: string
        readonly source?: { readonly start: number; readonly end: number; readonly text: string }
      }>
      readonly agents?: ReadonlyArray<{
        readonly name: string
        readonly source?: { readonly start: number; readonly end: number; readonly text: string }
      }>
      readonly scheduledTasks?: ReadonlyArray<{
        readonly id: string
        readonly prompt: string
        readonly description: string
        readonly agent: string
        readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
        readonly command?: string
      }>
      readonly system?: { readonly text: string; readonly source: "request"; readonly scope: "turn" }
      readonly route?: {
        readonly agent?: string
        readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
      }
      readonly command?: { readonly name: string; readonly arguments: string }
      readonly format?:
        | { readonly type: "text" }
        | {
            readonly type: "json_schema"
            readonly schema: { readonly [x: string]: JsonValue }
            readonly retryCount?: number | null | null
          }
    }
  }["prompt"]
}

export type SessionsPromptQueueUpdateOutput = {
  readonly data: {
    readonly admittedSeq: number
    readonly id: string
    readonly sessionID: string
    readonly prompt: {
      readonly text: string
      readonly files?: ReadonlyArray<{
        readonly uri: string
        readonly mime: string
        readonly name?: string
        readonly description?: string
        readonly source?: { readonly start: number; readonly end: number; readonly text: string }
      }>
      readonly agents?: ReadonlyArray<{
        readonly name: string
        readonly source?: { readonly start: number; readonly end: number; readonly text: string }
      }>
      readonly scheduledTasks?: ReadonlyArray<{
        readonly id: string
        readonly prompt: string
        readonly description: string
        readonly agent: string
        readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
        readonly command?: string
      }>
      readonly system?: { readonly text: string; readonly source: "request"; readonly scope: "turn" }
      readonly route?: {
        readonly agent?: string
        readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
      }
      readonly command?: { readonly name: string; readonly arguments: string }
      readonly format?:
        | { readonly type: "text" }
        | {
            readonly type: "json_schema"
            readonly schema: { readonly [x: string]: JsonValue }
            readonly retryCount?: number | null | null
          }
    }
    readonly delivery: "steer" | "queue"
    readonly timeCreated: number
    readonly promotedSeq?: number
  }
}["data"]

export type SessionsPromptQueueRemoveInput = {
  readonly sessionID: { readonly sessionID: string; readonly messageID: string }["sessionID"]
  readonly messageID: { readonly sessionID: string; readonly messageID: string }["messageID"]
  readonly expectedAdmittedSeq: { readonly expectedAdmittedSeq: number }["expectedAdmittedSeq"]
}

export type SessionsPromptQueueRemoveOutput = void

export type SessionsCompactInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type SessionsCompactOutput = void

export type SessionsWaitInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type SessionsWaitOutput = void

export type SessionsStageInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly messageID: { readonly messageID: string; readonly files?: boolean | undefined }["messageID"]
  readonly files?: { readonly messageID: string; readonly files?: boolean | undefined }["files"]
}

export type SessionsStageOutput = {
  readonly data: {
    readonly messageID: string
    readonly partID?: string
    readonly snapshot?: string
    readonly diff?: string
    readonly files?: ReadonlyArray<{
      readonly path: string
      readonly status: "added" | "modified" | "deleted"
      readonly additions: number
      readonly deletions: number
      readonly patch: string
    }>
  }
}["data"]

export type SessionsClearInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type SessionsClearOutput = void

export type SessionsCommitInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type SessionsCommitOutput = void

export type SessionsContextInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type SessionsContextOutput = {
  readonly data: ReadonlyArray<
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number }
        readonly type: "agent-switched"
        readonly agent: string
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number }
        readonly type: "model-switched"
        readonly model: { readonly id: string; readonly providerID: string; readonly variant?: string }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number }
        readonly text: string
        readonly files?: ReadonlyArray<{
          readonly uri: string
          readonly mime: string
          readonly name?: string
          readonly description?: string
          readonly source?: { readonly start: number; readonly end: number; readonly text: string }
        }>
        readonly agents?: ReadonlyArray<{
          readonly name: string
          readonly source?: { readonly start: number; readonly end: number; readonly text: string }
        }>
        readonly scheduledTasks?: ReadonlyArray<{
          readonly id: string
          readonly prompt: string
          readonly description: string
          readonly agent: string
          readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
          readonly command?: string
        }>
        readonly system?: { readonly text: string; readonly source: "request"; readonly scope: "turn" }
        readonly route?: {
          readonly agent?: string
          readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
        }
        readonly command?: { readonly name: string; readonly arguments: string }
        readonly format?:
          | { readonly type: "text" }
          | {
              readonly type: "json_schema"
              readonly schema: { readonly [x: string]: JsonValue }
              readonly retryCount?: number | null | null
            }
        readonly type: "user"
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number }
        readonly sessionID: string
        readonly text: string
        readonly type: "synthetic"
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number }
        readonly type: "system"
        readonly text: string
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number; readonly completed?: number }
        readonly type: "shell"
        readonly callID: string
        readonly command: string
        readonly output: string
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number; readonly completed?: number }
        readonly type: "assistant"
        readonly agent: string
        readonly model: { readonly id: string; readonly providerID: string; readonly variant?: string }
        readonly content: ReadonlyArray<
          | { readonly type: "text"; readonly id: string; readonly text: string }
          | {
              readonly type: "reasoning"
              readonly id: string
              readonly text: string
              readonly providerMetadata?: { readonly [x: string]: { readonly [x: string]: JsonValue } }
              readonly time?: { readonly created: number; readonly completed?: number }
            }
          | {
              readonly type: "tool"
              readonly id: string
              readonly name: string
              readonly provider?: {
                readonly executed: boolean
                readonly metadata?: { readonly [x: string]: { readonly [x: string]: JsonValue } }
                readonly resultMetadata?: { readonly [x: string]: { readonly [x: string]: JsonValue } }
              }
              readonly state:
                | { readonly status: "pending"; readonly input: string }
                | {
                    readonly status: "running"
                    readonly input: { readonly [x: string]: JsonValue }
                    readonly structured: { readonly [x: string]: JsonValue }
                    readonly content: ReadonlyArray<
                      | { readonly type: "text"; readonly text: string }
                      | { readonly type: "file"; readonly uri: string; readonly mime: string; readonly name?: string }
                    >
                  }
                | {
                    readonly status: "completed"
                    readonly input: { readonly [x: string]: JsonValue }
                    readonly attachments?: ReadonlyArray<{
                      readonly uri: string
                      readonly mime: string
                      readonly name?: string
                      readonly description?: string
                      readonly source?: { readonly start: number; readonly end: number; readonly text: string }
                    }>
                    readonly content: ReadonlyArray<
                      | { readonly type: "text"; readonly text: string }
                      | { readonly type: "file"; readonly uri: string; readonly mime: string; readonly name?: string }
                    >
                    readonly artifactRefs?: ReadonlyArray<{
                      readonly version: 1
                      readonly artifactID: string
                      readonly kind: string
                      readonly digest: string
                      readonly mime: string
                      readonly sizeBytes: number
                      readonly owner: { readonly scope: "session" | "profile" | "tenant"; readonly id: string }
                      readonly retention: {
                        readonly mode: "ephemeral" | "session" | "durable"
                        readonly expiresAt?: number
                      }
                      readonly retrievalHint: { readonly kind: "managed"; readonly handle: string }
                      readonly label?: string
                      readonly createdAt: number
                    }>
                    readonly outputPaths?: ReadonlyArray<string>
                    readonly structured: { readonly [x: string]: JsonValue }
                    readonly result?: JsonValue
                  }
                | {
                    readonly status: "error"
                    readonly input: { readonly [x: string]: JsonValue }
                    readonly content: ReadonlyArray<
                      | { readonly type: "text"; readonly text: string }
                      | { readonly type: "file"; readonly uri: string; readonly mime: string; readonly name?: string }
                    >
                    readonly structured: { readonly [x: string]: JsonValue }
                    readonly error: { readonly type: "unknown"; readonly message: string }
                    readonly artifactRefs?: ReadonlyArray<{
                      readonly version: 1
                      readonly artifactID: string
                      readonly kind: string
                      readonly digest: string
                      readonly mime: string
                      readonly sizeBytes: number
                      readonly owner: { readonly scope: "session" | "profile" | "tenant"; readonly id: string }
                      readonly retention: {
                        readonly mode: "ephemeral" | "session" | "durable"
                        readonly expiresAt?: number
                      }
                      readonly retrievalHint: { readonly kind: "managed"; readonly handle: string }
                      readonly label?: string
                      readonly createdAt: number
                    }>
                    readonly outputPaths?: ReadonlyArray<string>
                    readonly result?: JsonValue
                  }
              readonly time: {
                readonly created: number
                readonly ran?: number
                readonly completed?: number
                readonly pruned?: number
              }
            }
        >
        readonly structured?: { readonly [x: string]: JsonValue }
        readonly delivery?: {
          readonly status: "normal" | "proactive"
          readonly sentAt: number
          readonly attachmentCount: number
          readonly attachments: ReadonlyArray<{
            readonly artifactID: string
            readonly artifactRef?: {
              readonly version: 1
              readonly artifactID: string
              readonly kind: string
              readonly digest: string
              readonly mime: string
              readonly sizeBytes: number
              readonly owner: { readonly scope: "session" | "profile" | "tenant"; readonly id: string }
              readonly retention: { readonly mode: "ephemeral" | "session" | "durable"; readonly expiresAt?: number }
              readonly retrievalHint: { readonly kind: "managed"; readonly handle: string }
              readonly label?: string
              readonly createdAt: number
            }
            readonly path: string
            readonly displayName: string
            readonly mime: string
            readonly sizeBytes: number
            readonly createdAt: number
            readonly sha256: string
            readonly source: "user_message"
            readonly isImage: boolean
          }>
          readonly localOnly: true
          readonly uploaded: false
        }
        readonly snapshot?: { readonly start?: string; readonly end?: string; readonly files?: ReadonlyArray<string> }
        readonly finish?: string
        readonly cost?: number
        readonly tokens?: {
          readonly input: number
          readonly output: number
          readonly reasoning: number
          readonly cache: { readonly read: number; readonly write: number }
        }
        readonly error?: { readonly type: "unknown"; readonly message: string }
      }
    | {
        readonly type: "compaction"
        readonly reason: "auto" | "manual"
        readonly summary: string
        readonly recent: string
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number }
      }
  >
}["data"]

export type SessionsHistoryInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly limit?: { readonly limit?: number | undefined; readonly after?: number | undefined }["limit"]
  readonly after?: { readonly limit?: number | undefined; readonly after?: number | undefined }["after"]
}

export type SessionsHistoryOutput = {
  readonly data: ReadonlyArray<
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.title.generated"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly messageID: string
          readonly expectedTitle: string
          readonly title: string
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.agent.switched"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly messageID: string
          readonly agent: string
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.model.switched"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly messageID: string
          readonly model: { readonly id: string; readonly providerID: string; readonly variant?: string }
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.moved"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly location: { readonly directory: string; readonly workspaceID?: string }
          readonly subdirectory?: string
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.prompted"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly messageID: string
          readonly prompt: {
            readonly text: string
            readonly files?: ReadonlyArray<{
              readonly uri: string
              readonly mime: string
              readonly name?: string
              readonly description?: string
              readonly source?: { readonly start: number; readonly end: number; readonly text: string }
            }>
            readonly agents?: ReadonlyArray<{
              readonly name: string
              readonly source?: { readonly start: number; readonly end: number; readonly text: string }
            }>
            readonly scheduledTasks?: ReadonlyArray<{
              readonly id: string
              readonly prompt: string
              readonly description: string
              readonly agent: string
              readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
              readonly command?: string
            }>
            readonly system?: { readonly text: string; readonly source: "request"; readonly scope: "turn" }
            readonly route?: {
              readonly agent?: string
              readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
            }
            readonly command?: { readonly name: string; readonly arguments: string }
            readonly format?:
              | { readonly type: "text" }
              | {
                  readonly type: "json_schema"
                  readonly schema: { readonly [x: string]: JsonValue }
                  readonly retryCount?: number | null | null
                }
          }
          readonly delivery: "steer" | "queue"
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.prompt.admitted"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly messageID: string
          readonly prompt: {
            readonly text: string
            readonly files?: ReadonlyArray<{
              readonly uri: string
              readonly mime: string
              readonly name?: string
              readonly description?: string
              readonly source?: { readonly start: number; readonly end: number; readonly text: string }
            }>
            readonly agents?: ReadonlyArray<{
              readonly name: string
              readonly source?: { readonly start: number; readonly end: number; readonly text: string }
            }>
            readonly scheduledTasks?: ReadonlyArray<{
              readonly id: string
              readonly prompt: string
              readonly description: string
              readonly agent: string
              readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
              readonly command?: string
            }>
            readonly system?: { readonly text: string; readonly source: "request"; readonly scope: "turn" }
            readonly route?: {
              readonly agent?: string
              readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
            }
            readonly command?: { readonly name: string; readonly arguments: string }
            readonly format?:
              | { readonly type: "text" }
              | {
                  readonly type: "json_schema"
                  readonly schema: { readonly [x: string]: JsonValue }
                  readonly retryCount?: number | null | null
                }
          }
          readonly delivery: "steer" | "queue"
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.prompt.queue.updated"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly messageID: string
          readonly prompt: {
            readonly text: string
            readonly files?: ReadonlyArray<{
              readonly uri: string
              readonly mime: string
              readonly name?: string
              readonly description?: string
              readonly source?: { readonly start: number; readonly end: number; readonly text: string }
            }>
            readonly agents?: ReadonlyArray<{
              readonly name: string
              readonly source?: { readonly start: number; readonly end: number; readonly text: string }
            }>
            readonly scheduledTasks?: ReadonlyArray<{
              readonly id: string
              readonly prompt: string
              readonly description: string
              readonly agent: string
              readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
              readonly command?: string
            }>
            readonly system?: { readonly text: string; readonly source: "request"; readonly scope: "turn" }
            readonly route?: {
              readonly agent?: string
              readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
            }
            readonly command?: { readonly name: string; readonly arguments: string }
            readonly format?:
              | { readonly type: "text" }
              | {
                  readonly type: "json_schema"
                  readonly schema: { readonly [x: string]: JsonValue }
                  readonly retryCount?: number | null | null
                }
          }
          readonly delivery: "steer" | "queue"
          readonly expectedAdmittedSeq: number
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.prompt.queue.removed"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly messageID: string
          readonly expectedAdmittedSeq: number
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.context.updated"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly messageID: string
          readonly text: string
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.memory.context.prepared"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly userMessageID: string
          readonly turnStep: number
          readonly queryDigest: string
          readonly contextDigest: string
          readonly injectedBytes: number
          readonly status: "prepared" | "unavailable"
          readonly algorithm: "hybrid_bm25_hashing_vector"
          readonly localOnly: true
          readonly candidates: ReadonlyArray<{
            readonly memoryID: string
            readonly rank: number
            readonly score: number
            readonly lexicalScore: number
            readonly vectorScore: number
          }>
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.context.fusion.prepared"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly userMessageID: string
          readonly turnStep: number
          readonly queryDigest: string
          readonly combinedContextDigest: string
          readonly totalInjectedBytes: number
          readonly providerCallReady: true
          readonly degraded: boolean
          readonly bridgeProtocol?: "arforge.bridge/1.2"
          readonly assemblyProtocol?: "arforge.context/2"
          readonly runtimeTopology?: "typescript-single-runtime" | "legacy-dual-runtime"
          readonly memory: {
            readonly runtime: "typescript-core"
            readonly status: "prepared" | "unavailable"
            readonly contextDigest: string
            readonly injectedBytes: number
            readonly candidateCount: number
          }
          readonly learning: {
            readonly runtime: "typescript-core"
            readonly status: "prepared" | "unavailable"
            readonly contextDigest: string
            readonly injectedBytes: number
          }
          readonly evolution: {
            readonly runtime: "typescript-core" | "python-sidecar"
            readonly status: "prepared" | "unavailable"
            readonly contextDigest: string
            readonly injectedBytes: number
            readonly activeCandidateCount: number
            readonly injectedCandidateCount: number
          }
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.request.envelope.prepared"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly runID: string
          readonly turnStep: number
          readonly attempt?: number
          readonly schemaVersion: "1.0"
          readonly requestDigest: string
          readonly envelope: string
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.request.binding.prepared"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly runID: string
          readonly turnStep: number
          readonly attempt: number
          readonly schemaVersion: 1
          readonly runtime: "native" | "ai-sdk"
          readonly mode: "native-envelope" | "prepared-projection"
          readonly requestDigest: string
          readonly contextDigest: string
          readonly toolSetRevision: string
          readonly routeConfigRevision: string
          readonly skillSnapshotDigest?: string
          readonly compilerRevision: string
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.synthetic"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly messageID: string
          readonly text: string
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.shell.started"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly messageID: string
          readonly callID: string
          readonly command: string
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.shell.ended"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly callID: string
          readonly output: string
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.step.started"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly assistantMessageID: string
          readonly runID?: string
          readonly requestDigest?: string
          readonly agent: string
          readonly model: { readonly id: string; readonly providerID: string; readonly variant?: string }
          readonly snapshot?: string
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.step.ended"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly assistantMessageID: string
          readonly finish: string
          readonly cost: number
          readonly tokens: {
            readonly input: number
            readonly output: number
            readonly reasoning: number
            readonly cache: { readonly read: number; readonly write: number }
          }
          readonly snapshot?: string
          readonly files?: ReadonlyArray<string>
          readonly structured?: { readonly [x: string]: JsonValue }
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.step.failed"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly assistantMessageID: string
          readonly error: { readonly type: "unknown"; readonly message: string }
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.text.started"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly assistantMessageID: string
          readonly textID: string
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.text.ended"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly assistantMessageID: string
          readonly textID: string
          readonly text: string
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.primary.delivered"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly assistantMessageID: string
          readonly callID: string
          readonly message: string
          readonly delivery: {
            readonly status: "normal" | "proactive"
            readonly sentAt: number
            readonly attachmentCount: number
            readonly attachments: ReadonlyArray<{
              readonly artifactID: string
              readonly artifactRef?: {
                readonly version: 1
                readonly artifactID: string
                readonly kind: string
                readonly digest: string
                readonly mime: string
                readonly sizeBytes: number
                readonly owner: { readonly scope: "session" | "profile" | "tenant"; readonly id: string }
                readonly retention: { readonly mode: "ephemeral" | "session" | "durable"; readonly expiresAt?: number }
                readonly retrievalHint: { readonly kind: "managed"; readonly handle: string }
                readonly label?: string
                readonly createdAt: number
              }
              readonly path: string
              readonly displayName: string
              readonly mime: string
              readonly sizeBytes: number
              readonly createdAt: number
              readonly sha256: string
              readonly source: "user_message"
              readonly isImage: boolean
            }>
            readonly localOnly: true
            readonly uploaded: false
          }
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.tool.input.started"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly assistantMessageID: string
          readonly callID: string
          readonly name: string
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.tool.input.ended"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly assistantMessageID: string
          readonly callID: string
          readonly text: string
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.tool.called"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly assistantMessageID: string
          readonly callID: string
          readonly tool: string
          readonly input: { readonly [x: string]: JsonValue }
          readonly provider: {
            readonly executed: boolean
            readonly metadata?: { readonly [x: string]: { readonly [x: string]: JsonValue } }
          }
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.tool.progress"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly assistantMessageID: string
          readonly callID: string
          readonly structured: { readonly [x: string]: JsonValue }
          readonly content: ReadonlyArray<
            | { readonly type: "text"; readonly text: string }
            | { readonly type: "file"; readonly uri: string; readonly mime: string; readonly name?: string }
          >
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.tool.success"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly assistantMessageID: string
          readonly callID: string
          readonly structured: { readonly [x: string]: JsonValue }
          readonly content: ReadonlyArray<
            | { readonly type: "text"; readonly text: string }
            | { readonly type: "file"; readonly uri: string; readonly mime: string; readonly name?: string }
          >
          readonly artifactRefs?: ReadonlyArray<{
            readonly version: 1
            readonly artifactID: string
            readonly kind: string
            readonly digest: string
            readonly mime: string
            readonly sizeBytes: number
            readonly owner: { readonly scope: "session" | "profile" | "tenant"; readonly id: string }
            readonly retention: { readonly mode: "ephemeral" | "session" | "durable"; readonly expiresAt?: number }
            readonly retrievalHint: { readonly kind: "managed"; readonly handle: string }
            readonly label?: string
            readonly createdAt: number
          }>
          readonly outputPaths?: ReadonlyArray<string>
          readonly result?: JsonValue
          readonly provider: {
            readonly executed: boolean
            readonly metadata?: { readonly [x: string]: { readonly [x: string]: JsonValue } }
          }
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.tool.failed"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly assistantMessageID: string
          readonly callID: string
          readonly error: { readonly type: "unknown"; readonly message: string }
          readonly content?: ReadonlyArray<
            | { readonly type: "text"; readonly text: string }
            | { readonly type: "file"; readonly uri: string; readonly mime: string; readonly name?: string }
          >
          readonly structured?: { readonly [x: string]: JsonValue }
          readonly artifactRefs?: ReadonlyArray<{
            readonly version: 1
            readonly artifactID: string
            readonly kind: string
            readonly digest: string
            readonly mime: string
            readonly sizeBytes: number
            readonly owner: { readonly scope: "session" | "profile" | "tenant"; readonly id: string }
            readonly retention: { readonly mode: "ephemeral" | "session" | "durable"; readonly expiresAt?: number }
            readonly retrievalHint: { readonly kind: "managed"; readonly handle: string }
            readonly label?: string
            readonly createdAt: number
          }>
          readonly outputPaths?: ReadonlyArray<string>
          readonly result?: JsonValue
          readonly provider: {
            readonly executed: boolean
            readonly metadata?: { readonly [x: string]: { readonly [x: string]: JsonValue } }
          }
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.reasoning.started"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly assistantMessageID: string
          readonly reasoningID: string
          readonly providerMetadata?: { readonly [x: string]: { readonly [x: string]: JsonValue } }
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.reasoning.ended"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly assistantMessageID: string
          readonly reasoningID: string
          readonly text: string
          readonly providerMetadata?: { readonly [x: string]: { readonly [x: string]: JsonValue } }
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.retried"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly attempt: number
          readonly error: {
            readonly message: string
            readonly statusCode?: number
            readonly isRetryable: boolean
            readonly responseHeaders?: { readonly [x: string]: string }
            readonly responseBody?: string
            readonly metadata?: { readonly [x: string]: string }
          }
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.compaction.started"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly messageID: string
          readonly reason: "auto" | "manual"
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.compaction.request.prepared"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly messageID: string
          readonly requestDigest: string
          readonly envelope: string
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.compaction.ended"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly messageID: string
          readonly reason: "auto" | "manual"
          readonly text: string
          readonly recent: string
          readonly usage?: {
            readonly cost: number
            readonly tokens: {
              readonly input: number
              readonly output: number
              readonly reasoning: number
              readonly cache: { readonly read: number; readonly write: number }
            }
          }
          readonly operationID?: string
          readonly candidateDigest?: string
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.revert.staged"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly revert: {
            readonly messageID: string
            readonly partID?: string
            readonly snapshot?: string
            readonly diff?: string
            readonly files?: ReadonlyArray<{
              readonly path: string
              readonly status: "added" | "modified" | "deleted"
              readonly additions: number
              readonly deletions: number
              readonly patch: string
            }>
          }
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.revert.cleared"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: { readonly timestamp: number; readonly sessionID: string }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.revert.committed"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: { readonly timestamp: number; readonly sessionID: string; readonly messageID: string }
      }
  >
  readonly hasMore: boolean
}

export type SessionsEventsInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly after?: { readonly after?: number | undefined }["after"]
}

export type SessionsEventsOutput =
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.title.generated"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly messageID: string
        readonly expectedTitle: string
        readonly title: string
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.agent.switched"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly messageID: string
        readonly agent: string
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.model.switched"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly messageID: string
        readonly model: { readonly id: string; readonly providerID: string; readonly variant?: string }
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.moved"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly location: { readonly directory: string; readonly workspaceID?: string }
        readonly subdirectory?: string
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.prompted"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly messageID: string
        readonly prompt: {
          readonly text: string
          readonly files?: ReadonlyArray<{
            readonly uri: string
            readonly mime: string
            readonly name?: string
            readonly description?: string
            readonly source?: { readonly start: number; readonly end: number; readonly text: string }
          }>
          readonly agents?: ReadonlyArray<{
            readonly name: string
            readonly source?: { readonly start: number; readonly end: number; readonly text: string }
          }>
          readonly scheduledTasks?: ReadonlyArray<{
            readonly id: string
            readonly prompt: string
            readonly description: string
            readonly agent: string
            readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
            readonly command?: string
          }>
          readonly system?: { readonly text: string; readonly source: "request"; readonly scope: "turn" }
          readonly route?: {
            readonly agent?: string
            readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
          }
          readonly command?: { readonly name: string; readonly arguments: string }
          readonly format?:
            | { readonly type: "text" }
            | {
                readonly type: "json_schema"
                readonly schema: { readonly [x: string]: JsonValue }
                readonly retryCount?: number | undefined | undefined
              }
        }
        readonly delivery: "steer" | "queue"
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.prompt.admitted"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly messageID: string
        readonly prompt: {
          readonly text: string
          readonly files?: ReadonlyArray<{
            readonly uri: string
            readonly mime: string
            readonly name?: string
            readonly description?: string
            readonly source?: { readonly start: number; readonly end: number; readonly text: string }
          }>
          readonly agents?: ReadonlyArray<{
            readonly name: string
            readonly source?: { readonly start: number; readonly end: number; readonly text: string }
          }>
          readonly scheduledTasks?: ReadonlyArray<{
            readonly id: string
            readonly prompt: string
            readonly description: string
            readonly agent: string
            readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
            readonly command?: string
          }>
          readonly system?: { readonly text: string; readonly source: "request"; readonly scope: "turn" }
          readonly route?: {
            readonly agent?: string
            readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
          }
          readonly command?: { readonly name: string; readonly arguments: string }
          readonly format?:
            | { readonly type: "text" }
            | {
                readonly type: "json_schema"
                readonly schema: { readonly [x: string]: JsonValue }
                readonly retryCount?: number | undefined | undefined
              }
        }
        readonly delivery: "steer" | "queue"
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.prompt.queue.updated"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly messageID: string
        readonly prompt: {
          readonly text: string
          readonly files?: ReadonlyArray<{
            readonly uri: string
            readonly mime: string
            readonly name?: string
            readonly description?: string
            readonly source?: { readonly start: number; readonly end: number; readonly text: string }
          }>
          readonly agents?: ReadonlyArray<{
            readonly name: string
            readonly source?: { readonly start: number; readonly end: number; readonly text: string }
          }>
          readonly scheduledTasks?: ReadonlyArray<{
            readonly id: string
            readonly prompt: string
            readonly description: string
            readonly agent: string
            readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
            readonly command?: string
          }>
          readonly system?: { readonly text: string; readonly source: "request"; readonly scope: "turn" }
          readonly route?: {
            readonly agent?: string
            readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
          }
          readonly command?: { readonly name: string; readonly arguments: string }
          readonly format?:
            | { readonly type: "text" }
            | {
                readonly type: "json_schema"
                readonly schema: { readonly [x: string]: JsonValue }
                readonly retryCount?: number | undefined | undefined
              }
        }
        readonly delivery: "steer" | "queue"
        readonly expectedAdmittedSeq: number
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.prompt.queue.removed"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly messageID: string
        readonly expectedAdmittedSeq: number
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.context.updated"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly messageID: string
        readonly text: string
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.memory.context.prepared"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly userMessageID: string
        readonly turnStep: number
        readonly queryDigest: string
        readonly contextDigest: string
        readonly injectedBytes: number
        readonly status: "prepared" | "unavailable"
        readonly algorithm: "hybrid_bm25_hashing_vector"
        readonly localOnly: true
        readonly candidates: ReadonlyArray<{
          readonly memoryID: string
          readonly rank: number
          readonly score: number
          readonly lexicalScore: number
          readonly vectorScore: number
        }>
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.context.fusion.prepared"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly userMessageID: string
        readonly turnStep: number
        readonly queryDigest: string
        readonly combinedContextDigest: string
        readonly totalInjectedBytes: number
        readonly providerCallReady: true
        readonly degraded: boolean
        readonly bridgeProtocol?: "arforge.bridge/1.2"
        readonly assemblyProtocol?: "arforge.context/2"
        readonly runtimeTopology?: "typescript-single-runtime" | "legacy-dual-runtime"
        readonly memory: {
          readonly runtime: "typescript-core"
          readonly status: "prepared" | "unavailable"
          readonly contextDigest: string
          readonly injectedBytes: number
          readonly candidateCount: number
        }
        readonly learning: {
          readonly runtime: "typescript-core"
          readonly status: "prepared" | "unavailable"
          readonly contextDigest: string
          readonly injectedBytes: number
        }
        readonly evolution: {
          readonly runtime: "typescript-core" | "python-sidecar"
          readonly status: "prepared" | "unavailable"
          readonly contextDigest: string
          readonly injectedBytes: number
          readonly activeCandidateCount: number
          readonly injectedCandidateCount: number
        }
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.request.envelope.prepared"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly runID: string
        readonly turnStep: number
        readonly attempt?: number
        readonly schemaVersion: "1.0"
        readonly requestDigest: string
        readonly envelope: string
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.request.binding.prepared"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly runID: string
        readonly turnStep: number
        readonly attempt: number
        readonly schemaVersion: 1
        readonly runtime: "native" | "ai-sdk"
        readonly mode: "native-envelope" | "prepared-projection"
        readonly requestDigest: string
        readonly contextDigest: string
        readonly toolSetRevision: string
        readonly routeConfigRevision: string
        readonly skillSnapshotDigest?: string
        readonly compilerRevision: string
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.synthetic"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly messageID: string
        readonly text: string
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.shell.started"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly messageID: string
        readonly callID: string
        readonly command: string
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.shell.ended"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly callID: string
        readonly output: string
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.step.started"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly assistantMessageID: string
        readonly runID?: string
        readonly requestDigest?: string
        readonly agent: string
        readonly model: { readonly id: string; readonly providerID: string; readonly variant?: string }
        readonly snapshot?: string
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.step.ended"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly assistantMessageID: string
        readonly finish: string
        readonly cost: number
        readonly tokens: {
          readonly input: number
          readonly output: number
          readonly reasoning: number
          readonly cache: { readonly read: number; readonly write: number }
        }
        readonly snapshot?: string
        readonly files?: ReadonlyArray<string>
        readonly structured?: { readonly [x: string]: JsonValue }
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.step.failed"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly assistantMessageID: string
        readonly error: { readonly type: "unknown"; readonly message: string }
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.text.started"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly assistantMessageID: string
        readonly textID: string
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.text.ended"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly assistantMessageID: string
        readonly textID: string
        readonly text: string
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.primary.delivered"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly assistantMessageID: string
        readonly callID: string
        readonly message: string
        readonly delivery: {
          readonly status: "normal" | "proactive"
          readonly sentAt: number
          readonly attachmentCount: number
          readonly attachments: ReadonlyArray<{
            readonly artifactID: string
            readonly artifactRef?: {
              readonly version: 1
              readonly artifactID: string
              readonly kind: string
              readonly digest: string
              readonly mime: string
              readonly sizeBytes: number
              readonly owner: { readonly scope: "session" | "profile" | "tenant"; readonly id: string }
              readonly retention: { readonly mode: "ephemeral" | "session" | "durable"; readonly expiresAt?: number }
              readonly retrievalHint: { readonly kind: "managed"; readonly handle: string }
              readonly label?: string
              readonly createdAt: number
            }
            readonly path: string
            readonly displayName: string
            readonly mime: string
            readonly sizeBytes: number
            readonly createdAt: number
            readonly sha256: string
            readonly source: "user_message"
            readonly isImage: boolean
          }>
          readonly localOnly: true
          readonly uploaded: false
        }
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.tool.input.started"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly assistantMessageID: string
        readonly callID: string
        readonly name: string
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.tool.input.ended"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly assistantMessageID: string
        readonly callID: string
        readonly text: string
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.tool.called"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly assistantMessageID: string
        readonly callID: string
        readonly tool: string
        readonly input: { readonly [x: string]: unknown }
        readonly provider: {
          readonly executed: boolean
          readonly metadata?: { readonly [x: string]: { readonly [x: string]: unknown } }
        }
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.tool.progress"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly assistantMessageID: string
        readonly callID: string
        readonly structured: { readonly [x: string]: unknown }
        readonly content: ReadonlyArray<
          | { readonly type: "text"; readonly text: string }
          | { readonly type: "file"; readonly uri: string; readonly mime: string; readonly name?: string }
        >
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.tool.success"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly assistantMessageID: string
        readonly callID: string
        readonly structured: { readonly [x: string]: unknown }
        readonly content: ReadonlyArray<
          | { readonly type: "text"; readonly text: string }
          | { readonly type: "file"; readonly uri: string; readonly mime: string; readonly name?: string }
        >
        readonly artifactRefs?: ReadonlyArray<{
          readonly version: 1
          readonly artifactID: string
          readonly kind: string
          readonly digest: string
          readonly mime: string
          readonly sizeBytes: number
          readonly owner: { readonly scope: "session" | "profile" | "tenant"; readonly id: string }
          readonly retention: { readonly mode: "ephemeral" | "session" | "durable"; readonly expiresAt?: number }
          readonly retrievalHint: { readonly kind: "managed"; readonly handle: string }
          readonly label?: string
          readonly createdAt: number
        }>
        readonly outputPaths?: ReadonlyArray<string>
        readonly result?: unknown
        readonly provider: {
          readonly executed: boolean
          readonly metadata?: { readonly [x: string]: { readonly [x: string]: unknown } }
        }
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.tool.failed"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly assistantMessageID: string
        readonly callID: string
        readonly error: { readonly type: "unknown"; readonly message: string }
        readonly content?: ReadonlyArray<
          | { readonly type: "text"; readonly text: string }
          | { readonly type: "file"; readonly uri: string; readonly mime: string; readonly name?: string }
        >
        readonly structured?: { readonly [x: string]: unknown }
        readonly artifactRefs?: ReadonlyArray<{
          readonly version: 1
          readonly artifactID: string
          readonly kind: string
          readonly digest: string
          readonly mime: string
          readonly sizeBytes: number
          readonly owner: { readonly scope: "session" | "profile" | "tenant"; readonly id: string }
          readonly retention: { readonly mode: "ephemeral" | "session" | "durable"; readonly expiresAt?: number }
          readonly retrievalHint: { readonly kind: "managed"; readonly handle: string }
          readonly label?: string
          readonly createdAt: number
        }>
        readonly outputPaths?: ReadonlyArray<string>
        readonly result?: unknown
        readonly provider: {
          readonly executed: boolean
          readonly metadata?: { readonly [x: string]: { readonly [x: string]: unknown } }
        }
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.reasoning.started"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly assistantMessageID: string
        readonly reasoningID: string
        readonly providerMetadata?: { readonly [x: string]: { readonly [x: string]: unknown } }
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.reasoning.ended"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly assistantMessageID: string
        readonly reasoningID: string
        readonly text: string
        readonly providerMetadata?: { readonly [x: string]: { readonly [x: string]: unknown } }
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.retried"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly attempt: number
        readonly error: {
          readonly message: string
          readonly statusCode?: number
          readonly isRetryable: boolean
          readonly responseHeaders?: { readonly [x: string]: string }
          readonly responseBody?: string
          readonly metadata?: { readonly [x: string]: string }
        }
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.compaction.started"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly messageID: string
        readonly reason: "auto" | "manual"
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.compaction.request.prepared"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly messageID: string
        readonly requestDigest: string
        readonly envelope: string
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.compaction.ended"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly messageID: string
        readonly reason: "auto" | "manual"
        readonly text: string
        readonly recent: string
        readonly usage?: {
          readonly cost: number
          readonly tokens: {
            readonly input: number
            readonly output: number
            readonly reasoning: number
            readonly cache: { readonly read: number; readonly write: number }
          }
        }
        readonly operationID?: string
        readonly candidateDigest?: string
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.revert.staged"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly revert: {
          readonly messageID: string
          readonly partID?: string
          readonly snapshot?: string
          readonly diff?: string
          readonly files?: ReadonlyArray<{
            readonly path: string
            readonly status: "added" | "modified" | "deleted"
            readonly additions: number
            readonly deletions: number
            readonly patch: string
          }>
        }
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.revert.cleared"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: { readonly timestamp: number; readonly sessionID: string }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.revert.committed"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: { readonly timestamp: number; readonly sessionID: string; readonly messageID: string }
    }

export type SessionsInterruptInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type SessionsInterruptOutput = void

export type SessionsMessageInput = {
  readonly sessionID: { readonly sessionID: string; readonly messageID: string }["sessionID"]
  readonly messageID: { readonly sessionID: string; readonly messageID: string }["messageID"]
}

export type SessionsMessageOutput = {
  readonly data:
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number }
        readonly type: "agent-switched"
        readonly agent: string
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number }
        readonly type: "model-switched"
        readonly model: { readonly id: string; readonly providerID: string; readonly variant?: string }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number }
        readonly text: string
        readonly files?: ReadonlyArray<{
          readonly uri: string
          readonly mime: string
          readonly name?: string
          readonly description?: string
          readonly source?: { readonly start: number; readonly end: number; readonly text: string }
        }>
        readonly agents?: ReadonlyArray<{
          readonly name: string
          readonly source?: { readonly start: number; readonly end: number; readonly text: string }
        }>
        readonly scheduledTasks?: ReadonlyArray<{
          readonly id: string
          readonly prompt: string
          readonly description: string
          readonly agent: string
          readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
          readonly command?: string
        }>
        readonly system?: { readonly text: string; readonly source: "request"; readonly scope: "turn" }
        readonly route?: {
          readonly agent?: string
          readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
        }
        readonly command?: { readonly name: string; readonly arguments: string }
        readonly format?:
          | { readonly type: "text" }
          | {
              readonly type: "json_schema"
              readonly schema: { readonly [x: string]: JsonValue }
              readonly retryCount?: number | null | null
            }
        readonly type: "user"
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number }
        readonly sessionID: string
        readonly text: string
        readonly type: "synthetic"
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number }
        readonly type: "system"
        readonly text: string
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number; readonly completed?: number }
        readonly type: "shell"
        readonly callID: string
        readonly command: string
        readonly output: string
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number; readonly completed?: number }
        readonly type: "assistant"
        readonly agent: string
        readonly model: { readonly id: string; readonly providerID: string; readonly variant?: string }
        readonly content: ReadonlyArray<
          | { readonly type: "text"; readonly id: string; readonly text: string }
          | {
              readonly type: "reasoning"
              readonly id: string
              readonly text: string
              readonly providerMetadata?: { readonly [x: string]: { readonly [x: string]: JsonValue } }
              readonly time?: { readonly created: number; readonly completed?: number }
            }
          | {
              readonly type: "tool"
              readonly id: string
              readonly name: string
              readonly provider?: {
                readonly executed: boolean
                readonly metadata?: { readonly [x: string]: { readonly [x: string]: JsonValue } }
                readonly resultMetadata?: { readonly [x: string]: { readonly [x: string]: JsonValue } }
              }
              readonly state:
                | { readonly status: "pending"; readonly input: string }
                | {
                    readonly status: "running"
                    readonly input: { readonly [x: string]: JsonValue }
                    readonly structured: { readonly [x: string]: JsonValue }
                    readonly content: ReadonlyArray<
                      | { readonly type: "text"; readonly text: string }
                      | { readonly type: "file"; readonly uri: string; readonly mime: string; readonly name?: string }
                    >
                  }
                | {
                    readonly status: "completed"
                    readonly input: { readonly [x: string]: JsonValue }
                    readonly attachments?: ReadonlyArray<{
                      readonly uri: string
                      readonly mime: string
                      readonly name?: string
                      readonly description?: string
                      readonly source?: { readonly start: number; readonly end: number; readonly text: string }
                    }>
                    readonly content: ReadonlyArray<
                      | { readonly type: "text"; readonly text: string }
                      | { readonly type: "file"; readonly uri: string; readonly mime: string; readonly name?: string }
                    >
                    readonly artifactRefs?: ReadonlyArray<{
                      readonly version: 1
                      readonly artifactID: string
                      readonly kind: string
                      readonly digest: string
                      readonly mime: string
                      readonly sizeBytes: number
                      readonly owner: { readonly scope: "session" | "profile" | "tenant"; readonly id: string }
                      readonly retention: {
                        readonly mode: "ephemeral" | "session" | "durable"
                        readonly expiresAt?: number
                      }
                      readonly retrievalHint: { readonly kind: "managed"; readonly handle: string }
                      readonly label?: string
                      readonly createdAt: number
                    }>
                    readonly outputPaths?: ReadonlyArray<string>
                    readonly structured: { readonly [x: string]: JsonValue }
                    readonly result?: JsonValue
                  }
                | {
                    readonly status: "error"
                    readonly input: { readonly [x: string]: JsonValue }
                    readonly content: ReadonlyArray<
                      | { readonly type: "text"; readonly text: string }
                      | { readonly type: "file"; readonly uri: string; readonly mime: string; readonly name?: string }
                    >
                    readonly structured: { readonly [x: string]: JsonValue }
                    readonly error: { readonly type: "unknown"; readonly message: string }
                    readonly artifactRefs?: ReadonlyArray<{
                      readonly version: 1
                      readonly artifactID: string
                      readonly kind: string
                      readonly digest: string
                      readonly mime: string
                      readonly sizeBytes: number
                      readonly owner: { readonly scope: "session" | "profile" | "tenant"; readonly id: string }
                      readonly retention: {
                        readonly mode: "ephemeral" | "session" | "durable"
                        readonly expiresAt?: number
                      }
                      readonly retrievalHint: { readonly kind: "managed"; readonly handle: string }
                      readonly label?: string
                      readonly createdAt: number
                    }>
                    readonly outputPaths?: ReadonlyArray<string>
                    readonly result?: JsonValue
                  }
              readonly time: {
                readonly created: number
                readonly ran?: number
                readonly completed?: number
                readonly pruned?: number
              }
            }
        >
        readonly structured?: { readonly [x: string]: JsonValue }
        readonly delivery?: {
          readonly status: "normal" | "proactive"
          readonly sentAt: number
          readonly attachmentCount: number
          readonly attachments: ReadonlyArray<{
            readonly artifactID: string
            readonly artifactRef?: {
              readonly version: 1
              readonly artifactID: string
              readonly kind: string
              readonly digest: string
              readonly mime: string
              readonly sizeBytes: number
              readonly owner: { readonly scope: "session" | "profile" | "tenant"; readonly id: string }
              readonly retention: { readonly mode: "ephemeral" | "session" | "durable"; readonly expiresAt?: number }
              readonly retrievalHint: { readonly kind: "managed"; readonly handle: string }
              readonly label?: string
              readonly createdAt: number
            }
            readonly path: string
            readonly displayName: string
            readonly mime: string
            readonly sizeBytes: number
            readonly createdAt: number
            readonly sha256: string
            readonly source: "user_message"
            readonly isImage: boolean
          }>
          readonly localOnly: true
          readonly uploaded: false
        }
        readonly snapshot?: { readonly start?: string; readonly end?: string; readonly files?: ReadonlyArray<string> }
        readonly finish?: string
        readonly cost?: number
        readonly tokens?: {
          readonly input: number
          readonly output: number
          readonly reasoning: number
          readonly cache: { readonly read: number; readonly write: number }
        }
        readonly error?: { readonly type: "unknown"; readonly message: string }
      }
    | {
        readonly type: "compaction"
        readonly reason: "auto" | "manual"
        readonly summary: string
        readonly recent: string
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number }
      }
}["data"]

export type ArtifactsReadInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly reference: {
    readonly reference: {
      readonly version: 1
      readonly artifactID: string
      readonly kind: string
      readonly digest: string
      readonly mime: string
      readonly sizeBytes: number
      readonly owner: { readonly scope: "session" | "profile" | "tenant"; readonly id: string }
      readonly retention: { readonly mode: "ephemeral" | "session" | "durable"; readonly expiresAt?: number }
      readonly retrievalHint: { readonly kind: "managed"; readonly handle: string }
      readonly label?: string
      readonly createdAt: number
    }
    readonly maxBytes?: number | "Infinity" | "-Infinity" | "NaN" | null
  }["reference"]
  readonly maxBytes?: {
    readonly reference: {
      readonly version: 1
      readonly artifactID: string
      readonly kind: string
      readonly digest: string
      readonly mime: string
      readonly sizeBytes: number
      readonly owner: { readonly scope: "session" | "profile" | "tenant"; readonly id: string }
      readonly retention: { readonly mode: "ephemeral" | "session" | "durable"; readonly expiresAt?: number }
      readonly retrievalHint: { readonly kind: "managed"; readonly handle: string }
      readonly label?: string
      readonly createdAt: number
    }
    readonly maxBytes?: number | "Infinity" | "-Infinity" | "NaN" | null
  }["maxBytes"]
}

export type ArtifactsReadOutput = globalThis.Uint8Array

export type ArtifactsReadRangeInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly reference: {
    readonly reference: {
      readonly version: 1
      readonly artifactID: string
      readonly kind: string
      readonly digest: string
      readonly mime: string
      readonly sizeBytes: number
      readonly owner: { readonly scope: "session" | "profile" | "tenant"; readonly id: string }
      readonly retention: { readonly mode: "ephemeral" | "session" | "durable"; readonly expiresAt?: number }
      readonly retrievalHint: { readonly kind: "managed"; readonly handle: string }
      readonly label?: string
      readonly createdAt: number
    }
    readonly offset: number
    readonly length: number
    readonly ifMatch?: string | null
  }["reference"]
  readonly offset: {
    readonly reference: {
      readonly version: 1
      readonly artifactID: string
      readonly kind: string
      readonly digest: string
      readonly mime: string
      readonly sizeBytes: number
      readonly owner: { readonly scope: "session" | "profile" | "tenant"; readonly id: string }
      readonly retention: { readonly mode: "ephemeral" | "session" | "durable"; readonly expiresAt?: number }
      readonly retrievalHint: { readonly kind: "managed"; readonly handle: string }
      readonly label?: string
      readonly createdAt: number
    }
    readonly offset: number
    readonly length: number
    readonly ifMatch?: string | null
  }["offset"]
  readonly length: {
    readonly reference: {
      readonly version: 1
      readonly artifactID: string
      readonly kind: string
      readonly digest: string
      readonly mime: string
      readonly sizeBytes: number
      readonly owner: { readonly scope: "session" | "profile" | "tenant"; readonly id: string }
      readonly retention: { readonly mode: "ephemeral" | "session" | "durable"; readonly expiresAt?: number }
      readonly retrievalHint: { readonly kind: "managed"; readonly handle: string }
      readonly label?: string
      readonly createdAt: number
    }
    readonly offset: number
    readonly length: number
    readonly ifMatch?: string | null
  }["length"]
  readonly ifMatch?: {
    readonly reference: {
      readonly version: 1
      readonly artifactID: string
      readonly kind: string
      readonly digest: string
      readonly mime: string
      readonly sizeBytes: number
      readonly owner: { readonly scope: "session" | "profile" | "tenant"; readonly id: string }
      readonly retention: { readonly mode: "ephemeral" | "session" | "durable"; readonly expiresAt?: number }
      readonly retrievalHint: { readonly kind: "managed"; readonly handle: string }
      readonly label?: string
      readonly createdAt: number
    }
    readonly offset: number
    readonly length: number
    readonly ifMatch?: string | null
  }["ifMatch"]
}

export type ArtifactsReadRangeOutput = globalThis.Uint8Array

export type ArtifactsReadScopedInput = {
  readonly reference: {
    readonly reference: {
      readonly version: 1
      readonly artifactID: string
      readonly kind: string
      readonly digest: string
      readonly mime: string
      readonly sizeBytes: number
      readonly owner: { readonly scope: "session" | "profile" | "tenant"; readonly id: string }
      readonly retention: { readonly mode: "ephemeral" | "session" | "durable"; readonly expiresAt?: number }
      readonly retrievalHint: { readonly kind: "managed"; readonly handle: string }
      readonly label?: string
      readonly createdAt: number
    }
    readonly maxBytes?: number | "Infinity" | "-Infinity" | "NaN" | null
  }["reference"]
  readonly maxBytes?: {
    readonly reference: {
      readonly version: 1
      readonly artifactID: string
      readonly kind: string
      readonly digest: string
      readonly mime: string
      readonly sizeBytes: number
      readonly owner: { readonly scope: "session" | "profile" | "tenant"; readonly id: string }
      readonly retention: { readonly mode: "ephemeral" | "session" | "durable"; readonly expiresAt?: number }
      readonly retrievalHint: { readonly kind: "managed"; readonly handle: string }
      readonly label?: string
      readonly createdAt: number
    }
    readonly maxBytes?: number | "Infinity" | "-Infinity" | "NaN" | null
  }["maxBytes"]
}

export type ArtifactsReadScopedOutput = globalThis.Uint8Array

export type ArtifactsReadScopedRangeInput = {
  readonly reference: {
    readonly reference: {
      readonly version: 1
      readonly artifactID: string
      readonly kind: string
      readonly digest: string
      readonly mime: string
      readonly sizeBytes: number
      readonly owner: { readonly scope: "session" | "profile" | "tenant"; readonly id: string }
      readonly retention: { readonly mode: "ephemeral" | "session" | "durable"; readonly expiresAt?: number }
      readonly retrievalHint: { readonly kind: "managed"; readonly handle: string }
      readonly label?: string
      readonly createdAt: number
    }
    readonly offset: number
    readonly length: number
    readonly ifMatch?: string | null
  }["reference"]
  readonly offset: {
    readonly reference: {
      readonly version: 1
      readonly artifactID: string
      readonly kind: string
      readonly digest: string
      readonly mime: string
      readonly sizeBytes: number
      readonly owner: { readonly scope: "session" | "profile" | "tenant"; readonly id: string }
      readonly retention: { readonly mode: "ephemeral" | "session" | "durable"; readonly expiresAt?: number }
      readonly retrievalHint: { readonly kind: "managed"; readonly handle: string }
      readonly label?: string
      readonly createdAt: number
    }
    readonly offset: number
    readonly length: number
    readonly ifMatch?: string | null
  }["offset"]
  readonly length: {
    readonly reference: {
      readonly version: 1
      readonly artifactID: string
      readonly kind: string
      readonly digest: string
      readonly mime: string
      readonly sizeBytes: number
      readonly owner: { readonly scope: "session" | "profile" | "tenant"; readonly id: string }
      readonly retention: { readonly mode: "ephemeral" | "session" | "durable"; readonly expiresAt?: number }
      readonly retrievalHint: { readonly kind: "managed"; readonly handle: string }
      readonly label?: string
      readonly createdAt: number
    }
    readonly offset: number
    readonly length: number
    readonly ifMatch?: string | null
  }["length"]
  readonly ifMatch?: {
    readonly reference: {
      readonly version: 1
      readonly artifactID: string
      readonly kind: string
      readonly digest: string
      readonly mime: string
      readonly sizeBytes: number
      readonly owner: { readonly scope: "session" | "profile" | "tenant"; readonly id: string }
      readonly retention: { readonly mode: "ephemeral" | "session" | "durable"; readonly expiresAt?: number }
      readonly retrievalHint: { readonly kind: "managed"; readonly handle: string }
      readonly label?: string
      readonly createdAt: number
    }
    readonly offset: number
    readonly length: number
    readonly ifMatch?: string | null
  }["ifMatch"]
}

export type ArtifactsReadScopedRangeOutput = globalThis.Uint8Array

export type ArtifactsOwnerContextOutput = {
  readonly profile: { readonly scope: "session" | "profile" | "tenant"; readonly id: string }
  readonly tenant: { readonly scope: "session" | "profile" | "tenant"; readonly id: string }
  readonly tenantReadable: boolean
}

export type ArtifactsMaintenanceContextInput = {
  readonly scope?: { readonly scope?: "profile" | "tenant" | undefined }["scope"]
}

export type ArtifactsMaintenanceContextOutput = {
  readonly owner: { readonly scope: "session" | "profile" | "tenant"; readonly id: string }
  readonly maintenanceScope: "profile"
  readonly canMaintain: boolean
  readonly scan: {
    readonly scanID: string
    readonly status: "active" | "complete" | "expired"
    readonly pageNumber: number
    readonly scannedActions: number
    readonly scanLimit: number
    readonly scanComplete: boolean
    readonly scanExpiresAt: number
    readonly sessionDigest: string
  } | null
  readonly reason: string
}

export type ArtifactsCatalogInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly limit?: { readonly limit?: number | undefined; readonly beforeSequence?: number | undefined }["limit"]
  readonly beforeSequence?: {
    readonly limit?: number | undefined
    readonly beforeSequence?: number | undefined
  }["beforeSequence"]
}

export type ArtifactsCatalogOutput = {
  readonly entries: ReadonlyArray<{
    readonly reference: {
      readonly version: 1
      readonly artifactID: string
      readonly kind: string
      readonly digest: string
      readonly mime: string
      readonly sizeBytes: number
      readonly owner: { readonly scope: "session" | "profile" | "tenant"; readonly id: string }
      readonly retention: { readonly mode: "ephemeral" | "session" | "durable"; readonly expiresAt?: number }
      readonly retrievalHint: { readonly kind: "managed"; readonly handle: string }
      readonly label?: string
      readonly createdAt: number
    }
    readonly firstSeenAt: number
    readonly lastSeenAt: number
    readonly lastSequence: number
    readonly readCount: number
  }>
  readonly nextSequence?: number | null
  readonly headSequence: number
  readonly headHash: string
  readonly droppedAuditEntries: number
}

export type ArtifactsCatalogScopedInput = {
  readonly owner: {
    readonly owner: { readonly scope: "session" | "profile" | "tenant"; readonly id: string }
    readonly limit?: number | undefined
    readonly beforeSequence?: number | undefined
  }["owner"]
  readonly limit?: {
    readonly owner: { readonly scope: "session" | "profile" | "tenant"; readonly id: string }
    readonly limit?: number | undefined
    readonly beforeSequence?: number | undefined
  }["limit"]
  readonly beforeSequence?: {
    readonly owner: { readonly scope: "session" | "profile" | "tenant"; readonly id: string }
    readonly limit?: number | undefined
    readonly beforeSequence?: number | undefined
  }["beforeSequence"]
}

export type ArtifactsCatalogScopedOutput = {
  readonly entries: ReadonlyArray<{
    readonly reference: {
      readonly version: 1
      readonly artifactID: string
      readonly kind: string
      readonly digest: string
      readonly mime: string
      readonly sizeBytes: number
      readonly owner: { readonly scope: "session" | "profile" | "tenant"; readonly id: string }
      readonly retention: { readonly mode: "ephemeral" | "session" | "durable"; readonly expiresAt?: number }
      readonly retrievalHint: { readonly kind: "managed"; readonly handle: string }
      readonly label?: string
      readonly createdAt: number
    }
    readonly firstSeenAt: number
    readonly lastSeenAt: number
    readonly lastSequence: number
    readonly readCount: number
  }>
  readonly nextSequence?: number | null
  readonly headSequence: number
  readonly headHash: string
  readonly droppedAuditEntries: number
}

export type ArtifactsAuditInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly limit?: { readonly limit?: number | undefined; readonly beforeSequence?: number | undefined }["limit"]
  readonly beforeSequence?: {
    readonly limit?: number | undefined
    readonly beforeSequence?: number | undefined
  }["beforeSequence"]
}

export type ArtifactsAuditOutput = ReadonlyArray<{
  readonly sequence: number
  readonly recordedAt: number
  readonly actor: string
  readonly action: "registered" | "read" | "range" | "rejected" | "rate_limited" | "removed"
  readonly artifactID: string
  readonly digest: string
  readonly owner: { readonly scope: "session" | "profile" | "tenant"; readonly id: string }
  readonly reason?: string | undefined
  readonly offset?: number | undefined
  readonly length?: number | undefined
  readonly previousHash: string
  readonly recordHash: string
}>

export type ArtifactsAuditScopedInput = {
  readonly owner: {
    readonly owner: { readonly scope: "session" | "profile" | "tenant"; readonly id: string }
    readonly limit?: number | undefined
    readonly beforeSequence?: number | undefined
  }["owner"]
  readonly limit?: {
    readonly owner: { readonly scope: "session" | "profile" | "tenant"; readonly id: string }
    readonly limit?: number | undefined
    readonly beforeSequence?: number | undefined
  }["limit"]
  readonly beforeSequence?: {
    readonly owner: { readonly scope: "session" | "profile" | "tenant"; readonly id: string }
    readonly limit?: number | undefined
    readonly beforeSequence?: number | undefined
  }["beforeSequence"]
}

export type ArtifactsAuditScopedOutput = ReadonlyArray<{
  readonly sequence: number
  readonly recordedAt: number
  readonly actor: string
  readonly action: "registered" | "read" | "range" | "rejected" | "rate_limited" | "removed"
  readonly artifactID: string
  readonly digest: string
  readonly owner: { readonly scope: "session" | "profile" | "tenant"; readonly id: string }
  readonly reason?: string | undefined
  readonly offset?: number | undefined
  readonly length?: number | undefined
  readonly previousHash: string
  readonly recordHash: string
}>

export type SubagentControlChildrenInput = {
  readonly parentRunID: { readonly parentRunID: string }["parentRunID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type SubagentControlChildrenOutput = {
  readonly parentRunID: string
  readonly controlAvailable?: boolean
  readonly children: ReadonlyArray<{
    readonly childRunID: string
    readonly sessionID: string
    readonly status:
      | "draft"
      | "preflight"
      | "awaiting_authorization"
      | "queued"
      | "running"
      | "paused"
      | "recovering"
      | "verifying"
      | "completed"
      | "failed"
      | "cancelled"
    readonly resultReceiptStatus?: "pending" | "missing" | "present" | "not-required"
    readonly depth: number
    readonly objectiveDigest: string
  }>
}

export type SubagentControlSteerInput = {
  readonly parentRunID: { readonly parentRunID: string; readonly childRunID: string }["parentRunID"]
  readonly childRunID: { readonly parentRunID: string; readonly childRunID: string }["childRunID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
  readonly requestID: {
    readonly requestID: string
    readonly prompt: {
      readonly text: string
      readonly files?: ReadonlyArray<{
        readonly uri: string
        readonly mime?: string
        readonly name?: string
        readonly description?: string
        readonly source?: { readonly start: number; readonly end: number; readonly text: string }
      }>
      readonly agents?: ReadonlyArray<{
        readonly name: string
        readonly source?: { readonly start: number; readonly end: number; readonly text: string }
      }>
      readonly scheduledTasks?: ReadonlyArray<{
        readonly id: string
        readonly prompt: string
        readonly description: string
        readonly agent: string
        readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
        readonly command?: string
      }>
      readonly system?: { readonly text: string; readonly source: "request"; readonly scope: "turn" }
      readonly route?: {
        readonly agent?: string
        readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
      }
      readonly command?: { readonly name: string; readonly arguments: string }
      readonly format?:
        | { readonly type: "text" }
        | {
            readonly type: "json_schema"
            readonly schema: { readonly [x: string]: JsonValue }
            readonly retryCount?: number | null | null
          }
    }
  }["requestID"]
  readonly prompt: {
    readonly requestID: string
    readonly prompt: {
      readonly text: string
      readonly files?: ReadonlyArray<{
        readonly uri: string
        readonly mime?: string
        readonly name?: string
        readonly description?: string
        readonly source?: { readonly start: number; readonly end: number; readonly text: string }
      }>
      readonly agents?: ReadonlyArray<{
        readonly name: string
        readonly source?: { readonly start: number; readonly end: number; readonly text: string }
      }>
      readonly scheduledTasks?: ReadonlyArray<{
        readonly id: string
        readonly prompt: string
        readonly description: string
        readonly agent: string
        readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
        readonly command?: string
      }>
      readonly system?: { readonly text: string; readonly source: "request"; readonly scope: "turn" }
      readonly route?: {
        readonly agent?: string
        readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
      }
      readonly command?: { readonly name: string; readonly arguments: string }
      readonly format?:
        | { readonly type: "text" }
        | {
            readonly type: "json_schema"
            readonly schema: { readonly [x: string]: JsonValue }
            readonly retryCount?: number | null | null
          }
    }
  }["prompt"]
}

export type SubagentControlSteerOutput = {
  readonly operation: "steer" | "followup" | "wait" | "cancel"
  readonly parentRunID: string
  readonly childRunID: string
  readonly status:
    | "draft"
    | "preflight"
    | "awaiting_authorization"
    | "queued"
    | "running"
    | "paused"
    | "recovering"
    | "verifying"
    | "completed"
    | "failed"
    | "cancelled"
  readonly timedOut: boolean
  readonly resultReceiptStatus?: "pending" | "missing" | "present" | "not-required"
  readonly requestID?: string
  readonly admission?: {
    readonly messageID: string
    readonly sessionID: string
    readonly delivery: "steer" | "queue"
    readonly promptDigest: string
    readonly envelopeDigest: string
  }
  readonly controlRunID?: string
  readonly actionID?: string
  readonly claim?: "claimed" | "existing"
}

export type SubagentControlFollowupInput = {
  readonly parentRunID: { readonly parentRunID: string; readonly childRunID: string }["parentRunID"]
  readonly childRunID: { readonly parentRunID: string; readonly childRunID: string }["childRunID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
  readonly requestID: {
    readonly requestID: string
    readonly prompt: {
      readonly text: string
      readonly files?: ReadonlyArray<{
        readonly uri: string
        readonly mime?: string
        readonly name?: string
        readonly description?: string
        readonly source?: { readonly start: number; readonly end: number; readonly text: string }
      }>
      readonly agents?: ReadonlyArray<{
        readonly name: string
        readonly source?: { readonly start: number; readonly end: number; readonly text: string }
      }>
      readonly scheduledTasks?: ReadonlyArray<{
        readonly id: string
        readonly prompt: string
        readonly description: string
        readonly agent: string
        readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
        readonly command?: string
      }>
      readonly system?: { readonly text: string; readonly source: "request"; readonly scope: "turn" }
      readonly route?: {
        readonly agent?: string
        readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
      }
      readonly command?: { readonly name: string; readonly arguments: string }
      readonly format?:
        | { readonly type: "text" }
        | {
            readonly type: "json_schema"
            readonly schema: { readonly [x: string]: JsonValue }
            readonly retryCount?: number | null | null
          }
    }
  }["requestID"]
  readonly prompt: {
    readonly requestID: string
    readonly prompt: {
      readonly text: string
      readonly files?: ReadonlyArray<{
        readonly uri: string
        readonly mime?: string
        readonly name?: string
        readonly description?: string
        readonly source?: { readonly start: number; readonly end: number; readonly text: string }
      }>
      readonly agents?: ReadonlyArray<{
        readonly name: string
        readonly source?: { readonly start: number; readonly end: number; readonly text: string }
      }>
      readonly scheduledTasks?: ReadonlyArray<{
        readonly id: string
        readonly prompt: string
        readonly description: string
        readonly agent: string
        readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
        readonly command?: string
      }>
      readonly system?: { readonly text: string; readonly source: "request"; readonly scope: "turn" }
      readonly route?: {
        readonly agent?: string
        readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
      }
      readonly command?: { readonly name: string; readonly arguments: string }
      readonly format?:
        | { readonly type: "text" }
        | {
            readonly type: "json_schema"
            readonly schema: { readonly [x: string]: JsonValue }
            readonly retryCount?: number | null | null
          }
    }
  }["prompt"]
}

export type SubagentControlFollowupOutput = {
  readonly operation: "steer" | "followup" | "wait" | "cancel"
  readonly parentRunID: string
  readonly childRunID: string
  readonly status:
    | "draft"
    | "preflight"
    | "awaiting_authorization"
    | "queued"
    | "running"
    | "paused"
    | "recovering"
    | "verifying"
    | "completed"
    | "failed"
    | "cancelled"
  readonly timedOut: boolean
  readonly resultReceiptStatus?: "pending" | "missing" | "present" | "not-required"
  readonly requestID?: string
  readonly admission?: {
    readonly messageID: string
    readonly sessionID: string
    readonly delivery: "steer" | "queue"
    readonly promptDigest: string
    readonly envelopeDigest: string
  }
  readonly controlRunID?: string
  readonly actionID?: string
  readonly claim?: "claimed" | "existing"
}

export type SubagentControlWaitInput = {
  readonly parentRunID: { readonly parentRunID: string; readonly childRunID: string }["parentRunID"]
  readonly childRunID: { readonly parentRunID: string; readonly childRunID: string }["childRunID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
  readonly requestID: { readonly requestID: string; readonly timeoutMs?: number }["requestID"]
  readonly timeoutMs?: { readonly requestID: string; readonly timeoutMs?: number }["timeoutMs"]
}

export type SubagentControlWaitOutput = {
  readonly operation: "steer" | "followup" | "wait" | "cancel"
  readonly parentRunID: string
  readonly childRunID: string
  readonly status:
    | "draft"
    | "preflight"
    | "awaiting_authorization"
    | "queued"
    | "running"
    | "paused"
    | "recovering"
    | "verifying"
    | "completed"
    | "failed"
    | "cancelled"
  readonly timedOut: boolean
  readonly resultReceiptStatus?: "pending" | "missing" | "present" | "not-required"
  readonly requestID?: string
  readonly admission?: {
    readonly messageID: string
    readonly sessionID: string
    readonly delivery: "steer" | "queue"
    readonly promptDigest: string
    readonly envelopeDigest: string
  }
  readonly controlRunID?: string
  readonly actionID?: string
  readonly claim?: "claimed" | "existing"
}

export type SubagentControlCancelInput = {
  readonly parentRunID: { readonly parentRunID: string; readonly childRunID: string }["parentRunID"]
  readonly childRunID: { readonly parentRunID: string; readonly childRunID: string }["childRunID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
  readonly requestID: {
    readonly requestID: string
    readonly reason: string
    readonly recursive?: boolean
    readonly timeoutMs?: number
  }["requestID"]
  readonly reason: {
    readonly requestID: string
    readonly reason: string
    readonly recursive?: boolean
    readonly timeoutMs?: number
  }["reason"]
  readonly recursive?: {
    readonly requestID: string
    readonly reason: string
    readonly recursive?: boolean
    readonly timeoutMs?: number
  }["recursive"]
  readonly timeoutMs?: {
    readonly requestID: string
    readonly reason: string
    readonly recursive?: boolean
    readonly timeoutMs?: number
  }["timeoutMs"]
}

export type SubagentControlCancelOutput = {
  readonly operation: "steer" | "followup" | "wait" | "cancel"
  readonly parentRunID: string
  readonly childRunID: string
  readonly status:
    | "draft"
    | "preflight"
    | "awaiting_authorization"
    | "queued"
    | "running"
    | "paused"
    | "recovering"
    | "verifying"
    | "completed"
    | "failed"
    | "cancelled"
  readonly timedOut: boolean
  readonly resultReceiptStatus?: "pending" | "missing" | "present" | "not-required"
  readonly requestID?: string
  readonly admission?: {
    readonly messageID: string
    readonly sessionID: string
    readonly delivery: "steer" | "queue"
    readonly promptDigest: string
    readonly envelopeDigest: string
  }
  readonly controlRunID?: string
  readonly actionID?: string
  readonly claim?: "claimed" | "existing"
}

export type SubagentControlStatusInput = {
  readonly parentRunID: {
    readonly parentRunID: string
    readonly childRunID: string
    readonly operation: "steer" | "followup" | "wait" | "cancel"
    readonly requestID: string
  }["parentRunID"]
  readonly childRunID: {
    readonly parentRunID: string
    readonly childRunID: string
    readonly operation: "steer" | "followup" | "wait" | "cancel"
    readonly requestID: string
  }["childRunID"]
  readonly operation: {
    readonly parentRunID: string
    readonly childRunID: string
    readonly operation: "steer" | "followup" | "wait" | "cancel"
    readonly requestID: string
  }["operation"]
  readonly requestID: {
    readonly parentRunID: string
    readonly childRunID: string
    readonly operation: "steer" | "followup" | "wait" | "cancel"
    readonly requestID: string
  }["requestID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type SubagentControlStatusOutput = {
  readonly operation: "steer" | "followup" | "wait" | "cancel"
  readonly parentRunID: string
  readonly childRunID: string
  readonly status:
    | "draft"
    | "preflight"
    | "awaiting_authorization"
    | "queued"
    | "running"
    | "paused"
    | "recovering"
    | "verifying"
    | "completed"
    | "failed"
    | "cancelled"
  readonly timedOut: boolean
  readonly resultReceiptStatus?: "pending" | "missing" | "present" | "not-required"
  readonly requestID?: string
  readonly admission?: {
    readonly messageID: string
    readonly sessionID: string
    readonly delivery: "steer" | "queue"
    readonly promptDigest: string
    readonly envelopeDigest: string
  }
  readonly controlRunID?: string
  readonly actionID?: string
  readonly claim?: "claimed" | "existing"
}

export type GoalsListInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly history?: { readonly history?: "true" | "false" | undefined }["history"]
}

export type GoalsListOutput = {
  readonly data: {
    readonly active?: {
      readonly id: string
      readonly sessionID: string
      readonly objective: string
      readonly status: "queued" | "active" | "running" | "paused" | "blocked" | "completed" | "cancelled"
      readonly queuePosition: number
      readonly revision: number
      readonly promptID?: string
      readonly lastError: string
      readonly time: {
        readonly created: number
        readonly updated: number
        readonly started?: number
        readonly finished?: number
      }
    }
    readonly queued: ReadonlyArray<{
      readonly id: string
      readonly sessionID: string
      readonly objective: string
      readonly status: "queued" | "active" | "running" | "paused" | "blocked" | "completed" | "cancelled"
      readonly queuePosition: number
      readonly revision: number
      readonly promptID?: string
      readonly lastError: string
      readonly time: {
        readonly created: number
        readonly updated: number
        readonly started?: number
        readonly finished?: number
      }
    }>
    readonly history: ReadonlyArray<{
      readonly id: string
      readonly sessionID: string
      readonly objective: string
      readonly status: "queued" | "active" | "running" | "paused" | "blocked" | "completed" | "cancelled"
      readonly queuePosition: number
      readonly revision: number
      readonly promptID?: string
      readonly lastError: string
      readonly time: {
        readonly created: number
        readonly updated: number
        readonly started?: number
        readonly finished?: number
      }
    }>
    readonly items: ReadonlyArray<{
      readonly id: string
      readonly sessionID: string
      readonly objective: string
      readonly status: "queued" | "active" | "running" | "paused" | "blocked" | "completed" | "cancelled"
      readonly queuePosition: number
      readonly revision: number
      readonly promptID?: string
      readonly lastError: string
      readonly time: {
        readonly created: number
        readonly updated: number
        readonly started?: number
        readonly finished?: number
      }
    }>
  }
}["data"]

export type GoalsCreateInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly objective: { readonly objective: string; readonly queue?: boolean | undefined }["objective"]
  readonly queue?: { readonly objective: string; readonly queue?: boolean | undefined }["queue"]
}

export type GoalsCreateOutput = {
  readonly data: {
    readonly id: string
    readonly sessionID: string
    readonly objective: string
    readonly status: "queued" | "active" | "running" | "paused" | "blocked" | "completed" | "cancelled"
    readonly queuePosition: number
    readonly revision: number
    readonly promptID?: string
    readonly lastError: string
    readonly time: {
      readonly created: number
      readonly updated: number
      readonly started?: number
      readonly finished?: number
    }
  }
}["data"]

export type GoalsGetInput = {
  readonly sessionID: { readonly sessionID: string; readonly goalID: string }["sessionID"]
  readonly goalID: { readonly sessionID: string; readonly goalID: string }["goalID"]
}

export type GoalsGetOutput = {
  readonly data: {
    readonly id: string
    readonly sessionID: string
    readonly objective: string
    readonly status: "queued" | "active" | "running" | "paused" | "blocked" | "completed" | "cancelled"
    readonly queuePosition: number
    readonly revision: number
    readonly promptID?: string
    readonly lastError: string
    readonly time: {
      readonly created: number
      readonly updated: number
      readonly started?: number
      readonly finished?: number
    }
  }
}["data"]

export type GoalsRunInput = {
  readonly sessionID: { readonly sessionID: string; readonly goalID: string }["sessionID"]
  readonly goalID: { readonly sessionID: string; readonly goalID: string }["goalID"]
  readonly expectedRevision: { readonly expectedRevision: number }["expectedRevision"]
}

export type GoalsRunOutput = {
  readonly data: {
    readonly goal: {
      readonly id: string
      readonly sessionID: string
      readonly objective: string
      readonly status: "queued" | "active" | "running" | "paused" | "blocked" | "completed" | "cancelled"
      readonly queuePosition: number
      readonly revision: number
      readonly promptID?: string
      readonly lastError: string
      readonly time: {
        readonly created: number
        readonly updated: number
        readonly started?: number
        readonly finished?: number
      }
    }
    readonly input: {
      readonly admittedSeq: number
      readonly id: string
      readonly sessionID: string
      readonly prompt: {
        readonly text: string
        readonly files?: ReadonlyArray<{
          readonly uri: string
          readonly mime: string
          readonly name?: string
          readonly description?: string
          readonly source?: { readonly start: number; readonly end: number; readonly text: string }
        }>
        readonly agents?: ReadonlyArray<{
          readonly name: string
          readonly source?: { readonly start: number; readonly end: number; readonly text: string }
        }>
        readonly scheduledTasks?: ReadonlyArray<{
          readonly id: string
          readonly prompt: string
          readonly description: string
          readonly agent: string
          readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
          readonly command?: string
        }>
        readonly system?: { readonly text: string; readonly source: "request"; readonly scope: "turn" }
        readonly route?: {
          readonly agent?: string
          readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
        }
        readonly command?: { readonly name: string; readonly arguments: string }
        readonly format?:
          | { readonly type: "text" }
          | {
              readonly type: "json_schema"
              readonly schema: { readonly [x: string]: JsonValue }
              readonly retryCount?: number | null | null
            }
      }
      readonly delivery: "steer" | "queue"
      readonly timeCreated: number
      readonly promotedSeq?: number
    }
  }
}["data"]

export type GoalsPauseInput = {
  readonly sessionID: { readonly sessionID: string; readonly goalID: string }["sessionID"]
  readonly goalID: { readonly sessionID: string; readonly goalID: string }["goalID"]
  readonly expectedRevision: { readonly expectedRevision: number }["expectedRevision"]
}

export type GoalsPauseOutput = {
  readonly data: {
    readonly id: string
    readonly sessionID: string
    readonly objective: string
    readonly status: "queued" | "active" | "running" | "paused" | "blocked" | "completed" | "cancelled"
    readonly queuePosition: number
    readonly revision: number
    readonly promptID?: string
    readonly lastError: string
    readonly time: {
      readonly created: number
      readonly updated: number
      readonly started?: number
      readonly finished?: number
    }
  }
}["data"]

export type GoalsResumeInput = {
  readonly sessionID: { readonly sessionID: string; readonly goalID: string }["sessionID"]
  readonly goalID: { readonly sessionID: string; readonly goalID: string }["goalID"]
  readonly expectedRevision: { readonly expectedRevision: number }["expectedRevision"]
}

export type GoalsResumeOutput = {
  readonly data: {
    readonly id: string
    readonly sessionID: string
    readonly objective: string
    readonly status: "queued" | "active" | "running" | "paused" | "blocked" | "completed" | "cancelled"
    readonly queuePosition: number
    readonly revision: number
    readonly promptID?: string
    readonly lastError: string
    readonly time: {
      readonly created: number
      readonly updated: number
      readonly started?: number
      readonly finished?: number
    }
  }
}["data"]

export type GoalsCompleteInput = {
  readonly sessionID: { readonly sessionID: string; readonly goalID: string }["sessionID"]
  readonly goalID: { readonly sessionID: string; readonly goalID: string }["goalID"]
  readonly expectedRevision: { readonly expectedRevision: number }["expectedRevision"]
}

export type GoalsCompleteOutput = {
  readonly data: {
    readonly id: string
    readonly sessionID: string
    readonly objective: string
    readonly status: "queued" | "active" | "running" | "paused" | "blocked" | "completed" | "cancelled"
    readonly queuePosition: number
    readonly revision: number
    readonly promptID?: string
    readonly lastError: string
    readonly time: {
      readonly created: number
      readonly updated: number
      readonly started?: number
      readonly finished?: number
    }
  }
}["data"]

export type GoalsBlockInput = {
  readonly sessionID: { readonly sessionID: string; readonly goalID: string }["sessionID"]
  readonly goalID: { readonly sessionID: string; readonly goalID: string }["goalID"]
  readonly expectedRevision: { readonly expectedRevision: number; readonly error: string }["expectedRevision"]
  readonly error: { readonly expectedRevision: number; readonly error: string }["error"]
}

export type GoalsBlockOutput = {
  readonly data: {
    readonly id: string
    readonly sessionID: string
    readonly objective: string
    readonly status: "queued" | "active" | "running" | "paused" | "blocked" | "completed" | "cancelled"
    readonly queuePosition: number
    readonly revision: number
    readonly promptID?: string
    readonly lastError: string
    readonly time: {
      readonly created: number
      readonly updated: number
      readonly started?: number
      readonly finished?: number
    }
  }
}["data"]

export type GoalsCancelInput = {
  readonly sessionID: { readonly sessionID: string; readonly goalID: string }["sessionID"]
  readonly goalID: { readonly sessionID: string; readonly goalID: string }["goalID"]
  readonly expectedRevision: { readonly expectedRevision: number }["expectedRevision"]
}

export type GoalsCancelOutput = {
  readonly data: {
    readonly id: string
    readonly sessionID: string
    readonly objective: string
    readonly status: "queued" | "active" | "running" | "paused" | "blocked" | "completed" | "cancelled"
    readonly queuePosition: number
    readonly revision: number
    readonly promptID?: string
    readonly lastError: string
    readonly time: {
      readonly created: number
      readonly updated: number
      readonly started?: number
      readonly finished?: number
    }
  }
}["data"]

export type GoalsReplaceInput = {
  readonly sessionID: { readonly sessionID: string; readonly goalID: string }["sessionID"]
  readonly goalID: { readonly sessionID: string; readonly goalID: string }["goalID"]
  readonly expectedRevision: { readonly expectedRevision: number; readonly objective: string }["expectedRevision"]
  readonly objective: { readonly expectedRevision: number; readonly objective: string }["objective"]
}

export type GoalsReplaceOutput = {
  readonly data: {
    readonly id: string
    readonly sessionID: string
    readonly objective: string
    readonly status: "queued" | "active" | "running" | "paused" | "blocked" | "completed" | "cancelled"
    readonly queuePosition: number
    readonly revision: number
    readonly promptID?: string
    readonly lastError: string
    readonly time: {
      readonly created: number
      readonly updated: number
      readonly started?: number
      readonly finished?: number
    }
  }
}["data"]

export type GoalsDeleteQueuedInput = {
  readonly sessionID: { readonly sessionID: string; readonly goalID: string }["sessionID"]
  readonly goalID: { readonly sessionID: string; readonly goalID: string }["goalID"]
  readonly expectedRevision: { readonly expectedRevision: number }["expectedRevision"]
}

export type GoalsDeleteQueuedOutput = void

export type GoalsReorderInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly goals: { readonly goals: ReadonlyArray<{ readonly id: string; readonly revision: number }> }["goals"]
}

export type GoalsReorderOutput = {
  readonly data: {
    readonly active?: {
      readonly id: string
      readonly sessionID: string
      readonly objective: string
      readonly status: "queued" | "active" | "running" | "paused" | "blocked" | "completed" | "cancelled"
      readonly queuePosition: number
      readonly revision: number
      readonly promptID?: string
      readonly lastError: string
      readonly time: {
        readonly created: number
        readonly updated: number
        readonly started?: number
        readonly finished?: number
      }
    }
    readonly queued: ReadonlyArray<{
      readonly id: string
      readonly sessionID: string
      readonly objective: string
      readonly status: "queued" | "active" | "running" | "paused" | "blocked" | "completed" | "cancelled"
      readonly queuePosition: number
      readonly revision: number
      readonly promptID?: string
      readonly lastError: string
      readonly time: {
        readonly created: number
        readonly updated: number
        readonly started?: number
        readonly finished?: number
      }
    }>
    readonly history: ReadonlyArray<{
      readonly id: string
      readonly sessionID: string
      readonly objective: string
      readonly status: "queued" | "active" | "running" | "paused" | "blocked" | "completed" | "cancelled"
      readonly queuePosition: number
      readonly revision: number
      readonly promptID?: string
      readonly lastError: string
      readonly time: {
        readonly created: number
        readonly updated: number
        readonly started?: number
        readonly finished?: number
      }
    }>
    readonly items: ReadonlyArray<{
      readonly id: string
      readonly sessionID: string
      readonly objective: string
      readonly status: "queued" | "active" | "running" | "paused" | "blocked" | "completed" | "cancelled"
      readonly queuePosition: number
      readonly revision: number
      readonly promptID?: string
      readonly lastError: string
      readonly time: {
        readonly created: number
        readonly updated: number
        readonly started?: number
        readonly finished?: number
      }
    }>
  }
}["data"]

export type ScheduledPromptsCreateInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly name: {
    readonly name: string
    readonly cron: string
    readonly prompt: string
    readonly recurring?: boolean | undefined
    readonly durable?: boolean | undefined
  }["name"]
  readonly cron: {
    readonly name: string
    readonly cron: string
    readonly prompt: string
    readonly recurring?: boolean | undefined
    readonly durable?: boolean | undefined
  }["cron"]
  readonly prompt: {
    readonly name: string
    readonly cron: string
    readonly prompt: string
    readonly recurring?: boolean | undefined
    readonly durable?: boolean | undefined
  }["prompt"]
  readonly recurring?: {
    readonly name: string
    readonly cron: string
    readonly prompt: string
    readonly recurring?: boolean | undefined
    readonly durable?: boolean | undefined
  }["recurring"]
  readonly durable?: {
    readonly name: string
    readonly cron: string
    readonly prompt: string
    readonly recurring?: boolean | undefined
    readonly durable?: boolean | undefined
  }["durable"]
}

export type ScheduledPromptsCreateOutput = {
  readonly data: {
    readonly id: string
    readonly sessionID: string
    readonly name: string
    readonly cron: string
    readonly prompt: string
    readonly recurring: boolean
    readonly durable: boolean
    readonly enabled: boolean
    readonly status: "scheduled" | "missed" | "running" | "completed" | "failed" | "expired"
    readonly revision: number
    readonly lastError: string
    readonly time: {
      readonly created: number
      readonly updated: number
      readonly nextRun?: number
      readonly lastRun?: number
      readonly expires: number
    }
  }
}["data"]

export type ScheduledPromptsListInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type ScheduledPromptsListOutput = {
  readonly data: ReadonlyArray<{
    readonly id: string
    readonly sessionID: string
    readonly name: string
    readonly cron: string
    readonly prompt: string
    readonly recurring: boolean
    readonly durable: boolean
    readonly enabled: boolean
    readonly status: "scheduled" | "missed" | "running" | "completed" | "failed" | "expired"
    readonly revision: number
    readonly lastError: string
    readonly time: {
      readonly created: number
      readonly updated: number
      readonly nextRun?: number
      readonly lastRun?: number
      readonly expires: number
    }
  }>
}["data"]

export type ScheduledPromptsGetInput = {
  readonly sessionID: { readonly sessionID: string; readonly scheduleID: string }["sessionID"]
  readonly scheduleID: { readonly sessionID: string; readonly scheduleID: string }["scheduleID"]
}

export type ScheduledPromptsGetOutput = {
  readonly data: {
    readonly id: string
    readonly sessionID: string
    readonly name: string
    readonly cron: string
    readonly prompt: string
    readonly recurring: boolean
    readonly durable: boolean
    readonly enabled: boolean
    readonly status: "scheduled" | "missed" | "running" | "completed" | "failed" | "expired"
    readonly revision: number
    readonly lastError: string
    readonly time: {
      readonly created: number
      readonly updated: number
      readonly nextRun?: number
      readonly lastRun?: number
      readonly expires: number
    }
  }
}["data"]

export type ScheduledPromptsUpdateInput = {
  readonly sessionID: { readonly sessionID: string; readonly scheduleID: string }["sessionID"]
  readonly scheduleID: { readonly sessionID: string; readonly scheduleID: string }["scheduleID"]
  readonly expectedRevision: {
    readonly expectedRevision: number
    readonly name?: string | undefined
    readonly cron?: string | undefined
    readonly prompt?: string | undefined
    readonly enabled?: boolean | undefined
    readonly recurring?: boolean | undefined
  }["expectedRevision"]
  readonly name?: {
    readonly expectedRevision: number
    readonly name?: string | undefined
    readonly cron?: string | undefined
    readonly prompt?: string | undefined
    readonly enabled?: boolean | undefined
    readonly recurring?: boolean | undefined
  }["name"]
  readonly cron?: {
    readonly expectedRevision: number
    readonly name?: string | undefined
    readonly cron?: string | undefined
    readonly prompt?: string | undefined
    readonly enabled?: boolean | undefined
    readonly recurring?: boolean | undefined
  }["cron"]
  readonly prompt?: {
    readonly expectedRevision: number
    readonly name?: string | undefined
    readonly cron?: string | undefined
    readonly prompt?: string | undefined
    readonly enabled?: boolean | undefined
    readonly recurring?: boolean | undefined
  }["prompt"]
  readonly enabled?: {
    readonly expectedRevision: number
    readonly name?: string | undefined
    readonly cron?: string | undefined
    readonly prompt?: string | undefined
    readonly enabled?: boolean | undefined
    readonly recurring?: boolean | undefined
  }["enabled"]
  readonly recurring?: {
    readonly expectedRevision: number
    readonly name?: string | undefined
    readonly cron?: string | undefined
    readonly prompt?: string | undefined
    readonly enabled?: boolean | undefined
    readonly recurring?: boolean | undefined
  }["recurring"]
}

export type ScheduledPromptsUpdateOutput = {
  readonly data: {
    readonly id: string
    readonly sessionID: string
    readonly name: string
    readonly cron: string
    readonly prompt: string
    readonly recurring: boolean
    readonly durable: boolean
    readonly enabled: boolean
    readonly status: "scheduled" | "missed" | "running" | "completed" | "failed" | "expired"
    readonly revision: number
    readonly lastError: string
    readonly time: {
      readonly created: number
      readonly updated: number
      readonly nextRun?: number
      readonly lastRun?: number
      readonly expires: number
    }
  }
}["data"]

export type ScheduledPromptsDeleteInput = {
  readonly sessionID: { readonly sessionID: string; readonly scheduleID: string }["sessionID"]
  readonly scheduleID: { readonly sessionID: string; readonly scheduleID: string }["scheduleID"]
  readonly expectedRevision: { readonly expectedRevision: number }["expectedRevision"]
}

export type ScheduledPromptsDeleteOutput = void

export type ScheduledPromptsRunInput = {
  readonly sessionID: { readonly sessionID: string; readonly scheduleID: string }["sessionID"]
  readonly scheduleID: { readonly sessionID: string; readonly scheduleID: string }["scheduleID"]
  readonly expectedRevision: { readonly expectedRevision: number }["expectedRevision"]
}

export type ScheduledPromptsRunOutput = {
  readonly data: {
    readonly id: string
    readonly sessionID: string
    readonly name: string
    readonly cron: string
    readonly prompt: string
    readonly recurring: boolean
    readonly durable: boolean
    readonly enabled: boolean
    readonly status: "scheduled" | "missed" | "running" | "completed" | "failed" | "expired"
    readonly revision: number
    readonly lastError: string
    readonly time: {
      readonly created: number
      readonly updated: number
      readonly nextRun?: number
      readonly lastRun?: number
      readonly expires: number
    }
  }
}["data"]

export type ScheduledPromptsRunMissedInput = {
  readonly sessionID: { readonly sessionID: string; readonly scheduleID: string }["sessionID"]
  readonly scheduleID: { readonly sessionID: string; readonly scheduleID: string }["scheduleID"]
  readonly expectedRevision: { readonly expectedRevision: number }["expectedRevision"]
}

export type ScheduledPromptsRunMissedOutput = {
  readonly data: {
    readonly id: string
    readonly sessionID: string
    readonly name: string
    readonly cron: string
    readonly prompt: string
    readonly recurring: boolean
    readonly durable: boolean
    readonly enabled: boolean
    readonly status: "scheduled" | "missed" | "running" | "completed" | "failed" | "expired"
    readonly revision: number
    readonly lastError: string
    readonly time: {
      readonly created: number
      readonly updated: number
      readonly nextRun?: number
      readonly lastRun?: number
      readonly expires: number
    }
  }
}["data"]

export type TasksCreateInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly title: {
    readonly title: string
    readonly description?: string | undefined
    readonly activeForm?: string | undefined
    readonly metadata?: { readonly [x: string]: string } | undefined
    readonly blockedBy?: ReadonlyArray<string> | undefined
  }["title"]
  readonly description?: {
    readonly title: string
    readonly description?: string | undefined
    readonly activeForm?: string | undefined
    readonly metadata?: { readonly [x: string]: string } | undefined
    readonly blockedBy?: ReadonlyArray<string> | undefined
  }["description"]
  readonly activeForm?: {
    readonly title: string
    readonly description?: string | undefined
    readonly activeForm?: string | undefined
    readonly metadata?: { readonly [x: string]: string } | undefined
    readonly blockedBy?: ReadonlyArray<string> | undefined
  }["activeForm"]
  readonly metadata?: {
    readonly title: string
    readonly description?: string | undefined
    readonly activeForm?: string | undefined
    readonly metadata?: { readonly [x: string]: string } | undefined
    readonly blockedBy?: ReadonlyArray<string> | undefined
  }["metadata"]
  readonly blockedBy?: {
    readonly title: string
    readonly description?: string | undefined
    readonly activeForm?: string | undefined
    readonly metadata?: { readonly [x: string]: string } | undefined
    readonly blockedBy?: ReadonlyArray<string> | undefined
  }["blockedBy"]
}

export type TasksCreateOutput = {
  readonly data: {
    readonly id: string
    readonly sessionID: string
    readonly title: string
    readonly description: string
    readonly activeForm: string
    readonly status: "pending" | "in_progress" | "completed" | "cancelled"
    readonly owner?: string
    readonly metadata: { readonly [x: string]: string }
    readonly blocks: ReadonlyArray<string>
    readonly blockedBy: ReadonlyArray<string>
    readonly unresolvedBlockers: number
    readonly revision: number
    readonly time: { readonly created: number; readonly updated: number; readonly completed?: number }
  }
}["data"]

export type TasksListInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly status?: {
    readonly status?: ("pending" | "in_progress" | "completed" | "cancelled") | undefined
    readonly owner?: string | undefined
    readonly search?: string | undefined
  }["status"]
  readonly owner?: {
    readonly status?: ("pending" | "in_progress" | "completed" | "cancelled") | undefined
    readonly owner?: string | undefined
    readonly search?: string | undefined
  }["owner"]
  readonly search?: {
    readonly status?: ("pending" | "in_progress" | "completed" | "cancelled") | undefined
    readonly owner?: string | undefined
    readonly search?: string | undefined
  }["search"]
}

export type TasksListOutput = {
  readonly data: {
    readonly items: ReadonlyArray<{
      readonly id: string
      readonly sessionID: string
      readonly title: string
      readonly description: string
      readonly activeForm: string
      readonly status: "pending" | "in_progress" | "completed" | "cancelled"
      readonly owner?: string
      readonly metadata: { readonly [x: string]: string }
      readonly blocks: ReadonlyArray<string>
      readonly blockedBy: ReadonlyArray<string>
      readonly unresolvedBlockers: number
      readonly revision: number
      readonly time: { readonly created: number; readonly updated: number; readonly completed?: number }
    }>
    readonly total: number
  }
}["data"]

export type TasksGetInput = {
  readonly sessionID: { readonly sessionID: string; readonly taskID: string }["sessionID"]
  readonly taskID: { readonly sessionID: string; readonly taskID: string }["taskID"]
}

export type TasksGetOutput = {
  readonly data: {
    readonly id: string
    readonly sessionID: string
    readonly title: string
    readonly description: string
    readonly activeForm: string
    readonly status: "pending" | "in_progress" | "completed" | "cancelled"
    readonly owner?: string
    readonly metadata: { readonly [x: string]: string }
    readonly blocks: ReadonlyArray<string>
    readonly blockedBy: ReadonlyArray<string>
    readonly unresolvedBlockers: number
    readonly revision: number
    readonly time: { readonly created: number; readonly updated: number; readonly completed?: number }
  }
}["data"]

export type TasksUpdateInput = {
  readonly sessionID: { readonly sessionID: string; readonly taskID: string }["sessionID"]
  readonly taskID: { readonly sessionID: string; readonly taskID: string }["taskID"]
  readonly expectedRevision: {
    readonly expectedRevision: number
    readonly title?: string | undefined
    readonly description?: string | undefined
    readonly activeForm?: string | undefined
    readonly metadata?: { readonly [x: string]: string } | undefined
    readonly blocks?: ReadonlyArray<string> | undefined
    readonly blockedBy?: ReadonlyArray<string> | undefined
  }["expectedRevision"]
  readonly title?: {
    readonly expectedRevision: number
    readonly title?: string | undefined
    readonly description?: string | undefined
    readonly activeForm?: string | undefined
    readonly metadata?: { readonly [x: string]: string } | undefined
    readonly blocks?: ReadonlyArray<string> | undefined
    readonly blockedBy?: ReadonlyArray<string> | undefined
  }["title"]
  readonly description?: {
    readonly expectedRevision: number
    readonly title?: string | undefined
    readonly description?: string | undefined
    readonly activeForm?: string | undefined
    readonly metadata?: { readonly [x: string]: string } | undefined
    readonly blocks?: ReadonlyArray<string> | undefined
    readonly blockedBy?: ReadonlyArray<string> | undefined
  }["description"]
  readonly activeForm?: {
    readonly expectedRevision: number
    readonly title?: string | undefined
    readonly description?: string | undefined
    readonly activeForm?: string | undefined
    readonly metadata?: { readonly [x: string]: string } | undefined
    readonly blocks?: ReadonlyArray<string> | undefined
    readonly blockedBy?: ReadonlyArray<string> | undefined
  }["activeForm"]
  readonly metadata?: {
    readonly expectedRevision: number
    readonly title?: string | undefined
    readonly description?: string | undefined
    readonly activeForm?: string | undefined
    readonly metadata?: { readonly [x: string]: string } | undefined
    readonly blocks?: ReadonlyArray<string> | undefined
    readonly blockedBy?: ReadonlyArray<string> | undefined
  }["metadata"]
  readonly blocks?: {
    readonly expectedRevision: number
    readonly title?: string | undefined
    readonly description?: string | undefined
    readonly activeForm?: string | undefined
    readonly metadata?: { readonly [x: string]: string } | undefined
    readonly blocks?: ReadonlyArray<string> | undefined
    readonly blockedBy?: ReadonlyArray<string> | undefined
  }["blocks"]
  readonly blockedBy?: {
    readonly expectedRevision: number
    readonly title?: string | undefined
    readonly description?: string | undefined
    readonly activeForm?: string | undefined
    readonly metadata?: { readonly [x: string]: string } | undefined
    readonly blocks?: ReadonlyArray<string> | undefined
    readonly blockedBy?: ReadonlyArray<string> | undefined
  }["blockedBy"]
}

export type TasksUpdateOutput = {
  readonly data: {
    readonly id: string
    readonly sessionID: string
    readonly title: string
    readonly description: string
    readonly activeForm: string
    readonly status: "pending" | "in_progress" | "completed" | "cancelled"
    readonly owner?: string
    readonly metadata: { readonly [x: string]: string }
    readonly blocks: ReadonlyArray<string>
    readonly blockedBy: ReadonlyArray<string>
    readonly unresolvedBlockers: number
    readonly revision: number
    readonly time: { readonly created: number; readonly updated: number; readonly completed?: number }
  }
}["data"]

export type TasksClaimInput = {
  readonly sessionID: { readonly sessionID: string; readonly taskID: string }["sessionID"]
  readonly taskID: { readonly sessionID: string; readonly taskID: string }["taskID"]
  readonly expectedRevision: { readonly expectedRevision: number; readonly owner: string }["expectedRevision"]
  readonly owner: { readonly expectedRevision: number; readonly owner: string }["owner"]
}

export type TasksClaimOutput = {
  readonly data: {
    readonly id: string
    readonly sessionID: string
    readonly title: string
    readonly description: string
    readonly activeForm: string
    readonly status: "pending" | "in_progress" | "completed" | "cancelled"
    readonly owner?: string
    readonly metadata: { readonly [x: string]: string }
    readonly blocks: ReadonlyArray<string>
    readonly blockedBy: ReadonlyArray<string>
    readonly unresolvedBlockers: number
    readonly revision: number
    readonly time: { readonly created: number; readonly updated: number; readonly completed?: number }
  }
}["data"]

export type TasksReleaseInput = {
  readonly sessionID: { readonly sessionID: string; readonly taskID: string }["sessionID"]
  readonly taskID: { readonly sessionID: string; readonly taskID: string }["taskID"]
  readonly expectedRevision: { readonly expectedRevision: number; readonly owner: string }["expectedRevision"]
  readonly owner: { readonly expectedRevision: number; readonly owner: string }["owner"]
}

export type TasksReleaseOutput = {
  readonly data: {
    readonly id: string
    readonly sessionID: string
    readonly title: string
    readonly description: string
    readonly activeForm: string
    readonly status: "pending" | "in_progress" | "completed" | "cancelled"
    readonly owner?: string
    readonly metadata: { readonly [x: string]: string }
    readonly blocks: ReadonlyArray<string>
    readonly blockedBy: ReadonlyArray<string>
    readonly unresolvedBlockers: number
    readonly revision: number
    readonly time: { readonly created: number; readonly updated: number; readonly completed?: number }
  }
}["data"]

export type TasksCompleteInput = {
  readonly sessionID: { readonly sessionID: string; readonly taskID: string }["sessionID"]
  readonly taskID: { readonly sessionID: string; readonly taskID: string }["taskID"]
  readonly expectedRevision: { readonly expectedRevision: number }["expectedRevision"]
}

export type TasksCompleteOutput = {
  readonly data: {
    readonly id: string
    readonly sessionID: string
    readonly title: string
    readonly description: string
    readonly activeForm: string
    readonly status: "pending" | "in_progress" | "completed" | "cancelled"
    readonly owner?: string
    readonly metadata: { readonly [x: string]: string }
    readonly blocks: ReadonlyArray<string>
    readonly blockedBy: ReadonlyArray<string>
    readonly unresolvedBlockers: number
    readonly revision: number
    readonly time: { readonly created: number; readonly updated: number; readonly completed?: number }
  }
}["data"]

export type TasksCancelInput = {
  readonly sessionID: { readonly sessionID: string; readonly taskID: string }["sessionID"]
  readonly taskID: { readonly sessionID: string; readonly taskID: string }["taskID"]
  readonly expectedRevision: { readonly expectedRevision: number }["expectedRevision"]
}

export type TasksCancelOutput = {
  readonly data: {
    readonly id: string
    readonly sessionID: string
    readonly title: string
    readonly description: string
    readonly activeForm: string
    readonly status: "pending" | "in_progress" | "completed" | "cancelled"
    readonly owner?: string
    readonly metadata: { readonly [x: string]: string }
    readonly blocks: ReadonlyArray<string>
    readonly blockedBy: ReadonlyArray<string>
    readonly unresolvedBlockers: number
    readonly revision: number
    readonly time: { readonly created: number; readonly updated: number; readonly completed?: number }
  }
}["data"]

export type TasksDeleteInput = {
  readonly sessionID: { readonly sessionID: string; readonly taskID: string }["sessionID"]
  readonly taskID: { readonly sessionID: string; readonly taskID: string }["taskID"]
  readonly expectedRevision: { readonly expectedRevision: number }["expectedRevision"]
}

export type TasksDeleteOutput = void

export type TasksClearInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly terminalOnly?: { readonly terminalOnly?: boolean | undefined }["terminalOnly"]
}

export type TasksClearOutput = { readonly data: { readonly deleted: number } }["data"]

export type TeamsCreateInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly name: { readonly name: string; readonly description?: string | undefined }["name"]
  readonly description?: { readonly name: string; readonly description?: string | undefined }["description"]
}

export type TeamsCreateOutput = {
  readonly data: {
    readonly id: string
    readonly sessionID: string
    readonly name: string
    readonly description: string
    readonly revision: number
    readonly nextSequence: number
    readonly members: ReadonlyArray<{
      readonly name: string
      readonly agentID: string
      readonly status: "active" | "shutdown_requested" | "stopped"
      readonly revision: number
      readonly time: { readonly joined: number; readonly updated: number }
    }>
    readonly memberCount: number
    readonly messageCount: number
    readonly pendingShutdowns: number
    readonly time: { readonly created: number; readonly updated: number }
  }
}["data"]

export type TeamsGetInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type TeamsGetOutput = {
  readonly data: {
    readonly id: string
    readonly sessionID: string
    readonly name: string
    readonly description: string
    readonly revision: number
    readonly nextSequence: number
    readonly members: ReadonlyArray<{
      readonly name: string
      readonly agentID: string
      readonly status: "active" | "shutdown_requested" | "stopped"
      readonly revision: number
      readonly time: { readonly joined: number; readonly updated: number }
    }>
    readonly memberCount: number
    readonly messageCount: number
    readonly pendingShutdowns: number
    readonly time: { readonly created: number; readonly updated: number }
  }
}["data"]

export type TeamsMemberAddInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly memberName: { readonly memberName: string; readonly agentID: string }["memberName"]
  readonly agentID: { readonly memberName: string; readonly agentID: string }["agentID"]
}

export type TeamsMemberAddOutput = {
  readonly data: {
    readonly name: string
    readonly agentID: string
    readonly status: "active" | "shutdown_requested" | "stopped"
    readonly revision: number
    readonly time: { readonly joined: number; readonly updated: number }
  }
}["data"]

export type TeamsMemberRemoveInput = {
  readonly sessionID: { readonly sessionID: string; readonly memberName: string }["sessionID"]
  readonly memberName: { readonly sessionID: string; readonly memberName: string }["memberName"]
}

export type TeamsMemberRemoveOutput = {
  readonly data: {
    readonly name: string
    readonly agentID: string
    readonly status: "active" | "shutdown_requested" | "stopped"
    readonly revision: number
    readonly time: { readonly joined: number; readonly updated: number }
  }
}["data"]

export type TeamsMessageSendInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly recipient: {
    readonly recipient: string
    readonly message: string
    readonly summary?: string | undefined
    readonly kind?: "info" | "request" | "result" | "alert" | undefined
  }["recipient"]
  readonly message: {
    readonly recipient: string
    readonly message: string
    readonly summary?: string | undefined
    readonly kind?: "info" | "request" | "result" | "alert" | undefined
  }["message"]
  readonly summary?: {
    readonly recipient: string
    readonly message: string
    readonly summary?: string | undefined
    readonly kind?: "info" | "request" | "result" | "alert" | undefined
  }["summary"]
  readonly kind?: {
    readonly recipient: string
    readonly message: string
    readonly summary?: string | undefined
    readonly kind?: "info" | "request" | "result" | "alert" | undefined
  }["kind"]
}

export type TeamsMessageSendOutput = {
  readonly data: {
    readonly id: string
    readonly teamID: string
    readonly sequence: number
    readonly sender: string
    readonly recipient: string
    readonly recipients: ReadonlyArray<string>
    readonly kind: "info" | "request" | "result" | "alert" | "shutdown_request" | "shutdown_response"
    readonly summary: string
    readonly message: string
    readonly shutdownID?: string
    readonly approve?: boolean
    readonly time: { readonly created: number }
  }
}["data"]

export type TeamsMessageListInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly afterSequence?: {
    readonly afterSequence?: number | undefined
    readonly limit?: number | undefined
  }["afterSequence"]
  readonly limit?: { readonly afterSequence?: number | undefined; readonly limit?: number | undefined }["limit"]
}

export type TeamsMessageListOutput = {
  readonly data: {
    readonly teamID: string
    readonly member: string
    readonly messages: ReadonlyArray<{
      readonly id: string
      readonly teamID: string
      readonly sequence: number
      readonly sender: string
      readonly recipient: string
      readonly recipients: ReadonlyArray<string>
      readonly kind: "info" | "request" | "result" | "alert" | "shutdown_request" | "shutdown_response"
      readonly summary: string
      readonly message: string
      readonly shutdownID?: string
      readonly approve?: boolean
      readonly time: { readonly created: number }
    }>
    readonly count: number
    readonly lastSequence: number
  }
}["data"]

export type TeamsShutdownRequestInput = {
  readonly sessionID: { readonly sessionID: string; readonly memberName: string }["sessionID"]
  readonly memberName: { readonly sessionID: string; readonly memberName: string }["memberName"]
  readonly reason?: { readonly reason?: string | undefined }["reason"]
}

export type TeamsShutdownRequestOutput = {
  readonly data: {
    readonly id: string
    readonly teamID: string
    readonly member: string
    readonly status: "pending" | "approved" | "rejected"
    readonly reason: string
    readonly responseReason: string
    readonly revision: number
    readonly time: { readonly requested: number; readonly responded?: number }
  }
}["data"]

export type TeamsDeleteInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type TeamsDeleteOutput = void

export type WaitsActiveInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type WaitsActiveOutput = {
  readonly data: {
    readonly waitID: string
    readonly sessionID: string
    readonly reason: string
    readonly durationSeconds: number
    readonly checkInInterval: number
    readonly startedAt: number
    readonly elapsedSeconds: number
    readonly remainingSeconds: number
    readonly checkInCount: number
  } | null
}["data"]

export type WaitsWakeInput = {
  readonly sessionID: { readonly sessionID: string; readonly waitID: string }["sessionID"]
  readonly waitID: { readonly sessionID: string; readonly waitID: string }["waitID"]
}

export type WaitsWakeOutput = {
  readonly data: {
    readonly waitID: string
    readonly sessionID: string
    readonly reason: string
    readonly durationSeconds: number
    readonly checkInInterval: number
    readonly startedAt: number
    readonly elapsedSeconds: number
    readonly remainingSeconds: number
    readonly checkInCount: number
    readonly wakeRequested: true
  }
}["data"]

export type TriggersProfilesOutput = {
  readonly data: {
    readonly items: ReadonlyArray<{
      readonly name: string
      readonly kind: "local" | "http"
      readonly baseUrl: string
      readonly timeout: number
      readonly headerNames: ReadonlyArray<string>
      readonly auth?:
        | { readonly type: "bearer_environment"; readonly environmentVariable: string; readonly configured: boolean }
        | {
            readonly type: "oauth_client_credentials"
            readonly tokenUrl: string
            readonly clientIdEnvironment: string
            readonly clientSecretEnvironment: string
            readonly scopes: ReadonlyArray<string>
            readonly audience: string
            readonly configured: boolean
          }
        | undefined
    }>
    readonly count: number
  }
}["data"]

export type TriggersListInput = {
  readonly sessionID: { readonly sessionID: string; readonly profile: string }["sessionID"]
  readonly profile: { readonly sessionID: string; readonly profile: string }["profile"]
}

export type TriggersListOutput = {
  readonly data: {
    readonly profile: string
    readonly kind: "local" | "http"
    readonly action: "list" | "get" | "create" | "update" | "run"
    readonly status: number
    readonly ok: boolean
    readonly data: unknown
  }
}["data"]

export type TriggersGetInput = {
  readonly sessionID: { readonly sessionID: string; readonly profile: string; readonly triggerID: string }["sessionID"]
  readonly profile: { readonly sessionID: string; readonly profile: string; readonly triggerID: string }["profile"]
  readonly triggerID: { readonly sessionID: string; readonly profile: string; readonly triggerID: string }["triggerID"]
}

export type TriggersGetOutput = {
  readonly data: {
    readonly profile: string
    readonly kind: "local" | "http"
    readonly action: "list" | "get" | "create" | "update" | "run"
    readonly status: number
    readonly ok: boolean
    readonly data: unknown
  }
}["data"]

export type TriggersCreateInput = {
  readonly sessionID: { readonly sessionID: string; readonly profile: string }["sessionID"]
  readonly profile: { readonly sessionID: string; readonly profile: string }["profile"]
  readonly body: { readonly body: { readonly [x: string]: unknown } }["body"]
}

export type TriggersCreateOutput = {
  readonly data: {
    readonly profile: string
    readonly kind: "local" | "http"
    readonly action: "list" | "get" | "create" | "update" | "run"
    readonly status: number
    readonly ok: boolean
    readonly data: unknown
  }
}["data"]

export type TriggersUpdateInput = {
  readonly sessionID: { readonly sessionID: string; readonly profile: string; readonly triggerID: string }["sessionID"]
  readonly profile: { readonly sessionID: string; readonly profile: string; readonly triggerID: string }["profile"]
  readonly triggerID: { readonly sessionID: string; readonly profile: string; readonly triggerID: string }["triggerID"]
  readonly body: { readonly body: { readonly [x: string]: unknown } }["body"]
}

export type TriggersUpdateOutput = {
  readonly data: {
    readonly profile: string
    readonly kind: "local" | "http"
    readonly action: "list" | "get" | "create" | "update" | "run"
    readonly status: number
    readonly ok: boolean
    readonly data: unknown
  }
}["data"]

export type TriggersRunInput = {
  readonly sessionID: { readonly sessionID: string; readonly profile: string; readonly triggerID: string }["sessionID"]
  readonly profile: { readonly sessionID: string; readonly profile: string; readonly triggerID: string }["profile"]
  readonly triggerID: { readonly sessionID: string; readonly profile: string; readonly triggerID: string }["triggerID"]
}

export type TriggersRunOutput = {
  readonly data: {
    readonly profile: string
    readonly kind: "local" | "http"
    readonly action: "list" | "get" | "create" | "update" | "run"
    readonly status: number
    readonly ok: boolean
    readonly data: unknown
  }
}["data"]

export type MemoriesListInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly query?: string | undefined
    readonly type?: string | undefined
    readonly tag?: string | undefined
    readonly source?:
      | (
          | "user"
          | "user-corrected"
          | "imported"
          | "auto"
          | "model"
          | "quarantined"
          | "quarantined:auto"
          | "quarantined:model"
        )
      | undefined
    readonly minimumImportance?: number | undefined
    readonly includeGlobal?: "true" | "false" | undefined
    readonly limit?: number | undefined
  }["location"]
  readonly query?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly query?: string | undefined
    readonly type?: string | undefined
    readonly tag?: string | undefined
    readonly source?:
      | (
          | "user"
          | "user-corrected"
          | "imported"
          | "auto"
          | "model"
          | "quarantined"
          | "quarantined:auto"
          | "quarantined:model"
        )
      | undefined
    readonly minimumImportance?: number | undefined
    readonly includeGlobal?: "true" | "false" | undefined
    readonly limit?: number | undefined
  }["query"]
  readonly type?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly query?: string | undefined
    readonly type?: string | undefined
    readonly tag?: string | undefined
    readonly source?:
      | (
          | "user"
          | "user-corrected"
          | "imported"
          | "auto"
          | "model"
          | "quarantined"
          | "quarantined:auto"
          | "quarantined:model"
        )
      | undefined
    readonly minimumImportance?: number | undefined
    readonly includeGlobal?: "true" | "false" | undefined
    readonly limit?: number | undefined
  }["type"]
  readonly tag?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly query?: string | undefined
    readonly type?: string | undefined
    readonly tag?: string | undefined
    readonly source?:
      | (
          | "user"
          | "user-corrected"
          | "imported"
          | "auto"
          | "model"
          | "quarantined"
          | "quarantined:auto"
          | "quarantined:model"
        )
      | undefined
    readonly minimumImportance?: number | undefined
    readonly includeGlobal?: "true" | "false" | undefined
    readonly limit?: number | undefined
  }["tag"]
  readonly source?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly query?: string | undefined
    readonly type?: string | undefined
    readonly tag?: string | undefined
    readonly source?:
      | (
          | "user"
          | "user-corrected"
          | "imported"
          | "auto"
          | "model"
          | "quarantined"
          | "quarantined:auto"
          | "quarantined:model"
        )
      | undefined
    readonly minimumImportance?: number | undefined
    readonly includeGlobal?: "true" | "false" | undefined
    readonly limit?: number | undefined
  }["source"]
  readonly minimumImportance?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly query?: string | undefined
    readonly type?: string | undefined
    readonly tag?: string | undefined
    readonly source?:
      | (
          | "user"
          | "user-corrected"
          | "imported"
          | "auto"
          | "model"
          | "quarantined"
          | "quarantined:auto"
          | "quarantined:model"
        )
      | undefined
    readonly minimumImportance?: number | undefined
    readonly includeGlobal?: "true" | "false" | undefined
    readonly limit?: number | undefined
  }["minimumImportance"]
  readonly includeGlobal?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly query?: string | undefined
    readonly type?: string | undefined
    readonly tag?: string | undefined
    readonly source?:
      | (
          | "user"
          | "user-corrected"
          | "imported"
          | "auto"
          | "model"
          | "quarantined"
          | "quarantined:auto"
          | "quarantined:model"
        )
      | undefined
    readonly minimumImportance?: number | undefined
    readonly includeGlobal?: "true" | "false" | undefined
    readonly limit?: number | undefined
  }["includeGlobal"]
  readonly limit?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly query?: string | undefined
    readonly type?: string | undefined
    readonly tag?: string | undefined
    readonly source?:
      | (
          | "user"
          | "user-corrected"
          | "imported"
          | "auto"
          | "model"
          | "quarantined"
          | "quarantined:auto"
          | "quarantined:model"
        )
      | undefined
    readonly minimumImportance?: number | undefined
    readonly includeGlobal?: "true" | "false" | undefined
    readonly limit?: number | undefined
  }["limit"]
}

export type MemoriesListOutput = {
  readonly data: {
    readonly items: ReadonlyArray<{
      readonly id: string
      readonly version: number
      readonly content: string
      readonly type: string
      readonly tags: ReadonlyArray<string>
      readonly importance: number
      readonly source:
        | "user"
        | "user-corrected"
        | "imported"
        | "auto"
        | "model"
        | "quarantined"
        | "quarantined:auto"
        | "quarantined:model"
      readonly scope: "workspace" | "global"
      readonly projectID?: string
      readonly workspacePath?: string
      readonly relatedTo?: string
      readonly strength: number
      readonly reviewLevel: number
      readonly time: { readonly created: number; readonly updated: number; readonly reviewed?: number }
    }>
    readonly count: number
    readonly total: number
  }
}["data"]

export type MemoriesCreateInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
  readonly content: {
    readonly content: string
    readonly type?: string | undefined
    readonly tags?: ReadonlyArray<string> | undefined
    readonly importance?: number | undefined
    readonly source?:
      | (
          | "user"
          | "user-corrected"
          | "imported"
          | "auto"
          | "model"
          | "quarantined"
          | "quarantined:auto"
          | "quarantined:model"
        )
      | undefined
    readonly scope?: ("workspace" | "global") | undefined
    readonly relatedTo?: string | undefined
    readonly strength?: number | undefined
    readonly reviewLevel?: number | undefined
  }["content"]
  readonly type?: {
    readonly content: string
    readonly type?: string | undefined
    readonly tags?: ReadonlyArray<string> | undefined
    readonly importance?: number | undefined
    readonly source?:
      | (
          | "user"
          | "user-corrected"
          | "imported"
          | "auto"
          | "model"
          | "quarantined"
          | "quarantined:auto"
          | "quarantined:model"
        )
      | undefined
    readonly scope?: ("workspace" | "global") | undefined
    readonly relatedTo?: string | undefined
    readonly strength?: number | undefined
    readonly reviewLevel?: number | undefined
  }["type"]
  readonly tags?: {
    readonly content: string
    readonly type?: string | undefined
    readonly tags?: ReadonlyArray<string> | undefined
    readonly importance?: number | undefined
    readonly source?:
      | (
          | "user"
          | "user-corrected"
          | "imported"
          | "auto"
          | "model"
          | "quarantined"
          | "quarantined:auto"
          | "quarantined:model"
        )
      | undefined
    readonly scope?: ("workspace" | "global") | undefined
    readonly relatedTo?: string | undefined
    readonly strength?: number | undefined
    readonly reviewLevel?: number | undefined
  }["tags"]
  readonly importance?: {
    readonly content: string
    readonly type?: string | undefined
    readonly tags?: ReadonlyArray<string> | undefined
    readonly importance?: number | undefined
    readonly source?:
      | (
          | "user"
          | "user-corrected"
          | "imported"
          | "auto"
          | "model"
          | "quarantined"
          | "quarantined:auto"
          | "quarantined:model"
        )
      | undefined
    readonly scope?: ("workspace" | "global") | undefined
    readonly relatedTo?: string | undefined
    readonly strength?: number | undefined
    readonly reviewLevel?: number | undefined
  }["importance"]
  readonly source?: {
    readonly content: string
    readonly type?: string | undefined
    readonly tags?: ReadonlyArray<string> | undefined
    readonly importance?: number | undefined
    readonly source?:
      | (
          | "user"
          | "user-corrected"
          | "imported"
          | "auto"
          | "model"
          | "quarantined"
          | "quarantined:auto"
          | "quarantined:model"
        )
      | undefined
    readonly scope?: ("workspace" | "global") | undefined
    readonly relatedTo?: string | undefined
    readonly strength?: number | undefined
    readonly reviewLevel?: number | undefined
  }["source"]
  readonly scope?: {
    readonly content: string
    readonly type?: string | undefined
    readonly tags?: ReadonlyArray<string> | undefined
    readonly importance?: number | undefined
    readonly source?:
      | (
          | "user"
          | "user-corrected"
          | "imported"
          | "auto"
          | "model"
          | "quarantined"
          | "quarantined:auto"
          | "quarantined:model"
        )
      | undefined
    readonly scope?: ("workspace" | "global") | undefined
    readonly relatedTo?: string | undefined
    readonly strength?: number | undefined
    readonly reviewLevel?: number | undefined
  }["scope"]
  readonly relatedTo?: {
    readonly content: string
    readonly type?: string | undefined
    readonly tags?: ReadonlyArray<string> | undefined
    readonly importance?: number | undefined
    readonly source?:
      | (
          | "user"
          | "user-corrected"
          | "imported"
          | "auto"
          | "model"
          | "quarantined"
          | "quarantined:auto"
          | "quarantined:model"
        )
      | undefined
    readonly scope?: ("workspace" | "global") | undefined
    readonly relatedTo?: string | undefined
    readonly strength?: number | undefined
    readonly reviewLevel?: number | undefined
  }["relatedTo"]
  readonly strength?: {
    readonly content: string
    readonly type?: string | undefined
    readonly tags?: ReadonlyArray<string> | undefined
    readonly importance?: number | undefined
    readonly source?:
      | (
          | "user"
          | "user-corrected"
          | "imported"
          | "auto"
          | "model"
          | "quarantined"
          | "quarantined:auto"
          | "quarantined:model"
        )
      | undefined
    readonly scope?: ("workspace" | "global") | undefined
    readonly relatedTo?: string | undefined
    readonly strength?: number | undefined
    readonly reviewLevel?: number | undefined
  }["strength"]
  readonly reviewLevel?: {
    readonly content: string
    readonly type?: string | undefined
    readonly tags?: ReadonlyArray<string> | undefined
    readonly importance?: number | undefined
    readonly source?:
      | (
          | "user"
          | "user-corrected"
          | "imported"
          | "auto"
          | "model"
          | "quarantined"
          | "quarantined:auto"
          | "quarantined:model"
        )
      | undefined
    readonly scope?: ("workspace" | "global") | undefined
    readonly relatedTo?: string | undefined
    readonly strength?: number | undefined
    readonly reviewLevel?: number | undefined
  }["reviewLevel"]
}

export type MemoriesCreateOutput = {
  readonly data: {
    readonly id: string
    readonly version: number
    readonly content: string
    readonly type: string
    readonly tags: ReadonlyArray<string>
    readonly importance: number
    readonly source:
      | "user"
      | "user-corrected"
      | "imported"
      | "auto"
      | "model"
      | "quarantined"
      | "quarantined:auto"
      | "quarantined:model"
    readonly scope: "workspace" | "global"
    readonly projectID?: string
    readonly workspacePath?: string
    readonly relatedTo?: string
    readonly strength: number
    readonly reviewLevel: number
    readonly time: { readonly created: number; readonly updated: number; readonly reviewed?: number }
  }
}["data"]

export type MemoriesGetInput = {
  readonly memoryID: { readonly memoryID: string }["memoryID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type MemoriesGetOutput = {
  readonly data: {
    readonly id: string
    readonly version: number
    readonly content: string
    readonly type: string
    readonly tags: ReadonlyArray<string>
    readonly importance: number
    readonly source:
      | "user"
      | "user-corrected"
      | "imported"
      | "auto"
      | "model"
      | "quarantined"
      | "quarantined:auto"
      | "quarantined:model"
    readonly scope: "workspace" | "global"
    readonly projectID?: string
    readonly workspacePath?: string
    readonly relatedTo?: string
    readonly strength: number
    readonly reviewLevel: number
    readonly time: { readonly created: number; readonly updated: number; readonly reviewed?: number }
  }
}["data"]

export type MemoriesUpdateInput = {
  readonly memoryID: { readonly memoryID: string }["memoryID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
  readonly content?: {
    readonly content?: string | undefined
    readonly type?: string | undefined
    readonly tags?: ReadonlyArray<string> | undefined
    readonly source?:
      | (
          | "user"
          | "user-corrected"
          | "imported"
          | "auto"
          | "model"
          | "quarantined"
          | "quarantined:auto"
          | "quarantined:model"
        )
      | undefined
    readonly importance?: number | undefined
    readonly strength?: number | undefined
    readonly reviewLevel?: number | undefined
  }["content"]
  readonly type?: {
    readonly content?: string | undefined
    readonly type?: string | undefined
    readonly tags?: ReadonlyArray<string> | undefined
    readonly source?:
      | (
          | "user"
          | "user-corrected"
          | "imported"
          | "auto"
          | "model"
          | "quarantined"
          | "quarantined:auto"
          | "quarantined:model"
        )
      | undefined
    readonly importance?: number | undefined
    readonly strength?: number | undefined
    readonly reviewLevel?: number | undefined
  }["type"]
  readonly tags?: {
    readonly content?: string | undefined
    readonly type?: string | undefined
    readonly tags?: ReadonlyArray<string> | undefined
    readonly source?:
      | (
          | "user"
          | "user-corrected"
          | "imported"
          | "auto"
          | "model"
          | "quarantined"
          | "quarantined:auto"
          | "quarantined:model"
        )
      | undefined
    readonly importance?: number | undefined
    readonly strength?: number | undefined
    readonly reviewLevel?: number | undefined
  }["tags"]
  readonly source?: {
    readonly content?: string | undefined
    readonly type?: string | undefined
    readonly tags?: ReadonlyArray<string> | undefined
    readonly source?:
      | (
          | "user"
          | "user-corrected"
          | "imported"
          | "auto"
          | "model"
          | "quarantined"
          | "quarantined:auto"
          | "quarantined:model"
        )
      | undefined
    readonly importance?: number | undefined
    readonly strength?: number | undefined
    readonly reviewLevel?: number | undefined
  }["source"]
  readonly importance?: {
    readonly content?: string | undefined
    readonly type?: string | undefined
    readonly tags?: ReadonlyArray<string> | undefined
    readonly source?:
      | (
          | "user"
          | "user-corrected"
          | "imported"
          | "auto"
          | "model"
          | "quarantined"
          | "quarantined:auto"
          | "quarantined:model"
        )
      | undefined
    readonly importance?: number | undefined
    readonly strength?: number | undefined
    readonly reviewLevel?: number | undefined
  }["importance"]
  readonly strength?: {
    readonly content?: string | undefined
    readonly type?: string | undefined
    readonly tags?: ReadonlyArray<string> | undefined
    readonly source?:
      | (
          | "user"
          | "user-corrected"
          | "imported"
          | "auto"
          | "model"
          | "quarantined"
          | "quarantined:auto"
          | "quarantined:model"
        )
      | undefined
    readonly importance?: number | undefined
    readonly strength?: number | undefined
    readonly reviewLevel?: number | undefined
  }["strength"]
  readonly reviewLevel?: {
    readonly content?: string | undefined
    readonly type?: string | undefined
    readonly tags?: ReadonlyArray<string> | undefined
    readonly source?:
      | (
          | "user"
          | "user-corrected"
          | "imported"
          | "auto"
          | "model"
          | "quarantined"
          | "quarantined:auto"
          | "quarantined:model"
        )
      | undefined
    readonly importance?: number | undefined
    readonly strength?: number | undefined
    readonly reviewLevel?: number | undefined
  }["reviewLevel"]
}

export type MemoriesUpdateOutput = {
  readonly data: {
    readonly id: string
    readonly version: number
    readonly content: string
    readonly type: string
    readonly tags: ReadonlyArray<string>
    readonly importance: number
    readonly source:
      | "user"
      | "user-corrected"
      | "imported"
      | "auto"
      | "model"
      | "quarantined"
      | "quarantined:auto"
      | "quarantined:model"
    readonly scope: "workspace" | "global"
    readonly projectID?: string
    readonly workspacePath?: string
    readonly relatedTo?: string
    readonly strength: number
    readonly reviewLevel: number
    readonly time: { readonly created: number; readonly updated: number; readonly reviewed?: number }
  }
}["data"]

export type MemoriesCorrectInput = {
  readonly memoryID: { readonly memoryID: string }["memoryID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
  readonly content: { readonly content: string; readonly reason: string; readonly expectedUpdatedAt: number }["content"]
  readonly reason: { readonly content: string; readonly reason: string; readonly expectedUpdatedAt: number }["reason"]
  readonly expectedUpdatedAt: {
    readonly content: string
    readonly reason: string
    readonly expectedUpdatedAt: number
  }["expectedUpdatedAt"]
}

export type MemoriesCorrectOutput = {
  readonly data: {
    readonly correction: {
      readonly id: string
      readonly originalMemoryID: string
      readonly successorMemoryID: string
      readonly originalSource:
        | "user"
        | "user-corrected"
        | "imported"
        | "auto"
        | "model"
        | "quarantined"
        | "quarantined:auto"
        | "quarantined:model"
      readonly reason: string
      readonly status: "active" | "undone"
      readonly time: { readonly created: number; readonly undone?: number }
    }
    readonly original: {
      readonly id: string
      readonly version: number
      readonly content: string
      readonly type: string
      readonly tags: ReadonlyArray<string>
      readonly importance: number
      readonly source:
        | "user"
        | "user-corrected"
        | "imported"
        | "auto"
        | "model"
        | "quarantined"
        | "quarantined:auto"
        | "quarantined:model"
      readonly scope: "workspace" | "global"
      readonly projectID?: string
      readonly workspacePath?: string
      readonly relatedTo?: string
      readonly strength: number
      readonly reviewLevel: number
      readonly time: { readonly created: number; readonly updated: number; readonly reviewed?: number }
    }
    readonly successor: {
      readonly id: string
      readonly version: number
      readonly content: string
      readonly type: string
      readonly tags: ReadonlyArray<string>
      readonly importance: number
      readonly source:
        | "user"
        | "user-corrected"
        | "imported"
        | "auto"
        | "model"
        | "quarantined"
        | "quarantined:auto"
        | "quarantined:model"
      readonly scope: "workspace" | "global"
      readonly projectID?: string
      readonly workspacePath?: string
      readonly relatedTo?: string
      readonly strength: number
      readonly reviewLevel: number
      readonly time: { readonly created: number; readonly updated: number; readonly reviewed?: number }
    }
  }
}["data"]

export type MemoriesCorrectionHistoryInput = {
  readonly memoryID: { readonly memoryID: string }["memoryID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type MemoriesCorrectionHistoryOutput = {
  readonly data: {
    readonly items: ReadonlyArray<{
      readonly id: string
      readonly originalMemoryID: string
      readonly successorMemoryID: string
      readonly originalSource:
        | "user"
        | "user-corrected"
        | "imported"
        | "auto"
        | "model"
        | "quarantined"
        | "quarantined:auto"
        | "quarantined:model"
      readonly reason: string
      readonly status: "active" | "undone"
      readonly time: { readonly created: number; readonly undone?: number }
    }>
    readonly count: number
  }
}["data"]

export type MemoriesUndoCorrectionInput = {
  readonly correctionID: { readonly correctionID: string }["correctionID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
  readonly expectedSuccessorUpdatedAt: { readonly expectedSuccessorUpdatedAt: number }["expectedSuccessorUpdatedAt"]
}

export type MemoriesUndoCorrectionOutput = {
  readonly data: {
    readonly correction: {
      readonly id: string
      readonly originalMemoryID: string
      readonly successorMemoryID: string
      readonly originalSource:
        | "user"
        | "user-corrected"
        | "imported"
        | "auto"
        | "model"
        | "quarantined"
        | "quarantined:auto"
        | "quarantined:model"
      readonly reason: string
      readonly status: "active" | "undone"
      readonly time: { readonly created: number; readonly undone?: number }
    }
    readonly original: {
      readonly id: string
      readonly version: number
      readonly content: string
      readonly type: string
      readonly tags: ReadonlyArray<string>
      readonly importance: number
      readonly source:
        | "user"
        | "user-corrected"
        | "imported"
        | "auto"
        | "model"
        | "quarantined"
        | "quarantined:auto"
        | "quarantined:model"
      readonly scope: "workspace" | "global"
      readonly projectID?: string
      readonly workspacePath?: string
      readonly relatedTo?: string
      readonly strength: number
      readonly reviewLevel: number
      readonly time: { readonly created: number; readonly updated: number; readonly reviewed?: number }
    }
    readonly successor: {
      readonly id: string
      readonly version: number
      readonly content: string
      readonly type: string
      readonly tags: ReadonlyArray<string>
      readonly importance: number
      readonly source:
        | "user"
        | "user-corrected"
        | "imported"
        | "auto"
        | "model"
        | "quarantined"
        | "quarantined:auto"
        | "quarantined:model"
      readonly scope: "workspace" | "global"
      readonly projectID?: string
      readonly workspacePath?: string
      readonly relatedTo?: string
      readonly strength: number
      readonly reviewLevel: number
      readonly time: { readonly created: number; readonly updated: number; readonly reviewed?: number }
    }
  }
}["data"]

export type MemoriesConflictListInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly includeClosed?: "true" | "false" | undefined
    readonly limit?: number | undefined
  }["location"]
  readonly includeClosed?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly includeClosed?: "true" | "false" | undefined
    readonly limit?: number | undefined
  }["includeClosed"]
  readonly limit?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly includeClosed?: "true" | "false" | undefined
    readonly limit?: number | undefined
  }["limit"]
}

export type MemoriesConflictListOutput = {
  readonly data: {
    readonly detectorVersion: "deterministic-v1"
    readonly scanned: number
    readonly detected: number
    readonly newCandidates: number
    readonly items: ReadonlyArray<{
      readonly conflict: {
        readonly id: string
        readonly conflictKey: string
        readonly basis: "explicit-tag" | "deterministic-pattern-v1"
        readonly leftMemoryID: string
        readonly rightMemoryID: string
        readonly status: "pending" | "resolved" | "dismissed" | "undone"
        readonly chosenMemoryID?: string
        readonly retiredMemoryID?: string
        readonly decisionReason?: string
        readonly time: {
          readonly created: number
          readonly updated: number
          readonly decided?: number
          readonly undone?: number
        }
      }
      readonly left: {
        readonly id: string
        readonly version: number
        readonly content: string
        readonly type: string
        readonly tags: ReadonlyArray<string>
        readonly importance: number
        readonly source:
          | "user"
          | "user-corrected"
          | "imported"
          | "auto"
          | "model"
          | "quarantined"
          | "quarantined:auto"
          | "quarantined:model"
        readonly scope: "workspace" | "global"
        readonly projectID?: string
        readonly workspacePath?: string
        readonly relatedTo?: string
        readonly strength: number
        readonly reviewLevel: number
        readonly time: { readonly created: number; readonly updated: number; readonly reviewed?: number }
      }
      readonly right: {
        readonly id: string
        readonly version: number
        readonly content: string
        readonly type: string
        readonly tags: ReadonlyArray<string>
        readonly importance: number
        readonly source:
          | "user"
          | "user-corrected"
          | "imported"
          | "auto"
          | "model"
          | "quarantined"
          | "quarantined:auto"
          | "quarantined:model"
        readonly scope: "workspace" | "global"
        readonly projectID?: string
        readonly workspacePath?: string
        readonly relatedTo?: string
        readonly strength: number
        readonly reviewLevel: number
        readonly time: { readonly created: number; readonly updated: number; readonly reviewed?: number }
      }
    }>
    readonly count: number
    readonly truncated: boolean
  }
}["data"]

export type MemoriesConflictScanInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
  readonly scanLimit?: {
    readonly scanLimit?: number | undefined
    readonly resultLimit?: number | undefined
  }["scanLimit"]
  readonly resultLimit?: {
    readonly scanLimit?: number | undefined
    readonly resultLimit?: number | undefined
  }["resultLimit"]
}

export type MemoriesConflictScanOutput = {
  readonly data: {
    readonly detectorVersion: "deterministic-v1"
    readonly scanned: number
    readonly detected: number
    readonly newCandidates: number
    readonly items: ReadonlyArray<{
      readonly conflict: {
        readonly id: string
        readonly conflictKey: string
        readonly basis: "explicit-tag" | "deterministic-pattern-v1"
        readonly leftMemoryID: string
        readonly rightMemoryID: string
        readonly status: "pending" | "resolved" | "dismissed" | "undone"
        readonly chosenMemoryID?: string
        readonly retiredMemoryID?: string
        readonly decisionReason?: string
        readonly time: {
          readonly created: number
          readonly updated: number
          readonly decided?: number
          readonly undone?: number
        }
      }
      readonly left: {
        readonly id: string
        readonly version: number
        readonly content: string
        readonly type: string
        readonly tags: ReadonlyArray<string>
        readonly importance: number
        readonly source:
          | "user"
          | "user-corrected"
          | "imported"
          | "auto"
          | "model"
          | "quarantined"
          | "quarantined:auto"
          | "quarantined:model"
        readonly scope: "workspace" | "global"
        readonly projectID?: string
        readonly workspacePath?: string
        readonly relatedTo?: string
        readonly strength: number
        readonly reviewLevel: number
        readonly time: { readonly created: number; readonly updated: number; readonly reviewed?: number }
      }
      readonly right: {
        readonly id: string
        readonly version: number
        readonly content: string
        readonly type: string
        readonly tags: ReadonlyArray<string>
        readonly importance: number
        readonly source:
          | "user"
          | "user-corrected"
          | "imported"
          | "auto"
          | "model"
          | "quarantined"
          | "quarantined:auto"
          | "quarantined:model"
        readonly scope: "workspace" | "global"
        readonly projectID?: string
        readonly workspacePath?: string
        readonly relatedTo?: string
        readonly strength: number
        readonly reviewLevel: number
        readonly time: { readonly created: number; readonly updated: number; readonly reviewed?: number }
      }
    }>
    readonly count: number
    readonly truncated: boolean
  }
}["data"]

export type MemoriesResolveConflictInput = {
  readonly conflictID: { readonly conflictID: string }["conflictID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
  readonly chosenMemoryID: {
    readonly chosenMemoryID: string
    readonly reason: string
    readonly expectedLeftUpdatedAt: number
    readonly expectedRightUpdatedAt: number
  }["chosenMemoryID"]
  readonly reason: {
    readonly chosenMemoryID: string
    readonly reason: string
    readonly expectedLeftUpdatedAt: number
    readonly expectedRightUpdatedAt: number
  }["reason"]
  readonly expectedLeftUpdatedAt: {
    readonly chosenMemoryID: string
    readonly reason: string
    readonly expectedLeftUpdatedAt: number
    readonly expectedRightUpdatedAt: number
  }["expectedLeftUpdatedAt"]
  readonly expectedRightUpdatedAt: {
    readonly chosenMemoryID: string
    readonly reason: string
    readonly expectedLeftUpdatedAt: number
    readonly expectedRightUpdatedAt: number
  }["expectedRightUpdatedAt"]
}

export type MemoriesResolveConflictOutput = {
  readonly data: {
    readonly conflict: {
      readonly id: string
      readonly conflictKey: string
      readonly basis: "explicit-tag" | "deterministic-pattern-v1"
      readonly leftMemoryID: string
      readonly rightMemoryID: string
      readonly status: "pending" | "resolved" | "dismissed" | "undone"
      readonly chosenMemoryID?: string
      readonly retiredMemoryID?: string
      readonly decisionReason?: string
      readonly time: {
        readonly created: number
        readonly updated: number
        readonly decided?: number
        readonly undone?: number
      }
    }
    readonly left: {
      readonly id: string
      readonly version: number
      readonly content: string
      readonly type: string
      readonly tags: ReadonlyArray<string>
      readonly importance: number
      readonly source:
        | "user"
        | "user-corrected"
        | "imported"
        | "auto"
        | "model"
        | "quarantined"
        | "quarantined:auto"
        | "quarantined:model"
      readonly scope: "workspace" | "global"
      readonly projectID?: string
      readonly workspacePath?: string
      readonly relatedTo?: string
      readonly strength: number
      readonly reviewLevel: number
      readonly time: { readonly created: number; readonly updated: number; readonly reviewed?: number }
    }
    readonly right: {
      readonly id: string
      readonly version: number
      readonly content: string
      readonly type: string
      readonly tags: ReadonlyArray<string>
      readonly importance: number
      readonly source:
        | "user"
        | "user-corrected"
        | "imported"
        | "auto"
        | "model"
        | "quarantined"
        | "quarantined:auto"
        | "quarantined:model"
      readonly scope: "workspace" | "global"
      readonly projectID?: string
      readonly workspacePath?: string
      readonly relatedTo?: string
      readonly strength: number
      readonly reviewLevel: number
      readonly time: { readonly created: number; readonly updated: number; readonly reviewed?: number }
    }
  }
}["data"]

export type MemoriesDismissConflictInput = {
  readonly conflictID: { readonly conflictID: string }["conflictID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
  readonly reason: {
    readonly reason: string
    readonly expectedLeftUpdatedAt: number
    readonly expectedRightUpdatedAt: number
  }["reason"]
  readonly expectedLeftUpdatedAt: {
    readonly reason: string
    readonly expectedLeftUpdatedAt: number
    readonly expectedRightUpdatedAt: number
  }["expectedLeftUpdatedAt"]
  readonly expectedRightUpdatedAt: {
    readonly reason: string
    readonly expectedLeftUpdatedAt: number
    readonly expectedRightUpdatedAt: number
  }["expectedRightUpdatedAt"]
}

export type MemoriesDismissConflictOutput = {
  readonly data: {
    readonly conflict: {
      readonly id: string
      readonly conflictKey: string
      readonly basis: "explicit-tag" | "deterministic-pattern-v1"
      readonly leftMemoryID: string
      readonly rightMemoryID: string
      readonly status: "pending" | "resolved" | "dismissed" | "undone"
      readonly chosenMemoryID?: string
      readonly retiredMemoryID?: string
      readonly decisionReason?: string
      readonly time: {
        readonly created: number
        readonly updated: number
        readonly decided?: number
        readonly undone?: number
      }
    }
    readonly left: {
      readonly id: string
      readonly version: number
      readonly content: string
      readonly type: string
      readonly tags: ReadonlyArray<string>
      readonly importance: number
      readonly source:
        | "user"
        | "user-corrected"
        | "imported"
        | "auto"
        | "model"
        | "quarantined"
        | "quarantined:auto"
        | "quarantined:model"
      readonly scope: "workspace" | "global"
      readonly projectID?: string
      readonly workspacePath?: string
      readonly relatedTo?: string
      readonly strength: number
      readonly reviewLevel: number
      readonly time: { readonly created: number; readonly updated: number; readonly reviewed?: number }
    }
    readonly right: {
      readonly id: string
      readonly version: number
      readonly content: string
      readonly type: string
      readonly tags: ReadonlyArray<string>
      readonly importance: number
      readonly source:
        | "user"
        | "user-corrected"
        | "imported"
        | "auto"
        | "model"
        | "quarantined"
        | "quarantined:auto"
        | "quarantined:model"
      readonly scope: "workspace" | "global"
      readonly projectID?: string
      readonly workspacePath?: string
      readonly relatedTo?: string
      readonly strength: number
      readonly reviewLevel: number
      readonly time: { readonly created: number; readonly updated: number; readonly reviewed?: number }
    }
  }
}["data"]

export type MemoriesUndoConflictInput = {
  readonly conflictID: { readonly conflictID: string }["conflictID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
  readonly expectedLeftUpdatedAt: {
    readonly expectedLeftUpdatedAt: number
    readonly expectedRightUpdatedAt: number
  }["expectedLeftUpdatedAt"]
  readonly expectedRightUpdatedAt: {
    readonly expectedLeftUpdatedAt: number
    readonly expectedRightUpdatedAt: number
  }["expectedRightUpdatedAt"]
}

export type MemoriesUndoConflictOutput = {
  readonly data: {
    readonly conflict: {
      readonly id: string
      readonly conflictKey: string
      readonly basis: "explicit-tag" | "deterministic-pattern-v1"
      readonly leftMemoryID: string
      readonly rightMemoryID: string
      readonly status: "pending" | "resolved" | "dismissed" | "undone"
      readonly chosenMemoryID?: string
      readonly retiredMemoryID?: string
      readonly decisionReason?: string
      readonly time: {
        readonly created: number
        readonly updated: number
        readonly decided?: number
        readonly undone?: number
      }
    }
    readonly left: {
      readonly id: string
      readonly version: number
      readonly content: string
      readonly type: string
      readonly tags: ReadonlyArray<string>
      readonly importance: number
      readonly source:
        | "user"
        | "user-corrected"
        | "imported"
        | "auto"
        | "model"
        | "quarantined"
        | "quarantined:auto"
        | "quarantined:model"
      readonly scope: "workspace" | "global"
      readonly projectID?: string
      readonly workspacePath?: string
      readonly relatedTo?: string
      readonly strength: number
      readonly reviewLevel: number
      readonly time: { readonly created: number; readonly updated: number; readonly reviewed?: number }
    }
    readonly right: {
      readonly id: string
      readonly version: number
      readonly content: string
      readonly type: string
      readonly tags: ReadonlyArray<string>
      readonly importance: number
      readonly source:
        | "user"
        | "user-corrected"
        | "imported"
        | "auto"
        | "model"
        | "quarantined"
        | "quarantined:auto"
        | "quarantined:model"
      readonly scope: "workspace" | "global"
      readonly projectID?: string
      readonly workspacePath?: string
      readonly relatedTo?: string
      readonly strength: number
      readonly reviewLevel: number
      readonly time: { readonly created: number; readonly updated: number; readonly reviewed?: number }
    }
  }
}["data"]

export type MemoriesCandidateReviewInput = {
  readonly candidateID: { readonly candidateID: string }["candidateID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type MemoriesCandidateReviewOutput = {
  readonly data: {
    readonly candidateID: string
    readonly proposedClass: "working" | "episodic" | "semantic" | "user" | "project"
    readonly content?: string
    readonly contentRedacted: boolean
    readonly sourceEvidenceIDs: ReadonlyArray<string>
    readonly scope: "workspace" | "global"
    readonly sensitivity: "public" | "internal" | "confidential" | "secret"
    readonly confidence: number
    readonly dedup: {
      readonly status: "unknown" | "novel" | "near_duplicate" | "duplicate" | "conflict"
      readonly comparedMemoryIDs: ReadonlyArray<string>
      readonly similarity?: number
    }
    readonly retention: {
      readonly mode: "default" | "short" | "long" | "indefinite" | "until_review"
      readonly expiresAt?: number
      readonly reason: string
    }
    readonly proposer: {
      readonly kind: "user" | "agent" | "system"
      readonly principalRef?: string
      readonly runID?: string
    }
    readonly policy: {
      readonly status: "pending" | "allow" | "deny" | "review"
      readonly policyVersion: string
      readonly reason: string
    }
    readonly status: "proposed" | "approved" | "rejected" | "promoted" | "expired" | "superseded"
    readonly reason: string
    readonly time: { readonly created: number; readonly updated: number; readonly expires?: number }
    readonly approvalAllowed: boolean
    readonly activationAllowed: boolean
    readonly blockedReasons: ReadonlyArray<
      "status_not_proposed" | "policy_not_allow" | "secret_or_credential" | "duplicate" | "conflict" | "working_state"
    >
    readonly audit: ReadonlyArray<{
      readonly auditID: string
      readonly operation: "proposed" | "approved" | "rejected" | "activated"
      readonly actorKind: "user" | "agent" | "system" | "maintenance" | "recovery"
      readonly reason: string
      readonly policyVersion: string
      readonly statusFrom?: "proposed" | "approved" | "rejected" | "promoted" | "expired" | "superseded"
      readonly statusTo: "proposed" | "approved" | "rejected" | "promoted" | "expired" | "superseded"
      readonly createdAt: number
    }>
  }
}["data"]

export type MemoriesCandidateApproveInput = {
  readonly candidateID: { readonly candidateID: string }["candidateID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
  readonly expectedUpdatedAt: { readonly expectedUpdatedAt: number; readonly reason: string }["expectedUpdatedAt"]
  readonly reason: { readonly expectedUpdatedAt: number; readonly reason: string }["reason"]
}

export type MemoriesCandidateApproveOutput = {
  readonly data: {
    readonly candidateID: string
    readonly proposedClass: "working" | "episodic" | "semantic" | "user" | "project"
    readonly content?: string
    readonly contentRedacted: boolean
    readonly sourceEvidenceIDs: ReadonlyArray<string>
    readonly scope: "workspace" | "global"
    readonly sensitivity: "public" | "internal" | "confidential" | "secret"
    readonly confidence: number
    readonly dedup: {
      readonly status: "unknown" | "novel" | "near_duplicate" | "duplicate" | "conflict"
      readonly comparedMemoryIDs: ReadonlyArray<string>
      readonly similarity?: number
    }
    readonly retention: {
      readonly mode: "default" | "short" | "long" | "indefinite" | "until_review"
      readonly expiresAt?: number
      readonly reason: string
    }
    readonly proposer: {
      readonly kind: "user" | "agent" | "system"
      readonly principalRef?: string
      readonly runID?: string
    }
    readonly policy: {
      readonly status: "pending" | "allow" | "deny" | "review"
      readonly policyVersion: string
      readonly reason: string
    }
    readonly status: "proposed" | "approved" | "rejected" | "promoted" | "expired" | "superseded"
    readonly reason: string
    readonly time: { readonly created: number; readonly updated: number; readonly expires?: number }
    readonly approvalAllowed: boolean
    readonly activationAllowed: boolean
    readonly blockedReasons: ReadonlyArray<
      "status_not_proposed" | "policy_not_allow" | "secret_or_credential" | "duplicate" | "conflict" | "working_state"
    >
    readonly audit: ReadonlyArray<{
      readonly auditID: string
      readonly operation: "proposed" | "approved" | "rejected" | "activated"
      readonly actorKind: "user" | "agent" | "system" | "maintenance" | "recovery"
      readonly reason: string
      readonly policyVersion: string
      readonly statusFrom?: "proposed" | "approved" | "rejected" | "promoted" | "expired" | "superseded"
      readonly statusTo: "proposed" | "approved" | "rejected" | "promoted" | "expired" | "superseded"
      readonly createdAt: number
    }>
  }
}["data"]

export type MemoriesCandidateRejectInput = {
  readonly candidateID: { readonly candidateID: string }["candidateID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
  readonly expectedUpdatedAt: { readonly expectedUpdatedAt: number; readonly reason: string }["expectedUpdatedAt"]
  readonly reason: { readonly expectedUpdatedAt: number; readonly reason: string }["reason"]
}

export type MemoriesCandidateRejectOutput = {
  readonly data: {
    readonly candidateID: string
    readonly proposedClass: "working" | "episodic" | "semantic" | "user" | "project"
    readonly content?: string
    readonly contentRedacted: boolean
    readonly sourceEvidenceIDs: ReadonlyArray<string>
    readonly scope: "workspace" | "global"
    readonly sensitivity: "public" | "internal" | "confidential" | "secret"
    readonly confidence: number
    readonly dedup: {
      readonly status: "unknown" | "novel" | "near_duplicate" | "duplicate" | "conflict"
      readonly comparedMemoryIDs: ReadonlyArray<string>
      readonly similarity?: number
    }
    readonly retention: {
      readonly mode: "default" | "short" | "long" | "indefinite" | "until_review"
      readonly expiresAt?: number
      readonly reason: string
    }
    readonly proposer: {
      readonly kind: "user" | "agent" | "system"
      readonly principalRef?: string
      readonly runID?: string
    }
    readonly policy: {
      readonly status: "pending" | "allow" | "deny" | "review"
      readonly policyVersion: string
      readonly reason: string
    }
    readonly status: "proposed" | "approved" | "rejected" | "promoted" | "expired" | "superseded"
    readonly reason: string
    readonly time: { readonly created: number; readonly updated: number; readonly expires?: number }
    readonly approvalAllowed: boolean
    readonly activationAllowed: boolean
    readonly blockedReasons: ReadonlyArray<
      "status_not_proposed" | "policy_not_allow" | "secret_or_credential" | "duplicate" | "conflict" | "working_state"
    >
    readonly audit: ReadonlyArray<{
      readonly auditID: string
      readonly operation: "proposed" | "approved" | "rejected" | "activated"
      readonly actorKind: "user" | "agent" | "system" | "maintenance" | "recovery"
      readonly reason: string
      readonly policyVersion: string
      readonly statusFrom?: "proposed" | "approved" | "rejected" | "promoted" | "expired" | "superseded"
      readonly statusTo: "proposed" | "approved" | "rejected" | "promoted" | "expired" | "superseded"
      readonly createdAt: number
    }>
  }
}["data"]

export type MemoriesCandidateActivateInput = {
  readonly candidateID: { readonly candidateID: string }["candidateID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
  readonly expectedUpdatedAt: { readonly expectedUpdatedAt: number; readonly reason: string }["expectedUpdatedAt"]
  readonly reason: { readonly expectedUpdatedAt: number; readonly reason: string }["reason"]
}

export type MemoriesCandidateActivateOutput = {
  readonly data: {
    readonly candidateID: string
    readonly proposedClass: "working" | "episodic" | "semantic" | "user" | "project"
    readonly content?: string
    readonly contentRedacted: boolean
    readonly sourceEvidenceIDs: ReadonlyArray<string>
    readonly scope: "workspace" | "global"
    readonly sensitivity: "public" | "internal" | "confidential" | "secret"
    readonly confidence: number
    readonly dedup: {
      readonly status: "unknown" | "novel" | "near_duplicate" | "duplicate" | "conflict"
      readonly comparedMemoryIDs: ReadonlyArray<string>
      readonly similarity?: number
    }
    readonly retention: {
      readonly mode: "default" | "short" | "long" | "indefinite" | "until_review"
      readonly expiresAt?: number
      readonly reason: string
    }
    readonly proposer: {
      readonly kind: "user" | "agent" | "system"
      readonly principalRef?: string
      readonly runID?: string
    }
    readonly policy: {
      readonly status: "pending" | "allow" | "deny" | "review"
      readonly policyVersion: string
      readonly reason: string
    }
    readonly status: "proposed" | "approved" | "rejected" | "promoted" | "expired" | "superseded"
    readonly reason: string
    readonly time: { readonly created: number; readonly updated: number; readonly expires?: number }
    readonly approvalAllowed: boolean
    readonly activationAllowed: boolean
    readonly blockedReasons: ReadonlyArray<
      "status_not_proposed" | "policy_not_allow" | "secret_or_credential" | "duplicate" | "conflict" | "working_state"
    >
    readonly audit: ReadonlyArray<{
      readonly auditID: string
      readonly operation: "proposed" | "approved" | "rejected" | "activated"
      readonly actorKind: "user" | "agent" | "system" | "maintenance" | "recovery"
      readonly reason: string
      readonly policyVersion: string
      readonly statusFrom?: "proposed" | "approved" | "rejected" | "promoted" | "expired" | "superseded"
      readonly statusTo: "proposed" | "approved" | "rejected" | "promoted" | "expired" | "superseded"
      readonly createdAt: number
    }>
  }
}["data"]

export type MemoriesMaintenanceDeleteInput = {
  readonly memoryID: { readonly memoryID: string }["memoryID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
  readonly expectedVersion: {
    readonly expectedVersion: number
    readonly actionID: string
    readonly redactionEvidenceID: string
    readonly reason: string
  }["expectedVersion"]
  readonly actionID: {
    readonly expectedVersion: number
    readonly actionID: string
    readonly redactionEvidenceID: string
    readonly reason: string
  }["actionID"]
  readonly redactionEvidenceID: {
    readonly expectedVersion: number
    readonly actionID: string
    readonly redactionEvidenceID: string
    readonly reason: string
  }["redactionEvidenceID"]
  readonly reason: {
    readonly expectedVersion: number
    readonly actionID: string
    readonly redactionEvidenceID: string
    readonly reason: string
  }["reason"]
}

export type MemoriesMaintenanceDeleteOutput = void

export type MemoriesMaintenanceDeleteManyInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
  readonly items: {
    readonly items: ReadonlyArray<{
      readonly memoryID: string
      readonly expectedVersion: number
      readonly actionID: string
      readonly redactionEvidenceID: string
      readonly reason: string
    }>
  }["items"]
}

export type MemoriesMaintenanceDeleteManyOutput = {
  readonly data: { readonly deleted: ReadonlyArray<string>; readonly notFound: ReadonlyArray<string> }
}["data"]

export type MemoriesSemanticInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly query: string
    readonly topK?: number | undefined
    readonly includeGlobal?: "true" | "false" | undefined
    readonly indexLimit?: number | undefined
  }["location"]
  readonly query: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly query: string
    readonly topK?: number | undefined
    readonly includeGlobal?: "true" | "false" | undefined
    readonly indexLimit?: number | undefined
  }["query"]
  readonly topK?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly query: string
    readonly topK?: number | undefined
    readonly includeGlobal?: "true" | "false" | undefined
    readonly indexLimit?: number | undefined
  }["topK"]
  readonly includeGlobal?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly query: string
    readonly topK?: number | undefined
    readonly includeGlobal?: "true" | "false" | undefined
    readonly indexLimit?: number | undefined
  }["includeGlobal"]
  readonly indexLimit?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly query: string
    readonly topK?: number | undefined
    readonly includeGlobal?: "true" | "false" | undefined
    readonly indexLimit?: number | undefined
  }["indexLimit"]
}

export type MemoriesSemanticOutput = {
  readonly data: {
    readonly algorithm: "hybrid_bm25_embedding_api" | "hybrid_bm25_hashing_vector"
    readonly localOnly: boolean
    readonly embeddingEgress: "none" | "denied" | "sent" | "unknown"
    readonly embeddingFallback?: "remote-not-authorized" | "remote-failed"
    readonly items: ReadonlyArray<{
      readonly memory: {
        readonly id: string
        readonly version: number
        readonly content: string
        readonly type: string
        readonly tags: ReadonlyArray<string>
        readonly importance: number
        readonly source:
          | "user"
          | "user-corrected"
          | "imported"
          | "auto"
          | "model"
          | "quarantined"
          | "quarantined:auto"
          | "quarantined:model"
        readonly scope: "workspace" | "global"
        readonly projectID?: string
        readonly workspacePath?: string
        readonly relatedTo?: string
        readonly strength: number
        readonly reviewLevel: number
        readonly time: { readonly created: number; readonly updated: number; readonly reviewed?: number }
      }
      readonly score: number
      readonly lexicalScore: number
      readonly vectorScore: number
      readonly matchedTerms: ReadonlyArray<string>
    }>
    readonly count: number
  }
}["data"]

export type MemoriesFacetsInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly includeGlobal?: "true" | "false" | undefined
  }["location"]
  readonly includeGlobal?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly includeGlobal?: "true" | "false" | undefined
  }["includeGlobal"]
}

export type MemoriesFacetsOutput = {
  readonly data: {
    readonly projects: ReadonlyArray<{ readonly value: string; readonly count: number }>
    readonly workspaces: ReadonlyArray<{ readonly value: string; readonly count: number }>
    readonly types: ReadonlyArray<{ readonly value: string; readonly count: number }>
    readonly sources: ReadonlyArray<{ readonly value: string; readonly count: number }>
    readonly tags: ReadonlyArray<{ readonly value: string; readonly count: number }>
  }
}["data"]

export type MemoriesStatusInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type MemoriesStatusOutput = {
  readonly data: {
    readonly total: number
    readonly important: number
    readonly workspace: number
    readonly global: number
    readonly quarantined: number
    readonly pendingConflicts: number
    readonly recent: ReadonlyArray<{
      readonly id: string
      readonly version: number
      readonly content: string
      readonly type: string
      readonly tags: ReadonlyArray<string>
      readonly importance: number
      readonly source:
        | "user"
        | "user-corrected"
        | "imported"
        | "auto"
        | "model"
        | "quarantined"
        | "quarantined:auto"
        | "quarantined:model"
      readonly scope: "workspace" | "global"
      readonly projectID?: string
      readonly workspacePath?: string
      readonly relatedTo?: string
      readonly strength: number
      readonly reviewLevel: number
      readonly time: { readonly created: number; readonly updated: number; readonly reviewed?: number }
    }>
  }
}["data"]

export type MemoriesRecallQualityInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type MemoriesRecallQualityOutput = {
  readonly data: {
    readonly status: "operational_baseline"
    readonly sampleSize: number
    readonly top1Rate: number
    readonly meanReciprocalRank: number
    readonly noResultRate: number
    readonly examples: ReadonlyArray<{
      readonly memoryID: string
      readonly query: string
      readonly rank: number
      readonly reciprocalRank: number
    }>
    readonly caveat: string
  }
}["data"]

export type MemoriesGovernancePreviewInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly scanLimit?: number | undefined
    readonly sampleLimit?: number | undefined
  }["location"]
  readonly scanLimit?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly scanLimit?: number | undefined
    readonly sampleLimit?: number | undefined
  }["scanLimit"]
  readonly sampleLimit?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly scanLimit?: number | undefined
    readonly sampleLimit?: number | undefined
  }["sampleLimit"]
}

export type MemoriesGovernancePreviewOutput = {
  readonly data: {
    readonly schemaVersion: 1
    readonly scanned: number
    readonly candidateCount: number
    readonly alreadyQuarantined: number
    readonly reasons: ReadonlyArray<{ readonly reason: string; readonly count: number }>
    readonly candidates: ReadonlyArray<{
      readonly id: string
      readonly reason: string
      readonly type: string
      readonly source:
        | "user"
        | "user-corrected"
        | "imported"
        | "auto"
        | "model"
        | "quarantined"
        | "quarantined:auto"
        | "quarantined:model"
      readonly projectID?: string
      readonly workspacePath?: string
      readonly contentPreview: string
    }>
    readonly truncated: boolean
    readonly action: "quarantine"
    readonly reversible: true
  }
}["data"]

export type MemoriesGovernanceApplyInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
  readonly scanLimit?: { readonly scanLimit?: number | undefined }["scanLimit"]
}

export type MemoriesGovernanceApplyOutput = {
  readonly data: {
    readonly schemaVersion: 1
    readonly scanned: number
    readonly quarantined: number
    readonly quarantinedIDs: ReadonlyArray<string>
    readonly reversible: true
    readonly status: "applied"
  }
}["data"]

export type LearningDreamInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type LearningDreamOutput = {
  readonly data: {
    readonly consolidation: {
      readonly status: "not_run"
      readonly patternsFound: number
      readonly savedNew: number
      readonly updatedExisting: number
      readonly patterns: number
      readonly breakdown: { readonly failure: number; readonly fix: number; readonly preference: number }
      readonly reason: string
    }
    readonly dream: {
      readonly totalTurns: number
      readonly totalFailures: number
      readonly totalPatterns: number
      readonly insights: ReadonlyArray<string>
      readonly suggestions: ReadonlyArray<string>
      readonly timestamp: string
    }
    readonly executionMode: "read-only-core-projection"
    readonly sideEffects: "none"
    readonly caveat: string
  }
}["data"]

export type LearningStatusInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type LearningStatusOutput = {
  readonly data: {
    readonly totalTurns: number
    readonly successfulTurns: number
    readonly failedTurns: number
    readonly successRate: number
    readonly patternCount: number
    readonly fixCount: number
    readonly regressionCount: number
    readonly correctionCount: number
    readonly injectionCount: number
    readonly averageInjectedContextSize: number
    readonly topTags: ReadonlyArray<{ readonly value: string; readonly count: number }>
    readonly recent: ReadonlyArray<{
      readonly id: string
      readonly sessionID?: string
      readonly runID?: string
      readonly actionID?: string
      readonly evaluationID?: string
      readonly evidenceIDs?: ReadonlyArray<string>
      readonly terminal?: boolean
      readonly verifierPassed?: boolean
      readonly projectID: string
      readonly workspacePath: string
      readonly turnIndex: number
      readonly userInput: string
      readonly intent: string
      readonly route: string
      readonly tools: ReadonlyArray<string>
      readonly success: boolean
      readonly errorType: string
      readonly errorMessage: string
      readonly userFeedback: string
      readonly fixStrategy: string
      readonly regression: boolean
      readonly tokenCount: number
      readonly responseTimeMs: number
      readonly tags: ReadonlyArray<string>
      readonly importance: number
      readonly injectedContextSize: number
      readonly time: { readonly created: number }
    }>
    readonly patterns: ReadonlyArray<{
      readonly id: string
      readonly projectID: string
      readonly workspacePath: string
      readonly type: string
      readonly description: string
      readonly frequency: number
      readonly confidence: number
      readonly tags: ReadonlyArray<string>
      readonly time: { readonly created: number; readonly updated: number }
    }>
    readonly impact: {
      readonly status: "insufficient_data" | "observed"
      readonly injectedCount: number
      readonly baselineCount: number
      readonly injectedSuccessRate: number
      readonly baselineSuccessRate: number
      readonly uplift: number
      readonly caveat: string
    }
  }
}["data"]

export type LearningRecordInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
  readonly userInput: {
    readonly userInput: string
    readonly intent?: string | undefined
    readonly route?: string | undefined
    readonly tools?: ReadonlyArray<string> | undefined
    readonly success: boolean
    readonly errorType?: string | undefined
    readonly errorMessage?: string | undefined
    readonly userFeedback?: string | undefined
    readonly fixStrategy?: string | undefined
    readonly regression?: boolean | undefined
    readonly tokenCount?: number | undefined
    readonly responseTimeMs?: number | undefined
    readonly tags?: ReadonlyArray<string> | undefined
    readonly importance?: number | undefined
    readonly injectedContextSize?: number | undefined
  }["userInput"]
  readonly intent?: {
    readonly userInput: string
    readonly intent?: string | undefined
    readonly route?: string | undefined
    readonly tools?: ReadonlyArray<string> | undefined
    readonly success: boolean
    readonly errorType?: string | undefined
    readonly errorMessage?: string | undefined
    readonly userFeedback?: string | undefined
    readonly fixStrategy?: string | undefined
    readonly regression?: boolean | undefined
    readonly tokenCount?: number | undefined
    readonly responseTimeMs?: number | undefined
    readonly tags?: ReadonlyArray<string> | undefined
    readonly importance?: number | undefined
    readonly injectedContextSize?: number | undefined
  }["intent"]
  readonly route?: {
    readonly userInput: string
    readonly intent?: string | undefined
    readonly route?: string | undefined
    readonly tools?: ReadonlyArray<string> | undefined
    readonly success: boolean
    readonly errorType?: string | undefined
    readonly errorMessage?: string | undefined
    readonly userFeedback?: string | undefined
    readonly fixStrategy?: string | undefined
    readonly regression?: boolean | undefined
    readonly tokenCount?: number | undefined
    readonly responseTimeMs?: number | undefined
    readonly tags?: ReadonlyArray<string> | undefined
    readonly importance?: number | undefined
    readonly injectedContextSize?: number | undefined
  }["route"]
  readonly tools?: {
    readonly userInput: string
    readonly intent?: string | undefined
    readonly route?: string | undefined
    readonly tools?: ReadonlyArray<string> | undefined
    readonly success: boolean
    readonly errorType?: string | undefined
    readonly errorMessage?: string | undefined
    readonly userFeedback?: string | undefined
    readonly fixStrategy?: string | undefined
    readonly regression?: boolean | undefined
    readonly tokenCount?: number | undefined
    readonly responseTimeMs?: number | undefined
    readonly tags?: ReadonlyArray<string> | undefined
    readonly importance?: number | undefined
    readonly injectedContextSize?: number | undefined
  }["tools"]
  readonly success: {
    readonly userInput: string
    readonly intent?: string | undefined
    readonly route?: string | undefined
    readonly tools?: ReadonlyArray<string> | undefined
    readonly success: boolean
    readonly errorType?: string | undefined
    readonly errorMessage?: string | undefined
    readonly userFeedback?: string | undefined
    readonly fixStrategy?: string | undefined
    readonly regression?: boolean | undefined
    readonly tokenCount?: number | undefined
    readonly responseTimeMs?: number | undefined
    readonly tags?: ReadonlyArray<string> | undefined
    readonly importance?: number | undefined
    readonly injectedContextSize?: number | undefined
  }["success"]
  readonly errorType?: {
    readonly userInput: string
    readonly intent?: string | undefined
    readonly route?: string | undefined
    readonly tools?: ReadonlyArray<string> | undefined
    readonly success: boolean
    readonly errorType?: string | undefined
    readonly errorMessage?: string | undefined
    readonly userFeedback?: string | undefined
    readonly fixStrategy?: string | undefined
    readonly regression?: boolean | undefined
    readonly tokenCount?: number | undefined
    readonly responseTimeMs?: number | undefined
    readonly tags?: ReadonlyArray<string> | undefined
    readonly importance?: number | undefined
    readonly injectedContextSize?: number | undefined
  }["errorType"]
  readonly errorMessage?: {
    readonly userInput: string
    readonly intent?: string | undefined
    readonly route?: string | undefined
    readonly tools?: ReadonlyArray<string> | undefined
    readonly success: boolean
    readonly errorType?: string | undefined
    readonly errorMessage?: string | undefined
    readonly userFeedback?: string | undefined
    readonly fixStrategy?: string | undefined
    readonly regression?: boolean | undefined
    readonly tokenCount?: number | undefined
    readonly responseTimeMs?: number | undefined
    readonly tags?: ReadonlyArray<string> | undefined
    readonly importance?: number | undefined
    readonly injectedContextSize?: number | undefined
  }["errorMessage"]
  readonly userFeedback?: {
    readonly userInput: string
    readonly intent?: string | undefined
    readonly route?: string | undefined
    readonly tools?: ReadonlyArray<string> | undefined
    readonly success: boolean
    readonly errorType?: string | undefined
    readonly errorMessage?: string | undefined
    readonly userFeedback?: string | undefined
    readonly fixStrategy?: string | undefined
    readonly regression?: boolean | undefined
    readonly tokenCount?: number | undefined
    readonly responseTimeMs?: number | undefined
    readonly tags?: ReadonlyArray<string> | undefined
    readonly importance?: number | undefined
    readonly injectedContextSize?: number | undefined
  }["userFeedback"]
  readonly fixStrategy?: {
    readonly userInput: string
    readonly intent?: string | undefined
    readonly route?: string | undefined
    readonly tools?: ReadonlyArray<string> | undefined
    readonly success: boolean
    readonly errorType?: string | undefined
    readonly errorMessage?: string | undefined
    readonly userFeedback?: string | undefined
    readonly fixStrategy?: string | undefined
    readonly regression?: boolean | undefined
    readonly tokenCount?: number | undefined
    readonly responseTimeMs?: number | undefined
    readonly tags?: ReadonlyArray<string> | undefined
    readonly importance?: number | undefined
    readonly injectedContextSize?: number | undefined
  }["fixStrategy"]
  readonly regression?: {
    readonly userInput: string
    readonly intent?: string | undefined
    readonly route?: string | undefined
    readonly tools?: ReadonlyArray<string> | undefined
    readonly success: boolean
    readonly errorType?: string | undefined
    readonly errorMessage?: string | undefined
    readonly userFeedback?: string | undefined
    readonly fixStrategy?: string | undefined
    readonly regression?: boolean | undefined
    readonly tokenCount?: number | undefined
    readonly responseTimeMs?: number | undefined
    readonly tags?: ReadonlyArray<string> | undefined
    readonly importance?: number | undefined
    readonly injectedContextSize?: number | undefined
  }["regression"]
  readonly tokenCount?: {
    readonly userInput: string
    readonly intent?: string | undefined
    readonly route?: string | undefined
    readonly tools?: ReadonlyArray<string> | undefined
    readonly success: boolean
    readonly errorType?: string | undefined
    readonly errorMessage?: string | undefined
    readonly userFeedback?: string | undefined
    readonly fixStrategy?: string | undefined
    readonly regression?: boolean | undefined
    readonly tokenCount?: number | undefined
    readonly responseTimeMs?: number | undefined
    readonly tags?: ReadonlyArray<string> | undefined
    readonly importance?: number | undefined
    readonly injectedContextSize?: number | undefined
  }["tokenCount"]
  readonly responseTimeMs?: {
    readonly userInput: string
    readonly intent?: string | undefined
    readonly route?: string | undefined
    readonly tools?: ReadonlyArray<string> | undefined
    readonly success: boolean
    readonly errorType?: string | undefined
    readonly errorMessage?: string | undefined
    readonly userFeedback?: string | undefined
    readonly fixStrategy?: string | undefined
    readonly regression?: boolean | undefined
    readonly tokenCount?: number | undefined
    readonly responseTimeMs?: number | undefined
    readonly tags?: ReadonlyArray<string> | undefined
    readonly importance?: number | undefined
    readonly injectedContextSize?: number | undefined
  }["responseTimeMs"]
  readonly tags?: {
    readonly userInput: string
    readonly intent?: string | undefined
    readonly route?: string | undefined
    readonly tools?: ReadonlyArray<string> | undefined
    readonly success: boolean
    readonly errorType?: string | undefined
    readonly errorMessage?: string | undefined
    readonly userFeedback?: string | undefined
    readonly fixStrategy?: string | undefined
    readonly regression?: boolean | undefined
    readonly tokenCount?: number | undefined
    readonly responseTimeMs?: number | undefined
    readonly tags?: ReadonlyArray<string> | undefined
    readonly importance?: number | undefined
    readonly injectedContextSize?: number | undefined
  }["tags"]
  readonly importance?: {
    readonly userInput: string
    readonly intent?: string | undefined
    readonly route?: string | undefined
    readonly tools?: ReadonlyArray<string> | undefined
    readonly success: boolean
    readonly errorType?: string | undefined
    readonly errorMessage?: string | undefined
    readonly userFeedback?: string | undefined
    readonly fixStrategy?: string | undefined
    readonly regression?: boolean | undefined
    readonly tokenCount?: number | undefined
    readonly responseTimeMs?: number | undefined
    readonly tags?: ReadonlyArray<string> | undefined
    readonly importance?: number | undefined
    readonly injectedContextSize?: number | undefined
  }["importance"]
  readonly injectedContextSize?: {
    readonly userInput: string
    readonly intent?: string | undefined
    readonly route?: string | undefined
    readonly tools?: ReadonlyArray<string> | undefined
    readonly success: boolean
    readonly errorType?: string | undefined
    readonly errorMessage?: string | undefined
    readonly userFeedback?: string | undefined
    readonly fixStrategy?: string | undefined
    readonly regression?: boolean | undefined
    readonly tokenCount?: number | undefined
    readonly responseTimeMs?: number | undefined
    readonly tags?: ReadonlyArray<string> | undefined
    readonly importance?: number | undefined
    readonly injectedContextSize?: number | undefined
  }["injectedContextSize"]
}

export type LearningRecordOutput = {
  readonly data: {
    readonly id: string
    readonly sessionID?: string
    readonly runID?: string
    readonly actionID?: string
    readonly evaluationID?: string
    readonly evidenceIDs?: ReadonlyArray<string>
    readonly terminal?: boolean
    readonly verifierPassed?: boolean
    readonly projectID: string
    readonly workspacePath: string
    readonly turnIndex: number
    readonly userInput: string
    readonly intent: string
    readonly route: string
    readonly tools: ReadonlyArray<string>
    readonly success: boolean
    readonly errorType: string
    readonly errorMessage: string
    readonly userFeedback: string
    readonly fixStrategy: string
    readonly regression: boolean
    readonly tokenCount: number
    readonly responseTimeMs: number
    readonly tags: ReadonlyArray<string>
    readonly importance: number
    readonly injectedContextSize: number
    readonly time: { readonly created: number }
  }
}["data"]

export type LearningUndoInput = {
  readonly outcomeID: { readonly outcomeID: string }["outcomeID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type LearningUndoOutput = {
  readonly data: {
    readonly outcomeID: string
    readonly deleted: boolean
    readonly linkedPatterns: ReadonlyArray<{ readonly patternID: string; readonly action: "decremented" | "deleted" }>
  }
}["data"]

export type LearningSyncDogfoodInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
  readonly candidates: {
    readonly candidates: ReadonlyArray<{
      readonly task: string
      readonly success: boolean
      readonly timestamp: string
      readonly steps?: number | undefined
      readonly toolCalls?: ReadonlyArray<string> | undefined
      readonly error?: string | undefined
    }>
  }["candidates"]
}

export type LearningSyncDogfoodOutput = {
  readonly data: {
    readonly seen: number
    readonly imported: number
    readonly skipped: number
    readonly failedCandidates: number
  }
}["data"]

export type FeedbackSubmitInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
  readonly category: {
    readonly category: "bug" | "feature" | "experience" | "other"
    readonly rating: number
    readonly message: string
    readonly sessionID?: string | undefined
  }["category"]
  readonly rating: {
    readonly category: "bug" | "feature" | "experience" | "other"
    readonly rating: number
    readonly message: string
    readonly sessionID?: string | undefined
  }["rating"]
  readonly message: {
    readonly category: "bug" | "feature" | "experience" | "other"
    readonly rating: number
    readonly message: string
    readonly sessionID?: string | undefined
  }["message"]
  readonly sessionID?: {
    readonly category: "bug" | "feature" | "experience" | "other"
    readonly rating: number
    readonly message: string
    readonly sessionID?: string | undefined
  }["sessionID"]
}

export type FeedbackSubmitOutput = {
  readonly data: {
    readonly schemaVersion: 1
    readonly storedLocally: true
    readonly feedback: {
      readonly id: string
      readonly category: "bug" | "feature" | "experience" | "other"
      readonly rating: number
      readonly message: string
      readonly sessionID?: string
      readonly learningOutcomeID?: string
      readonly time: { readonly created: number }
    }
  }
}["data"]

export type FeedbackListInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly limit?: number | undefined
    readonly category?: ("bug" | "feature" | "experience" | "other") | undefined
  }["location"]
  readonly limit?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly limit?: number | undefined
    readonly category?: ("bug" | "feature" | "experience" | "other") | undefined
  }["limit"]
  readonly category?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly limit?: number | undefined
    readonly category?: ("bug" | "feature" | "experience" | "other") | undefined
  }["category"]
}

export type FeedbackListOutput = {
  readonly data: {
    readonly schemaVersion: 1
    readonly storedLocally: true
    readonly category?: "bug" | "feature" | "experience" | "other"
    readonly items: ReadonlyArray<{
      readonly id: string
      readonly category: "bug" | "feature" | "experience" | "other"
      readonly rating: number
      readonly message: string
      readonly sessionID?: string
      readonly learningOutcomeID?: string
      readonly time: { readonly created: number }
    }>
    readonly count: number
    readonly total: number
  }
}["data"]

export type FeedbackSummaryInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type FeedbackSummaryOutput = {
  readonly data: {
    readonly schemaVersion: 1
    readonly storedLocally: true
    readonly total: number
    readonly averageRating?: number
    readonly byCategory: ReadonlyArray<{
      readonly category: "bug" | "feature" | "experience" | "other"
      readonly count: number
    }>
  }
}["data"]

export type FeedbackDeleteInput = {
  readonly feedbackID: { readonly feedbackID: string }["feedbackID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type FeedbackDeleteOutput = {
  readonly data: {
    readonly schemaVersion: 1
    readonly feedbackID: string
    readonly deleted: boolean
    readonly status: "deleted" | "not_found"
  }
}["data"]

export type DiagnosticsDiagnoseInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
  readonly filename: {
    readonly filename: string
    readonly extractedText?: string | undefined
    readonly limit?: number | undefined
    readonly mode?: "error" | "frontend" | "javascript" | undefined
  }["filename"]
  readonly extractedText?: {
    readonly filename: string
    readonly extractedText?: string | undefined
    readonly limit?: number | undefined
    readonly mode?: "error" | "frontend" | "javascript" | undefined
  }["extractedText"]
  readonly limit?: {
    readonly filename: string
    readonly extractedText?: string | undefined
    readonly limit?: number | undefined
    readonly mode?: "error" | "frontend" | "javascript" | undefined
  }["limit"]
  readonly mode?: {
    readonly filename: string
    readonly extractedText?: string | undefined
    readonly limit?: number | undefined
    readonly mode?: "error" | "frontend" | "javascript" | undefined
  }["mode"]
}

export type DiagnosticsDiagnoseOutput = {
  readonly data: {
    readonly schemaVersion: 1
    readonly localOnly: true
    readonly modelCalls: 0
    readonly mode: "error" | "frontend" | "javascript"
    readonly success: boolean
    readonly path: string
    readonly source: {
      readonly success: boolean
      readonly type: "provided_text" | "document" | "image_ocr" | "missing" | "unsupported"
      readonly path: string
      readonly text: string
      readonly truncated: boolean
      readonly error?: string
      readonly engine?: string
      readonly image?: {
        readonly bytes: number
        readonly width?: number
        readonly height?: number
        readonly format?: string
        readonly error?: string
      }
    }
    readonly signals: ReadonlyArray<{
      readonly kind: "file_line" | "exception" | "missing_name" | "missing_module" | "missing_import" | "file_reference"
      readonly value: string
      readonly line?: number
      readonly detail?: string
      readonly raw: string
    }>
    readonly searchTerms: ReadonlyArray<string>
    readonly matches: ReadonlyArray<{
      readonly file: string
      readonly line: number
      readonly terms: ReadonlyArray<string>
      readonly preview: string
    }>
    readonly suggestions: ReadonlyArray<string>
    readonly warnings: ReadonlyArray<string>
    readonly summary: {
      readonly textChars: number
      readonly signals: number
      readonly searchTerms: number
      readonly matches: number
    }
    readonly frontend?: {
      readonly schemaVersion: 1
      readonly localOnly: true
      readonly mode: "frontend" | "javascript"
      readonly path: string
      readonly success: boolean
      readonly textChars: number
      readonly lineCount: number
      readonly truncated: boolean
      readonly script?: {
        readonly tags: number
        readonly inline: number
        readonly external: number
        readonly blocking: number
      }
      readonly framework: "none" | "vue3"
      readonly externalAssets: ReadonlyArray<{
        readonly kind: "script" | "stylesheet"
        readonly url: string
        readonly local: boolean
      }>
      readonly assetLocalizationPreview?: {
        readonly status: "ready" | "none" | "blocked"
        readonly execution: "preview_only"
        readonly htmlResource: string
        readonly assetRoot: string
        readonly discoveryDigest?: string
        readonly references: ReadonlyArray<{ readonly kind: "script" | "stylesheet"; readonly url: string }>
        readonly networkScopeCount: number
        readonly reason?: string
      }
      readonly issues: ReadonlyArray<{
        readonly code:
          | "empty_source"
          | "missing_body"
          | "missing_html"
          | "unclosed_script"
          | "blocking_script"
          | "external_asset_not_checked"
          | "unbalanced_braces"
          | "unbalanced_parentheses"
          | "unbalanced_brackets"
          | "stray_closing_delimiter"
          | "unterminated_string"
          | "unterminated_comment"
          | "missing_mount_target"
          | "prefix_icon_literal"
          | "undeclared_app"
          | "router_history_unclear"
          | "vue_detected"
        readonly severity: "error" | "warning" | "info"
        readonly message: string
        readonly line?: number
        readonly detail?: string
      }>
    }
  }
}["data"]

export type AgentCapabilitiesHealthInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type AgentCapabilitiesHealthOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly status: "ok"
    readonly brand: string
    readonly version: string
    readonly python: string
    readonly python_supported: boolean
  }
}

export type AgentCapabilitiesListInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type AgentCapabilitiesListOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly count: number
    readonly items: ReadonlyArray<{
      readonly name: string
      readonly description: string
      readonly kind: string
      readonly keywords: ReadonlyArray<string>
      readonly priority: number
      readonly enabled: boolean
    }>
  }
}

export type AgentCapabilitiesSystemOverviewInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type AgentCapabilitiesSystemOverviewOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly schema_version: 1
    readonly sections: ReadonlyArray<{
      readonly id:
        | "status"
        | "runtime-stats"
        | "runtime-metrics"
        | "sandbox"
        | "tools"
        | "subagent-roles"
        | "cost-optimization"
      readonly title: string
      readonly data: JsonValue
    }>
  }
}

export type AgentCapabilitiesDeepInsightsInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type AgentCapabilitiesDeepInsightsOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly schema_version: 1
    readonly sections: ReadonlyArray<{
      readonly id:
        | "features"
        | "file-state"
        | "memory-feedback"
        | "feature-policy-contract"
        | "permission-rules"
        | "permission-policy-contract"
        | "permission-mode"
        | "self-correct"
        | "release-gates"
        | "release-remediation"
      readonly title: string
      readonly data: JsonValue
    }>
  }
}

export type AgentCapabilitiesRepoScaleInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
  readonly path?: {
    readonly path?: string | undefined
    readonly query?: string | undefined
    readonly maxFiles?: number | undefined
    readonly limit?: number | undefined
  }["path"]
  readonly query?: {
    readonly path?: string | undefined
    readonly query?: string | undefined
    readonly maxFiles?: number | undefined
    readonly limit?: number | undefined
  }["query"]
  readonly maxFiles?: {
    readonly path?: string | undefined
    readonly query?: string | undefined
    readonly maxFiles?: number | undefined
    readonly limit?: number | undefined
  }["maxFiles"]
  readonly limit?: {
    readonly path?: string | undefined
    readonly query?: string | undefined
    readonly maxFiles?: number | undefined
    readonly limit?: number | undefined
  }["limit"]
}

export type AgentCapabilitiesRepoScaleOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly schema_version: 1
    readonly root: string
    readonly budget: { readonly max_files: number; readonly suffixes: ReadonlyArray<string> }
    readonly scan: {
      readonly total: number
      readonly added: number
      readonly changed: number
      readonly unchanged: number
      readonly removed: number
      readonly incremental: boolean
      readonly scan_time_ms: number
      readonly truncated: boolean
      readonly total_files_estimate: number
      readonly code_files_estimate: number
    }
    readonly suffix_counts: { readonly [x: string]: number }
    readonly largest_files: ReadonlyArray<{ readonly path: string; readonly suffix: string; readonly bytes: number }>
    readonly search: {
      readonly query: string
      readonly total: number
      readonly items: ReadonlyArray<{
        readonly path: string
        readonly line: number
        readonly score: number
        readonly matched_terms: ReadonlyArray<string>
        readonly preview: string
      }>
      readonly searched_files: number
      readonly truncated: boolean
    }
    readonly recommendations: ReadonlyArray<string>
  }
}

export type AgentCapabilitiesRunListInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly limit?: number | undefined
  }["location"]
  readonly limit?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly limit?: number | undefined
  }["limit"]
}

export type AgentCapabilitiesRunListOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly schema_version: 1
    readonly count: number
    readonly items: ReadonlyArray<{
      readonly run_id: string
      readonly created: string
      readonly has_transaction: boolean
      readonly has_trace: boolean
      readonly has_messages: boolean
      readonly changed_files: number
      readonly trace_events: number
      readonly messages_count: number
      readonly answer_preview: string
    }>
  }
}

export type AgentCapabilitiesRunReportInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly runID?: string | undefined
  }["location"]
  readonly runID?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly runID?: string | undefined
  }["runID"]
}

export type AgentCapabilitiesRunReportOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data:
    | { readonly schema_version: 1; readonly found: false; readonly run_id: string; readonly report: null }
    | {
        readonly schema_version: 1
        readonly found: true
        readonly run_id: string
        readonly report: {
          readonly schema_version: 1
          readonly run_id: string
          readonly created: string
          readonly has_transaction: boolean
          readonly has_trace: boolean
          readonly has_messages: boolean
          readonly changed_files: ReadonlyArray<string>
          readonly commands_run: ReadonlyArray<{
            readonly command: string
            readonly success: boolean
            readonly returncode: number | null
          }>
          readonly trace_events: number
          readonly messages_count: number
          readonly answer: string
          readonly observability: { readonly [x: string]: JsonValue }
          readonly self_correct: { readonly [x: string]: JsonValue }
          readonly trace: ReadonlyArray<{ readonly [x: string]: JsonValue }>
          readonly trace_truncated: boolean
        }
      }
}

export type AgentCapabilitiesQualityAssessInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
  readonly files?: {
    readonly files?: ReadonlyArray<string> | undefined
    readonly patchText?: string | undefined
  }["files"]
  readonly patchText?: {
    readonly files?: ReadonlyArray<string> | undefined
    readonly patchText?: string | undefined
  }["patchText"]
}

export type AgentCapabilitiesQualityAssessOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly passed: boolean
    readonly score: number
    readonly files_checked: number
    readonly diff_stats?: {
      readonly files: ReadonlyArray<string>
      readonly files_changed: number
      readonly additions: number
      readonly deletions: number
      readonly changed_lines: number
      readonly hunks: number
      readonly new_files: number
      readonly deleted_files: number
    }
    readonly issues: ReadonlyArray<{
      readonly level: "error" | "warning"
      readonly code: string
      readonly message: string
      readonly file: string
    }>
    readonly summary: string
  }
}

export type AgentCapabilitiesSkillListInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type AgentCapabilitiesSkillListOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly count: number
    readonly enabled_count: number
    readonly items: ReadonlyArray<{
      readonly id: string
      readonly name: string
      readonly description: string
      readonly version: string
      readonly source: string
      readonly path: string
      readonly entrypoint: string
      readonly license: string
      readonly tags: ReadonlyArray<string>
      readonly enabled: boolean
      readonly problems: ReadonlyArray<string>
    }>
    readonly roots: ReadonlyArray<string>
  }
}

export type AgentCapabilitiesSkillReadInput = {
  readonly skillID: { readonly skillID: string }["skillID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly maxChars?: number | undefined
  }["location"]
  readonly maxChars?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly maxChars?: number | undefined
  }["maxChars"]
}

export type AgentCapabilitiesSkillReadOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data:
    | { readonly ok: false; readonly error: string }
    | {
        readonly ok: true
        readonly manifest: {
          readonly id: string
          readonly name: string
          readonly description: string
          readonly version: string
          readonly source: string
          readonly path: string
          readonly entrypoint: string
          readonly license: string
          readonly tags: ReadonlyArray<string>
          readonly enabled: boolean
          readonly problems: ReadonlyArray<string>
        }
        readonly content: string
        readonly truncated: boolean
        readonly resources: ReadonlyArray<string>
      }
}

export type AgentCapabilitiesSkillRouteInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
  readonly request: { readonly request: string }["request"]
}

export type AgentCapabilitiesSkillRouteOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly mode: string
    readonly selected: ReadonlyArray<string>
    readonly phases: ReadonlyArray<string>
    readonly reasons: { readonly [x: string]: string }
    readonly missing: ReadonlyArray<string>
    readonly relationship: string
  }
}

export type AgentCapabilitiesSkillSetEnabledInput = {
  readonly skillID: { readonly skillID: string }["skillID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
  readonly enabled: { readonly enabled: boolean; readonly requestID?: string | undefined }["enabled"]
  readonly requestID?: { readonly enabled: boolean; readonly requestID?: string | undefined }["requestID"]
}

export type AgentCapabilitiesSkillSetEnabledOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly skill_id: string
    readonly enabled: boolean
    readonly changed: boolean
    readonly skills: {
      readonly count: number
      readonly enabled_count: number
      readonly items: ReadonlyArray<{
        readonly id: string
        readonly name: string
        readonly description: string
        readonly version: string
        readonly source: string
        readonly path: string
        readonly entrypoint: string
        readonly license: string
        readonly tags: ReadonlyArray<string>
        readonly enabled: boolean
        readonly problems: ReadonlyArray<string>
      }>
      readonly roots: ReadonlyArray<string>
    }
  }
}

export type AgentCapabilitiesSkillRefreshInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type AgentCapabilitiesSkillRefreshOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly count: number
    readonly enabled_count: number
    readonly items: ReadonlyArray<{
      readonly id: string
      readonly name: string
      readonly description: string
      readonly version: string
      readonly source: string
      readonly path: string
      readonly entrypoint: string
      readonly license: string
      readonly tags: ReadonlyArray<string>
      readonly enabled: boolean
      readonly problems: ReadonlyArray<string>
    }>
    readonly roots: ReadonlyArray<string>
  }
}

export type AgentCapabilitiesPluginListInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type AgentCapabilitiesPluginListOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly count: number
    readonly items: ReadonlyArray<{
      readonly name: string
      readonly version: string
      readonly description: string
      readonly hooks: ReadonlyArray<string>
      readonly tools: ReadonlyArray<{
        readonly name: string
        readonly description: string
        readonly parameters: JsonValue
      }>
      readonly manifest_path: string
      readonly entrypoint: string
      readonly source: "profile" | "workspace" | "external"
      readonly sha256: string
      readonly permissions: ReadonlyArray<{ readonly action: string; readonly resources: ReadonlyArray<string> }>
      readonly egress: ReadonlyArray<string>
      readonly secrets: ReadonlyArray<string>
      readonly compatibility: {
        readonly api_version: number
        readonly runtime?: string
        readonly platforms: ReadonlyArray<string>
      }
      readonly signature: {
        readonly status: "unsigned" | "untrusted" | "verified" | "invalid"
        readonly algorithm?: "ed25519"
        readonly key_id?: string
        readonly signed_digest: string
        readonly reason?: string
      }
      readonly security: {
        readonly status: "passed" | "warning" | "blocked"
        readonly findings: ReadonlyArray<{
          readonly rule:
            | "forbidden-runtime-boundary"
            | "undeclared-egress"
            | "undeclared-secret"
            | "signature"
            | "scan-limit"
            | "unsafe-path"
          readonly severity: "info" | "warning" | "blocking"
          readonly path: string
          readonly message: string
        }>
        readonly scanned_files: number
        readonly scanned_bytes: number
      }
      readonly enabled: boolean
      readonly problems: ReadonlyArray<string>
      readonly managed: boolean
    }>
    readonly roots: ReadonlyArray<string>
  }
}

export type AgentCapabilitiesCustomizationListInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type AgentCapabilitiesCustomizationListOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly commands: {
      readonly count: number
      readonly enabled_count: number
      readonly items: ReadonlyArray<{
        readonly name: string
        readonly description: string
        readonly template: string
        readonly source: string
        readonly path: string
        readonly category: string
        readonly problems: ReadonlyArray<string>
      }>
    }
    readonly hooks: {
      readonly count: number
      readonly enabled_count: number
      readonly items: ReadonlyArray<{
        readonly name: string
        readonly event: string
        readonly description: string
        readonly source: string
        readonly path: string
        readonly priority: number
        readonly enabled: boolean
        readonly matcher: string
        readonly timeout_seconds: number
        readonly problems: ReadonlyArray<string>
        readonly command_configured: boolean
        readonly executable: string
      }>
    }
    readonly roots: ReadonlyArray<string>
  }
}

export type AgentCapabilitiesCustomizationRenderInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
  readonly name: { readonly name: string; readonly args?: string | undefined }["name"]
  readonly args?: { readonly name: string; readonly args?: string | undefined }["args"]
}

export type AgentCapabilitiesCustomizationRenderOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: { readonly name: string; readonly rendered: string }
}

export type AgentCapabilitiesPluginSetEnabledInput = {
  readonly name: { readonly name: string }["name"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
  readonly enabled: { readonly enabled: boolean; readonly requestID?: string | undefined }["enabled"]
  readonly requestID?: { readonly enabled: boolean; readonly requestID?: string | undefined }["requestID"]
}

export type AgentCapabilitiesPluginSetEnabledOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly count: number
    readonly items: ReadonlyArray<{
      readonly name: string
      readonly version: string
      readonly description: string
      readonly hooks: ReadonlyArray<string>
      readonly tools: ReadonlyArray<{
        readonly name: string
        readonly description: string
        readonly parameters: JsonValue
      }>
      readonly manifest_path: string
      readonly entrypoint: string
      readonly source: "profile" | "workspace" | "external"
      readonly sha256: string
      readonly permissions: ReadonlyArray<{ readonly action: string; readonly resources: ReadonlyArray<string> }>
      readonly egress: ReadonlyArray<string>
      readonly secrets: ReadonlyArray<string>
      readonly compatibility: {
        readonly api_version: number
        readonly runtime?: string
        readonly platforms: ReadonlyArray<string>
      }
      readonly signature: {
        readonly status: "unsigned" | "untrusted" | "verified" | "invalid"
        readonly algorithm?: "ed25519"
        readonly key_id?: string
        readonly signed_digest: string
        readonly reason?: string
      }
      readonly security: {
        readonly status: "passed" | "warning" | "blocked"
        readonly findings: ReadonlyArray<{
          readonly rule:
            | "forbidden-runtime-boundary"
            | "undeclared-egress"
            | "undeclared-secret"
            | "signature"
            | "scan-limit"
            | "unsafe-path"
          readonly severity: "info" | "warning" | "blocking"
          readonly path: string
          readonly message: string
        }>
        readonly scanned_files: number
        readonly scanned_bytes: number
      }
      readonly enabled: boolean
      readonly problems: ReadonlyArray<string>
      readonly managed: boolean
    }>
    readonly roots: ReadonlyArray<string>
  }
}

export type AgentCapabilitiesPluginInspectInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
  readonly source: { readonly source: string }["source"]
}

export type AgentCapabilitiesPluginInspectOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly token: string
    readonly source: string
    readonly expires_in_seconds: number
    readonly selection_required: boolean
    readonly candidates: ReadonlyArray<{
      readonly name: string
      readonly version: string
      readonly description: string
      readonly hooks: ReadonlyArray<string>
      readonly tools: ReadonlyArray<{
        readonly name: string
        readonly description: string
        readonly parameters: JsonValue
      }>
      readonly manifest_path: string
      readonly entrypoint: string
      readonly source: "profile" | "workspace" | "external"
      readonly permissions: ReadonlyArray<{ readonly action: string; readonly resources: ReadonlyArray<string> }>
      readonly egress: ReadonlyArray<string>
      readonly secrets: ReadonlyArray<string>
      readonly compatibility: {
        readonly api_version: number
        readonly runtime?: string
        readonly platforms: ReadonlyArray<string>
      }
      readonly signature: {
        readonly status: "unsigned" | "untrusted" | "verified" | "invalid"
        readonly algorithm?: "ed25519"
        readonly key_id?: string
        readonly signed_digest: string
        readonly reason?: string
      }
      readonly security: {
        readonly status: "passed" | "warning" | "blocked"
        readonly findings: ReadonlyArray<{
          readonly rule:
            | "forbidden-runtime-boundary"
            | "undeclared-egress"
            | "undeclared-secret"
            | "signature"
            | "scan-limit"
            | "unsafe-path"
          readonly severity: "info" | "warning" | "blocking"
          readonly path: string
          readonly message: string
        }>
        readonly scanned_files: number
        readonly scanned_bytes: number
      }
      readonly enabled: boolean
      readonly problems: ReadonlyArray<string>
      readonly sha256: string
    }>
  }
}

export type AgentCapabilitiesPluginApplyInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
  readonly token: {
    readonly token: string
    readonly name?: string | undefined
    readonly replace?: boolean | undefined
    readonly requestID?: string | undefined
  }["token"]
  readonly name?: {
    readonly token: string
    readonly name?: string | undefined
    readonly replace?: boolean | undefined
    readonly requestID?: string | undefined
  }["name"]
  readonly replace?: {
    readonly token: string
    readonly name?: string | undefined
    readonly replace?: boolean | undefined
    readonly requestID?: string | undefined
  }["replace"]
  readonly requestID?: {
    readonly token: string
    readonly name?: string | undefined
    readonly replace?: boolean | undefined
    readonly requestID?: string | undefined
  }["requestID"]
}

export type AgentCapabilitiesPluginApplyOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly transaction: JsonValue
    readonly plugins: {
      readonly count: number
      readonly items: ReadonlyArray<{
        readonly name: string
        readonly version: string
        readonly description: string
        readonly hooks: ReadonlyArray<string>
        readonly tools: ReadonlyArray<{
          readonly name: string
          readonly description: string
          readonly parameters: JsonValue
        }>
        readonly manifest_path: string
        readonly entrypoint: string
        readonly source: "profile" | "workspace" | "external"
        readonly sha256: string
        readonly permissions: ReadonlyArray<{ readonly action: string; readonly resources: ReadonlyArray<string> }>
        readonly egress: ReadonlyArray<string>
        readonly secrets: ReadonlyArray<string>
        readonly compatibility: {
          readonly api_version: number
          readonly runtime?: string
          readonly platforms: ReadonlyArray<string>
        }
        readonly signature: {
          readonly status: "unsigned" | "untrusted" | "verified" | "invalid"
          readonly algorithm?: "ed25519"
          readonly key_id?: string
          readonly signed_digest: string
          readonly reason?: string
        }
        readonly security: {
          readonly status: "passed" | "warning" | "blocked"
          readonly findings: ReadonlyArray<{
            readonly rule:
              | "forbidden-runtime-boundary"
              | "undeclared-egress"
              | "undeclared-secret"
              | "signature"
              | "scan-limit"
              | "unsafe-path"
            readonly severity: "info" | "warning" | "blocking"
            readonly path: string
            readonly message: string
          }>
          readonly scanned_files: number
          readonly scanned_bytes: number
        }
        readonly enabled: boolean
        readonly problems: ReadonlyArray<string>
        readonly managed: boolean
      }>
      readonly roots: ReadonlyArray<string>
    }
  }
}

export type AgentCapabilitiesPluginRemoveInput = {
  readonly name: { readonly name: string }["name"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
  readonly requestID?: { readonly requestID?: string | undefined }["requestID"]
}

export type AgentCapabilitiesPluginRemoveOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly transaction: JsonValue
    readonly plugins: {
      readonly count: number
      readonly items: ReadonlyArray<{
        readonly name: string
        readonly version: string
        readonly description: string
        readonly hooks: ReadonlyArray<string>
        readonly tools: ReadonlyArray<{
          readonly name: string
          readonly description: string
          readonly parameters: JsonValue
        }>
        readonly manifest_path: string
        readonly entrypoint: string
        readonly source: "profile" | "workspace" | "external"
        readonly sha256: string
        readonly permissions: ReadonlyArray<{ readonly action: string; readonly resources: ReadonlyArray<string> }>
        readonly egress: ReadonlyArray<string>
        readonly secrets: ReadonlyArray<string>
        readonly compatibility: {
          readonly api_version: number
          readonly runtime?: string
          readonly platforms: ReadonlyArray<string>
        }
        readonly signature: {
          readonly status: "unsigned" | "untrusted" | "verified" | "invalid"
          readonly algorithm?: "ed25519"
          readonly key_id?: string
          readonly signed_digest: string
          readonly reason?: string
        }
        readonly security: {
          readonly status: "passed" | "warning" | "blocked"
          readonly findings: ReadonlyArray<{
            readonly rule:
              | "forbidden-runtime-boundary"
              | "undeclared-egress"
              | "undeclared-secret"
              | "signature"
              | "scan-limit"
              | "unsafe-path"
            readonly severity: "info" | "warning" | "blocking"
            readonly path: string
            readonly message: string
          }>
          readonly scanned_files: number
          readonly scanned_bytes: number
        }
        readonly enabled: boolean
        readonly problems: ReadonlyArray<string>
        readonly managed: boolean
      }>
      readonly roots: ReadonlyArray<string>
    }
  }
}

export type AgentCapabilitiesPluginRestoreInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
  readonly recoveryID: { readonly recoveryID: string; readonly requestID?: string | undefined }["recoveryID"]
  readonly requestID?: { readonly recoveryID: string; readonly requestID?: string | undefined }["requestID"]
}

export type AgentCapabilitiesPluginRestoreOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly transaction: JsonValue
    readonly plugins: {
      readonly count: number
      readonly items: ReadonlyArray<{
        readonly name: string
        readonly version: string
        readonly description: string
        readonly hooks: ReadonlyArray<string>
        readonly tools: ReadonlyArray<{
          readonly name: string
          readonly description: string
          readonly parameters: JsonValue
        }>
        readonly manifest_path: string
        readonly entrypoint: string
        readonly source: "profile" | "workspace" | "external"
        readonly sha256: string
        readonly permissions: ReadonlyArray<{ readonly action: string; readonly resources: ReadonlyArray<string> }>
        readonly egress: ReadonlyArray<string>
        readonly secrets: ReadonlyArray<string>
        readonly compatibility: {
          readonly api_version: number
          readonly runtime?: string
          readonly platforms: ReadonlyArray<string>
        }
        readonly signature: {
          readonly status: "unsigned" | "untrusted" | "verified" | "invalid"
          readonly algorithm?: "ed25519"
          readonly key_id?: string
          readonly signed_digest: string
          readonly reason?: string
        }
        readonly security: {
          readonly status: "passed" | "warning" | "blocked"
          readonly findings: ReadonlyArray<{
            readonly rule:
              | "forbidden-runtime-boundary"
              | "undeclared-egress"
              | "undeclared-secret"
              | "signature"
              | "scan-limit"
              | "unsafe-path"
            readonly severity: "info" | "warning" | "blocking"
            readonly path: string
            readonly message: string
          }>
          readonly scanned_files: number
          readonly scanned_bytes: number
        }
        readonly enabled: boolean
        readonly problems: ReadonlyArray<string>
        readonly managed: boolean
      }>
      readonly roots: ReadonlyArray<string>
    }
  }
}

export type AgentCapabilitiesWorkflowListInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type AgentCapabilitiesWorkflowListOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly schema_version: 1
    readonly items: ReadonlyArray<{
      readonly path: string
      readonly valid: boolean
      readonly name?: string
      readonly description?: string
      readonly schema_version?: number
      readonly nodes?: number
      readonly edges?: number
      readonly has_approval?: boolean
      readonly error?: string
    }>
    readonly count: number
  }
}

export type AgentCapabilitiesWorkflowPreviewInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
  readonly path: { readonly path: string }["path"]
}

export type AgentCapabilitiesWorkflowPreviewOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly schema_version: number
    readonly name: string
    readonly source_path: string
    readonly success: boolean
    readonly dry_run: boolean
    readonly steps: ReadonlyArray<{
      readonly id: string
      readonly title: string
      readonly kind?: string
      readonly access?: string
      readonly max_attempts?: number
      readonly depends_on?: ReadonlyArray<string>
      readonly continue_on_error?: boolean
      readonly condition?: JsonValue
      readonly status: string
      readonly output: string
      readonly error: string
    }>
    readonly edges: ReadonlyArray<{ readonly from: string; readonly to: string }>
    readonly node_kinds: { readonly [x: string]: string }
  }
}

export type AgentCapabilitiesWorkflowRunListInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly sessionID?: string | undefined
    readonly limit?: number | undefined
  }["location"]
  readonly sessionID?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly sessionID?: string | undefined
    readonly limit?: number | undefined
  }["sessionID"]
  readonly limit?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly sessionID?: string | undefined
    readonly limit?: number | undefined
  }["limit"]
}

export type AgentCapabilitiesWorkflowRunListOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly schema_version: 1
    readonly items: ReadonlyArray<{
      readonly schema_version: 1
      readonly run_id: string
      readonly session_id: string
      readonly name: string
      readonly description: string
      readonly source_path: string
      readonly workspace: string
      readonly permission_mode: string
      readonly status: string
      readonly max_parallel: number
      readonly created_at: string
      readonly updated_at: string
      readonly started_at: string | null
      readonly finished_at: string | null
      readonly last_error: string
      readonly definition_digest?: string
      readonly budget?: {
        readonly max_attempts: number
        readonly reserved_attempts: number
        readonly used_attempts: number
        readonly max_duration_ms: number
      }
      readonly scheduling?: {
        readonly schema_version: number
        readonly request_digest: string
        readonly requested_max_parallel: number
        readonly effective_max_parallel: number
        readonly action: string
        readonly execute_mode: string
        readonly eligible: boolean
        readonly reasons: ReadonlyArray<string>
        readonly failed_checks: ReadonlyArray<string>
        readonly reason: string
        readonly decision_digest: string
        readonly evaluated_at: string
        readonly evidence_digest?: string
        readonly policy_revision?: string
      }
      readonly verification?: {
        readonly schema_version: 1
        readonly action_kind: "workflow"
        readonly action_version: "1"
        readonly passed: boolean
        readonly total: number
        readonly passed_count: number
        readonly failed_checks: ReadonlyArray<string>
        readonly evidence_digest: string
        readonly evaluated_at: string
      }
      readonly progress: {
        readonly settled: number
        readonly total: number
        readonly percent: number
        readonly by_status: { readonly [x: string]: number }
      }
      readonly nodes: ReadonlyArray<{
        readonly node_id: string
        readonly title: string
        readonly kind: string
        readonly access: string
        readonly status: string
        readonly attempt: number
        readonly max_attempts: number
        readonly depends_on: ReadonlyArray<string>
        readonly continue_on_error: boolean
        readonly condition: JsonValue
        readonly output: string
        readonly error: string
        readonly started_at: string | null
        readonly finished_at: string | null
        readonly budget_reserved_attempts?: number
        readonly child_run_id?: string
      }>
    }>
    readonly count: number
  }
}

export type AgentCapabilitiesWorkflowRunGetInput = {
  readonly runID: { readonly runID: string }["runID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type AgentCapabilitiesWorkflowRunGetOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly schema_version: 1
    readonly run_id: string
    readonly session_id: string
    readonly name: string
    readonly description: string
    readonly source_path: string
    readonly workspace: string
    readonly permission_mode: string
    readonly status: string
    readonly max_parallel: number
    readonly created_at: string
    readonly updated_at: string
    readonly started_at: string | null
    readonly finished_at: string | null
    readonly last_error: string
    readonly definition_digest?: string
    readonly budget?: {
      readonly max_attempts: number
      readonly reserved_attempts: number
      readonly used_attempts: number
      readonly max_duration_ms: number
    }
    readonly scheduling?: {
      readonly schema_version: number
      readonly request_digest: string
      readonly requested_max_parallel: number
      readonly effective_max_parallel: number
      readonly action: string
      readonly execute_mode: string
      readonly eligible: boolean
      readonly reasons: ReadonlyArray<string>
      readonly failed_checks: ReadonlyArray<string>
      readonly reason: string
      readonly decision_digest: string
      readonly evaluated_at: string
      readonly evidence_digest?: string
      readonly policy_revision?: string
    }
    readonly verification?: {
      readonly schema_version: 1
      readonly action_kind: "workflow"
      readonly action_version: "1"
      readonly passed: boolean
      readonly total: number
      readonly passed_count: number
      readonly failed_checks: ReadonlyArray<string>
      readonly evidence_digest: string
      readonly evaluated_at: string
    }
    readonly progress: {
      readonly settled: number
      readonly total: number
      readonly percent: number
      readonly by_status: { readonly [x: string]: number }
    }
    readonly nodes: ReadonlyArray<{
      readonly node_id: string
      readonly title: string
      readonly kind: string
      readonly access: string
      readonly status: string
      readonly attempt: number
      readonly max_attempts: number
      readonly depends_on: ReadonlyArray<string>
      readonly continue_on_error: boolean
      readonly condition: JsonValue
      readonly output: string
      readonly error: string
      readonly started_at: string | null
      readonly finished_at: string | null
      readonly budget_reserved_attempts?: number
      readonly child_run_id?: string
    }>
  }
}

export type AgentCapabilitiesWorkflowRunEventsInput = {
  readonly runID: { readonly runID: string }["runID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly after?: number | undefined
    readonly limit?: number | undefined
  }["location"]
  readonly after?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly after?: number | undefined
    readonly limit?: number | undefined
  }["after"]
  readonly limit?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly after?: number | undefined
    readonly limit?: number | undefined
  }["limit"]
}

export type AgentCapabilitiesWorkflowRunEventsOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly schema_version: 1
    readonly run_id: string
    readonly items: ReadonlyArray<{
      readonly sequence: number
      readonly type: string
      readonly node_id: string
      readonly data: JsonValue
      readonly created_at: string
    }>
    readonly count: number
    readonly next_after: number
  }
}

export type AgentCapabilitiesPlanPreviewInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
  readonly task: {
    readonly task: string
    readonly planText: string
    readonly exploredFiles?: ReadonlyArray<string> | undefined
    readonly estimatedSteps?: number | undefined
  }["task"]
  readonly planText: {
    readonly task: string
    readonly planText: string
    readonly exploredFiles?: ReadonlyArray<string> | undefined
    readonly estimatedSteps?: number | undefined
  }["planText"]
  readonly exploredFiles?: {
    readonly task: string
    readonly planText: string
    readonly exploredFiles?: ReadonlyArray<string> | undefined
    readonly estimatedSteps?: number | undefined
  }["exploredFiles"]
  readonly estimatedSteps?: {
    readonly task: string
    readonly planText: string
    readonly exploredFiles?: ReadonlyArray<string> | undefined
    readonly estimatedSteps?: number | undefined
  }["estimatedSteps"]
}

export type AgentCapabilitiesPlanPreviewOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly schema_version: 1
    readonly mode: "plan"
    readonly approval_required: boolean
    readonly execution_mode_after_approval: string
    readonly task: string
    readonly summary: string
    readonly affected_files: ReadonlyArray<string>
    readonly steps: ReadonlyArray<{ readonly index: number; readonly content: string; readonly status: string }>
    readonly risks: ReadonlyArray<string>
    readonly rollback: ReadonlyArray<string>
    readonly estimated_steps: number
    readonly raw_plan: string
  }
}

export type AgentCapabilitiesRunTraceExportInput = {
  readonly runID: { readonly runID: string }["runID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type AgentCapabilitiesRunTraceExportOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data:
    | {
        readonly format: "json"
        readonly mime_type: "application/json"
        readonly filename: ""
        readonly content: ""
        readonly trace_events: 0
        readonly found: false
      }
    | {
        readonly format: "json"
        readonly mime_type: "application/json"
        readonly filename: string
        readonly content: string
        readonly trace_events: number
      }
}

export type AgentCapabilitiesWorkflowStartInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
  readonly path: {
    readonly path: string
    readonly sessionID?: string | undefined
    readonly permissionMode?: "plan" | "acceptEdits" | "fullAccess" | undefined
    readonly maxParallel?: number | undefined
  }["path"]
  readonly sessionID?: {
    readonly path: string
    readonly sessionID?: string | undefined
    readonly permissionMode?: "plan" | "acceptEdits" | "fullAccess" | undefined
    readonly maxParallel?: number | undefined
  }["sessionID"]
  readonly permissionMode?: {
    readonly path: string
    readonly sessionID?: string | undefined
    readonly permissionMode?: "plan" | "acceptEdits" | "fullAccess" | undefined
    readonly maxParallel?: number | undefined
  }["permissionMode"]
  readonly maxParallel?: {
    readonly path: string
    readonly sessionID?: string | undefined
    readonly permissionMode?: "plan" | "acceptEdits" | "fullAccess" | undefined
    readonly maxParallel?: number | undefined
  }["maxParallel"]
}

export type AgentCapabilitiesWorkflowStartOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly schema_version: 1
    readonly run_id: string
    readonly session_id: string
    readonly name: string
    readonly description: string
    readonly source_path: string
    readonly workspace: string
    readonly permission_mode: string
    readonly status: string
    readonly max_parallel: number
    readonly created_at: string
    readonly updated_at: string
    readonly started_at: string | null
    readonly finished_at: string | null
    readonly last_error: string
    readonly definition_digest?: string
    readonly budget?: {
      readonly max_attempts: number
      readonly reserved_attempts: number
      readonly used_attempts: number
      readonly max_duration_ms: number
    }
    readonly scheduling?: {
      readonly schema_version: number
      readonly request_digest: string
      readonly requested_max_parallel: number
      readonly effective_max_parallel: number
      readonly action: string
      readonly execute_mode: string
      readonly eligible: boolean
      readonly reasons: ReadonlyArray<string>
      readonly failed_checks: ReadonlyArray<string>
      readonly reason: string
      readonly decision_digest: string
      readonly evaluated_at: string
      readonly evidence_digest?: string
      readonly policy_revision?: string
    }
    readonly verification?: {
      readonly schema_version: 1
      readonly action_kind: "workflow"
      readonly action_version: "1"
      readonly passed: boolean
      readonly total: number
      readonly passed_count: number
      readonly failed_checks: ReadonlyArray<string>
      readonly evidence_digest: string
      readonly evaluated_at: string
    }
    readonly progress: {
      readonly settled: number
      readonly total: number
      readonly percent: number
      readonly by_status: { readonly [x: string]: number }
    }
    readonly nodes: ReadonlyArray<{
      readonly node_id: string
      readonly title: string
      readonly kind: string
      readonly access: string
      readonly status: string
      readonly attempt: number
      readonly max_attempts: number
      readonly depends_on: ReadonlyArray<string>
      readonly continue_on_error: boolean
      readonly condition: JsonValue
      readonly output: string
      readonly error: string
      readonly started_at: string | null
      readonly finished_at: string | null
      readonly budget_reserved_attempts?: number
      readonly child_run_id?: string
    }>
  }
}

export type AgentCapabilitiesWorkflowControlInput = {
  readonly runID: { readonly runID: string }["runID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
  readonly action: { readonly action: "pause" | "resume" | "cancel" }["action"]
}

export type AgentCapabilitiesWorkflowControlOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly schema_version: 1
    readonly run_id: string
    readonly session_id: string
    readonly name: string
    readonly description: string
    readonly source_path: string
    readonly workspace: string
    readonly permission_mode: string
    readonly status: string
    readonly max_parallel: number
    readonly created_at: string
    readonly updated_at: string
    readonly started_at: string | null
    readonly finished_at: string | null
    readonly last_error: string
    readonly definition_digest?: string
    readonly budget?: {
      readonly max_attempts: number
      readonly reserved_attempts: number
      readonly used_attempts: number
      readonly max_duration_ms: number
    }
    readonly scheduling?: {
      readonly schema_version: number
      readonly request_digest: string
      readonly requested_max_parallel: number
      readonly effective_max_parallel: number
      readonly action: string
      readonly execute_mode: string
      readonly eligible: boolean
      readonly reasons: ReadonlyArray<string>
      readonly failed_checks: ReadonlyArray<string>
      readonly reason: string
      readonly decision_digest: string
      readonly evaluated_at: string
      readonly evidence_digest?: string
      readonly policy_revision?: string
    }
    readonly verification?: {
      readonly schema_version: 1
      readonly action_kind: "workflow"
      readonly action_version: "1"
      readonly passed: boolean
      readonly total: number
      readonly passed_count: number
      readonly failed_checks: ReadonlyArray<string>
      readonly evidence_digest: string
      readonly evaluated_at: string
    }
    readonly progress: {
      readonly settled: number
      readonly total: number
      readonly percent: number
      readonly by_status: { readonly [x: string]: number }
    }
    readonly nodes: ReadonlyArray<{
      readonly node_id: string
      readonly title: string
      readonly kind: string
      readonly access: string
      readonly status: string
      readonly attempt: number
      readonly max_attempts: number
      readonly depends_on: ReadonlyArray<string>
      readonly continue_on_error: boolean
      readonly condition: JsonValue
      readonly output: string
      readonly error: string
      readonly started_at: string | null
      readonly finished_at: string | null
      readonly budget_reserved_attempts?: number
      readonly child_run_id?: string
    }>
  }
}

export type AgentCapabilitiesWorkflowApproveInput = {
  readonly runID: { readonly runID: string }["runID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
  readonly nodeID: {
    readonly nodeID: string
    readonly approved: boolean
    readonly comment?: string | undefined
  }["nodeID"]
  readonly approved: {
    readonly nodeID: string
    readonly approved: boolean
    readonly comment?: string | undefined
  }["approved"]
  readonly comment?: {
    readonly nodeID: string
    readonly approved: boolean
    readonly comment?: string | undefined
  }["comment"]
}

export type AgentCapabilitiesWorkflowApproveOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly schema_version: 1
    readonly run_id: string
    readonly session_id: string
    readonly name: string
    readonly description: string
    readonly source_path: string
    readonly workspace: string
    readonly permission_mode: string
    readonly status: string
    readonly max_parallel: number
    readonly created_at: string
    readonly updated_at: string
    readonly started_at: string | null
    readonly finished_at: string | null
    readonly last_error: string
    readonly definition_digest?: string
    readonly budget?: {
      readonly max_attempts: number
      readonly reserved_attempts: number
      readonly used_attempts: number
      readonly max_duration_ms: number
    }
    readonly scheduling?: {
      readonly schema_version: number
      readonly request_digest: string
      readonly requested_max_parallel: number
      readonly effective_max_parallel: number
      readonly action: string
      readonly execute_mode: string
      readonly eligible: boolean
      readonly reasons: ReadonlyArray<string>
      readonly failed_checks: ReadonlyArray<string>
      readonly reason: string
      readonly decision_digest: string
      readonly evaluated_at: string
      readonly evidence_digest?: string
      readonly policy_revision?: string
    }
    readonly verification?: {
      readonly schema_version: 1
      readonly action_kind: "workflow"
      readonly action_version: "1"
      readonly passed: boolean
      readonly total: number
      readonly passed_count: number
      readonly failed_checks: ReadonlyArray<string>
      readonly evidence_digest: string
      readonly evaluated_at: string
    }
    readonly progress: {
      readonly settled: number
      readonly total: number
      readonly percent: number
      readonly by_status: { readonly [x: string]: number }
    }
    readonly nodes: ReadonlyArray<{
      readonly node_id: string
      readonly title: string
      readonly kind: string
      readonly access: string
      readonly status: string
      readonly attempt: number
      readonly max_attempts: number
      readonly depends_on: ReadonlyArray<string>
      readonly continue_on_error: boolean
      readonly condition: JsonValue
      readonly output: string
      readonly error: string
      readonly started_at: string | null
      readonly finished_at: string | null
      readonly budget_reserved_attempts?: number
      readonly child_run_id?: string
    }>
  }
}

export type AgentCapabilitiesWorkflowRetryInput = {
  readonly runID: { readonly runID: string }["runID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
  readonly nodeID: { readonly nodeID: string; readonly includeDescendants?: boolean | undefined }["nodeID"]
  readonly includeDescendants?: {
    readonly nodeID: string
    readonly includeDescendants?: boolean | undefined
  }["includeDescendants"]
}

export type AgentCapabilitiesWorkflowRetryOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly schema_version: 1
    readonly run_id: string
    readonly session_id: string
    readonly name: string
    readonly description: string
    readonly source_path: string
    readonly workspace: string
    readonly permission_mode: string
    readonly status: string
    readonly max_parallel: number
    readonly created_at: string
    readonly updated_at: string
    readonly started_at: string | null
    readonly finished_at: string | null
    readonly last_error: string
    readonly definition_digest?: string
    readonly budget?: {
      readonly max_attempts: number
      readonly reserved_attempts: number
      readonly used_attempts: number
      readonly max_duration_ms: number
    }
    readonly scheduling?: {
      readonly schema_version: number
      readonly request_digest: string
      readonly requested_max_parallel: number
      readonly effective_max_parallel: number
      readonly action: string
      readonly execute_mode: string
      readonly eligible: boolean
      readonly reasons: ReadonlyArray<string>
      readonly failed_checks: ReadonlyArray<string>
      readonly reason: string
      readonly decision_digest: string
      readonly evaluated_at: string
      readonly evidence_digest?: string
      readonly policy_revision?: string
    }
    readonly verification?: {
      readonly schema_version: 1
      readonly action_kind: "workflow"
      readonly action_version: "1"
      readonly passed: boolean
      readonly total: number
      readonly passed_count: number
      readonly failed_checks: ReadonlyArray<string>
      readonly evidence_digest: string
      readonly evaluated_at: string
    }
    readonly progress: {
      readonly settled: number
      readonly total: number
      readonly percent: number
      readonly by_status: { readonly [x: string]: number }
    }
    readonly nodes: ReadonlyArray<{
      readonly node_id: string
      readonly title: string
      readonly kind: string
      readonly access: string
      readonly status: string
      readonly attempt: number
      readonly max_attempts: number
      readonly depends_on: ReadonlyArray<string>
      readonly continue_on_error: boolean
      readonly condition: JsonValue
      readonly output: string
      readonly error: string
      readonly started_at: string | null
      readonly finished_at: string | null
      readonly budget_reserved_attempts?: number
      readonly child_run_id?: string
    }>
  }
}

export type AgentCapabilitiesEvolutionStatusInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type AgentCapabilitiesEvolutionStatusOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly schema_version: 1
    readonly counts: { readonly [x: string]: number }
    readonly total: number
    readonly active: number
    readonly constitution: {
      readonly version: string
      readonly allowed_targets: ReadonlyArray<string>
      readonly protected_prefixes: ReadonlyArray<string>
      readonly self_approval_allowed: false
      readonly source_mutation_allowed: false
    }
    readonly evolution_levels: {
      readonly version: string
      readonly levels: {
        readonly L0: {
          readonly level: "L0" | "L1" | "L2" | "L3" | "L4" | "L5"
          readonly capability: string
          readonly operations: ReadonlyArray<string>
          readonly executable: boolean
        }
        readonly L1: {
          readonly level: "L0" | "L1" | "L2" | "L3" | "L4" | "L5"
          readonly capability: string
          readonly operations: ReadonlyArray<string>
          readonly executable: boolean
        }
        readonly L2: {
          readonly level: "L0" | "L1" | "L2" | "L3" | "L4" | "L5"
          readonly capability: string
          readonly operations: ReadonlyArray<string>
          readonly executable: boolean
        }
        readonly L3: {
          readonly level: "L0" | "L1" | "L2" | "L3" | "L4" | "L5"
          readonly capability: string
          readonly operations: ReadonlyArray<string>
          readonly executable: boolean
        }
        readonly L4: {
          readonly level: "L0" | "L1" | "L2" | "L3" | "L4" | "L5"
          readonly capability: string
          readonly operations: ReadonlyArray<string>
          readonly executable: boolean
        }
        readonly L5: {
          readonly level: "L0" | "L1" | "L2" | "L3" | "L4" | "L5"
          readonly capability: string
          readonly operations: ReadonlyArray<string>
          readonly executable: boolean
        }
      }
    }
    readonly audit: {
      readonly schema_version: 1
      readonly valid: boolean
      readonly events: number
      readonly head_hash?: string
      readonly issue: string
    }
    readonly policy: {
      readonly min_auto_proposal_frequency: number
      readonly min_auto_proposal_confidence: number
      readonly min_canary_observations: number
      readonly min_control_observations: number
      readonly min_canary_success_rate: number
      readonly min_success_rate_delta: number
      readonly default_traffic_percent: number
      readonly auto_rollback_min_observations: number
      readonly auto_rollback_success_rate: number
      readonly max_active_candidates: number
    }
  }
}

export type AgentCapabilitiesEvolutionCandidatesInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly status?: string | undefined
    readonly limit?: number | undefined
  }["location"]
  readonly status?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly status?: string | undefined
    readonly limit?: number | undefined
  }["status"]
  readonly limit?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly status?: string | undefined
    readonly limit?: number | undefined
  }["limit"]
}

export type AgentCapabilitiesEvolutionCandidatesOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly schema_version: 1
    readonly count: number
    readonly items: ReadonlyArray<{
      readonly schema_version: 1
      readonly candidate_type: "strategy_rule"
      readonly title: string
      readonly target: "learning.failure" | "learning.fix" | "learning.preference" | "routing.advice" | "tool.advice"
      readonly instruction: string
      readonly rationale: string
      readonly evidence_refs: ReadonlyArray<string>
      readonly source_experience_ids: ReadonlyArray<string>
      readonly source_evidence_ids: ReadonlyArray<string>
      readonly source_evaluation_ids: ReadonlyArray<string>
      readonly source_provenance_digest: string
      readonly source_provenance_artifact: {
        readonly digest: string
        readonly record_digest: string
        readonly kind: "evolution-source-provenance"
        readonly uri: string
      } | null
      readonly capability_boundary: {
        readonly permission_requests: ReadonlyArray<string>
        readonly secret_refs: ReadonlyArray<string>
        readonly network_egress: ReadonlyArray<string>
      }
      readonly evaluation_budget: {
        readonly max_attempts: number
        readonly max_duration_ms: number
        readonly max_cost_micros: number
      }
      readonly baseline_digest: string
      readonly rollback_artifact: {
        readonly artifact_id: string
        readonly digest: string
        readonly plan_digest: string
        readonly operation: "deactivate_strategy_overlay"
      }
      readonly created_by: string
      readonly created_at: string
      readonly constitution_version: string
      readonly evolution_level: "L2"
      readonly candidate_id: string
      readonly artifact_digest: string
      readonly state: {
        readonly schema_version: 1
        readonly candidate_id: string
        readonly artifact_digest: string
        readonly status: "proposed" | "evaluated" | "approved" | "rejected" | "canary" | "promoted" | "rolled_back"
        readonly revision: number
        readonly updated_at: string
        readonly evaluation_id: string
        readonly approval: JsonValue
        readonly deployment: JsonValue
        readonly rollback: JsonValue
        readonly promotion_gate: {
          readonly schema_version: 1
          readonly candidate_id: string
          readonly candidate_digest: string
          readonly source_experience_ids: ReadonlyArray<string>
          readonly source_evidence_ids: ReadonlyArray<string>
          readonly source_evaluation_ids: ReadonlyArray<string>
          readonly source_provenance_digest: string
          readonly evaluation: {
            readonly id: string
            readonly baseline_digest: string
            readonly candidate_digest: string
            readonly report_digest: string
          }
          readonly approval_actor: string
          readonly canary: {
            readonly candidate_observations: number
            readonly control_observations: number
            readonly observation_ids: ReadonlyArray<string>
            readonly observation_digest: string
          }
          readonly rollback_artifact: {
            readonly artifact_id: string
            readonly digest: string
            readonly plan_digest: string
          }
          readonly policy: {
            readonly version: string
            readonly action_gateway_policy_version: string
            readonly digest: string
          }
          readonly checks: {
            readonly immutable_artifact_digest: boolean
            readonly source_experience_evidence: boolean
            readonly baseline_candidate_evaluation: boolean
            readonly safety_pass: boolean
            readonly permission_pass: boolean
            readonly secret_pass: boolean
            readonly egress_pass: boolean
            readonly budget_pass: boolean
            readonly human_actor_approval: boolean
            readonly canary_cohort_observations: boolean
            readonly no_unacceptable_regression: boolean
            readonly rollback_artifact_plan: boolean
            readonly current_policy_version: boolean
          }
          readonly gate_passed: true
          readonly gate_digest: string
        } | null
        readonly evolution_level: "L0" | "L2" | "L3" | "L4"
      }
      readonly evaluation?: {
        readonly schema_version: 1
        readonly candidate_id: string
        readonly candidate_digest: string
        readonly created_at: string
        readonly isolation: "temporary_directory"
        readonly workspace_retained: false
        readonly gate_passed: boolean
        readonly budget: {
          readonly max_attempts: number
          readonly attempts_used: number
          readonly max_duration_ms: number
          readonly duration_ms_used: number
          readonly max_cost_micros: number
          readonly cost_micros_used: number
          readonly passed: boolean
        }
        readonly cases: ReadonlyArray<{
          readonly case_id: string
          readonly category: string
          readonly passed: boolean
          readonly score: number
          readonly baseline_score: number
          readonly detail: string
          readonly required: boolean
        }>
        readonly evaluation_id: string
        readonly report_digest: string
      }
    }>
  }
}

export type AgentCapabilitiesEvolutionExposuresInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly status?: "pending" | "recorded" | undefined
    readonly limit?: number | undefined
  }["location"]
  readonly status?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly status?: "pending" | "recorded" | undefined
    readonly limit?: number | undefined
  }["status"]
  readonly limit?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly status?: "pending" | "recorded" | undefined
    readonly limit?: number | undefined
  }["limit"]
}

export type AgentCapabilitiesEvolutionExposuresOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly schema_version: 1
    readonly count: number
    readonly total: number
    readonly counts: { readonly pending: number; readonly recorded: number }
    readonly truncated: boolean
    readonly items: ReadonlyArray<{
      readonly schema_version: 1
      readonly exposure_id: string
      readonly created_at: string
      readonly cohort_key_digest: string
      readonly context_digest: string
      readonly injected_candidate_ids: ReadonlyArray<string>
      readonly assignments: ReadonlyArray<{
        readonly candidate_id: string
        readonly candidate_digest: string
        readonly cohort: "candidate" | "control"
      }>
      readonly status: "pending" | "recorded"
      readonly ticket_digest: string
      readonly receipt: {
        readonly receipt_digest: string
        readonly recorded_at: string
        readonly outcome: {
          readonly success: boolean
          readonly stop_reason: string
          readonly safety_incident: boolean
        } | null
        readonly observation_count: number
        readonly assistant_message_id?: string
      } | null
      readonly source?: {
        readonly kind: "session_turn"
        readonly authority: "typescript-core"
        readonly session_id: string
        readonly user_message_id: string
        readonly turn_step: number
      }
    }>
  }
}

export type AgentCapabilitiesEvolutionExposureArchivePreviewInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly keepRecorded?: number | undefined
  }["location"]
  readonly keepRecorded?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly keepRecorded?: number | undefined
  }["keepRecorded"]
}

export type AgentCapabilitiesEvolutionExposureArchivePreviewOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly schema_version: 1
    readonly archive_id: string
    readonly plan_digest: string
    readonly keep_recorded: number
    readonly eligible_count: number
    readonly counts: { readonly pending: number; readonly recorded: number; readonly retained_recorded: number }
    readonly truncated: boolean
    readonly items: ReadonlyArray<{
      readonly exposure_id: string
      readonly created_at: string
      readonly ticket_digest: string
      readonly receipt_digest: string
      readonly source?: {
        readonly kind: "session_turn"
        readonly authority: "typescript-core"
        readonly session_id: string
        readonly user_message_id: string
        readonly turn_step: number
      }
    }>
  }
}

export type AgentCapabilitiesEvolutionExposureArchiveApplyInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
  readonly keepRecorded: {
    readonly keepRecorded: number
    readonly expectedPlanDigest: string
    readonly reason: string
  }["keepRecorded"]
  readonly expectedPlanDigest: {
    readonly keepRecorded: number
    readonly expectedPlanDigest: string
    readonly reason: string
  }["expectedPlanDigest"]
  readonly reason: {
    readonly keepRecorded: number
    readonly expectedPlanDigest: string
    readonly reason: string
  }["reason"]
}

export type AgentCapabilitiesEvolutionExposureArchiveApplyOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly schema_version: 1
    readonly applied: boolean
    readonly archive_id: string
    readonly plan_digest: string
    readonly archived_count: number
    readonly completed_at: string
    readonly active_counts: { readonly pending: number; readonly recorded: number }
  }
}

export type AgentCapabilitiesEvolutionExposureArchivesInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly limit?: number | undefined
  }["location"]
  readonly limit?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly limit?: number | undefined
  }["limit"]
}

export type AgentCapabilitiesEvolutionExposureArchivesOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly schema_version: 1
    readonly count: number
    readonly total: number
    readonly valid_count: number
    readonly invalid_count: number
    readonly truncated: boolean
    readonly items: ReadonlyArray<{
      readonly schema_version: 1
      readonly archive_id: string
      readonly integrity: { readonly valid: boolean; readonly issue: string }
      readonly published_at: string
      readonly completed_at: string
      readonly archived_count: number
      readonly keep_recorded: number
      readonly plan_digest: "" | string
      readonly manifest_digest: "" | string
      readonly completion_digest: "" | string
      readonly evidence_set_digest: "" | string
      readonly restore: {
        readonly missing: number
        readonly identical: number
        readonly conflicts: number
        readonly can_restore: boolean
      }
    }>
  }
}

export type AgentCapabilitiesEvolutionExposureArchiveGetInput = {
  readonly archiveID: { readonly archiveID: string }["archiveID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly limit?: number | undefined
  }["location"]
  readonly limit?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly limit?: number | undefined
  }["limit"]
}

export type AgentCapabilitiesEvolutionExposureArchiveGetOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly schema_version: 1
    readonly archive_id: string
    readonly integrity: { readonly valid: boolean; readonly issue: string }
    readonly published_at: string
    readonly completed_at: string
    readonly archived_count: number
    readonly keep_recorded: number
    readonly plan_digest: "" | string
    readonly manifest_digest: "" | string
    readonly completion_digest: "" | string
    readonly evidence_set_digest: "" | string
    readonly restore: {
      readonly missing: number
      readonly identical: number
      readonly conflicts: number
      readonly can_restore: boolean
    }
    readonly count: number
    readonly truncated: boolean
    readonly capacity_exceeded: boolean
    readonly active_total: number
    readonly active_after: number
    readonly items: ReadonlyArray<{
      readonly exposure_id: string
      readonly created_at: string
      readonly ticket_digest: string
      readonly receipt_digest: string
      readonly ticket_file_digest: string
      readonly receipt_file_digest: string
      readonly live_status: "missing" | "identical" | "conflict"
      readonly source?: {
        readonly kind: "session_turn"
        readonly authority: "typescript-core"
        readonly session_id: string
        readonly user_message_id: string
        readonly turn_step: number
      }
    }>
  }
}

export type AgentCapabilitiesEvolutionExposureRestorePreviewInput = {
  readonly archiveID: { readonly archiveID: string }["archiveID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type AgentCapabilitiesEvolutionExposureRestorePreviewOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly schema_version: 1
    readonly restore_id: string
    readonly archive_id: string
    readonly plan_digest: string
    readonly manifest_digest: string
    readonly completion_digest: string
    readonly archived_count: number
    readonly counts: {
      readonly missing: number
      readonly already_present: number
      readonly conflicts: number
      readonly active_total: number
      readonly active_after: number
    }
    readonly capacity_exceeded: boolean
    readonly can_apply: boolean
    readonly truncated: boolean
    readonly items: ReadonlyArray<{
      readonly exposure_id: string
      readonly created_at: string
      readonly ticket_digest: string
      readonly receipt_digest: string
      readonly live_status: "missing" | "identical" | "conflict"
      readonly source?: {
        readonly kind: "session_turn"
        readonly authority: "typescript-core"
        readonly session_id: string
        readonly user_message_id: string
        readonly turn_step: number
      }
    }>
  }
}

export type AgentCapabilitiesEvolutionExposureRestoreApplyInput = {
  readonly archiveID: { readonly archiveID: string }["archiveID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
  readonly expectedPlanDigest: { readonly expectedPlanDigest: string; readonly reason: string }["expectedPlanDigest"]
  readonly reason: { readonly expectedPlanDigest: string; readonly reason: string }["reason"]
}

export type AgentCapabilitiesEvolutionExposureRestoreApplyOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly schema_version: 1
    readonly applied: boolean
    readonly restore_id: string
    readonly archive_id: string
    readonly plan_digest: string
    readonly restored_count: number
    readonly already_present_count: number
    readonly completed_at: string
    readonly active_counts: { readonly pending: number; readonly recorded: number }
  }
}

export type AgentCapabilitiesEvolutionExposureArchiveExportInput = {
  readonly archiveID: { readonly archiveID: string }["archiveID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type AgentCapabilitiesEvolutionExposureArchiveExportOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly schema_version: 1
    readonly filename: string
    readonly media_type: "application/json"
    readonly sha256: string
    readonly content: string
  }
}

export type AgentCapabilitiesEvolutionAuditEventsInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly limit?: number | undefined
    readonly beforeSequence?: number | undefined
  }["location"]
  readonly limit?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly limit?: number | undefined
    readonly beforeSequence?: number | undefined
  }["limit"]
  readonly beforeSequence?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly limit?: number | undefined
    readonly beforeSequence?: number | undefined
  }["beforeSequence"]
}

export type AgentCapabilitiesEvolutionAuditEventsOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly schema_version: 1
    readonly valid: true
    readonly head_hash: string
    readonly total: number
    readonly count: number
    readonly truncated: boolean
    readonly items: ReadonlyArray<{
      readonly schema_version: 1
      readonly sequence: number
      readonly recorded_at: string
      readonly subject_id: string
      readonly subject_kind: "candidate" | "archive" | "restore" | "exposure" | "system"
      readonly action: string
      readonly actor: string
      readonly reason: string
      readonly metadata: { readonly [x: string]: JsonValue }
      readonly previous_hash: string
      readonly record_hash: string
    }>
  }
}

export type AgentCapabilitiesEvolutionCandidateGetInput = {
  readonly candidateID: { readonly candidateID: string }["candidateID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type AgentCapabilitiesEvolutionCandidateGetOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly schema_version: 1
    readonly candidate_type: "strategy_rule"
    readonly title: string
    readonly target: "learning.failure" | "learning.fix" | "learning.preference" | "routing.advice" | "tool.advice"
    readonly instruction: string
    readonly rationale: string
    readonly evidence_refs: ReadonlyArray<string>
    readonly source_experience_ids: ReadonlyArray<string>
    readonly source_evidence_ids: ReadonlyArray<string>
    readonly source_evaluation_ids: ReadonlyArray<string>
    readonly source_provenance_digest: string
    readonly source_provenance_artifact: {
      readonly digest: string
      readonly record_digest: string
      readonly kind: "evolution-source-provenance"
      readonly uri: string
    } | null
    readonly capability_boundary: {
      readonly permission_requests: ReadonlyArray<string>
      readonly secret_refs: ReadonlyArray<string>
      readonly network_egress: ReadonlyArray<string>
    }
    readonly evaluation_budget: {
      readonly max_attempts: number
      readonly max_duration_ms: number
      readonly max_cost_micros: number
    }
    readonly baseline_digest: string
    readonly rollback_artifact: {
      readonly artifact_id: string
      readonly digest: string
      readonly plan_digest: string
      readonly operation: "deactivate_strategy_overlay"
    }
    readonly created_by: string
    readonly created_at: string
    readonly constitution_version: string
    readonly evolution_level: "L2"
    readonly candidate_id: string
    readonly artifact_digest: string
    readonly state: {
      readonly schema_version: 1
      readonly candidate_id: string
      readonly artifact_digest: string
      readonly status: "proposed" | "evaluated" | "approved" | "rejected" | "canary" | "promoted" | "rolled_back"
      readonly revision: number
      readonly updated_at: string
      readonly evaluation_id: string
      readonly approval: JsonValue
      readonly deployment: JsonValue
      readonly rollback: JsonValue
      readonly promotion_gate: {
        readonly schema_version: 1
        readonly candidate_id: string
        readonly candidate_digest: string
        readonly source_experience_ids: ReadonlyArray<string>
        readonly source_evidence_ids: ReadonlyArray<string>
        readonly source_evaluation_ids: ReadonlyArray<string>
        readonly source_provenance_digest: string
        readonly evaluation: {
          readonly id: string
          readonly baseline_digest: string
          readonly candidate_digest: string
          readonly report_digest: string
        }
        readonly approval_actor: string
        readonly canary: {
          readonly candidate_observations: number
          readonly control_observations: number
          readonly observation_ids: ReadonlyArray<string>
          readonly observation_digest: string
        }
        readonly rollback_artifact: {
          readonly artifact_id: string
          readonly digest: string
          readonly plan_digest: string
        }
        readonly policy: {
          readonly version: string
          readonly action_gateway_policy_version: string
          readonly digest: string
        }
        readonly checks: {
          readonly immutable_artifact_digest: boolean
          readonly source_experience_evidence: boolean
          readonly baseline_candidate_evaluation: boolean
          readonly safety_pass: boolean
          readonly permission_pass: boolean
          readonly secret_pass: boolean
          readonly egress_pass: boolean
          readonly budget_pass: boolean
          readonly human_actor_approval: boolean
          readonly canary_cohort_observations: boolean
          readonly no_unacceptable_regression: boolean
          readonly rollback_artifact_plan: boolean
          readonly current_policy_version: boolean
        }
        readonly gate_passed: true
        readonly gate_digest: string
      } | null
      readonly evolution_level: "L0" | "L2" | "L3" | "L4"
    }
    readonly evaluation?: {
      readonly schema_version: 1
      readonly candidate_id: string
      readonly candidate_digest: string
      readonly created_at: string
      readonly isolation: "temporary_directory"
      readonly workspace_retained: false
      readonly gate_passed: boolean
      readonly budget: {
        readonly max_attempts: number
        readonly attempts_used: number
        readonly max_duration_ms: number
        readonly duration_ms_used: number
        readonly max_cost_micros: number
        readonly cost_micros_used: number
        readonly passed: boolean
      }
      readonly cases: ReadonlyArray<{
        readonly case_id: string
        readonly category: string
        readonly passed: boolean
        readonly score: number
        readonly baseline_score: number
        readonly detail: string
        readonly required: boolean
      }>
      readonly evaluation_id: string
      readonly report_digest: string
    }
  }
}

export type AgentCapabilitiesEvolutionOpportunitiesInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly limit?: number | undefined
  }["location"]
  readonly limit?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly limit?: number | undefined
  }["limit"]
}

export type AgentCapabilitiesEvolutionOpportunitiesOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly schema_version: 1
    readonly count: number
    readonly items: ReadonlyArray<{
      readonly kind: string
      readonly source_ref: string
      readonly category: string
      readonly proposal_available: boolean
      readonly frequency?: number
      readonly confidence?: number
      readonly stop_reason?: string
      readonly count?: number
    }>
  }
}

export type AgentCapabilitiesEvolutionCreateInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
  readonly title: {
    readonly title: string
    readonly target: "learning.failure" | "learning.fix" | "learning.preference" | "routing.advice" | "tool.advice"
    readonly instruction: string
    readonly rationale: string
    readonly evidenceRefs: ReadonlyArray<string>
    readonly sourceExperienceIDs?: ReadonlyArray<string> | undefined
  }["title"]
  readonly target: {
    readonly title: string
    readonly target: "learning.failure" | "learning.fix" | "learning.preference" | "routing.advice" | "tool.advice"
    readonly instruction: string
    readonly rationale: string
    readonly evidenceRefs: ReadonlyArray<string>
    readonly sourceExperienceIDs?: ReadonlyArray<string> | undefined
  }["target"]
  readonly instruction: {
    readonly title: string
    readonly target: "learning.failure" | "learning.fix" | "learning.preference" | "routing.advice" | "tool.advice"
    readonly instruction: string
    readonly rationale: string
    readonly evidenceRefs: ReadonlyArray<string>
    readonly sourceExperienceIDs?: ReadonlyArray<string> | undefined
  }["instruction"]
  readonly rationale: {
    readonly title: string
    readonly target: "learning.failure" | "learning.fix" | "learning.preference" | "routing.advice" | "tool.advice"
    readonly instruction: string
    readonly rationale: string
    readonly evidenceRefs: ReadonlyArray<string>
    readonly sourceExperienceIDs?: ReadonlyArray<string> | undefined
  }["rationale"]
  readonly evidenceRefs: {
    readonly title: string
    readonly target: "learning.failure" | "learning.fix" | "learning.preference" | "routing.advice" | "tool.advice"
    readonly instruction: string
    readonly rationale: string
    readonly evidenceRefs: ReadonlyArray<string>
    readonly sourceExperienceIDs?: ReadonlyArray<string> | undefined
  }["evidenceRefs"]
  readonly sourceExperienceIDs?: {
    readonly title: string
    readonly target: "learning.failure" | "learning.fix" | "learning.preference" | "routing.advice" | "tool.advice"
    readonly instruction: string
    readonly rationale: string
    readonly evidenceRefs: ReadonlyArray<string>
    readonly sourceExperienceIDs?: ReadonlyArray<string> | undefined
  }["sourceExperienceIDs"]
}

export type AgentCapabilitiesEvolutionCreateOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly schema_version: 1
    readonly candidate_type: "strategy_rule"
    readonly title: string
    readonly target: "learning.failure" | "learning.fix" | "learning.preference" | "routing.advice" | "tool.advice"
    readonly instruction: string
    readonly rationale: string
    readonly evidence_refs: ReadonlyArray<string>
    readonly source_experience_ids: ReadonlyArray<string>
    readonly source_evidence_ids: ReadonlyArray<string>
    readonly source_evaluation_ids: ReadonlyArray<string>
    readonly source_provenance_digest: string
    readonly source_provenance_artifact: {
      readonly digest: string
      readonly record_digest: string
      readonly kind: "evolution-source-provenance"
      readonly uri: string
    } | null
    readonly capability_boundary: {
      readonly permission_requests: ReadonlyArray<string>
      readonly secret_refs: ReadonlyArray<string>
      readonly network_egress: ReadonlyArray<string>
    }
    readonly evaluation_budget: {
      readonly max_attempts: number
      readonly max_duration_ms: number
      readonly max_cost_micros: number
    }
    readonly baseline_digest: string
    readonly rollback_artifact: {
      readonly artifact_id: string
      readonly digest: string
      readonly plan_digest: string
      readonly operation: "deactivate_strategy_overlay"
    }
    readonly created_by: string
    readonly created_at: string
    readonly constitution_version: string
    readonly evolution_level: "L2"
    readonly candidate_id: string
    readonly artifact_digest: string
    readonly state: {
      readonly schema_version: 1
      readonly candidate_id: string
      readonly artifact_digest: string
      readonly status: "proposed" | "evaluated" | "approved" | "rejected" | "canary" | "promoted" | "rolled_back"
      readonly revision: number
      readonly updated_at: string
      readonly evaluation_id: string
      readonly approval: JsonValue
      readonly deployment: JsonValue
      readonly rollback: JsonValue
      readonly promotion_gate: {
        readonly schema_version: 1
        readonly candidate_id: string
        readonly candidate_digest: string
        readonly source_experience_ids: ReadonlyArray<string>
        readonly source_evidence_ids: ReadonlyArray<string>
        readonly source_evaluation_ids: ReadonlyArray<string>
        readonly source_provenance_digest: string
        readonly evaluation: {
          readonly id: string
          readonly baseline_digest: string
          readonly candidate_digest: string
          readonly report_digest: string
        }
        readonly approval_actor: string
        readonly canary: {
          readonly candidate_observations: number
          readonly control_observations: number
          readonly observation_ids: ReadonlyArray<string>
          readonly observation_digest: string
        }
        readonly rollback_artifact: {
          readonly artifact_id: string
          readonly digest: string
          readonly plan_digest: string
        }
        readonly policy: {
          readonly version: string
          readonly action_gateway_policy_version: string
          readonly digest: string
        }
        readonly checks: {
          readonly immutable_artifact_digest: boolean
          readonly source_experience_evidence: boolean
          readonly baseline_candidate_evaluation: boolean
          readonly safety_pass: boolean
          readonly permission_pass: boolean
          readonly secret_pass: boolean
          readonly egress_pass: boolean
          readonly budget_pass: boolean
          readonly human_actor_approval: boolean
          readonly canary_cohort_observations: boolean
          readonly no_unacceptable_regression: boolean
          readonly rollback_artifact_plan: boolean
          readonly current_policy_version: boolean
        }
        readonly gate_passed: true
        readonly gate_digest: string
      } | null
      readonly evolution_level: "L0" | "L2" | "L3" | "L4"
    }
    readonly evaluation?: {
      readonly schema_version: 1
      readonly candidate_id: string
      readonly candidate_digest: string
      readonly created_at: string
      readonly isolation: "temporary_directory"
      readonly workspace_retained: false
      readonly gate_passed: boolean
      readonly budget: {
        readonly max_attempts: number
        readonly attempts_used: number
        readonly max_duration_ms: number
        readonly duration_ms_used: number
        readonly max_cost_micros: number
        readonly cost_micros_used: number
        readonly passed: boolean
      }
      readonly cases: ReadonlyArray<{
        readonly case_id: string
        readonly category: string
        readonly passed: boolean
        readonly score: number
        readonly baseline_score: number
        readonly detail: string
        readonly required: boolean
      }>
      readonly evaluation_id: string
      readonly report_digest: string
    }
  }
}

export type AgentCapabilitiesEvolutionFromPatternInput = {
  readonly patternID: { readonly patternID: number }["patternID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type AgentCapabilitiesEvolutionFromPatternOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly schema_version: 1
    readonly candidate_type: "strategy_rule"
    readonly title: string
    readonly target: "learning.failure" | "learning.fix" | "learning.preference" | "routing.advice" | "tool.advice"
    readonly instruction: string
    readonly rationale: string
    readonly evidence_refs: ReadonlyArray<string>
    readonly source_experience_ids: ReadonlyArray<string>
    readonly source_evidence_ids: ReadonlyArray<string>
    readonly source_evaluation_ids: ReadonlyArray<string>
    readonly source_provenance_digest: string
    readonly source_provenance_artifact: {
      readonly digest: string
      readonly record_digest: string
      readonly kind: "evolution-source-provenance"
      readonly uri: string
    } | null
    readonly capability_boundary: {
      readonly permission_requests: ReadonlyArray<string>
      readonly secret_refs: ReadonlyArray<string>
      readonly network_egress: ReadonlyArray<string>
    }
    readonly evaluation_budget: {
      readonly max_attempts: number
      readonly max_duration_ms: number
      readonly max_cost_micros: number
    }
    readonly baseline_digest: string
    readonly rollback_artifact: {
      readonly artifact_id: string
      readonly digest: string
      readonly plan_digest: string
      readonly operation: "deactivate_strategy_overlay"
    }
    readonly created_by: string
    readonly created_at: string
    readonly constitution_version: string
    readonly evolution_level: "L2"
    readonly candidate_id: string
    readonly artifact_digest: string
    readonly state: {
      readonly schema_version: 1
      readonly candidate_id: string
      readonly artifact_digest: string
      readonly status: "proposed" | "evaluated" | "approved" | "rejected" | "canary" | "promoted" | "rolled_back"
      readonly revision: number
      readonly updated_at: string
      readonly evaluation_id: string
      readonly approval: JsonValue
      readonly deployment: JsonValue
      readonly rollback: JsonValue
      readonly promotion_gate: {
        readonly schema_version: 1
        readonly candidate_id: string
        readonly candidate_digest: string
        readonly source_experience_ids: ReadonlyArray<string>
        readonly source_evidence_ids: ReadonlyArray<string>
        readonly source_evaluation_ids: ReadonlyArray<string>
        readonly source_provenance_digest: string
        readonly evaluation: {
          readonly id: string
          readonly baseline_digest: string
          readonly candidate_digest: string
          readonly report_digest: string
        }
        readonly approval_actor: string
        readonly canary: {
          readonly candidate_observations: number
          readonly control_observations: number
          readonly observation_ids: ReadonlyArray<string>
          readonly observation_digest: string
        }
        readonly rollback_artifact: {
          readonly artifact_id: string
          readonly digest: string
          readonly plan_digest: string
        }
        readonly policy: {
          readonly version: string
          readonly action_gateway_policy_version: string
          readonly digest: string
        }
        readonly checks: {
          readonly immutable_artifact_digest: boolean
          readonly source_experience_evidence: boolean
          readonly baseline_candidate_evaluation: boolean
          readonly safety_pass: boolean
          readonly permission_pass: boolean
          readonly secret_pass: boolean
          readonly egress_pass: boolean
          readonly budget_pass: boolean
          readonly human_actor_approval: boolean
          readonly canary_cohort_observations: boolean
          readonly no_unacceptable_regression: boolean
          readonly rollback_artifact_plan: boolean
          readonly current_policy_version: boolean
        }
        readonly gate_passed: true
        readonly gate_digest: string
      } | null
      readonly evolution_level: "L0" | "L2" | "L3" | "L4"
    }
    readonly evaluation?: {
      readonly schema_version: 1
      readonly candidate_id: string
      readonly candidate_digest: string
      readonly created_at: string
      readonly isolation: "temporary_directory"
      readonly workspace_retained: false
      readonly gate_passed: boolean
      readonly budget: {
        readonly max_attempts: number
        readonly attempts_used: number
        readonly max_duration_ms: number
        readonly duration_ms_used: number
        readonly max_cost_micros: number
        readonly cost_micros_used: number
        readonly passed: boolean
      }
      readonly cases: ReadonlyArray<{
        readonly case_id: string
        readonly category: string
        readonly passed: boolean
        readonly score: number
        readonly baseline_score: number
        readonly detail: string
        readonly required: boolean
      }>
      readonly evaluation_id: string
      readonly report_digest: string
    }
  }
}

export type AgentCapabilitiesEvolutionTransitionInput = {
  readonly candidateID: { readonly candidateID: string }["candidateID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
  readonly action: {
    readonly action: "evaluate" | "approve" | "reject" | "startCanary" | "promote" | "rollback"
    readonly expectedRevision: number
    readonly reason?: string | undefined
    readonly trafficPercent?: number | undefined
  }["action"]
  readonly expectedRevision: {
    readonly action: "evaluate" | "approve" | "reject" | "startCanary" | "promote" | "rollback"
    readonly expectedRevision: number
    readonly reason?: string | undefined
    readonly trafficPercent?: number | undefined
  }["expectedRevision"]
  readonly reason?: {
    readonly action: "evaluate" | "approve" | "reject" | "startCanary" | "promote" | "rollback"
    readonly expectedRevision: number
    readonly reason?: string | undefined
    readonly trafficPercent?: number | undefined
  }["reason"]
  readonly trafficPercent?: {
    readonly action: "evaluate" | "approve" | "reject" | "startCanary" | "promote" | "rollback"
    readonly expectedRevision: number
    readonly reason?: string | undefined
    readonly trafficPercent?: number | undefined
  }["trafficPercent"]
}

export type AgentCapabilitiesEvolutionTransitionOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly schema_version: 1
    readonly candidate_type: "strategy_rule"
    readonly title: string
    readonly target: "learning.failure" | "learning.fix" | "learning.preference" | "routing.advice" | "tool.advice"
    readonly instruction: string
    readonly rationale: string
    readonly evidence_refs: ReadonlyArray<string>
    readonly source_experience_ids: ReadonlyArray<string>
    readonly source_evidence_ids: ReadonlyArray<string>
    readonly source_evaluation_ids: ReadonlyArray<string>
    readonly source_provenance_digest: string
    readonly source_provenance_artifact: {
      readonly digest: string
      readonly record_digest: string
      readonly kind: "evolution-source-provenance"
      readonly uri: string
    } | null
    readonly capability_boundary: {
      readonly permission_requests: ReadonlyArray<string>
      readonly secret_refs: ReadonlyArray<string>
      readonly network_egress: ReadonlyArray<string>
    }
    readonly evaluation_budget: {
      readonly max_attempts: number
      readonly max_duration_ms: number
      readonly max_cost_micros: number
    }
    readonly baseline_digest: string
    readonly rollback_artifact: {
      readonly artifact_id: string
      readonly digest: string
      readonly plan_digest: string
      readonly operation: "deactivate_strategy_overlay"
    }
    readonly created_by: string
    readonly created_at: string
    readonly constitution_version: string
    readonly evolution_level: "L2"
    readonly candidate_id: string
    readonly artifact_digest: string
    readonly state: {
      readonly schema_version: 1
      readonly candidate_id: string
      readonly artifact_digest: string
      readonly status: "proposed" | "evaluated" | "approved" | "rejected" | "canary" | "promoted" | "rolled_back"
      readonly revision: number
      readonly updated_at: string
      readonly evaluation_id: string
      readonly approval: JsonValue
      readonly deployment: JsonValue
      readonly rollback: JsonValue
      readonly promotion_gate: {
        readonly schema_version: 1
        readonly candidate_id: string
        readonly candidate_digest: string
        readonly source_experience_ids: ReadonlyArray<string>
        readonly source_evidence_ids: ReadonlyArray<string>
        readonly source_evaluation_ids: ReadonlyArray<string>
        readonly source_provenance_digest: string
        readonly evaluation: {
          readonly id: string
          readonly baseline_digest: string
          readonly candidate_digest: string
          readonly report_digest: string
        }
        readonly approval_actor: string
        readonly canary: {
          readonly candidate_observations: number
          readonly control_observations: number
          readonly observation_ids: ReadonlyArray<string>
          readonly observation_digest: string
        }
        readonly rollback_artifact: {
          readonly artifact_id: string
          readonly digest: string
          readonly plan_digest: string
        }
        readonly policy: {
          readonly version: string
          readonly action_gateway_policy_version: string
          readonly digest: string
        }
        readonly checks: {
          readonly immutable_artifact_digest: boolean
          readonly source_experience_evidence: boolean
          readonly baseline_candidate_evaluation: boolean
          readonly safety_pass: boolean
          readonly permission_pass: boolean
          readonly secret_pass: boolean
          readonly egress_pass: boolean
          readonly budget_pass: boolean
          readonly human_actor_approval: boolean
          readonly canary_cohort_observations: boolean
          readonly no_unacceptable_regression: boolean
          readonly rollback_artifact_plan: boolean
          readonly current_policy_version: boolean
        }
        readonly gate_passed: true
        readonly gate_digest: string
      } | null
      readonly evolution_level: "L0" | "L2" | "L3" | "L4"
    }
    readonly evaluation?: {
      readonly schema_version: 1
      readonly candidate_id: string
      readonly candidate_digest: string
      readonly created_at: string
      readonly isolation: "temporary_directory"
      readonly workspace_retained: false
      readonly gate_passed: boolean
      readonly budget: {
        readonly max_attempts: number
        readonly attempts_used: number
        readonly max_duration_ms: number
        readonly duration_ms_used: number
        readonly max_cost_micros: number
        readonly cost_micros_used: number
        readonly passed: boolean
      }
      readonly cases: ReadonlyArray<{
        readonly case_id: string
        readonly category: string
        readonly passed: boolean
        readonly score: number
        readonly baseline_score: number
        readonly detail: string
        readonly required: boolean
      }>
      readonly evaluation_id: string
      readonly report_digest: string
    }
  }
}

export type AgentCapabilitiesEvolutionCanaryReportInput = {
  readonly candidateID: { readonly candidateID: string }["candidateID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type AgentCapabilitiesEvolutionCanaryReportOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly schema_version: 1
    readonly candidate_id: string
    readonly candidate_digest: string
    readonly candidate_observations: number
    readonly control_observations: number
    readonly candidate_success_rate: number
    readonly control_success_rate: number
    readonly success_rate_delta: number
    readonly safety_incidents: number
    readonly control_safety_incidents: number
    readonly observation_ids: ReadonlyArray<string>
    readonly observation_digest: string
    readonly policy_version: string
    readonly policy_digest: string
    readonly checks: { readonly [x: string]: boolean }
    readonly gate_passed: boolean
  }
}

export type AgentCapabilitiesEvolutionContextPreviewInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
  readonly userInput: { readonly userInput: string; readonly cohortKey: string }["userInput"]
  readonly cohortKey: { readonly userInput: string; readonly cohortKey: string }["cohortKey"]
}

export type AgentCapabilitiesEvolutionContextPreviewOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly schema_version: 1
    readonly text: string
    readonly candidate_ids: ReadonlyArray<string>
    readonly cohorts: { readonly [x: string]: string }
  }
}

export type AgentCapabilitiesExperienceCandidateListInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly status?: "candidate" | "active" | "rejected" | "expired" | undefined
    readonly limit?: number | undefined
  }["location"]
  readonly status?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly status?: "candidate" | "active" | "rejected" | "expired" | undefined
    readonly limit?: number | undefined
  }["status"]
  readonly limit?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly status?: "candidate" | "active" | "rejected" | "expired" | undefined
    readonly limit?: number | undefined
  }["limit"]
}

export type AgentCapabilitiesExperienceCandidateListOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly schema_version: 1
    readonly count: number
    readonly items: ReadonlyArray<{
      readonly schema_version: 1
      readonly candidate_id: string
      readonly problem_signature: string
      readonly applicable_scope: string
      readonly conditions: ReadonlyArray<string>
      readonly attempted_strategy: string
      readonly counterexamples: ReadonlyArray<string>
      readonly support_count: number
      readonly source_run_ids: ReadonlyArray<string>
      readonly source_support_ids: ReadonlyArray<string>
      readonly evidence_ids: ReadonlyArray<string>
      readonly evaluation_digest: string | null
      readonly review_actor: string | null
      readonly review_reason: string | null
      readonly review_status: "pending" | "approved" | "rejected" | "expired"
      readonly status: "candidate" | "active" | "rejected" | "expired"
      readonly policy_version: string
      readonly expiry_at: number | null
      readonly digest: string
      readonly revision: number
      readonly created_by: string
      readonly created_at: string
      readonly updated_at: string
    }>
  }
}

export type AgentCapabilitiesExperienceCandidateGetInput = {
  readonly candidateID: { readonly candidateID: string }["candidateID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type AgentCapabilitiesExperienceCandidateGetOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly schema_version: 1
    readonly candidate_id: string
    readonly problem_signature: string
    readonly applicable_scope: string
    readonly conditions: ReadonlyArray<string>
    readonly attempted_strategy: string
    readonly counterexamples: ReadonlyArray<string>
    readonly support_count: number
    readonly source_run_ids: ReadonlyArray<string>
    readonly source_support_ids: ReadonlyArray<string>
    readonly evidence_ids: ReadonlyArray<string>
    readonly evaluation_digest: string | null
    readonly review_actor: string | null
    readonly review_reason: string | null
    readonly review_status: "pending" | "approved" | "rejected" | "expired"
    readonly status: "candidate" | "active" | "rejected" | "expired"
    readonly policy_version: string
    readonly expiry_at: number | null
    readonly digest: string
    readonly revision: number
    readonly created_by: string
    readonly created_at: string
    readonly updated_at: string
  }
}

export type AgentCapabilitiesExperienceCandidateReviewInput = {
  readonly candidateID: { readonly candidateID: string }["candidateID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
  readonly expectedRevision: {
    readonly expectedRevision: number
    readonly decision: "approve" | "reject"
    readonly reason: string
  }["expectedRevision"]
  readonly decision: {
    readonly expectedRevision: number
    readonly decision: "approve" | "reject"
    readonly reason: string
  }["decision"]
  readonly reason: {
    readonly expectedRevision: number
    readonly decision: "approve" | "reject"
    readonly reason: string
  }["reason"]
}

export type AgentCapabilitiesExperienceCandidateReviewOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly schema_version: 1
    readonly candidate: {
      readonly schema_version: 1
      readonly candidate_id: string
      readonly problem_signature: string
      readonly applicable_scope: string
      readonly conditions: ReadonlyArray<string>
      readonly attempted_strategy: string
      readonly counterexamples: ReadonlyArray<string>
      readonly support_count: number
      readonly source_run_ids: ReadonlyArray<string>
      readonly source_support_ids: ReadonlyArray<string>
      readonly evidence_ids: ReadonlyArray<string>
      readonly evaluation_digest: string | null
      readonly review_actor: string | null
      readonly review_reason: string | null
      readonly review_status: "pending" | "approved" | "rejected" | "expired"
      readonly status: "candidate" | "active" | "rejected" | "expired"
      readonly policy_version: string
      readonly expiry_at: number | null
      readonly digest: string
      readonly revision: number
      readonly created_by: string
      readonly created_at: string
      readonly updated_at: string
    }
    readonly experience_ids: ReadonlyArray<string>
    readonly receipt_digest: string
  }
}

export type AgentCapabilitiesExperienceSourceListInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly limit?: number | undefined
  }["location"]
  readonly limit?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly limit?: number | undefined
  }["limit"]
}

export type AgentCapabilitiesExperienceSourceListOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly schema_version: 1
    readonly count: number
    readonly items: ReadonlyArray<{
      readonly schema_version: 1
      readonly experience_id: string
      readonly candidate_id: string
      readonly summary: string
      readonly evidence_count: number
      readonly record_digest: string
      readonly policy_version: string
      readonly created_at: string
    }>
  }
}

export type AgentCapabilitiesSkillLifecycleCandidateListInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly skillID?: string | undefined
    readonly status?: "draft" | "candidate" | "canary" | "active" | "retired" | undefined
    readonly limit?: number | undefined
  }["location"]
  readonly skillID?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly skillID?: string | undefined
    readonly status?: "draft" | "candidate" | "canary" | "active" | "retired" | undefined
    readonly limit?: number | undefined
  }["skillID"]
  readonly status?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly skillID?: string | undefined
    readonly status?: "draft" | "candidate" | "canary" | "active" | "retired" | undefined
    readonly limit?: number | undefined
  }["status"]
  readonly limit?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly skillID?: string | undefined
    readonly status?: "draft" | "candidate" | "canary" | "active" | "retired" | undefined
    readonly limit?: number | undefined
  }["limit"]
}

export type AgentCapabilitiesSkillLifecycleCandidateListOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly schema_version: 1
    readonly count: number
    readonly items: ReadonlyArray<{
      readonly schema_version: 1
      readonly candidate_id: string
      readonly skill_id: string
      readonly version: string
      readonly digest: string
      readonly status: "draft" | "candidate" | "canary" | "active" | "retired"
      readonly purpose: string
      readonly triggers: ReadonlyArray<string>
      readonly allowed_tools: ReadonlyArray<string>
      readonly allowed_capabilities: ReadonlyArray<string>
      readonly source_experience_ids: ReadonlyArray<string>
      readonly source_evidence_ids: ReadonlyArray<string>
      readonly test_ids: ReadonlyArray<string>
      readonly evaluation_id: string
      readonly evaluation_digest: string | null
      readonly evaluation_passed: boolean | null
      readonly baseline_candidate_id: string | null
      readonly revision: number
      readonly created_by: string
      readonly review_actor: string | null
      readonly review_reason: string | null
      readonly traffic_percent: number | null
      readonly canary_digest: string | null
      readonly rollback_version: string | null
      readonly record_digest: string
      readonly created_at: string
      readonly updated_at: string
    }>
  }
}

export type AgentCapabilitiesSkillLifecycleCandidateGetInput = {
  readonly candidateID: { readonly candidateID: string }["candidateID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type AgentCapabilitiesSkillLifecycleCandidateGetOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly schema_version: 1
    readonly candidate: {
      readonly schema_version: 1
      readonly candidate_id: string
      readonly skill_id: string
      readonly version: string
      readonly digest: string
      readonly status: "draft" | "candidate" | "canary" | "active" | "retired"
      readonly purpose: string
      readonly triggers: ReadonlyArray<string>
      readonly allowed_tools: ReadonlyArray<string>
      readonly allowed_capabilities: ReadonlyArray<string>
      readonly source_experience_ids: ReadonlyArray<string>
      readonly source_evidence_ids: ReadonlyArray<string>
      readonly test_ids: ReadonlyArray<string>
      readonly evaluation_id: string
      readonly evaluation_digest: string | null
      readonly evaluation_passed: boolean | null
      readonly baseline_candidate_id: string | null
      readonly revision: number
      readonly created_by: string
      readonly review_actor: string | null
      readonly review_reason: string | null
      readonly traffic_percent: number | null
      readonly canary_digest: string | null
      readonly rollback_version: string | null
      readonly record_digest: string
      readonly created_at: string
      readonly updated_at: string
    }
    readonly evaluation: {
      readonly candidate_digest: string
      readonly baseline_digest: string
      readonly sample_size: number
      readonly utility_delta: number
      readonly regression_cases: ReadonlyArray<string>
      readonly new_failure_count: number
      readonly new_secret_findings: number
      readonly new_egress_attempts: number
      readonly checks: {
        readonly no_permission_expansion: boolean
        readonly no_new_secret: boolean
        readonly no_new_egress: boolean
        readonly no_regression: boolean
        readonly utility_non_regression: boolean
      }
      readonly passed: boolean
      readonly evidence_ids: ReadonlyArray<string>
    } | null
    readonly canary: {
      readonly observation_count: number
      readonly success_count: number
      readonly safety_incident_count: number
      readonly success_rate: number
      readonly minimum_observations: number
      readonly minimum_success_rate: number
      readonly promotion_ready: boolean
    }
  }
}

export type AgentCapabilitiesSkillLifecycleCandidateCreateInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
  readonly skillID: {
    readonly skillID: string
    readonly version: string
    readonly purpose: string
    readonly triggers: ReadonlyArray<string>
    readonly allowedTools: ReadonlyArray<string>
    readonly allowedCapabilities: ReadonlyArray<string>
    readonly inputSchema: { readonly [x: string]: unknown }
    readonly outputSchema: { readonly [x: string]: unknown }
    readonly instructions: string
    readonly assets?: ReadonlyArray<{ readonly path: string; readonly content: string }> | undefined
    readonly scripts?: ReadonlyArray<{ readonly path: string; readonly content: string }> | undefined
    readonly sourceExperienceIDs: ReadonlyArray<string>
    readonly testCases: ReadonlyArray<{
      readonly id: string
      readonly input: { readonly [x: string]: unknown }
      readonly expected: { readonly [x: string]: unknown }
    }>
    readonly policyVersion: string
  }["skillID"]
  readonly version: {
    readonly skillID: string
    readonly version: string
    readonly purpose: string
    readonly triggers: ReadonlyArray<string>
    readonly allowedTools: ReadonlyArray<string>
    readonly allowedCapabilities: ReadonlyArray<string>
    readonly inputSchema: { readonly [x: string]: unknown }
    readonly outputSchema: { readonly [x: string]: unknown }
    readonly instructions: string
    readonly assets?: ReadonlyArray<{ readonly path: string; readonly content: string }> | undefined
    readonly scripts?: ReadonlyArray<{ readonly path: string; readonly content: string }> | undefined
    readonly sourceExperienceIDs: ReadonlyArray<string>
    readonly testCases: ReadonlyArray<{
      readonly id: string
      readonly input: { readonly [x: string]: unknown }
      readonly expected: { readonly [x: string]: unknown }
    }>
    readonly policyVersion: string
  }["version"]
  readonly purpose: {
    readonly skillID: string
    readonly version: string
    readonly purpose: string
    readonly triggers: ReadonlyArray<string>
    readonly allowedTools: ReadonlyArray<string>
    readonly allowedCapabilities: ReadonlyArray<string>
    readonly inputSchema: { readonly [x: string]: unknown }
    readonly outputSchema: { readonly [x: string]: unknown }
    readonly instructions: string
    readonly assets?: ReadonlyArray<{ readonly path: string; readonly content: string }> | undefined
    readonly scripts?: ReadonlyArray<{ readonly path: string; readonly content: string }> | undefined
    readonly sourceExperienceIDs: ReadonlyArray<string>
    readonly testCases: ReadonlyArray<{
      readonly id: string
      readonly input: { readonly [x: string]: unknown }
      readonly expected: { readonly [x: string]: unknown }
    }>
    readonly policyVersion: string
  }["purpose"]
  readonly triggers: {
    readonly skillID: string
    readonly version: string
    readonly purpose: string
    readonly triggers: ReadonlyArray<string>
    readonly allowedTools: ReadonlyArray<string>
    readonly allowedCapabilities: ReadonlyArray<string>
    readonly inputSchema: { readonly [x: string]: unknown }
    readonly outputSchema: { readonly [x: string]: unknown }
    readonly instructions: string
    readonly assets?: ReadonlyArray<{ readonly path: string; readonly content: string }> | undefined
    readonly scripts?: ReadonlyArray<{ readonly path: string; readonly content: string }> | undefined
    readonly sourceExperienceIDs: ReadonlyArray<string>
    readonly testCases: ReadonlyArray<{
      readonly id: string
      readonly input: { readonly [x: string]: unknown }
      readonly expected: { readonly [x: string]: unknown }
    }>
    readonly policyVersion: string
  }["triggers"]
  readonly allowedTools: {
    readonly skillID: string
    readonly version: string
    readonly purpose: string
    readonly triggers: ReadonlyArray<string>
    readonly allowedTools: ReadonlyArray<string>
    readonly allowedCapabilities: ReadonlyArray<string>
    readonly inputSchema: { readonly [x: string]: unknown }
    readonly outputSchema: { readonly [x: string]: unknown }
    readonly instructions: string
    readonly assets?: ReadonlyArray<{ readonly path: string; readonly content: string }> | undefined
    readonly scripts?: ReadonlyArray<{ readonly path: string; readonly content: string }> | undefined
    readonly sourceExperienceIDs: ReadonlyArray<string>
    readonly testCases: ReadonlyArray<{
      readonly id: string
      readonly input: { readonly [x: string]: unknown }
      readonly expected: { readonly [x: string]: unknown }
    }>
    readonly policyVersion: string
  }["allowedTools"]
  readonly allowedCapabilities: {
    readonly skillID: string
    readonly version: string
    readonly purpose: string
    readonly triggers: ReadonlyArray<string>
    readonly allowedTools: ReadonlyArray<string>
    readonly allowedCapabilities: ReadonlyArray<string>
    readonly inputSchema: { readonly [x: string]: unknown }
    readonly outputSchema: { readonly [x: string]: unknown }
    readonly instructions: string
    readonly assets?: ReadonlyArray<{ readonly path: string; readonly content: string }> | undefined
    readonly scripts?: ReadonlyArray<{ readonly path: string; readonly content: string }> | undefined
    readonly sourceExperienceIDs: ReadonlyArray<string>
    readonly testCases: ReadonlyArray<{
      readonly id: string
      readonly input: { readonly [x: string]: unknown }
      readonly expected: { readonly [x: string]: unknown }
    }>
    readonly policyVersion: string
  }["allowedCapabilities"]
  readonly inputSchema: {
    readonly skillID: string
    readonly version: string
    readonly purpose: string
    readonly triggers: ReadonlyArray<string>
    readonly allowedTools: ReadonlyArray<string>
    readonly allowedCapabilities: ReadonlyArray<string>
    readonly inputSchema: { readonly [x: string]: unknown }
    readonly outputSchema: { readonly [x: string]: unknown }
    readonly instructions: string
    readonly assets?: ReadonlyArray<{ readonly path: string; readonly content: string }> | undefined
    readonly scripts?: ReadonlyArray<{ readonly path: string; readonly content: string }> | undefined
    readonly sourceExperienceIDs: ReadonlyArray<string>
    readonly testCases: ReadonlyArray<{
      readonly id: string
      readonly input: { readonly [x: string]: unknown }
      readonly expected: { readonly [x: string]: unknown }
    }>
    readonly policyVersion: string
  }["inputSchema"]
  readonly outputSchema: {
    readonly skillID: string
    readonly version: string
    readonly purpose: string
    readonly triggers: ReadonlyArray<string>
    readonly allowedTools: ReadonlyArray<string>
    readonly allowedCapabilities: ReadonlyArray<string>
    readonly inputSchema: { readonly [x: string]: unknown }
    readonly outputSchema: { readonly [x: string]: unknown }
    readonly instructions: string
    readonly assets?: ReadonlyArray<{ readonly path: string; readonly content: string }> | undefined
    readonly scripts?: ReadonlyArray<{ readonly path: string; readonly content: string }> | undefined
    readonly sourceExperienceIDs: ReadonlyArray<string>
    readonly testCases: ReadonlyArray<{
      readonly id: string
      readonly input: { readonly [x: string]: unknown }
      readonly expected: { readonly [x: string]: unknown }
    }>
    readonly policyVersion: string
  }["outputSchema"]
  readonly instructions: {
    readonly skillID: string
    readonly version: string
    readonly purpose: string
    readonly triggers: ReadonlyArray<string>
    readonly allowedTools: ReadonlyArray<string>
    readonly allowedCapabilities: ReadonlyArray<string>
    readonly inputSchema: { readonly [x: string]: unknown }
    readonly outputSchema: { readonly [x: string]: unknown }
    readonly instructions: string
    readonly assets?: ReadonlyArray<{ readonly path: string; readonly content: string }> | undefined
    readonly scripts?: ReadonlyArray<{ readonly path: string; readonly content: string }> | undefined
    readonly sourceExperienceIDs: ReadonlyArray<string>
    readonly testCases: ReadonlyArray<{
      readonly id: string
      readonly input: { readonly [x: string]: unknown }
      readonly expected: { readonly [x: string]: unknown }
    }>
    readonly policyVersion: string
  }["instructions"]
  readonly assets?: {
    readonly skillID: string
    readonly version: string
    readonly purpose: string
    readonly triggers: ReadonlyArray<string>
    readonly allowedTools: ReadonlyArray<string>
    readonly allowedCapabilities: ReadonlyArray<string>
    readonly inputSchema: { readonly [x: string]: unknown }
    readonly outputSchema: { readonly [x: string]: unknown }
    readonly instructions: string
    readonly assets?: ReadonlyArray<{ readonly path: string; readonly content: string }> | undefined
    readonly scripts?: ReadonlyArray<{ readonly path: string; readonly content: string }> | undefined
    readonly sourceExperienceIDs: ReadonlyArray<string>
    readonly testCases: ReadonlyArray<{
      readonly id: string
      readonly input: { readonly [x: string]: unknown }
      readonly expected: { readonly [x: string]: unknown }
    }>
    readonly policyVersion: string
  }["assets"]
  readonly scripts?: {
    readonly skillID: string
    readonly version: string
    readonly purpose: string
    readonly triggers: ReadonlyArray<string>
    readonly allowedTools: ReadonlyArray<string>
    readonly allowedCapabilities: ReadonlyArray<string>
    readonly inputSchema: { readonly [x: string]: unknown }
    readonly outputSchema: { readonly [x: string]: unknown }
    readonly instructions: string
    readonly assets?: ReadonlyArray<{ readonly path: string; readonly content: string }> | undefined
    readonly scripts?: ReadonlyArray<{ readonly path: string; readonly content: string }> | undefined
    readonly sourceExperienceIDs: ReadonlyArray<string>
    readonly testCases: ReadonlyArray<{
      readonly id: string
      readonly input: { readonly [x: string]: unknown }
      readonly expected: { readonly [x: string]: unknown }
    }>
    readonly policyVersion: string
  }["scripts"]
  readonly sourceExperienceIDs: {
    readonly skillID: string
    readonly version: string
    readonly purpose: string
    readonly triggers: ReadonlyArray<string>
    readonly allowedTools: ReadonlyArray<string>
    readonly allowedCapabilities: ReadonlyArray<string>
    readonly inputSchema: { readonly [x: string]: unknown }
    readonly outputSchema: { readonly [x: string]: unknown }
    readonly instructions: string
    readonly assets?: ReadonlyArray<{ readonly path: string; readonly content: string }> | undefined
    readonly scripts?: ReadonlyArray<{ readonly path: string; readonly content: string }> | undefined
    readonly sourceExperienceIDs: ReadonlyArray<string>
    readonly testCases: ReadonlyArray<{
      readonly id: string
      readonly input: { readonly [x: string]: unknown }
      readonly expected: { readonly [x: string]: unknown }
    }>
    readonly policyVersion: string
  }["sourceExperienceIDs"]
  readonly testCases: {
    readonly skillID: string
    readonly version: string
    readonly purpose: string
    readonly triggers: ReadonlyArray<string>
    readonly allowedTools: ReadonlyArray<string>
    readonly allowedCapabilities: ReadonlyArray<string>
    readonly inputSchema: { readonly [x: string]: unknown }
    readonly outputSchema: { readonly [x: string]: unknown }
    readonly instructions: string
    readonly assets?: ReadonlyArray<{ readonly path: string; readonly content: string }> | undefined
    readonly scripts?: ReadonlyArray<{ readonly path: string; readonly content: string }> | undefined
    readonly sourceExperienceIDs: ReadonlyArray<string>
    readonly testCases: ReadonlyArray<{
      readonly id: string
      readonly input: { readonly [x: string]: unknown }
      readonly expected: { readonly [x: string]: unknown }
    }>
    readonly policyVersion: string
  }["testCases"]
  readonly policyVersion: {
    readonly skillID: string
    readonly version: string
    readonly purpose: string
    readonly triggers: ReadonlyArray<string>
    readonly allowedTools: ReadonlyArray<string>
    readonly allowedCapabilities: ReadonlyArray<string>
    readonly inputSchema: { readonly [x: string]: unknown }
    readonly outputSchema: { readonly [x: string]: unknown }
    readonly instructions: string
    readonly assets?: ReadonlyArray<{ readonly path: string; readonly content: string }> | undefined
    readonly scripts?: ReadonlyArray<{ readonly path: string; readonly content: string }> | undefined
    readonly sourceExperienceIDs: ReadonlyArray<string>
    readonly testCases: ReadonlyArray<{
      readonly id: string
      readonly input: { readonly [x: string]: unknown }
      readonly expected: { readonly [x: string]: unknown }
    }>
    readonly policyVersion: string
  }["policyVersion"]
}

export type AgentCapabilitiesSkillLifecycleCandidateCreateOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly schema_version: 1
    readonly candidate_id: string
    readonly skill_id: string
    readonly version: string
    readonly digest: string
    readonly status: "draft" | "candidate" | "canary" | "active" | "retired"
    readonly purpose: string
    readonly triggers: ReadonlyArray<string>
    readonly allowed_tools: ReadonlyArray<string>
    readonly allowed_capabilities: ReadonlyArray<string>
    readonly source_experience_ids: ReadonlyArray<string>
    readonly source_evidence_ids: ReadonlyArray<string>
    readonly test_ids: ReadonlyArray<string>
    readonly evaluation_id: string
    readonly evaluation_digest: string | null
    readonly evaluation_passed: boolean | null
    readonly baseline_candidate_id: string | null
    readonly revision: number
    readonly created_by: string
    readonly review_actor: string | null
    readonly review_reason: string | null
    readonly traffic_percent: number | null
    readonly canary_digest: string | null
    readonly rollback_version: string | null
    readonly record_digest: string
    readonly created_at: string
    readonly updated_at: string
  }
}

export type AgentCapabilitiesSkillLifecycleEvaluateInput = {
  readonly candidateID: { readonly candidateID: string }["candidateID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
  readonly expectedRevision: {
    readonly expectedRevision: number
    readonly observations: ReadonlyArray<{
      readonly caseID: string
      readonly baseline: {
        readonly success: boolean
        readonly steps: number
        readonly tokens: number
        readonly costMinor: number
        readonly newFailures: number
        readonly newSecretFindings: number
        readonly newEgressAttempts: number
      }
      readonly candidate: {
        readonly success: boolean
        readonly steps: number
        readonly tokens: number
        readonly costMinor: number
        readonly newFailures: number
        readonly newSecretFindings: number
        readonly newEgressAttempts: number
      }
      readonly evidenceIDs: ReadonlyArray<string>
    }>
  }["expectedRevision"]
  readonly observations: {
    readonly expectedRevision: number
    readonly observations: ReadonlyArray<{
      readonly caseID: string
      readonly baseline: {
        readonly success: boolean
        readonly steps: number
        readonly tokens: number
        readonly costMinor: number
        readonly newFailures: number
        readonly newSecretFindings: number
        readonly newEgressAttempts: number
      }
      readonly candidate: {
        readonly success: boolean
        readonly steps: number
        readonly tokens: number
        readonly costMinor: number
        readonly newFailures: number
        readonly newSecretFindings: number
        readonly newEgressAttempts: number
      }
      readonly evidenceIDs: ReadonlyArray<string>
    }>
  }["observations"]
}

export type AgentCapabilitiesSkillLifecycleEvaluateOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly schema_version: 1
    readonly candidate: {
      readonly schema_version: 1
      readonly candidate_id: string
      readonly skill_id: string
      readonly version: string
      readonly digest: string
      readonly status: "draft" | "candidate" | "canary" | "active" | "retired"
      readonly purpose: string
      readonly triggers: ReadonlyArray<string>
      readonly allowed_tools: ReadonlyArray<string>
      readonly allowed_capabilities: ReadonlyArray<string>
      readonly source_experience_ids: ReadonlyArray<string>
      readonly source_evidence_ids: ReadonlyArray<string>
      readonly test_ids: ReadonlyArray<string>
      readonly evaluation_id: string
      readonly evaluation_digest: string | null
      readonly evaluation_passed: boolean | null
      readonly baseline_candidate_id: string | null
      readonly revision: number
      readonly created_by: string
      readonly review_actor: string | null
      readonly review_reason: string | null
      readonly traffic_percent: number | null
      readonly canary_digest: string | null
      readonly rollback_version: string | null
      readonly record_digest: string
      readonly created_at: string
      readonly updated_at: string
    }
    readonly report: {
      readonly candidate_digest: string
      readonly baseline_digest: string
      readonly sample_size: number
      readonly utility_delta: number
      readonly regression_cases: ReadonlyArray<string>
      readonly new_failure_count: number
      readonly new_secret_findings: number
      readonly new_egress_attempts: number
      readonly checks: {
        readonly no_permission_expansion: boolean
        readonly no_new_secret: boolean
        readonly no_new_egress: boolean
        readonly no_regression: boolean
        readonly utility_non_regression: boolean
      }
      readonly passed: boolean
      readonly evidence_ids: ReadonlyArray<string>
    }
  }
}

export type AgentCapabilitiesSkillLifecycleCanaryObservationInput = {
  readonly candidateID: { readonly candidateID: string }["candidateID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
  readonly expectedRevision: {
    readonly expectedRevision: number
    readonly idempotencyKey: string
    readonly cohortKey: string
    readonly runID: string
    readonly evaluationID: string
    readonly evidenceIDs: ReadonlyArray<string>
    readonly success: boolean
    readonly safetyIncident: boolean
  }["expectedRevision"]
  readonly idempotencyKey: {
    readonly expectedRevision: number
    readonly idempotencyKey: string
    readonly cohortKey: string
    readonly runID: string
    readonly evaluationID: string
    readonly evidenceIDs: ReadonlyArray<string>
    readonly success: boolean
    readonly safetyIncident: boolean
  }["idempotencyKey"]
  readonly cohortKey: {
    readonly expectedRevision: number
    readonly idempotencyKey: string
    readonly cohortKey: string
    readonly runID: string
    readonly evaluationID: string
    readonly evidenceIDs: ReadonlyArray<string>
    readonly success: boolean
    readonly safetyIncident: boolean
  }["cohortKey"]
  readonly runID: {
    readonly expectedRevision: number
    readonly idempotencyKey: string
    readonly cohortKey: string
    readonly runID: string
    readonly evaluationID: string
    readonly evidenceIDs: ReadonlyArray<string>
    readonly success: boolean
    readonly safetyIncident: boolean
  }["runID"]
  readonly evaluationID: {
    readonly expectedRevision: number
    readonly idempotencyKey: string
    readonly cohortKey: string
    readonly runID: string
    readonly evaluationID: string
    readonly evidenceIDs: ReadonlyArray<string>
    readonly success: boolean
    readonly safetyIncident: boolean
  }["evaluationID"]
  readonly evidenceIDs: {
    readonly expectedRevision: number
    readonly idempotencyKey: string
    readonly cohortKey: string
    readonly runID: string
    readonly evaluationID: string
    readonly evidenceIDs: ReadonlyArray<string>
    readonly success: boolean
    readonly safetyIncident: boolean
  }["evidenceIDs"]
  readonly success: {
    readonly expectedRevision: number
    readonly idempotencyKey: string
    readonly cohortKey: string
    readonly runID: string
    readonly evaluationID: string
    readonly evidenceIDs: ReadonlyArray<string>
    readonly success: boolean
    readonly safetyIncident: boolean
  }["success"]
  readonly safetyIncident: {
    readonly expectedRevision: number
    readonly idempotencyKey: string
    readonly cohortKey: string
    readonly runID: string
    readonly evaluationID: string
    readonly evidenceIDs: ReadonlyArray<string>
    readonly success: boolean
    readonly safetyIncident: boolean
  }["safetyIncident"]
}

export type AgentCapabilitiesSkillLifecycleCanaryObservationOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly schema_version: 1
    readonly candidate: {
      readonly schema_version: 1
      readonly candidate_id: string
      readonly skill_id: string
      readonly version: string
      readonly digest: string
      readonly status: "draft" | "candidate" | "canary" | "active" | "retired"
      readonly purpose: string
      readonly triggers: ReadonlyArray<string>
      readonly allowed_tools: ReadonlyArray<string>
      readonly allowed_capabilities: ReadonlyArray<string>
      readonly source_experience_ids: ReadonlyArray<string>
      readonly source_evidence_ids: ReadonlyArray<string>
      readonly test_ids: ReadonlyArray<string>
      readonly evaluation_id: string
      readonly evaluation_digest: string | null
      readonly evaluation_passed: boolean | null
      readonly baseline_candidate_id: string | null
      readonly revision: number
      readonly created_by: string
      readonly review_actor: string | null
      readonly review_reason: string | null
      readonly traffic_percent: number | null
      readonly canary_digest: string | null
      readonly rollback_version: string | null
      readonly record_digest: string
      readonly created_at: string
      readonly updated_at: string
    }
    readonly observation_id: string
    readonly replayed: boolean
  }
}

export type AgentCapabilitiesSkillLifecycleCanaryStartInput = {
  readonly candidateID: { readonly candidateID: string }["candidateID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
  readonly expectedRevision: {
    readonly expectedRevision: number
    readonly trafficPercent: number
    readonly reason: string
  }["expectedRevision"]
  readonly trafficPercent: {
    readonly expectedRevision: number
    readonly trafficPercent: number
    readonly reason: string
  }["trafficPercent"]
  readonly reason: {
    readonly expectedRevision: number
    readonly trafficPercent: number
    readonly reason: string
  }["reason"]
}

export type AgentCapabilitiesSkillLifecycleCanaryStartOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly schema_version: 1
    readonly candidate_id: string
    readonly skill_id: string
    readonly version: string
    readonly digest: string
    readonly status: "draft" | "candidate" | "canary" | "active" | "retired"
    readonly purpose: string
    readonly triggers: ReadonlyArray<string>
    readonly allowed_tools: ReadonlyArray<string>
    readonly allowed_capabilities: ReadonlyArray<string>
    readonly source_experience_ids: ReadonlyArray<string>
    readonly source_evidence_ids: ReadonlyArray<string>
    readonly test_ids: ReadonlyArray<string>
    readonly evaluation_id: string
    readonly evaluation_digest: string | null
    readonly evaluation_passed: boolean | null
    readonly baseline_candidate_id: string | null
    readonly revision: number
    readonly created_by: string
    readonly review_actor: string | null
    readonly review_reason: string | null
    readonly traffic_percent: number | null
    readonly canary_digest: string | null
    readonly rollback_version: string | null
    readonly record_digest: string
    readonly created_at: string
    readonly updated_at: string
  }
}

export type AgentCapabilitiesSkillLifecyclePromoteInput = {
  readonly candidateID: { readonly candidateID: string }["candidateID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
  readonly expectedRevision: { readonly expectedRevision: number; readonly reason: string }["expectedRevision"]
  readonly reason: { readonly expectedRevision: number; readonly reason: string }["reason"]
}

export type AgentCapabilitiesSkillLifecyclePromoteOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly schema_version: 1
    readonly candidate: {
      readonly schema_version: 1
      readonly candidate_id: string
      readonly skill_id: string
      readonly version: string
      readonly digest: string
      readonly status: "draft" | "candidate" | "canary" | "active" | "retired"
      readonly purpose: string
      readonly triggers: ReadonlyArray<string>
      readonly allowed_tools: ReadonlyArray<string>
      readonly allowed_capabilities: ReadonlyArray<string>
      readonly source_experience_ids: ReadonlyArray<string>
      readonly source_evidence_ids: ReadonlyArray<string>
      readonly test_ids: ReadonlyArray<string>
      readonly evaluation_id: string
      readonly evaluation_digest: string | null
      readonly evaluation_passed: boolean | null
      readonly baseline_candidate_id: string | null
      readonly revision: number
      readonly created_by: string
      readonly review_actor: string | null
      readonly review_reason: string | null
      readonly traffic_percent: number | null
      readonly canary_digest: string | null
      readonly rollback_version: string | null
      readonly record_digest: string
      readonly created_at: string
      readonly updated_at: string
    }
    readonly deployment: {
      readonly schema_version: 1
      readonly skill_id: string
      readonly active_candidate_id: string
      readonly previous_candidate_id: string | null
      readonly generation: number
      readonly digest: string
    }
    readonly receipt_digest: string
  }
}

export type AgentCapabilitiesSkillLifecycleRollbackInput = {
  readonly candidateID: { readonly candidateID: string }["candidateID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
  readonly expectedRevision: { readonly expectedRevision: number; readonly reason: string }["expectedRevision"]
  readonly reason: { readonly expectedRevision: number; readonly reason: string }["reason"]
}

export type AgentCapabilitiesSkillLifecycleRollbackOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly schema_version: 1
    readonly rolled_back: {
      readonly schema_version: 1
      readonly candidate_id: string
      readonly skill_id: string
      readonly version: string
      readonly digest: string
      readonly status: "draft" | "candidate" | "canary" | "active" | "retired"
      readonly purpose: string
      readonly triggers: ReadonlyArray<string>
      readonly allowed_tools: ReadonlyArray<string>
      readonly allowed_capabilities: ReadonlyArray<string>
      readonly source_experience_ids: ReadonlyArray<string>
      readonly source_evidence_ids: ReadonlyArray<string>
      readonly test_ids: ReadonlyArray<string>
      readonly evaluation_id: string
      readonly evaluation_digest: string | null
      readonly evaluation_passed: boolean | null
      readonly baseline_candidate_id: string | null
      readonly revision: number
      readonly created_by: string
      readonly review_actor: string | null
      readonly review_reason: string | null
      readonly traffic_percent: number | null
      readonly canary_digest: string | null
      readonly rollback_version: string | null
      readonly record_digest: string
      readonly created_at: string
      readonly updated_at: string
    }
    readonly restored: {
      readonly schema_version: 1
      readonly candidate_id: string
      readonly skill_id: string
      readonly version: string
      readonly digest: string
      readonly status: "draft" | "candidate" | "canary" | "active" | "retired"
      readonly purpose: string
      readonly triggers: ReadonlyArray<string>
      readonly allowed_tools: ReadonlyArray<string>
      readonly allowed_capabilities: ReadonlyArray<string>
      readonly source_experience_ids: ReadonlyArray<string>
      readonly source_evidence_ids: ReadonlyArray<string>
      readonly test_ids: ReadonlyArray<string>
      readonly evaluation_id: string
      readonly evaluation_digest: string | null
      readonly evaluation_passed: boolean | null
      readonly baseline_candidate_id: string | null
      readonly revision: number
      readonly created_by: string
      readonly review_actor: string | null
      readonly review_reason: string | null
      readonly traffic_percent: number | null
      readonly canary_digest: string | null
      readonly rollback_version: string | null
      readonly record_digest: string
      readonly created_at: string
      readonly updated_at: string
    }
    readonly deployment: {
      readonly schema_version: 1
      readonly skill_id: string
      readonly active_candidate_id: string
      readonly previous_candidate_id: string | null
      readonly generation: number
      readonly digest: string
    }
    readonly receipt_digest: string
  }
}

export type AgentCapabilitiesSkillLifecycleDeploymentGetInput = {
  readonly skillID: { readonly skillID: string }["skillID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type AgentCapabilitiesSkillLifecycleDeploymentGetOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly schema_version: 1
    readonly skill_id: string
    readonly active_candidate_id: string
    readonly previous_candidate_id: string | null
    readonly generation: number
    readonly digest: string
  }
}

export type McpListInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type McpListOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: ReadonlyArray<{
    readonly name: string
    readonly status:
      | { readonly status: "connected" }
      | { readonly status: "pending" }
      | { readonly status: "disabled" }
      | { readonly status: "failed"; readonly error: string }
      | { readonly status: "needs_auth" }
      | { readonly status: "needs_client_registration"; readonly error: string }
      | { readonly status: "needs_approval"; readonly reason: string }
    readonly integrationID?: string | null
  }>
}

export type McpResourceCatalogInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type McpResourceCatalogOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly resources: ReadonlyArray<{
      readonly server: string
      readonly name: string
      readonly uri: string
      readonly description?: string | null
      readonly mimeType?: string | null
    }>
    readonly templates: ReadonlyArray<{
      readonly server: string
      readonly name: string
      readonly uriTemplate: string
      readonly description?: string | null
      readonly mimeType?: string | null
    }>
  }
}

export type McpCapabilitiesInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type McpCapabilitiesOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: ReadonlyArray<{
    readonly id: string
    readonly server: string
    readonly kind: "tool" | "prompt" | "resource" | "resource_template"
    readonly generation: number
    readonly name: string
    readonly reference?: string | null
    readonly permission: string
    readonly patterns: ReadonlyArray<string>
  }>
}

export type McpActionReconciliationInput = {
  readonly actionID: { readonly actionID: string }["actionID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly intentDigest: string
    readonly idempotencyKey: string
  }["location"]
  readonly intentDigest: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly intentDigest: string
    readonly idempotencyKey: string
  }["intentDigest"]
  readonly idempotencyKey: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly intentDigest: string
    readonly idempotencyKey: string
  }["idempotencyKey"]
}

export type McpActionReconciliationOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly actionID: string
    readonly kind: "confirmed" | "manual_review"
    readonly state: "known_success" | "known_failure" | "unknown"
    readonly automaticRetryAllowed: false
    readonly reason: string
    readonly evidence: {
      readonly state: "known_success" | "known_failure" | "unknown"
      readonly evidenceDigest: string
      readonly source: string
      readonly observedAt: number | "Infinity" | "-Infinity" | "NaN"
      readonly summary: string | null
    }
  }
}

export type McpRecordReconciliationInput = {
  readonly actionID: { readonly actionID: string }["actionID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly intentDigest: string
    readonly idempotencyKey: string
  }["location"]
  readonly intentDigest: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly intentDigest: string
    readonly idempotencyKey: string
  }["intentDigest"]
  readonly idempotencyKey: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly intentDigest: string
    readonly idempotencyKey: string
  }["idempotencyKey"]
  readonly expectedEvidenceDigest: {
    readonly expectedEvidenceDigest: string
    readonly approval: "record_evidence"
  }["expectedEvidenceDigest"]
  readonly approval: { readonly expectedEvidenceDigest: string; readonly approval: "record_evidence" }["approval"]
}

export type McpRecordReconciliationOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly actionID: string
    readonly kind: "confirmed" | "manual_review"
    readonly state: "known_success" | "known_failure" | "unknown"
    readonly automaticRetryAllowed: false
    readonly reason: string
    readonly evidence: {
      readonly state: "known_success" | "known_failure" | "unknown"
      readonly evidenceDigest: string
      readonly source: string
      readonly observedAt: number | "Infinity" | "-Infinity" | "NaN"
      readonly summary: string | null
    }
  }
}

export type McpConnectInput = {
  readonly server: { readonly server: string }["server"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type McpConnectOutput = void

export type McpDisconnectInput = {
  readonly server: { readonly server: string }["server"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type McpDisconnectOutput = void

export type PrivateOperationsOverviewInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type PrivateOperationsOverviewOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly schemaVersion: 1
    readonly generatedAt: string
    readonly readOnly: true
    readonly doctor: {
      readonly ok: boolean
      readonly passed: number
      readonly failed: number
      readonly checks: ReadonlyArray<{
        readonly id: string
        readonly label: string
        readonly ok: boolean
        readonly detail: string
      }>
    }
    readonly usage: {
      readonly sessions: number
      readonly cost: number
      readonly tokens: {
        readonly input: number
        readonly output: number
        readonly reasoning: number
        readonly cacheRead: number
        readonly cacheWrite: number
        readonly total: number
      }
    }
    readonly backup: {
      readonly available: boolean
      readonly createdAt?: string
      readonly database?: string
      readonly bytes: number
      readonly encrypted: boolean
      readonly checksumVerified: boolean
      readonly restoreListVerified: boolean
    }
    readonly recoveryDrill: {
      readonly available: boolean
      readonly completedAt?: string
      readonly passed: boolean
      readonly tables: number
      readonly sourceRows: number
      readonly restoredRows: number
      readonly differences: number
    }
    readonly secrets: {
      readonly filesScanned: number
      readonly filesSkipped: number
      readonly findingFiles: number
      readonly findings: number
      readonly truncated: boolean
    }
    readonly logs: {
      readonly retentionDays: number
      readonly cutoff: string
      readonly files: number
      readonly bytes: number
    }
  }
}

export type RuntimeInsightSnapshotInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly limit?: string | undefined
  }["location"]
  readonly limit?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly limit?: string | undefined
  }["limit"]
}

export type RuntimeInsightSnapshotOutput = {
  readonly access: {
    readonly role: "owner" | "admin" | "member"
    readonly canReviewMutation: boolean
    readonly canRollbackMutation: boolean
    readonly canMaintainArtifacts: boolean
    readonly canRecordMcpEvidence: boolean
  }
  readonly contextLayers: ReadonlyArray<{
    readonly sessionID: string
    readonly timestamp: number
    readonly model: string
    readonly totalTokens: number
    readonly layers: ReadonlyArray<{
      readonly layer: string
      readonly name: string
      readonly source: string
      readonly tokens: number
      readonly chars: number
      readonly kept: boolean
    }>
  }>
  readonly routing: ReadonlyArray<{
    readonly timestamp: number
    readonly sessionID: string
    readonly task: string
    readonly providerID: string
    readonly modelID: string
    readonly inputCost: number
    readonly outputCost: number
    readonly reason: string
    readonly candidates: ReadonlyArray<{
      readonly providerID: string
      readonly modelID: string
      readonly inputCost: number
      readonly outputCost: number
    }>
  }>
  readonly verifications: ReadonlyArray<{
    readonly timestamp: number
    readonly sessionID: string
    readonly toolCallID: string
    readonly claim: string
    readonly commands: ReadonlyArray<string>
    readonly results: ReadonlyArray<{
      readonly command: string
      readonly ok: boolean
      readonly exitCode: number | null
      readonly outputTail: string
    }>
    readonly passed: boolean
    readonly durationMs: number
  }>
  readonly audit: ReadonlyArray<{
    readonly seq: number
    readonly recordedAt: number
    readonly actor: string
    readonly action: string
    readonly resource: string
    readonly reason: string | null
    readonly metadata: { readonly [x: string]: unknown }
    readonly previousHash: string
    readonly recordHash: string
  }>
  readonly auditDropped: number
  readonly auditVerify: {
    readonly valid: boolean
    readonly count: number
    readonly headHash: string
    readonly issue: string | null
  }
  readonly runs: ReadonlyArray<{
    readonly runID: string
    readonly sessionID: string
    readonly status: string
    readonly startedAt: number
    readonly finishedAt: number | null
    readonly lastSeq: number | null
    readonly error: string | null
  }>
  readonly durableRuns: ReadonlyArray<{
    readonly runID: string
    readonly sessionID: string
    readonly status: string
    readonly initiator: string
    readonly authority: string
    readonly riskTier: string
    readonly reasonSummary: string
    readonly attemptsUsed: number
    readonly maxAttempts: number
    readonly durationMsUsed: number
    readonly maxDurationMs: number
    readonly costMicrosUsed: number
    readonly maxCostMicros: number
    readonly activeAttempt: { readonly attempt: number; readonly startedAt: number } | null
    readonly createdAt: number
    readonly updatedAt: number
    readonly startedAt: number | null
    readonly finishedAt: number | null
    readonly lastLeaseGeneration: number | null
    readonly lastTransition: {
      readonly from: string
      readonly to: string
      readonly reason: string
      readonly changedAt: number
    } | null
    readonly lease: {
      readonly leaseID: string
      readonly ownerID: string
      readonly generation: number
      readonly acquiredAt: number
      readonly heartbeatAt: number
      readonly expiresAt: number
    } | null
    readonly checkpoint: {
      readonly checkpointID: string
      readonly eventSequence: number
      readonly stateDigest: string
      readonly createdAt: number
    } | null
    readonly admission: {
      readonly role: string
      readonly status: string
      readonly decision: "admitted" | "blocked"
      readonly reason: string
      readonly ready: boolean
      readonly descriptorDigest: string | null
      readonly checks: {
        readonly statusConsistent: boolean
        readonly descriptorDigestConsistent: boolean
        readonly toolProjectionConsistent: boolean
        readonly payloadFree: boolean
      }
      readonly declaredToolCount: number
      readonly canonicalToolCount: number
      readonly unsupportedToolCount: number
      readonly valid: boolean
      readonly evidenceRefs: ReadonlyArray<string>
    } | null
  }>
  readonly durableActions: ReadonlyArray<{
    readonly actionID: string
    readonly runID: string | null
    readonly sessionID: string
    readonly name: string
    readonly status: string
    readonly authority: string
    readonly riskTier: string
    readonly reasonSummary: string
    readonly resourceCount: number
    readonly observationStatus: string | null
    readonly resultReplayable: boolean
    readonly outputDigest: string | null
    readonly outputByteLength: number | null
    readonly progress?:
      | {
          readonly phase: string
          readonly completed: number
          readonly total: number
          readonly sequence: number
          readonly updatedAt: number
          readonly detail?: string | undefined
        }
      | null
      | undefined
    readonly attemptsUsed: number
    readonly maxAttempts: number
    readonly durationMsUsed: number
    readonly maxDurationMs: number
    readonly costMicrosUsed: number
    readonly maxCostMicros: number
    readonly mcpReconciliation?:
      | {
          readonly actionKind: "mcp"
          readonly actionVersion: "1"
          readonly intentDigest: string
          readonly idempotencyKey: string
          readonly state: "known_success" | "known_failure" | "unknown" | null
          readonly evidenceDigest: string | null
          readonly source: string | null
          readonly observedAt: number | null
          readonly summary: string | null
          readonly operatorRequired: true
        }
      | null
      | undefined
    readonly mutationRecovery: {
      readonly transactionID: string
      readonly phase: string
      readonly decision: string
      readonly automaticRetryAllowed: false
      readonly requiresReview: boolean
      readonly postProcessing?:
        | ReadonlyArray<{
            readonly sequence: number
            readonly stage: string
            readonly status: string
            readonly target?: string | undefined
          }>
        | undefined
      readonly postProcessingRecovery?:
        | {
            readonly status: string
            readonly stage?: string | undefined
            readonly target?: string | undefined
            readonly sequence?: number | undefined
            readonly reason: string
          }
        | undefined
      readonly reason: string
    } | null
    readonly createdAt: number
    readonly updatedAt: number
  }>
  readonly recalls: ReadonlyArray<{
    readonly timestamp: number
    readonly sessionID: string
    readonly scopeHash: string
    readonly queryFingerprint: string
    readonly algorithm: string
    readonly algorithmRevision: string
    readonly latencyMs: number
    readonly hits: ReadonlyArray<{ readonly memoryID: string; readonly score: number; readonly source: string }>
  }>
}

export type RuntimeInsightActionRecoveryInput = {
  readonly actionID: { readonly actionID: string }["actionID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type RuntimeInsightActionRecoveryOutput = {
  readonly actionID: string
  readonly actionStatus: string
  readonly state: string
  readonly outcome: string | null
  readonly repair: { readonly required: boolean; readonly source: string; readonly reason: string | null }
  readonly mutationRecovery: {
    readonly transactionID: string
    readonly phase: string
    readonly decision: string
    readonly automaticRetryAllowed: false
    readonly requiresReview: boolean
    readonly postProcessing?:
      | ReadonlyArray<{
          readonly sequence: number
          readonly stage: string
          readonly status: string
          readonly target?: string | undefined
        }>
      | undefined
    readonly postProcessingRecovery?:
      | {
          readonly status: string
          readonly stage?: string | undefined
          readonly target?: string | undefined
          readonly sequence?: number | undefined
          readonly reason: string
        }
      | undefined
    readonly reason: string
  } | null
  readonly inspection: {
    readonly transactionID: string
    readonly phase: string
    readonly observationDigest: string
    readonly decision: string
    readonly automaticRetryAllowed: false
    readonly rollbackAvailable: boolean
    readonly entries: ReadonlyArray<{ readonly target: string; readonly operation: string; readonly state: string }>
    readonly reason: string
  } | null
  readonly inspectionError: string | null
  readonly artifact: {
    readonly status: "not_required" | "available" | "missing" | "corrupt" | "quota_pressure" | "unavailable"
    readonly referencedCount: number
    readonly missingReferenceCount: number
    readonly corruptCount: number
    readonly overQuota: boolean
    readonly reason: string
  } | null
  readonly access: {
    readonly role: "owner" | "admin" | "member"
    readonly canReviewMutation: boolean
    readonly canRollbackMutation: boolean
    readonly canMaintainArtifacts: boolean
    readonly canRecordMcpEvidence: boolean
  }
}

export type RuntimeInsightActionRecoveryReviewInput = {
  readonly actionID: { readonly actionID: string }["actionID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
  readonly transactionID: {
    readonly transactionID: string
    readonly expectedPhase: string
    readonly observationDigest: string
    readonly decision: "settle_postimage" | "require_rollback" | "confirm_rolled_back" | "block_rollback"
    readonly inspectedDecision: "postimage_matches" | "preimage_matches" | "manual_review"
  }["transactionID"]
  readonly expectedPhase: {
    readonly transactionID: string
    readonly expectedPhase: string
    readonly observationDigest: string
    readonly decision: "settle_postimage" | "require_rollback" | "confirm_rolled_back" | "block_rollback"
    readonly inspectedDecision: "postimage_matches" | "preimage_matches" | "manual_review"
  }["expectedPhase"]
  readonly observationDigest: {
    readonly transactionID: string
    readonly expectedPhase: string
    readonly observationDigest: string
    readonly decision: "settle_postimage" | "require_rollback" | "confirm_rolled_back" | "block_rollback"
    readonly inspectedDecision: "postimage_matches" | "preimage_matches" | "manual_review"
  }["observationDigest"]
  readonly decision: {
    readonly transactionID: string
    readonly expectedPhase: string
    readonly observationDigest: string
    readonly decision: "settle_postimage" | "require_rollback" | "confirm_rolled_back" | "block_rollback"
    readonly inspectedDecision: "postimage_matches" | "preimage_matches" | "manual_review"
  }["decision"]
  readonly inspectedDecision: {
    readonly transactionID: string
    readonly expectedPhase: string
    readonly observationDigest: string
    readonly decision: "settle_postimage" | "require_rollback" | "confirm_rolled_back" | "block_rollback"
    readonly inspectedDecision: "postimage_matches" | "preimage_matches" | "manual_review"
  }["inspectedDecision"]
}

export type RuntimeInsightActionRecoveryReviewOutput = {
  readonly actionID: string
  readonly actionStatus: string
  readonly state: string
  readonly outcome: string | null
  readonly repair: { readonly required: boolean; readonly source: string; readonly reason: string | null }
  readonly mutationRecovery: {
    readonly transactionID: string
    readonly phase: string
    readonly decision: string
    readonly automaticRetryAllowed: false
    readonly requiresReview: boolean
    readonly postProcessing?:
      | ReadonlyArray<{
          readonly sequence: number
          readonly stage: string
          readonly status: string
          readonly target?: string | undefined
        }>
      | undefined
    readonly postProcessingRecovery?:
      | {
          readonly status: string
          readonly stage?: string | undefined
          readonly target?: string | undefined
          readonly sequence?: number | undefined
          readonly reason: string
        }
      | undefined
    readonly reason: string
  } | null
  readonly inspection: {
    readonly transactionID: string
    readonly phase: string
    readonly observationDigest: string
    readonly decision: string
    readonly automaticRetryAllowed: false
    readonly rollbackAvailable: boolean
    readonly entries: ReadonlyArray<{ readonly target: string; readonly operation: string; readonly state: string }>
    readonly reason: string
  } | null
  readonly inspectionError: string | null
  readonly artifact: {
    readonly status: "not_required" | "available" | "missing" | "corrupt" | "quota_pressure" | "unavailable"
    readonly referencedCount: number
    readonly missingReferenceCount: number
    readonly corruptCount: number
    readonly overQuota: boolean
    readonly reason: string
  } | null
  readonly access: {
    readonly role: "owner" | "admin" | "member"
    readonly canReviewMutation: boolean
    readonly canRollbackMutation: boolean
    readonly canMaintainArtifacts: boolean
    readonly canRecordMcpEvidence: boolean
  }
}

export type RuntimeInsightActionRecoveryRollbackInput = {
  readonly actionID: { readonly actionID: string }["actionID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
  readonly transactionID: {
    readonly transactionID: string
    readonly expectedPhase: "rollback_required"
    readonly observationDigest: string
    readonly inspectedDecision: "postimage_matches"
    readonly approval: "execute_rollback"
  }["transactionID"]
  readonly expectedPhase: {
    readonly transactionID: string
    readonly expectedPhase: "rollback_required"
    readonly observationDigest: string
    readonly inspectedDecision: "postimage_matches"
    readonly approval: "execute_rollback"
  }["expectedPhase"]
  readonly observationDigest: {
    readonly transactionID: string
    readonly expectedPhase: "rollback_required"
    readonly observationDigest: string
    readonly inspectedDecision: "postimage_matches"
    readonly approval: "execute_rollback"
  }["observationDigest"]
  readonly inspectedDecision: {
    readonly transactionID: string
    readonly expectedPhase: "rollback_required"
    readonly observationDigest: string
    readonly inspectedDecision: "postimage_matches"
    readonly approval: "execute_rollback"
  }["inspectedDecision"]
  readonly approval: {
    readonly transactionID: string
    readonly expectedPhase: "rollback_required"
    readonly observationDigest: string
    readonly inspectedDecision: "postimage_matches"
    readonly approval: "execute_rollback"
  }["approval"]
}

export type RuntimeInsightActionRecoveryRollbackOutput = {
  readonly actionID: string
  readonly actionStatus: string
  readonly state: string
  readonly outcome: string | null
  readonly repair: { readonly required: boolean; readonly source: string; readonly reason: string | null }
  readonly mutationRecovery: {
    readonly transactionID: string
    readonly phase: string
    readonly decision: string
    readonly automaticRetryAllowed: false
    readonly requiresReview: boolean
    readonly postProcessing?:
      | ReadonlyArray<{
          readonly sequence: number
          readonly stage: string
          readonly status: string
          readonly target?: string | undefined
        }>
      | undefined
    readonly postProcessingRecovery?:
      | {
          readonly status: string
          readonly stage?: string | undefined
          readonly target?: string | undefined
          readonly sequence?: number | undefined
          readonly reason: string
        }
      | undefined
    readonly reason: string
  } | null
  readonly inspection: {
    readonly transactionID: string
    readonly phase: string
    readonly observationDigest: string
    readonly decision: string
    readonly automaticRetryAllowed: false
    readonly rollbackAvailable: boolean
    readonly entries: ReadonlyArray<{ readonly target: string; readonly operation: string; readonly state: string }>
    readonly reason: string
  } | null
  readonly inspectionError: string | null
  readonly artifact: {
    readonly status: "not_required" | "available" | "missing" | "corrupt" | "quota_pressure" | "unavailable"
    readonly referencedCount: number
    readonly missingReferenceCount: number
    readonly corruptCount: number
    readonly overQuota: boolean
    readonly reason: string
  } | null
  readonly access: {
    readonly role: "owner" | "admin" | "member"
    readonly canReviewMutation: boolean
    readonly canRollbackMutation: boolean
    readonly canMaintainArtifacts: boolean
    readonly canRecordMcpEvidence: boolean
  }
}

export type RuntimeInsightArtifactMaintenanceInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly scanID?: string | undefined
    readonly cursor?: string | undefined
  }["location"]
  readonly scanID?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly scanID?: string | undefined
    readonly cursor?: string | undefined
  }["scanID"]
  readonly cursor?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly scanID?: string | undefined
    readonly cursor?: string | undefined
  }["cursor"]
}

export type RuntimeInsightArtifactMaintenanceOutput = {
  readonly scope: "profile"
  readonly operation: "audit" | "sweep"
  readonly scanID: string
  readonly scanStatus: "active" | "complete" | "expired"
  readonly pageNumber: number
  readonly scannedActions: number
  readonly scanLimit: number
  readonly scanComplete: boolean
  readonly scanExpiresAt: number
  readonly sessionDigest: string
  readonly nextCursor?: string | undefined
  readonly referencedCount: number
  readonly audit: {
    readonly scannedEntries: number
    readonly artifactCount: number
    readonly totalBytes: number
    readonly referencedCount: number
    readonly orphanCount: number
    readonly expiredOrphanCount: number
    readonly missingReferenceCount: number
    readonly invalidCount: number
    readonly unsafeCount: number
    readonly corruptCount: number
    readonly overQuota: boolean
  }
  readonly removed: number
}

export type RuntimeInsightArtifactMaintenanceSweepInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
  readonly scanID: {
    readonly scanID: string
    readonly approval: "execute_sweep"
    readonly maxAgeMs?: number | undefined
    readonly enforceQuota?: boolean | undefined
  }["scanID"]
  readonly approval: {
    readonly scanID: string
    readonly approval: "execute_sweep"
    readonly maxAgeMs?: number | undefined
    readonly enforceQuota?: boolean | undefined
  }["approval"]
  readonly maxAgeMs?: {
    readonly scanID: string
    readonly approval: "execute_sweep"
    readonly maxAgeMs?: number | undefined
    readonly enforceQuota?: boolean | undefined
  }["maxAgeMs"]
  readonly enforceQuota?: {
    readonly scanID: string
    readonly approval: "execute_sweep"
    readonly maxAgeMs?: number | undefined
    readonly enforceQuota?: boolean | undefined
  }["enforceQuota"]
}

export type RuntimeInsightArtifactMaintenanceSweepOutput = {
  readonly scope: "profile"
  readonly operation: "audit" | "sweep"
  readonly scanID: string
  readonly scanStatus: "active" | "complete" | "expired"
  readonly pageNumber: number
  readonly scannedActions: number
  readonly scanLimit: number
  readonly scanComplete: boolean
  readonly scanExpiresAt: number
  readonly sessionDigest: string
  readonly nextCursor?: string | undefined
  readonly referencedCount: number
  readonly audit: {
    readonly scannedEntries: number
    readonly artifactCount: number
    readonly totalBytes: number
    readonly referencedCount: number
    readonly orphanCount: number
    readonly expiredOrphanCount: number
    readonly missingReferenceCount: number
    readonly invalidCount: number
    readonly unsafeCount: number
    readonly corruptCount: number
    readonly overQuota: boolean
  }
  readonly removed: number
}

export type RuntimeInsightAuditVerifyInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type RuntimeInsightAuditVerifyOutput = {
  readonly valid: boolean
  readonly count: number
  readonly headHash: string
  readonly issue: string | null
}

export type RuntimeInsightChildSettlementAuditInput = {
  readonly parentRunID: { readonly parentRunID: string; readonly childRunID: string }["parentRunID"]
  readonly childRunID: { readonly parentRunID: string; readonly childRunID: string }["childRunID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type RuntimeInsightChildSettlementAuditOutput = {
  readonly parentRunID: string
  readonly childRunID: string
  readonly status: "complete" | "repairable" | "manual-review" | "missing-intent"
  readonly deterministic: true
  readonly providerExecutionAllowed: false
  readonly intentID: string | null
  readonly decision: {
    readonly next: ReadonlyArray<string>
    readonly missing: ReadonlyArray<string>
    readonly conflicts: ReadonlyArray<string>
    readonly complete: boolean
    readonly reason: string
  } | null
  readonly reason: string
  readonly access: {
    readonly role: "owner" | "admin" | "member"
    readonly canReviewMutation: boolean
    readonly canRollbackMutation: boolean
    readonly canMaintainArtifacts: boolean
    readonly canRecordMcpEvidence: boolean
  }
}

export type RuntimeInsightChildSettlementRecoverInput = {
  readonly parentRunID: { readonly parentRunID: string; readonly childRunID: string }["parentRunID"]
  readonly childRunID: { readonly parentRunID: string; readonly childRunID: string }["childRunID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
  readonly approval: { readonly approval: "recover_settlement" }["approval"]
}

export type RuntimeInsightChildSettlementRecoverOutput = {
  readonly before: {
    readonly parentRunID: string
    readonly childRunID: string
    readonly status: "complete" | "repairable" | "manual-review" | "missing-intent"
    readonly deterministic: true
    readonly providerExecutionAllowed: false
    readonly intentID: string | null
    readonly decision: {
      readonly next: ReadonlyArray<string>
      readonly missing: ReadonlyArray<string>
      readonly conflicts: ReadonlyArray<string>
      readonly complete: boolean
      readonly reason: string
    } | null
    readonly reason: string
    readonly access: {
      readonly role: "owner" | "admin" | "member"
      readonly canReviewMutation: boolean
      readonly canRollbackMutation: boolean
      readonly canMaintainArtifacts: boolean
      readonly canRecordMcpEvidence: boolean
    }
  }
  readonly after: {
    readonly parentRunID: string
    readonly childRunID: string
    readonly status: "complete" | "repairable" | "manual-review" | "missing-intent"
    readonly deterministic: true
    readonly providerExecutionAllowed: false
    readonly intentID: string | null
    readonly decision: {
      readonly next: ReadonlyArray<string>
      readonly missing: ReadonlyArray<string>
      readonly conflicts: ReadonlyArray<string>
      readonly complete: boolean
      readonly reason: string
    } | null
    readonly reason: string
    readonly access: {
      readonly role: "owner" | "admin" | "member"
      readonly canReviewMutation: boolean
      readonly canRollbackMutation: boolean
      readonly canMaintainArtifacts: boolean
      readonly canRecordMcpEvidence: boolean
    }
  }
  readonly attempted: ReadonlyArray<string>
  readonly repaired: ReadonlyArray<string>
  readonly deterministic: true
  readonly providerExecutionAllowed: false
  readonly reason: string
  readonly access: {
    readonly role: "owner" | "admin" | "member"
    readonly canReviewMutation: boolean
    readonly canRollbackMutation: boolean
    readonly canMaintainArtifacts: boolean
    readonly canRecordMcpEvidence: boolean
  }
}

export type RuntimeInsightChildSettlementRecoverySweepInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
  readonly approval: {
    readonly approval: "recover_settlements"
    readonly status?: "prepared" | "recovery-required" | undefined
    readonly limit?: number | undefined
  }["approval"]
  readonly status?: {
    readonly approval: "recover_settlements"
    readonly status?: "prepared" | "recovery-required" | undefined
    readonly limit?: number | undefined
  }["status"]
  readonly limit?: {
    readonly approval: "recover_settlements"
    readonly status?: "prepared" | "recovery-required" | undefined
    readonly limit?: number | undefined
  }["limit"]
}

export type RuntimeInsightChildSettlementRecoverySweepOutput = {
  readonly schemaVersion: 1
  readonly status: "prepared" | "recovery-required" | null
  readonly limit: number
  readonly scanned: number
  readonly committed: number
  readonly pending: number
  readonly recoveryRequired: number
  readonly failed: number
  readonly hasMore: boolean
  readonly items: ReadonlyArray<{
    readonly intentID: string
    readonly parentRunID: string
    readonly childRunID: string
    readonly sourceStatus: "prepared" | "recovery-required"
    readonly afterStatus: "prepared" | "committed" | "recovery-required" | null
    readonly outcome: "committed" | "pending" | "recovery-required" | "failed"
    readonly attempted: ReadonlyArray<string>
    readonly repaired: ReadonlyArray<string>
    readonly reason: string
  }>
  readonly deterministic: true
  readonly providerExecutionAllowed: false
  readonly reason: string
  readonly access: {
    readonly role: "owner" | "admin" | "member"
    readonly canReviewMutation: boolean
    readonly canRollbackMutation: boolean
    readonly canMaintainArtifacts: boolean
    readonly canRecordMcpEvidence: boolean
  }
}

export type MessagesListInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly limit?: {
    readonly limit?: number | undefined
    readonly order?: "asc" | "desc" | undefined
    readonly cursor?: string | undefined
  }["limit"]
  readonly order?: {
    readonly limit?: number | undefined
    readonly order?: "asc" | "desc" | undefined
    readonly cursor?: string | undefined
  }["order"]
  readonly cursor?: {
    readonly limit?: number | undefined
    readonly order?: "asc" | "desc" | undefined
    readonly cursor?: string | undefined
  }["cursor"]
}

export type MessagesListOutput = {
  readonly data: ReadonlyArray<
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number }
        readonly type: "agent-switched"
        readonly agent: string
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number }
        readonly type: "model-switched"
        readonly model: { readonly id: string; readonly providerID: string; readonly variant?: string }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number }
        readonly text: string
        readonly files?: ReadonlyArray<{
          readonly uri: string
          readonly mime: string
          readonly name?: string
          readonly description?: string
          readonly source?: { readonly start: number; readonly end: number; readonly text: string }
        }>
        readonly agents?: ReadonlyArray<{
          readonly name: string
          readonly source?: { readonly start: number; readonly end: number; readonly text: string }
        }>
        readonly scheduledTasks?: ReadonlyArray<{
          readonly id: string
          readonly prompt: string
          readonly description: string
          readonly agent: string
          readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
          readonly command?: string
        }>
        readonly system?: { readonly text: string; readonly source: "request"; readonly scope: "turn" }
        readonly route?: {
          readonly agent?: string
          readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
        }
        readonly command?: { readonly name: string; readonly arguments: string }
        readonly format?:
          | { readonly type: "text" }
          | {
              readonly type: "json_schema"
              readonly schema: { readonly [x: string]: JsonValue }
              readonly retryCount?: number | null | null
            }
        readonly type: "user"
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number }
        readonly sessionID: string
        readonly text: string
        readonly type: "synthetic"
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number }
        readonly type: "system"
        readonly text: string
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number; readonly completed?: number }
        readonly type: "shell"
        readonly callID: string
        readonly command: string
        readonly output: string
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number; readonly completed?: number }
        readonly type: "assistant"
        readonly agent: string
        readonly model: { readonly id: string; readonly providerID: string; readonly variant?: string }
        readonly content: ReadonlyArray<
          | { readonly type: "text"; readonly id: string; readonly text: string }
          | {
              readonly type: "reasoning"
              readonly id: string
              readonly text: string
              readonly providerMetadata?: { readonly [x: string]: { readonly [x: string]: JsonValue } }
              readonly time?: { readonly created: number; readonly completed?: number }
            }
          | {
              readonly type: "tool"
              readonly id: string
              readonly name: string
              readonly provider?: {
                readonly executed: boolean
                readonly metadata?: { readonly [x: string]: { readonly [x: string]: JsonValue } }
                readonly resultMetadata?: { readonly [x: string]: { readonly [x: string]: JsonValue } }
              }
              readonly state:
                | { readonly status: "pending"; readonly input: string }
                | {
                    readonly status: "running"
                    readonly input: { readonly [x: string]: JsonValue }
                    readonly structured: { readonly [x: string]: JsonValue }
                    readonly content: ReadonlyArray<
                      | { readonly type: "text"; readonly text: string }
                      | { readonly type: "file"; readonly uri: string; readonly mime: string; readonly name?: string }
                    >
                  }
                | {
                    readonly status: "completed"
                    readonly input: { readonly [x: string]: JsonValue }
                    readonly attachments?: ReadonlyArray<{
                      readonly uri: string
                      readonly mime: string
                      readonly name?: string
                      readonly description?: string
                      readonly source?: { readonly start: number; readonly end: number; readonly text: string }
                    }>
                    readonly content: ReadonlyArray<
                      | { readonly type: "text"; readonly text: string }
                      | { readonly type: "file"; readonly uri: string; readonly mime: string; readonly name?: string }
                    >
                    readonly artifactRefs?: ReadonlyArray<{
                      readonly version: 1
                      readonly artifactID: string
                      readonly kind: string
                      readonly digest: string
                      readonly mime: string
                      readonly sizeBytes: number
                      readonly owner: { readonly scope: "session" | "profile" | "tenant"; readonly id: string }
                      readonly retention: {
                        readonly mode: "ephemeral" | "session" | "durable"
                        readonly expiresAt?: number
                      }
                      readonly retrievalHint: { readonly kind: "managed"; readonly handle: string }
                      readonly label?: string
                      readonly createdAt: number
                    }>
                    readonly outputPaths?: ReadonlyArray<string>
                    readonly structured: { readonly [x: string]: JsonValue }
                    readonly result?: JsonValue
                  }
                | {
                    readonly status: "error"
                    readonly input: { readonly [x: string]: JsonValue }
                    readonly content: ReadonlyArray<
                      | { readonly type: "text"; readonly text: string }
                      | { readonly type: "file"; readonly uri: string; readonly mime: string; readonly name?: string }
                    >
                    readonly structured: { readonly [x: string]: JsonValue }
                    readonly error: { readonly type: "unknown"; readonly message: string }
                    readonly artifactRefs?: ReadonlyArray<{
                      readonly version: 1
                      readonly artifactID: string
                      readonly kind: string
                      readonly digest: string
                      readonly mime: string
                      readonly sizeBytes: number
                      readonly owner: { readonly scope: "session" | "profile" | "tenant"; readonly id: string }
                      readonly retention: {
                        readonly mode: "ephemeral" | "session" | "durable"
                        readonly expiresAt?: number
                      }
                      readonly retrievalHint: { readonly kind: "managed"; readonly handle: string }
                      readonly label?: string
                      readonly createdAt: number
                    }>
                    readonly outputPaths?: ReadonlyArray<string>
                    readonly result?: JsonValue
                  }
              readonly time: {
                readonly created: number
                readonly ran?: number
                readonly completed?: number
                readonly pruned?: number
              }
            }
        >
        readonly structured?: { readonly [x: string]: JsonValue }
        readonly delivery?: {
          readonly status: "normal" | "proactive"
          readonly sentAt: number
          readonly attachmentCount: number
          readonly attachments: ReadonlyArray<{
            readonly artifactID: string
            readonly artifactRef?: {
              readonly version: 1
              readonly artifactID: string
              readonly kind: string
              readonly digest: string
              readonly mime: string
              readonly sizeBytes: number
              readonly owner: { readonly scope: "session" | "profile" | "tenant"; readonly id: string }
              readonly retention: { readonly mode: "ephemeral" | "session" | "durable"; readonly expiresAt?: number }
              readonly retrievalHint: { readonly kind: "managed"; readonly handle: string }
              readonly label?: string
              readonly createdAt: number
            }
            readonly path: string
            readonly displayName: string
            readonly mime: string
            readonly sizeBytes: number
            readonly createdAt: number
            readonly sha256: string
            readonly source: "user_message"
            readonly isImage: boolean
          }>
          readonly localOnly: true
          readonly uploaded: false
        }
        readonly snapshot?: { readonly start?: string; readonly end?: string; readonly files?: ReadonlyArray<string> }
        readonly finish?: string
        readonly cost?: number
        readonly tokens?: {
          readonly input: number
          readonly output: number
          readonly reasoning: number
          readonly cache: { readonly read: number; readonly write: number }
        }
        readonly error?: { readonly type: "unknown"; readonly message: string }
      }
    | {
        readonly type: "compaction"
        readonly reason: "auto" | "manual"
        readonly summary: string
        readonly recent: string
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number }
      }
  >
  readonly cursor: { readonly previous?: string | null; readonly next?: string | null }
}

export type ModelsDefaultInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type ModelsDefaultOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly id: string
    readonly providerID: string
    readonly family?: string
    readonly name: string
    readonly api:
      | {
          readonly id: string
          readonly type: "aisdk"
          readonly package: string
          readonly url?: string
          readonly settings?: { readonly [x: string]: JsonValue }
        }
      | {
          readonly id: string
          readonly type: "native"
          readonly url?: string
          readonly settings: { readonly [x: string]: JsonValue }
        }
    readonly profile?: {
      readonly version: "v1"
      readonly providerID: string
      readonly modelID: string
      readonly modality: {
        readonly input: ReadonlyArray<"text" | "image" | "audio" | "video" | "document">
        readonly output: ReadonlyArray<"text" | "image" | "audio" | "video" | "document">
      }
      readonly limits: { readonly context: number; readonly input?: number; readonly output: number }
      readonly capabilities: {
        readonly tools: "supported" | "unsupported" | "unknown"
        readonly structured: "native" | "synthetic_tool" | "unsupported" | "unknown"
        readonly reasoning: "none" | "effort" | "budget" | "provider_defined" | "unknown"
        readonly cache: "none" | "implicit" | "explicit" | "provider_defined" | "unknown"
      }
      readonly tokenizer: string
      readonly estimator: string
      readonly priceCatalogRevision: string
      readonly observations: ReadonlyArray<{
        readonly kind: "latency" | "error" | "capability"
        readonly status: "pass" | "fail" | "inconclusive"
        readonly source: "catalog" | "recorded" | "local" | "live"
        readonly sourceID: string
        readonly observedAt: number
        readonly expiresAt?: number
        readonly value: JsonValue
      }>
      readonly policy: {
        readonly region: {
          readonly mode: "allowlist" | "provider_default" | "unknown"
          readonly regions: ReadonlyArray<string>
        }
        readonly egress: {
          readonly mode: "provider" | "proxy" | "direct" | "unknown"
          readonly origins: ReadonlyArray<string>
        }
        readonly data: {
          readonly retention: "ephemeral" | "provider_defined" | "unknown"
          readonly training: "excluded" | "provider_defined" | "unknown"
        }
      }
    }
    readonly capabilities: {
      readonly tools: boolean
      readonly input: ReadonlyArray<string>
      readonly output: ReadonlyArray<string>
    }
    readonly request: {
      readonly headers: { readonly [x: string]: string }
      readonly body: { readonly [x: string]: JsonValue }
      readonly variant?: string
    }
    readonly variants: ReadonlyArray<{
      readonly id: string
      readonly headers: { readonly [x: string]: string }
      readonly body: { readonly [x: string]: JsonValue }
    }>
    readonly time: { readonly released: number }
    readonly cost: ReadonlyArray<{
      readonly tier?: { readonly type: "context"; readonly size: number }
      readonly input: number
      readonly output: number
      readonly cache: { readonly read: number; readonly write: number }
    }>
    readonly priceCatalog?: {
      readonly revision: string
      readonly currency: string
      readonly minorUnit: number
      readonly unit: "token" | "1k-tokens" | "1m-tokens"
      readonly effectiveFrom: number
      readonly source: string
      readonly rates: {
        readonly unknownInput?: { readonly amountMinor: number }
        readonly imageInput?: { readonly amountMinor: number }
        readonly audioInput?: { readonly amountMinor: number }
        readonly cacheReadInput?: { readonly amountMinor: number }
        readonly cacheWriteInput?: { readonly amountMinor: number }
        readonly textOutput?: { readonly amountMinor: number }
        readonly reasoningOutput?: { readonly amountMinor: number }
        readonly audioOutput?: { readonly amountMinor: number }
      }
    }
    readonly status: "alpha" | "beta" | "deprecated" | "active"
    readonly enabled: boolean
    readonly limit: { readonly context: number; readonly input?: number; readonly output: number }
  } | null
}

export type ModelsListInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type ModelsListOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: ReadonlyArray<{
    readonly id: string
    readonly providerID: string
    readonly family?: string
    readonly name: string
    readonly api:
      | {
          readonly id: string
          readonly type: "aisdk"
          readonly package: string
          readonly url?: string
          readonly settings?: { readonly [x: string]: JsonValue }
        }
      | {
          readonly id: string
          readonly type: "native"
          readonly url?: string
          readonly settings: { readonly [x: string]: JsonValue }
        }
    readonly profile?: {
      readonly version: "v1"
      readonly providerID: string
      readonly modelID: string
      readonly modality: {
        readonly input: ReadonlyArray<"text" | "image" | "audio" | "video" | "document">
        readonly output: ReadonlyArray<"text" | "image" | "audio" | "video" | "document">
      }
      readonly limits: { readonly context: number; readonly input?: number; readonly output: number }
      readonly capabilities: {
        readonly tools: "supported" | "unsupported" | "unknown"
        readonly structured: "native" | "synthetic_tool" | "unsupported" | "unknown"
        readonly reasoning: "none" | "effort" | "budget" | "provider_defined" | "unknown"
        readonly cache: "none" | "implicit" | "explicit" | "provider_defined" | "unknown"
      }
      readonly tokenizer: string
      readonly estimator: string
      readonly priceCatalogRevision: string
      readonly observations: ReadonlyArray<{
        readonly kind: "latency" | "error" | "capability"
        readonly status: "pass" | "fail" | "inconclusive"
        readonly source: "catalog" | "recorded" | "local" | "live"
        readonly sourceID: string
        readonly observedAt: number
        readonly expiresAt?: number
        readonly value: JsonValue
      }>
      readonly policy: {
        readonly region: {
          readonly mode: "allowlist" | "provider_default" | "unknown"
          readonly regions: ReadonlyArray<string>
        }
        readonly egress: {
          readonly mode: "provider" | "proxy" | "direct" | "unknown"
          readonly origins: ReadonlyArray<string>
        }
        readonly data: {
          readonly retention: "ephemeral" | "provider_defined" | "unknown"
          readonly training: "excluded" | "provider_defined" | "unknown"
        }
      }
    }
    readonly capabilities: {
      readonly tools: boolean
      readonly input: ReadonlyArray<string>
      readonly output: ReadonlyArray<string>
    }
    readonly request: {
      readonly headers: { readonly [x: string]: string }
      readonly body: { readonly [x: string]: JsonValue }
      readonly variant?: string
    }
    readonly variants: ReadonlyArray<{
      readonly id: string
      readonly headers: { readonly [x: string]: string }
      readonly body: { readonly [x: string]: JsonValue }
    }>
    readonly time: { readonly released: number }
    readonly cost: ReadonlyArray<{
      readonly tier?: { readonly type: "context"; readonly size: number }
      readonly input: number
      readonly output: number
      readonly cache: { readonly read: number; readonly write: number }
    }>
    readonly priceCatalog?: {
      readonly revision: string
      readonly currency: string
      readonly minorUnit: number
      readonly unit: "token" | "1k-tokens" | "1m-tokens"
      readonly effectiveFrom: number
      readonly source: string
      readonly rates: {
        readonly unknownInput?: { readonly amountMinor: number }
        readonly imageInput?: { readonly amountMinor: number }
        readonly audioInput?: { readonly amountMinor: number }
        readonly cacheReadInput?: { readonly amountMinor: number }
        readonly cacheWriteInput?: { readonly amountMinor: number }
        readonly textOutput?: { readonly amountMinor: number }
        readonly reasoningOutput?: { readonly amountMinor: number }
        readonly audioOutput?: { readonly amountMinor: number }
      }
    }
    readonly status: "alpha" | "beta" | "deprecated" | "active"
    readonly enabled: boolean
    readonly limit: { readonly context: number; readonly input?: number; readonly output: number }
  }>
}

export type ProvidersListInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type ProvidersListOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: ReadonlyArray<{
    readonly id: string
    readonly integrationID?: string
    readonly name: string
    readonly disabled?: boolean
    readonly api:
      | {
          readonly type: "aisdk"
          readonly package: string
          readonly url?: string
          readonly settings?: { readonly [x: string]: JsonValue }
        }
      | { readonly type: "native"; readonly url?: string; readonly settings: { readonly [x: string]: JsonValue } }
    readonly request: {
      readonly headers: { readonly [x: string]: string }
      readonly body: { readonly [x: string]: JsonValue }
    }
  }>
}

export type ProvidersGetInput = {
  readonly providerID: { readonly providerID: string }["providerID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type ProvidersGetOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly id: string
    readonly integrationID?: string
    readonly name: string
    readonly disabled?: boolean
    readonly api:
      | {
          readonly type: "aisdk"
          readonly package: string
          readonly url?: string
          readonly settings?: { readonly [x: string]: JsonValue }
        }
      | { readonly type: "native"; readonly url?: string; readonly settings: { readonly [x: string]: JsonValue } }
    readonly request: {
      readonly headers: { readonly [x: string]: string }
      readonly body: { readonly [x: string]: JsonValue }
    }
  }
}

export type IntegrationsListInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type IntegrationsListOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: ReadonlyArray<{
    readonly id: string
    readonly name: string
    readonly methods: ReadonlyArray<
      | {
          readonly id: string
          readonly type: "oauth"
          readonly label: string
          readonly prompts?: ReadonlyArray<
            | {
                readonly type: "text"
                readonly key: string
                readonly message: string
                readonly placeholder?: string
                readonly when?: { readonly key: string; readonly op: "eq" | "neq"; readonly value: string }
              }
            | {
                readonly type: "select"
                readonly key: string
                readonly message: string
                readonly options: ReadonlyArray<{
                  readonly label: string
                  readonly value: string
                  readonly hint?: string
                }>
                readonly when?: { readonly key: string; readonly op: "eq" | "neq"; readonly value: string }
              }
          >
        }
      | { readonly type: "key"; readonly label?: string }
      | { readonly type: "env"; readonly names: ReadonlyArray<string> }
    >
    readonly connections: ReadonlyArray<
      | { readonly type: "credential"; readonly id: string; readonly label: string }
      | { readonly type: "env"; readonly name: string }
    >
  }>
}

export type IntegrationsGetInput = {
  readonly integrationID: { readonly integrationID: string }["integrationID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type IntegrationsGetOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly id: string
    readonly name: string
    readonly methods: ReadonlyArray<
      | {
          readonly id: string
          readonly type: "oauth"
          readonly label: string
          readonly prompts?: ReadonlyArray<
            | {
                readonly type: "text"
                readonly key: string
                readonly message: string
                readonly placeholder?: string
                readonly when?: { readonly key: string; readonly op: "eq" | "neq"; readonly value: string }
              }
            | {
                readonly type: "select"
                readonly key: string
                readonly message: string
                readonly options: ReadonlyArray<{
                  readonly label: string
                  readonly value: string
                  readonly hint?: string
                }>
                readonly when?: { readonly key: string; readonly op: "eq" | "neq"; readonly value: string }
              }
          >
        }
      | { readonly type: "key"; readonly label?: string }
      | { readonly type: "env"; readonly names: ReadonlyArray<string> }
    >
    readonly connections: ReadonlyArray<
      | { readonly type: "credential"; readonly id: string; readonly label: string }
      | { readonly type: "env"; readonly name: string }
    >
  } | null
}

export type IntegrationsConnectKeyInput = {
  readonly integrationID: { readonly integrationID: string }["integrationID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
  readonly key: { readonly key: string; readonly label?: string | undefined }["key"]
  readonly label?: { readonly key: string; readonly label?: string | undefined }["label"]
}

export type IntegrationsConnectKeyOutput = void

export type IntegrationsConnectOauthInput = {
  readonly integrationID: { readonly integrationID: string }["integrationID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
  readonly methodID: {
    readonly methodID: string
    readonly inputs: { readonly [x: string]: string }
    readonly label?: string | undefined
  }["methodID"]
  readonly inputs: {
    readonly methodID: string
    readonly inputs: { readonly [x: string]: string }
    readonly label?: string | undefined
  }["inputs"]
  readonly label?: {
    readonly methodID: string
    readonly inputs: { readonly [x: string]: string }
    readonly label?: string | undefined
  }["label"]
}

export type IntegrationsConnectOauthOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly attemptID: string
    readonly url: string
    readonly instructions: string
    readonly mode: "auto" | "code"
    readonly time: {
      readonly created: number | "Infinity" | "-Infinity" | "NaN"
      readonly expires: number | "Infinity" | "-Infinity" | "NaN"
    }
  }
}

export type IntegrationsAttemptStatusInput = {
  readonly attemptID: { readonly attemptID: string }["attemptID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type IntegrationsAttemptStatusOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data:
    | {
        readonly status: "pending"
        readonly time: {
          readonly created: number | "Infinity" | "-Infinity" | "NaN"
          readonly expires: number | "Infinity" | "-Infinity" | "NaN"
        }
      }
    | {
        readonly status: "complete"
        readonly time: {
          readonly created: number | "Infinity" | "-Infinity" | "NaN"
          readonly expires: number | "Infinity" | "-Infinity" | "NaN"
        }
      }
    | {
        readonly status: "failed"
        readonly message: string
        readonly time: {
          readonly created: number | "Infinity" | "-Infinity" | "NaN"
          readonly expires: number | "Infinity" | "-Infinity" | "NaN"
        }
      }
    | {
        readonly status: "expired"
        readonly time: {
          readonly created: number | "Infinity" | "-Infinity" | "NaN"
          readonly expires: number | "Infinity" | "-Infinity" | "NaN"
        }
      }
}

export type IntegrationsAttemptCompleteInput = {
  readonly attemptID: { readonly attemptID: string }["attemptID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
  readonly code?: { readonly code?: string | undefined }["code"]
}

export type IntegrationsAttemptCompleteOutput = void

export type IntegrationsAttemptCancelInput = {
  readonly attemptID: { readonly attemptID: string }["attemptID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type IntegrationsAttemptCancelOutput = void

export type CredentialsUpdateInput = {
  readonly credentialID: { readonly credentialID: string }["credentialID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
  readonly label: { readonly label: string }["label"]
}

export type CredentialsUpdateOutput = void

export type CredentialsRemoveInput = {
  readonly credentialID: { readonly credentialID: string }["credentialID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type CredentialsRemoveOutput = void

export type PermissionsListRequestsInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type PermissionsListRequestsOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: ReadonlyArray<{
    readonly id: string
    readonly sessionID: string
    readonly action: string
    readonly resources: ReadonlyArray<string>
    readonly save?: ReadonlyArray<string>
    readonly metadata?: { readonly [x: string]: JsonValue }
    readonly source?: { readonly type: "tool"; readonly messageID: string; readonly callID: string }
    readonly requiresHumanConfirmation?: boolean
  }>
}

export type PermissionsListSavedInput = {
  readonly projectID?: { readonly projectID?: string | undefined }["projectID"]
}

export type PermissionsListSavedOutput = {
  readonly data: ReadonlyArray<{
    readonly id: string
    readonly projectID: string
    readonly action: string
    readonly resource: string
  }>
}["data"]

export type PermissionsRemoveSavedInput = { readonly id: { readonly id: string }["id"] }

export type PermissionsRemoveSavedOutput = void

export type PermissionsCreateInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly id?: {
    readonly id?: string | null
    readonly action: string
    readonly resources: ReadonlyArray<string>
    readonly save?: ReadonlyArray<string>
    readonly metadata?: { readonly [x: string]: JsonValue }
    readonly source?: { readonly type: "tool"; readonly messageID: string; readonly callID: string }
    readonly agent?: string | null
  }["id"]
  readonly action: {
    readonly id?: string | null
    readonly action: string
    readonly resources: ReadonlyArray<string>
    readonly save?: ReadonlyArray<string>
    readonly metadata?: { readonly [x: string]: JsonValue }
    readonly source?: { readonly type: "tool"; readonly messageID: string; readonly callID: string }
    readonly agent?: string | null
  }["action"]
  readonly resources: {
    readonly id?: string | null
    readonly action: string
    readonly resources: ReadonlyArray<string>
    readonly save?: ReadonlyArray<string>
    readonly metadata?: { readonly [x: string]: JsonValue }
    readonly source?: { readonly type: "tool"; readonly messageID: string; readonly callID: string }
    readonly agent?: string | null
  }["resources"]
  readonly save?: {
    readonly id?: string | null
    readonly action: string
    readonly resources: ReadonlyArray<string>
    readonly save?: ReadonlyArray<string>
    readonly metadata?: { readonly [x: string]: JsonValue }
    readonly source?: { readonly type: "tool"; readonly messageID: string; readonly callID: string }
    readonly agent?: string | null
  }["save"]
  readonly metadata?: {
    readonly id?: string | null
    readonly action: string
    readonly resources: ReadonlyArray<string>
    readonly save?: ReadonlyArray<string>
    readonly metadata?: { readonly [x: string]: JsonValue }
    readonly source?: { readonly type: "tool"; readonly messageID: string; readonly callID: string }
    readonly agent?: string | null
  }["metadata"]
  readonly source?: {
    readonly id?: string | null
    readonly action: string
    readonly resources: ReadonlyArray<string>
    readonly save?: ReadonlyArray<string>
    readonly metadata?: { readonly [x: string]: JsonValue }
    readonly source?: { readonly type: "tool"; readonly messageID: string; readonly callID: string }
    readonly agent?: string | null
  }["source"]
  readonly agent?: {
    readonly id?: string | null
    readonly action: string
    readonly resources: ReadonlyArray<string>
    readonly save?: ReadonlyArray<string>
    readonly metadata?: { readonly [x: string]: JsonValue }
    readonly source?: { readonly type: "tool"; readonly messageID: string; readonly callID: string }
    readonly agent?: string | null
  }["agent"]
}

export type PermissionsCreateOutput = {
  readonly data: { readonly id: string; readonly effect: "allow" | "deny" | "ask" }
}["data"]

export type PermissionsListInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type PermissionsListOutput = {
  readonly data: ReadonlyArray<{
    readonly id: string
    readonly sessionID: string
    readonly action: string
    readonly resources: ReadonlyArray<string>
    readonly save?: ReadonlyArray<string>
    readonly metadata?: { readonly [x: string]: JsonValue }
    readonly source?: { readonly type: "tool"; readonly messageID: string; readonly callID: string }
    readonly requiresHumanConfirmation?: boolean
  }>
}["data"]

export type PermissionsGetInput = {
  readonly sessionID: { readonly sessionID: string; readonly requestID: string }["sessionID"]
  readonly requestID: { readonly sessionID: string; readonly requestID: string }["requestID"]
}

export type PermissionsGetOutput = {
  readonly data: {
    readonly id: string
    readonly sessionID: string
    readonly action: string
    readonly resources: ReadonlyArray<string>
    readonly save?: ReadonlyArray<string>
    readonly metadata?: { readonly [x: string]: JsonValue }
    readonly source?: { readonly type: "tool"; readonly messageID: string; readonly callID: string }
    readonly requiresHumanConfirmation?: boolean
  }
}["data"]

export type PermissionsReplyInput = {
  readonly sessionID: { readonly sessionID: string; readonly requestID: string }["sessionID"]
  readonly requestID: { readonly sessionID: string; readonly requestID: string }["requestID"]
  readonly reply: { readonly reply: "once" | "always" | "reject"; readonly message?: string | undefined }["reply"]
  readonly message?: { readonly reply: "once" | "always" | "reject"; readonly message?: string | undefined }["message"]
}

export type PermissionsReplyOutput = void

export type FilesOpenInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
  readonly path: { readonly path: string }["path"]
}

export type FilesOpenOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly id: string
    readonly documentPath: string
    readonly baseURL: string
    readonly expiresAt: number | "Infinity" | "-Infinity" | "NaN"
  }
}

export type FilesCloseInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
  readonly id: { readonly id: string }["id"]
}

export type FilesCloseOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: { readonly revoked: boolean }
}

export type FilesReadInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly path: string
  }["location"]
  readonly path: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly path: string
  }["path"]
}

export type FilesReadOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly path: string
    readonly text: string
    readonly version: string
    readonly bom: boolean
    readonly lineEnding: "lf" | "crlf"
  }
}

export type FilesSaveInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
  readonly path: { readonly path: string; readonly baseVersion: string; readonly text: string }["path"]
  readonly baseVersion: { readonly path: string; readonly baseVersion: string; readonly text: string }["baseVersion"]
  readonly text: { readonly path: string; readonly baseVersion: string; readonly text: string }["text"]
}

export type FilesSaveOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly path: string
    readonly text: string
    readonly version: string
    readonly bom: boolean
    readonly lineEnding: "lf" | "crlf"
  }
}

export type FilesListInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly path?: string | undefined
  }["location"]
  readonly path?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly path?: string | undefined
  }["path"]
}

export type FilesListOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: ReadonlyArray<{ readonly path: string; readonly type: "file" | "directory" }>
}

export type FilesFindInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly query: string
    readonly type?: "file" | "directory" | undefined
    readonly limit?: number | undefined
  }["location"]
  readonly query: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly query: string
    readonly type?: "file" | "directory" | undefined
    readonly limit?: number | undefined
  }["query"]
  readonly type?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly query: string
    readonly type?: "file" | "directory" | undefined
    readonly limit?: number | undefined
  }["type"]
  readonly limit?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly query: string
    readonly type?: "file" | "directory" | undefined
    readonly limit?: number | undefined
  }["limit"]
}

export type FilesFindOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: ReadonlyArray<{ readonly path: string; readonly type: "file" | "directory" }>
}

export type CommandsListInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type CommandsListOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: ReadonlyArray<{
    readonly name: string
    readonly template: string
    readonly description?: string
    readonly agent?: string
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
    readonly subtask?: boolean
  }>
}

export type SkillsListInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type SkillsListOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: ReadonlyArray<{
    readonly name: string
    readonly description?: string
    readonly slash?: boolean
    readonly location: string
    readonly content: string
  }>
}

export type EventsSubscribeOutput = ArforgeEventEncoded

export type PtysListInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type PtysListOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: ReadonlyArray<{
    readonly id: string
    readonly title: string
    readonly command: string
    readonly args: ReadonlyArray<string>
    readonly cwd: string
    readonly status: "running" | "exited"
    readonly pid: number
    readonly exitCode?: number
  }>
}

export type PtysCreateInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
  readonly command?: {
    readonly command?: string
    readonly args?: ReadonlyArray<string>
    readonly cwd?: string
    readonly title?: string
    readonly env?: { readonly [x: string]: string }
  }["command"]
  readonly args?: {
    readonly command?: string
    readonly args?: ReadonlyArray<string>
    readonly cwd?: string
    readonly title?: string
    readonly env?: { readonly [x: string]: string }
  }["args"]
  readonly cwd?: {
    readonly command?: string
    readonly args?: ReadonlyArray<string>
    readonly cwd?: string
    readonly title?: string
    readonly env?: { readonly [x: string]: string }
  }["cwd"]
  readonly title?: {
    readonly command?: string
    readonly args?: ReadonlyArray<string>
    readonly cwd?: string
    readonly title?: string
    readonly env?: { readonly [x: string]: string }
  }["title"]
  readonly env?: {
    readonly command?: string
    readonly args?: ReadonlyArray<string>
    readonly cwd?: string
    readonly title?: string
    readonly env?: { readonly [x: string]: string }
  }["env"]
}

export type PtysCreateOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly id: string
    readonly title: string
    readonly command: string
    readonly args: ReadonlyArray<string>
    readonly cwd: string
    readonly status: "running" | "exited"
    readonly pid: number
    readonly exitCode?: number
  }
}

export type PtysGetInput = {
  readonly ptyID: { readonly ptyID: string }["ptyID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type PtysGetOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly id: string
    readonly title: string
    readonly command: string
    readonly args: ReadonlyArray<string>
    readonly cwd: string
    readonly status: "running" | "exited"
    readonly pid: number
    readonly exitCode?: number
  }
}

export type PtysUpdateInput = {
  readonly ptyID: { readonly ptyID: string }["ptyID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
  readonly title?: {
    readonly title?: string
    readonly size?: { readonly rows: number; readonly cols: number }
  }["title"]
  readonly size?: { readonly title?: string; readonly size?: { readonly rows: number; readonly cols: number } }["size"]
}

export type PtysUpdateOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly id: string
    readonly title: string
    readonly command: string
    readonly args: ReadonlyArray<string>
    readonly cwd: string
    readonly status: "running" | "exited"
    readonly pid: number
    readonly exitCode?: number
  }
}

export type PtysRemoveInput = {
  readonly ptyID: { readonly ptyID: string }["ptyID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type PtysRemoveOutput = void

export type QuestionsListRequestsInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type QuestionsListRequestsOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: ReadonlyArray<{
    readonly id: string
    readonly sessionID: string
    readonly questions: ReadonlyArray<{
      readonly question: string
      readonly header: string
      readonly options: ReadonlyArray<{ readonly label: string; readonly description: string }>
      readonly multiple?: boolean
      readonly custom?: boolean
    }>
    readonly tool?: { readonly messageID: string; readonly callID: string }
  }>
}

export type QuestionsListInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type QuestionsListOutput = {
  readonly data: ReadonlyArray<{
    readonly id: string
    readonly sessionID: string
    readonly questions: ReadonlyArray<{
      readonly question: string
      readonly header: string
      readonly options: ReadonlyArray<{ readonly label: string; readonly description: string }>
      readonly multiple?: boolean
      readonly custom?: boolean
    }>
    readonly tool?: { readonly messageID: string; readonly callID: string }
  }>
}["data"]

export type QuestionsReplyInput = {
  readonly sessionID: { readonly sessionID: string; readonly requestID: string }["sessionID"]
  readonly requestID: { readonly sessionID: string; readonly requestID: string }["requestID"]
  readonly answers: { readonly answers: ReadonlyArray<ReadonlyArray<string>> }["answers"]
}

export type QuestionsReplyOutput = void

export type QuestionsRejectInput = {
  readonly sessionID: { readonly sessionID: string; readonly requestID: string }["sessionID"]
  readonly requestID: { readonly sessionID: string; readonly requestID: string }["requestID"]
}

export type QuestionsRejectOutput = void

export type ReferencesListInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type ReferencesListOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: ReadonlyArray<{
    readonly name: string
    readonly path: string
    readonly description?: string
    readonly hidden?: boolean
    readonly source:
      | { readonly type: "local"; readonly path: string; readonly description?: string; readonly hidden?: boolean }
      | {
          readonly type: "git"
          readonly repository: string
          readonly branch?: string
          readonly description?: string
          readonly hidden?: boolean
        }
  }>
}

export type ProjectCopiesListInput = {
  readonly projectID: { readonly projectID: string }["projectID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type ProjectCopiesListOutput = ReadonlyArray<{
  readonly directory: string
  readonly type: "root" | "copy"
  readonly strategy?: string
}>

export type ProjectCopiesCreateInput = {
  readonly projectID: { readonly projectID: string }["projectID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
  readonly strategy: { readonly strategy: string; readonly directory: string; readonly name?: string }["strategy"]
  readonly directory: { readonly strategy: string; readonly directory: string; readonly name?: string }["directory"]
  readonly name?: { readonly strategy: string; readonly directory: string; readonly name?: string }["name"]
}

export type ProjectCopiesCreateOutput = { readonly directory: string }

export type ProjectCopiesRemoveInput = {
  readonly projectID: { readonly projectID: string }["projectID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
  readonly directory: { readonly directory: string; readonly force: boolean }["directory"]
  readonly force: { readonly directory: string; readonly force: boolean }["force"]
}

export type ProjectCopiesRemoveOutput = void

export type ProjectCopiesRefreshInput = {
  readonly projectID: { readonly projectID: string }["projectID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type ProjectCopiesRefreshOutput = void

export type PersonalJobsCreateInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly idempotencyKey: {
    readonly idempotencyKey: string
    readonly title: string
    readonly prompt: string
    readonly schedule: {
      readonly kind: "once" | "cron"
      readonly label: string
      readonly cron?: string
      readonly nextRunAt: number
      readonly timezone: string
      readonly scheduledPromptID?: string
    }
    readonly credentialIDs?: ReadonlyArray<string> | null
    readonly budget: { readonly maxAttempts: number; readonly maxDurationMs: number; readonly maxCostMicros: number }
    readonly approvalPolicy: { readonly mode: "automatic" | "user_once" | "user_each_run"; readonly rationale: string }
    readonly quietHours?: { readonly timezone: string; readonly startMinute: number; readonly endMinute: number } | null
    readonly notificationPolicy?: {
      readonly mode: "none" | "in_app"
      readonly events: ReadonlyArray<
        "approval_required" | "started" | "completed" | "failed" | "paused" | "cancelled" | "budget_exhausted"
      >
    } | null
    readonly retainUntil?: number | null
  }["idempotencyKey"]
  readonly title: {
    readonly idempotencyKey: string
    readonly title: string
    readonly prompt: string
    readonly schedule: {
      readonly kind: "once" | "cron"
      readonly label: string
      readonly cron?: string
      readonly nextRunAt: number
      readonly timezone: string
      readonly scheduledPromptID?: string
    }
    readonly credentialIDs?: ReadonlyArray<string> | null
    readonly budget: { readonly maxAttempts: number; readonly maxDurationMs: number; readonly maxCostMicros: number }
    readonly approvalPolicy: { readonly mode: "automatic" | "user_once" | "user_each_run"; readonly rationale: string }
    readonly quietHours?: { readonly timezone: string; readonly startMinute: number; readonly endMinute: number } | null
    readonly notificationPolicy?: {
      readonly mode: "none" | "in_app"
      readonly events: ReadonlyArray<
        "approval_required" | "started" | "completed" | "failed" | "paused" | "cancelled" | "budget_exhausted"
      >
    } | null
    readonly retainUntil?: number | null
  }["title"]
  readonly prompt: {
    readonly idempotencyKey: string
    readonly title: string
    readonly prompt: string
    readonly schedule: {
      readonly kind: "once" | "cron"
      readonly label: string
      readonly cron?: string
      readonly nextRunAt: number
      readonly timezone: string
      readonly scheduledPromptID?: string
    }
    readonly credentialIDs?: ReadonlyArray<string> | null
    readonly budget: { readonly maxAttempts: number; readonly maxDurationMs: number; readonly maxCostMicros: number }
    readonly approvalPolicy: { readonly mode: "automatic" | "user_once" | "user_each_run"; readonly rationale: string }
    readonly quietHours?: { readonly timezone: string; readonly startMinute: number; readonly endMinute: number } | null
    readonly notificationPolicy?: {
      readonly mode: "none" | "in_app"
      readonly events: ReadonlyArray<
        "approval_required" | "started" | "completed" | "failed" | "paused" | "cancelled" | "budget_exhausted"
      >
    } | null
    readonly retainUntil?: number | null
  }["prompt"]
  readonly schedule: {
    readonly idempotencyKey: string
    readonly title: string
    readonly prompt: string
    readonly schedule: {
      readonly kind: "once" | "cron"
      readonly label: string
      readonly cron?: string
      readonly nextRunAt: number
      readonly timezone: string
      readonly scheduledPromptID?: string
    }
    readonly credentialIDs?: ReadonlyArray<string> | null
    readonly budget: { readonly maxAttempts: number; readonly maxDurationMs: number; readonly maxCostMicros: number }
    readonly approvalPolicy: { readonly mode: "automatic" | "user_once" | "user_each_run"; readonly rationale: string }
    readonly quietHours?: { readonly timezone: string; readonly startMinute: number; readonly endMinute: number } | null
    readonly notificationPolicy?: {
      readonly mode: "none" | "in_app"
      readonly events: ReadonlyArray<
        "approval_required" | "started" | "completed" | "failed" | "paused" | "cancelled" | "budget_exhausted"
      >
    } | null
    readonly retainUntil?: number | null
  }["schedule"]
  readonly credentialIDs?: {
    readonly idempotencyKey: string
    readonly title: string
    readonly prompt: string
    readonly schedule: {
      readonly kind: "once" | "cron"
      readonly label: string
      readonly cron?: string
      readonly nextRunAt: number
      readonly timezone: string
      readonly scheduledPromptID?: string
    }
    readonly credentialIDs?: ReadonlyArray<string> | null
    readonly budget: { readonly maxAttempts: number; readonly maxDurationMs: number; readonly maxCostMicros: number }
    readonly approvalPolicy: { readonly mode: "automatic" | "user_once" | "user_each_run"; readonly rationale: string }
    readonly quietHours?: { readonly timezone: string; readonly startMinute: number; readonly endMinute: number } | null
    readonly notificationPolicy?: {
      readonly mode: "none" | "in_app"
      readonly events: ReadonlyArray<
        "approval_required" | "started" | "completed" | "failed" | "paused" | "cancelled" | "budget_exhausted"
      >
    } | null
    readonly retainUntil?: number | null
  }["credentialIDs"]
  readonly budget: {
    readonly idempotencyKey: string
    readonly title: string
    readonly prompt: string
    readonly schedule: {
      readonly kind: "once" | "cron"
      readonly label: string
      readonly cron?: string
      readonly nextRunAt: number
      readonly timezone: string
      readonly scheduledPromptID?: string
    }
    readonly credentialIDs?: ReadonlyArray<string> | null
    readonly budget: { readonly maxAttempts: number; readonly maxDurationMs: number; readonly maxCostMicros: number }
    readonly approvalPolicy: { readonly mode: "automatic" | "user_once" | "user_each_run"; readonly rationale: string }
    readonly quietHours?: { readonly timezone: string; readonly startMinute: number; readonly endMinute: number } | null
    readonly notificationPolicy?: {
      readonly mode: "none" | "in_app"
      readonly events: ReadonlyArray<
        "approval_required" | "started" | "completed" | "failed" | "paused" | "cancelled" | "budget_exhausted"
      >
    } | null
    readonly retainUntil?: number | null
  }["budget"]
  readonly approvalPolicy: {
    readonly idempotencyKey: string
    readonly title: string
    readonly prompt: string
    readonly schedule: {
      readonly kind: "once" | "cron"
      readonly label: string
      readonly cron?: string
      readonly nextRunAt: number
      readonly timezone: string
      readonly scheduledPromptID?: string
    }
    readonly credentialIDs?: ReadonlyArray<string> | null
    readonly budget: { readonly maxAttempts: number; readonly maxDurationMs: number; readonly maxCostMicros: number }
    readonly approvalPolicy: { readonly mode: "automatic" | "user_once" | "user_each_run"; readonly rationale: string }
    readonly quietHours?: { readonly timezone: string; readonly startMinute: number; readonly endMinute: number } | null
    readonly notificationPolicy?: {
      readonly mode: "none" | "in_app"
      readonly events: ReadonlyArray<
        "approval_required" | "started" | "completed" | "failed" | "paused" | "cancelled" | "budget_exhausted"
      >
    } | null
    readonly retainUntil?: number | null
  }["approvalPolicy"]
  readonly quietHours?: {
    readonly idempotencyKey: string
    readonly title: string
    readonly prompt: string
    readonly schedule: {
      readonly kind: "once" | "cron"
      readonly label: string
      readonly cron?: string
      readonly nextRunAt: number
      readonly timezone: string
      readonly scheduledPromptID?: string
    }
    readonly credentialIDs?: ReadonlyArray<string> | null
    readonly budget: { readonly maxAttempts: number; readonly maxDurationMs: number; readonly maxCostMicros: number }
    readonly approvalPolicy: { readonly mode: "automatic" | "user_once" | "user_each_run"; readonly rationale: string }
    readonly quietHours?: { readonly timezone: string; readonly startMinute: number; readonly endMinute: number } | null
    readonly notificationPolicy?: {
      readonly mode: "none" | "in_app"
      readonly events: ReadonlyArray<
        "approval_required" | "started" | "completed" | "failed" | "paused" | "cancelled" | "budget_exhausted"
      >
    } | null
    readonly retainUntil?: number | null
  }["quietHours"]
  readonly notificationPolicy?: {
    readonly idempotencyKey: string
    readonly title: string
    readonly prompt: string
    readonly schedule: {
      readonly kind: "once" | "cron"
      readonly label: string
      readonly cron?: string
      readonly nextRunAt: number
      readonly timezone: string
      readonly scheduledPromptID?: string
    }
    readonly credentialIDs?: ReadonlyArray<string> | null
    readonly budget: { readonly maxAttempts: number; readonly maxDurationMs: number; readonly maxCostMicros: number }
    readonly approvalPolicy: { readonly mode: "automatic" | "user_once" | "user_each_run"; readonly rationale: string }
    readonly quietHours?: { readonly timezone: string; readonly startMinute: number; readonly endMinute: number } | null
    readonly notificationPolicy?: {
      readonly mode: "none" | "in_app"
      readonly events: ReadonlyArray<
        "approval_required" | "started" | "completed" | "failed" | "paused" | "cancelled" | "budget_exhausted"
      >
    } | null
    readonly retainUntil?: number | null
  }["notificationPolicy"]
  readonly retainUntil?: {
    readonly idempotencyKey: string
    readonly title: string
    readonly prompt: string
    readonly schedule: {
      readonly kind: "once" | "cron"
      readonly label: string
      readonly cron?: string
      readonly nextRunAt: number
      readonly timezone: string
      readonly scheduledPromptID?: string
    }
    readonly credentialIDs?: ReadonlyArray<string> | null
    readonly budget: { readonly maxAttempts: number; readonly maxDurationMs: number; readonly maxCostMicros: number }
    readonly approvalPolicy: { readonly mode: "automatic" | "user_once" | "user_each_run"; readonly rationale: string }
    readonly quietHours?: { readonly timezone: string; readonly startMinute: number; readonly endMinute: number } | null
    readonly notificationPolicy?: {
      readonly mode: "none" | "in_app"
      readonly events: ReadonlyArray<
        "approval_required" | "started" | "completed" | "failed" | "paused" | "cancelled" | "budget_exhausted"
      >
    } | null
    readonly retainUntil?: number | null
  }["retainUntil"]
}

export type PersonalJobsCreateOutput = {
  readonly data: {
    readonly id: string
    readonly sessionID: string
    readonly title: string
    readonly prompt: string
    readonly status: "awaiting_approval" | "queued" | "running" | "paused" | "completed" | "failed" | "cancelled"
    readonly visibility: { readonly mode: "background"; readonly label: "后台自动"; readonly userVisible: true }
    readonly schedule: {
      readonly kind: "once" | "cron"
      readonly label: string
      readonly cron?: string
      readonly nextRunAt: number
      readonly timezone: string
      readonly scheduledPromptID?: string
    }
    readonly credentialIDs: ReadonlyArray<string>
    readonly budget: {
      readonly maxAttempts: number
      readonly maxDurationMs: number
      readonly maxCostMicros: number
      readonly attemptsUsed: number
      readonly durationMsUsed: number
      readonly costMicrosUsed: number
    }
    readonly approvalPolicy: { readonly mode: "automatic" | "user_once" | "user_each_run"; readonly rationale: string }
    readonly approvalState: "not_required" | "pending" | "approved" | "rejected"
    readonly execution?: { readonly leaseID: string; readonly heartbeatAt: number }
    readonly occurrence?: { readonly version: 1; readonly messageID: string; readonly digest: string }
    readonly quietHours?: { readonly timezone: string; readonly startMinute: number; readonly endMinute: number }
    readonly notificationPolicy: {
      readonly mode: "none" | "in_app"
      readonly events: ReadonlyArray<
        "approval_required" | "started" | "completed" | "failed" | "paused" | "cancelled" | "budget_exhausted"
      >
    }
    readonly notifications: ReadonlyArray<{
      readonly id: string
      readonly jobID: string
      readonly kind:
        | "approval_required"
        | "started"
        | "completed"
        | "failed"
        | "paused"
        | "cancelled"
        | "budget_exhausted"
      readonly title: string
      readonly body: string
      readonly availableAt: number
      readonly readAt?: number
    }>
    readonly result?: {
      readonly status: "completed" | "failed"
      readonly summary: string
      readonly digest: string
      readonly artifactRefs: ReadonlyArray<string>
      readonly artifacts?: ReadonlyArray<{
        readonly id: string
        readonly artifactRef?: {
          readonly version: 1
          readonly artifactID: string
          readonly kind: string
          readonly digest: string
          readonly mime: string
          readonly sizeBytes: number
          readonly owner: { readonly scope: "session" | "profile" | "tenant"; readonly id: string }
          readonly retention: { readonly mode: "ephemeral" | "session" | "durable"; readonly expiresAt?: number }
          readonly retrievalHint: { readonly kind: "managed"; readonly handle: string }
          readonly label?: string
          readonly createdAt: number
        }
        readonly kind: "primary_delivery" | "tool_output" | "session_snapshot"
        readonly uri: string
        readonly name: string
        readonly mime: string
        readonly sizeBytes: number
        readonly digest: string
      }>
      readonly usage: { readonly durationMs: number; readonly costMicros: number }
      readonly recordedAt: number
    }
    readonly retention: { readonly retainUntil?: number }
    readonly admissionDigest: string
    readonly lastError: string
    readonly revision: number
    readonly time: {
      readonly created: number
      readonly updated: number
      readonly started?: number
      readonly finished?: number
    }
  }
}["data"]

export type PersonalJobsListInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly status?: {
    readonly status?:
      | ("awaiting_approval" | "queued" | "running" | "paused" | "completed" | "failed" | "cancelled")
      | undefined
  }["status"]
}

export type PersonalJobsListOutput = {
  readonly data: ReadonlyArray<{
    readonly id: string
    readonly sessionID: string
    readonly title: string
    readonly prompt: string
    readonly status: "awaiting_approval" | "queued" | "running" | "paused" | "completed" | "failed" | "cancelled"
    readonly visibility: { readonly mode: "background"; readonly label: "后台自动"; readonly userVisible: true }
    readonly schedule: {
      readonly kind: "once" | "cron"
      readonly label: string
      readonly cron?: string
      readonly nextRunAt: number
      readonly timezone: string
      readonly scheduledPromptID?: string
    }
    readonly credentialIDs: ReadonlyArray<string>
    readonly budget: {
      readonly maxAttempts: number
      readonly maxDurationMs: number
      readonly maxCostMicros: number
      readonly attemptsUsed: number
      readonly durationMsUsed: number
      readonly costMicrosUsed: number
    }
    readonly approvalPolicy: { readonly mode: "automatic" | "user_once" | "user_each_run"; readonly rationale: string }
    readonly approvalState: "not_required" | "pending" | "approved" | "rejected"
    readonly execution?: { readonly leaseID: string; readonly heartbeatAt: number }
    readonly occurrence?: { readonly version: 1; readonly messageID: string; readonly digest: string }
    readonly quietHours?: { readonly timezone: string; readonly startMinute: number; readonly endMinute: number }
    readonly notificationPolicy: {
      readonly mode: "none" | "in_app"
      readonly events: ReadonlyArray<
        "approval_required" | "started" | "completed" | "failed" | "paused" | "cancelled" | "budget_exhausted"
      >
    }
    readonly notifications: ReadonlyArray<{
      readonly id: string
      readonly jobID: string
      readonly kind:
        | "approval_required"
        | "started"
        | "completed"
        | "failed"
        | "paused"
        | "cancelled"
        | "budget_exhausted"
      readonly title: string
      readonly body: string
      readonly availableAt: number
      readonly readAt?: number
    }>
    readonly result?: {
      readonly status: "completed" | "failed"
      readonly summary: string
      readonly digest: string
      readonly artifactRefs: ReadonlyArray<string>
      readonly artifacts?: ReadonlyArray<{
        readonly id: string
        readonly artifactRef?: {
          readonly version: 1
          readonly artifactID: string
          readonly kind: string
          readonly digest: string
          readonly mime: string
          readonly sizeBytes: number
          readonly owner: { readonly scope: "session" | "profile" | "tenant"; readonly id: string }
          readonly retention: { readonly mode: "ephemeral" | "session" | "durable"; readonly expiresAt?: number }
          readonly retrievalHint: { readonly kind: "managed"; readonly handle: string }
          readonly label?: string
          readonly createdAt: number
        }
        readonly kind: "primary_delivery" | "tool_output" | "session_snapshot"
        readonly uri: string
        readonly name: string
        readonly mime: string
        readonly sizeBytes: number
        readonly digest: string
      }>
      readonly usage: { readonly durationMs: number; readonly costMicros: number }
      readonly recordedAt: number
    }
    readonly retention: { readonly retainUntil?: number }
    readonly admissionDigest: string
    readonly lastError: string
    readonly revision: number
    readonly time: {
      readonly created: number
      readonly updated: number
      readonly started?: number
      readonly finished?: number
    }
  }>
}["data"]

export type PersonalJobsGetInput = {
  readonly sessionID: { readonly sessionID: string; readonly jobID: string }["sessionID"]
  readonly jobID: { readonly sessionID: string; readonly jobID: string }["jobID"]
}

export type PersonalJobsGetOutput = {
  readonly data: {
    readonly id: string
    readonly sessionID: string
    readonly title: string
    readonly prompt: string
    readonly status: "awaiting_approval" | "queued" | "running" | "paused" | "completed" | "failed" | "cancelled"
    readonly visibility: { readonly mode: "background"; readonly label: "后台自动"; readonly userVisible: true }
    readonly schedule: {
      readonly kind: "once" | "cron"
      readonly label: string
      readonly cron?: string
      readonly nextRunAt: number
      readonly timezone: string
      readonly scheduledPromptID?: string
    }
    readonly credentialIDs: ReadonlyArray<string>
    readonly budget: {
      readonly maxAttempts: number
      readonly maxDurationMs: number
      readonly maxCostMicros: number
      readonly attemptsUsed: number
      readonly durationMsUsed: number
      readonly costMicrosUsed: number
    }
    readonly approvalPolicy: { readonly mode: "automatic" | "user_once" | "user_each_run"; readonly rationale: string }
    readonly approvalState: "not_required" | "pending" | "approved" | "rejected"
    readonly execution?: { readonly leaseID: string; readonly heartbeatAt: number }
    readonly occurrence?: { readonly version: 1; readonly messageID: string; readonly digest: string }
    readonly quietHours?: { readonly timezone: string; readonly startMinute: number; readonly endMinute: number }
    readonly notificationPolicy: {
      readonly mode: "none" | "in_app"
      readonly events: ReadonlyArray<
        "approval_required" | "started" | "completed" | "failed" | "paused" | "cancelled" | "budget_exhausted"
      >
    }
    readonly notifications: ReadonlyArray<{
      readonly id: string
      readonly jobID: string
      readonly kind:
        | "approval_required"
        | "started"
        | "completed"
        | "failed"
        | "paused"
        | "cancelled"
        | "budget_exhausted"
      readonly title: string
      readonly body: string
      readonly availableAt: number
      readonly readAt?: number
    }>
    readonly result?: {
      readonly status: "completed" | "failed"
      readonly summary: string
      readonly digest: string
      readonly artifactRefs: ReadonlyArray<string>
      readonly artifacts?: ReadonlyArray<{
        readonly id: string
        readonly artifactRef?: {
          readonly version: 1
          readonly artifactID: string
          readonly kind: string
          readonly digest: string
          readonly mime: string
          readonly sizeBytes: number
          readonly owner: { readonly scope: "session" | "profile" | "tenant"; readonly id: string }
          readonly retention: { readonly mode: "ephemeral" | "session" | "durable"; readonly expiresAt?: number }
          readonly retrievalHint: { readonly kind: "managed"; readonly handle: string }
          readonly label?: string
          readonly createdAt: number
        }
        readonly kind: "primary_delivery" | "tool_output" | "session_snapshot"
        readonly uri: string
        readonly name: string
        readonly mime: string
        readonly sizeBytes: number
        readonly digest: string
      }>
      readonly usage: { readonly durationMs: number; readonly costMicros: number }
      readonly recordedAt: number
    }
    readonly retention: { readonly retainUntil?: number }
    readonly admissionDigest: string
    readonly lastError: string
    readonly revision: number
    readonly time: {
      readonly created: number
      readonly updated: number
      readonly started?: number
      readonly finished?: number
    }
  }
}["data"]

export type PersonalJobsApproveInput = {
  readonly sessionID: { readonly sessionID: string; readonly jobID: string }["sessionID"]
  readonly jobID: { readonly sessionID: string; readonly jobID: string }["jobID"]
  readonly expectedRevision: { readonly expectedRevision: number }["expectedRevision"]
}

export type PersonalJobsApproveOutput = {
  readonly data: {
    readonly id: string
    readonly sessionID: string
    readonly title: string
    readonly prompt: string
    readonly status: "awaiting_approval" | "queued" | "running" | "paused" | "completed" | "failed" | "cancelled"
    readonly visibility: { readonly mode: "background"; readonly label: "后台自动"; readonly userVisible: true }
    readonly schedule: {
      readonly kind: "once" | "cron"
      readonly label: string
      readonly cron?: string
      readonly nextRunAt: number
      readonly timezone: string
      readonly scheduledPromptID?: string
    }
    readonly credentialIDs: ReadonlyArray<string>
    readonly budget: {
      readonly maxAttempts: number
      readonly maxDurationMs: number
      readonly maxCostMicros: number
      readonly attemptsUsed: number
      readonly durationMsUsed: number
      readonly costMicrosUsed: number
    }
    readonly approvalPolicy: { readonly mode: "automatic" | "user_once" | "user_each_run"; readonly rationale: string }
    readonly approvalState: "not_required" | "pending" | "approved" | "rejected"
    readonly execution?: { readonly leaseID: string; readonly heartbeatAt: number }
    readonly occurrence?: { readonly version: 1; readonly messageID: string; readonly digest: string }
    readonly quietHours?: { readonly timezone: string; readonly startMinute: number; readonly endMinute: number }
    readonly notificationPolicy: {
      readonly mode: "none" | "in_app"
      readonly events: ReadonlyArray<
        "approval_required" | "started" | "completed" | "failed" | "paused" | "cancelled" | "budget_exhausted"
      >
    }
    readonly notifications: ReadonlyArray<{
      readonly id: string
      readonly jobID: string
      readonly kind:
        | "approval_required"
        | "started"
        | "completed"
        | "failed"
        | "paused"
        | "cancelled"
        | "budget_exhausted"
      readonly title: string
      readonly body: string
      readonly availableAt: number
      readonly readAt?: number
    }>
    readonly result?: {
      readonly status: "completed" | "failed"
      readonly summary: string
      readonly digest: string
      readonly artifactRefs: ReadonlyArray<string>
      readonly artifacts?: ReadonlyArray<{
        readonly id: string
        readonly artifactRef?: {
          readonly version: 1
          readonly artifactID: string
          readonly kind: string
          readonly digest: string
          readonly mime: string
          readonly sizeBytes: number
          readonly owner: { readonly scope: "session" | "profile" | "tenant"; readonly id: string }
          readonly retention: { readonly mode: "ephemeral" | "session" | "durable"; readonly expiresAt?: number }
          readonly retrievalHint: { readonly kind: "managed"; readonly handle: string }
          readonly label?: string
          readonly createdAt: number
        }
        readonly kind: "primary_delivery" | "tool_output" | "session_snapshot"
        readonly uri: string
        readonly name: string
        readonly mime: string
        readonly sizeBytes: number
        readonly digest: string
      }>
      readonly usage: { readonly durationMs: number; readonly costMicros: number }
      readonly recordedAt: number
    }
    readonly retention: { readonly retainUntil?: number }
    readonly admissionDigest: string
    readonly lastError: string
    readonly revision: number
    readonly time: {
      readonly created: number
      readonly updated: number
      readonly started?: number
      readonly finished?: number
    }
  }
}["data"]

export type PersonalJobsRejectInput = {
  readonly sessionID: { readonly sessionID: string; readonly jobID: string }["sessionID"]
  readonly jobID: { readonly sessionID: string; readonly jobID: string }["jobID"]
  readonly expectedRevision: {
    readonly expectedRevision: number
    readonly reason?: string | undefined
  }["expectedRevision"]
  readonly reason?: { readonly expectedRevision: number; readonly reason?: string | undefined }["reason"]
}

export type PersonalJobsRejectOutput = {
  readonly data: {
    readonly id: string
    readonly sessionID: string
    readonly title: string
    readonly prompt: string
    readonly status: "awaiting_approval" | "queued" | "running" | "paused" | "completed" | "failed" | "cancelled"
    readonly visibility: { readonly mode: "background"; readonly label: "后台自动"; readonly userVisible: true }
    readonly schedule: {
      readonly kind: "once" | "cron"
      readonly label: string
      readonly cron?: string
      readonly nextRunAt: number
      readonly timezone: string
      readonly scheduledPromptID?: string
    }
    readonly credentialIDs: ReadonlyArray<string>
    readonly budget: {
      readonly maxAttempts: number
      readonly maxDurationMs: number
      readonly maxCostMicros: number
      readonly attemptsUsed: number
      readonly durationMsUsed: number
      readonly costMicrosUsed: number
    }
    readonly approvalPolicy: { readonly mode: "automatic" | "user_once" | "user_each_run"; readonly rationale: string }
    readonly approvalState: "not_required" | "pending" | "approved" | "rejected"
    readonly execution?: { readonly leaseID: string; readonly heartbeatAt: number }
    readonly occurrence?: { readonly version: 1; readonly messageID: string; readonly digest: string }
    readonly quietHours?: { readonly timezone: string; readonly startMinute: number; readonly endMinute: number }
    readonly notificationPolicy: {
      readonly mode: "none" | "in_app"
      readonly events: ReadonlyArray<
        "approval_required" | "started" | "completed" | "failed" | "paused" | "cancelled" | "budget_exhausted"
      >
    }
    readonly notifications: ReadonlyArray<{
      readonly id: string
      readonly jobID: string
      readonly kind:
        | "approval_required"
        | "started"
        | "completed"
        | "failed"
        | "paused"
        | "cancelled"
        | "budget_exhausted"
      readonly title: string
      readonly body: string
      readonly availableAt: number
      readonly readAt?: number
    }>
    readonly result?: {
      readonly status: "completed" | "failed"
      readonly summary: string
      readonly digest: string
      readonly artifactRefs: ReadonlyArray<string>
      readonly artifacts?: ReadonlyArray<{
        readonly id: string
        readonly artifactRef?: {
          readonly version: 1
          readonly artifactID: string
          readonly kind: string
          readonly digest: string
          readonly mime: string
          readonly sizeBytes: number
          readonly owner: { readonly scope: "session" | "profile" | "tenant"; readonly id: string }
          readonly retention: { readonly mode: "ephemeral" | "session" | "durable"; readonly expiresAt?: number }
          readonly retrievalHint: { readonly kind: "managed"; readonly handle: string }
          readonly label?: string
          readonly createdAt: number
        }
        readonly kind: "primary_delivery" | "tool_output" | "session_snapshot"
        readonly uri: string
        readonly name: string
        readonly mime: string
        readonly sizeBytes: number
        readonly digest: string
      }>
      readonly usage: { readonly durationMs: number; readonly costMicros: number }
      readonly recordedAt: number
    }
    readonly retention: { readonly retainUntil?: number }
    readonly admissionDigest: string
    readonly lastError: string
    readonly revision: number
    readonly time: {
      readonly created: number
      readonly updated: number
      readonly started?: number
      readonly finished?: number
    }
  }
}["data"]

export type PersonalJobsStartInput = {
  readonly sessionID: { readonly sessionID: string; readonly jobID: string }["sessionID"]
  readonly jobID: { readonly sessionID: string; readonly jobID: string }["jobID"]
  readonly expectedRevision: { readonly expectedRevision: number }["expectedRevision"]
}

export type PersonalJobsStartOutput = {
  readonly data: {
    readonly id: string
    readonly sessionID: string
    readonly title: string
    readonly prompt: string
    readonly status: "awaiting_approval" | "queued" | "running" | "paused" | "completed" | "failed" | "cancelled"
    readonly visibility: { readonly mode: "background"; readonly label: "后台自动"; readonly userVisible: true }
    readonly schedule: {
      readonly kind: "once" | "cron"
      readonly label: string
      readonly cron?: string
      readonly nextRunAt: number
      readonly timezone: string
      readonly scheduledPromptID?: string
    }
    readonly credentialIDs: ReadonlyArray<string>
    readonly budget: {
      readonly maxAttempts: number
      readonly maxDurationMs: number
      readonly maxCostMicros: number
      readonly attemptsUsed: number
      readonly durationMsUsed: number
      readonly costMicrosUsed: number
    }
    readonly approvalPolicy: { readonly mode: "automatic" | "user_once" | "user_each_run"; readonly rationale: string }
    readonly approvalState: "not_required" | "pending" | "approved" | "rejected"
    readonly execution?: { readonly leaseID: string; readonly heartbeatAt: number }
    readonly occurrence?: { readonly version: 1; readonly messageID: string; readonly digest: string }
    readonly quietHours?: { readonly timezone: string; readonly startMinute: number; readonly endMinute: number }
    readonly notificationPolicy: {
      readonly mode: "none" | "in_app"
      readonly events: ReadonlyArray<
        "approval_required" | "started" | "completed" | "failed" | "paused" | "cancelled" | "budget_exhausted"
      >
    }
    readonly notifications: ReadonlyArray<{
      readonly id: string
      readonly jobID: string
      readonly kind:
        | "approval_required"
        | "started"
        | "completed"
        | "failed"
        | "paused"
        | "cancelled"
        | "budget_exhausted"
      readonly title: string
      readonly body: string
      readonly availableAt: number
      readonly readAt?: number
    }>
    readonly result?: {
      readonly status: "completed" | "failed"
      readonly summary: string
      readonly digest: string
      readonly artifactRefs: ReadonlyArray<string>
      readonly artifacts?: ReadonlyArray<{
        readonly id: string
        readonly artifactRef?: {
          readonly version: 1
          readonly artifactID: string
          readonly kind: string
          readonly digest: string
          readonly mime: string
          readonly sizeBytes: number
          readonly owner: { readonly scope: "session" | "profile" | "tenant"; readonly id: string }
          readonly retention: { readonly mode: "ephemeral" | "session" | "durable"; readonly expiresAt?: number }
          readonly retrievalHint: { readonly kind: "managed"; readonly handle: string }
          readonly label?: string
          readonly createdAt: number
        }
        readonly kind: "primary_delivery" | "tool_output" | "session_snapshot"
        readonly uri: string
        readonly name: string
        readonly mime: string
        readonly sizeBytes: number
        readonly digest: string
      }>
      readonly usage: { readonly durationMs: number; readonly costMicros: number }
      readonly recordedAt: number
    }
    readonly retention: { readonly retainUntil?: number }
    readonly admissionDigest: string
    readonly lastError: string
    readonly revision: number
    readonly time: {
      readonly created: number
      readonly updated: number
      readonly started?: number
      readonly finished?: number
    }
  }
}["data"]

export type PersonalJobsExecuteInput = {
  readonly sessionID: { readonly sessionID: string; readonly jobID: string }["sessionID"]
  readonly jobID: { readonly sessionID: string; readonly jobID: string }["jobID"]
  readonly expectedRevision: { readonly expectedRevision: number }["expectedRevision"]
}

export type PersonalJobsExecuteOutput = {
  readonly data: {
    readonly id: string
    readonly sessionID: string
    readonly title: string
    readonly prompt: string
    readonly status: "awaiting_approval" | "queued" | "running" | "paused" | "completed" | "failed" | "cancelled"
    readonly visibility: { readonly mode: "background"; readonly label: "后台自动"; readonly userVisible: true }
    readonly schedule: {
      readonly kind: "once" | "cron"
      readonly label: string
      readonly cron?: string
      readonly nextRunAt: number
      readonly timezone: string
      readonly scheduledPromptID?: string
    }
    readonly credentialIDs: ReadonlyArray<string>
    readonly budget: {
      readonly maxAttempts: number
      readonly maxDurationMs: number
      readonly maxCostMicros: number
      readonly attemptsUsed: number
      readonly durationMsUsed: number
      readonly costMicrosUsed: number
    }
    readonly approvalPolicy: { readonly mode: "automatic" | "user_once" | "user_each_run"; readonly rationale: string }
    readonly approvalState: "not_required" | "pending" | "approved" | "rejected"
    readonly execution?: { readonly leaseID: string; readonly heartbeatAt: number }
    readonly occurrence?: { readonly version: 1; readonly messageID: string; readonly digest: string }
    readonly quietHours?: { readonly timezone: string; readonly startMinute: number; readonly endMinute: number }
    readonly notificationPolicy: {
      readonly mode: "none" | "in_app"
      readonly events: ReadonlyArray<
        "approval_required" | "started" | "completed" | "failed" | "paused" | "cancelled" | "budget_exhausted"
      >
    }
    readonly notifications: ReadonlyArray<{
      readonly id: string
      readonly jobID: string
      readonly kind:
        | "approval_required"
        | "started"
        | "completed"
        | "failed"
        | "paused"
        | "cancelled"
        | "budget_exhausted"
      readonly title: string
      readonly body: string
      readonly availableAt: number
      readonly readAt?: number
    }>
    readonly result?: {
      readonly status: "completed" | "failed"
      readonly summary: string
      readonly digest: string
      readonly artifactRefs: ReadonlyArray<string>
      readonly artifacts?: ReadonlyArray<{
        readonly id: string
        readonly artifactRef?: {
          readonly version: 1
          readonly artifactID: string
          readonly kind: string
          readonly digest: string
          readonly mime: string
          readonly sizeBytes: number
          readonly owner: { readonly scope: "session" | "profile" | "tenant"; readonly id: string }
          readonly retention: { readonly mode: "ephemeral" | "session" | "durable"; readonly expiresAt?: number }
          readonly retrievalHint: { readonly kind: "managed"; readonly handle: string }
          readonly label?: string
          readonly createdAt: number
        }
        readonly kind: "primary_delivery" | "tool_output" | "session_snapshot"
        readonly uri: string
        readonly name: string
        readonly mime: string
        readonly sizeBytes: number
        readonly digest: string
      }>
      readonly usage: { readonly durationMs: number; readonly costMicros: number }
      readonly recordedAt: number
    }
    readonly retention: { readonly retainUntil?: number }
    readonly admissionDigest: string
    readonly lastError: string
    readonly revision: number
    readonly time: {
      readonly created: number
      readonly updated: number
      readonly started?: number
      readonly finished?: number
    }
  }
}["data"]

export type PersonalJobsDispatchInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly limit?: { readonly limit?: number | undefined }["limit"]
}

export type PersonalJobsDispatchOutput = {
  readonly data: {
    readonly recovered: number
    readonly advanced: number
    readonly attempted: number
    readonly completed: number
    readonly failed: number
    readonly skipped: number
  }
}["data"]

export type PersonalJobsPauseInput = {
  readonly sessionID: { readonly sessionID: string; readonly jobID: string }["sessionID"]
  readonly jobID: { readonly sessionID: string; readonly jobID: string }["jobID"]
  readonly expectedRevision: { readonly expectedRevision: number }["expectedRevision"]
}

export type PersonalJobsPauseOutput = {
  readonly data: {
    readonly id: string
    readonly sessionID: string
    readonly title: string
    readonly prompt: string
    readonly status: "awaiting_approval" | "queued" | "running" | "paused" | "completed" | "failed" | "cancelled"
    readonly visibility: { readonly mode: "background"; readonly label: "后台自动"; readonly userVisible: true }
    readonly schedule: {
      readonly kind: "once" | "cron"
      readonly label: string
      readonly cron?: string
      readonly nextRunAt: number
      readonly timezone: string
      readonly scheduledPromptID?: string
    }
    readonly credentialIDs: ReadonlyArray<string>
    readonly budget: {
      readonly maxAttempts: number
      readonly maxDurationMs: number
      readonly maxCostMicros: number
      readonly attemptsUsed: number
      readonly durationMsUsed: number
      readonly costMicrosUsed: number
    }
    readonly approvalPolicy: { readonly mode: "automatic" | "user_once" | "user_each_run"; readonly rationale: string }
    readonly approvalState: "not_required" | "pending" | "approved" | "rejected"
    readonly execution?: { readonly leaseID: string; readonly heartbeatAt: number }
    readonly occurrence?: { readonly version: 1; readonly messageID: string; readonly digest: string }
    readonly quietHours?: { readonly timezone: string; readonly startMinute: number; readonly endMinute: number }
    readonly notificationPolicy: {
      readonly mode: "none" | "in_app"
      readonly events: ReadonlyArray<
        "approval_required" | "started" | "completed" | "failed" | "paused" | "cancelled" | "budget_exhausted"
      >
    }
    readonly notifications: ReadonlyArray<{
      readonly id: string
      readonly jobID: string
      readonly kind:
        | "approval_required"
        | "started"
        | "completed"
        | "failed"
        | "paused"
        | "cancelled"
        | "budget_exhausted"
      readonly title: string
      readonly body: string
      readonly availableAt: number
      readonly readAt?: number
    }>
    readonly result?: {
      readonly status: "completed" | "failed"
      readonly summary: string
      readonly digest: string
      readonly artifactRefs: ReadonlyArray<string>
      readonly artifacts?: ReadonlyArray<{
        readonly id: string
        readonly artifactRef?: {
          readonly version: 1
          readonly artifactID: string
          readonly kind: string
          readonly digest: string
          readonly mime: string
          readonly sizeBytes: number
          readonly owner: { readonly scope: "session" | "profile" | "tenant"; readonly id: string }
          readonly retention: { readonly mode: "ephemeral" | "session" | "durable"; readonly expiresAt?: number }
          readonly retrievalHint: { readonly kind: "managed"; readonly handle: string }
          readonly label?: string
          readonly createdAt: number
        }
        readonly kind: "primary_delivery" | "tool_output" | "session_snapshot"
        readonly uri: string
        readonly name: string
        readonly mime: string
        readonly sizeBytes: number
        readonly digest: string
      }>
      readonly usage: { readonly durationMs: number; readonly costMicros: number }
      readonly recordedAt: number
    }
    readonly retention: { readonly retainUntil?: number }
    readonly admissionDigest: string
    readonly lastError: string
    readonly revision: number
    readonly time: {
      readonly created: number
      readonly updated: number
      readonly started?: number
      readonly finished?: number
    }
  }
}["data"]

export type PersonalJobsResumeInput = {
  readonly sessionID: { readonly sessionID: string; readonly jobID: string }["sessionID"]
  readonly jobID: { readonly sessionID: string; readonly jobID: string }["jobID"]
  readonly expectedRevision: { readonly expectedRevision: number }["expectedRevision"]
}

export type PersonalJobsResumeOutput = {
  readonly data: {
    readonly id: string
    readonly sessionID: string
    readonly title: string
    readonly prompt: string
    readonly status: "awaiting_approval" | "queued" | "running" | "paused" | "completed" | "failed" | "cancelled"
    readonly visibility: { readonly mode: "background"; readonly label: "后台自动"; readonly userVisible: true }
    readonly schedule: {
      readonly kind: "once" | "cron"
      readonly label: string
      readonly cron?: string
      readonly nextRunAt: number
      readonly timezone: string
      readonly scheduledPromptID?: string
    }
    readonly credentialIDs: ReadonlyArray<string>
    readonly budget: {
      readonly maxAttempts: number
      readonly maxDurationMs: number
      readonly maxCostMicros: number
      readonly attemptsUsed: number
      readonly durationMsUsed: number
      readonly costMicrosUsed: number
    }
    readonly approvalPolicy: { readonly mode: "automatic" | "user_once" | "user_each_run"; readonly rationale: string }
    readonly approvalState: "not_required" | "pending" | "approved" | "rejected"
    readonly execution?: { readonly leaseID: string; readonly heartbeatAt: number }
    readonly occurrence?: { readonly version: 1; readonly messageID: string; readonly digest: string }
    readonly quietHours?: { readonly timezone: string; readonly startMinute: number; readonly endMinute: number }
    readonly notificationPolicy: {
      readonly mode: "none" | "in_app"
      readonly events: ReadonlyArray<
        "approval_required" | "started" | "completed" | "failed" | "paused" | "cancelled" | "budget_exhausted"
      >
    }
    readonly notifications: ReadonlyArray<{
      readonly id: string
      readonly jobID: string
      readonly kind:
        | "approval_required"
        | "started"
        | "completed"
        | "failed"
        | "paused"
        | "cancelled"
        | "budget_exhausted"
      readonly title: string
      readonly body: string
      readonly availableAt: number
      readonly readAt?: number
    }>
    readonly result?: {
      readonly status: "completed" | "failed"
      readonly summary: string
      readonly digest: string
      readonly artifactRefs: ReadonlyArray<string>
      readonly artifacts?: ReadonlyArray<{
        readonly id: string
        readonly artifactRef?: {
          readonly version: 1
          readonly artifactID: string
          readonly kind: string
          readonly digest: string
          readonly mime: string
          readonly sizeBytes: number
          readonly owner: { readonly scope: "session" | "profile" | "tenant"; readonly id: string }
          readonly retention: { readonly mode: "ephemeral" | "session" | "durable"; readonly expiresAt?: number }
          readonly retrievalHint: { readonly kind: "managed"; readonly handle: string }
          readonly label?: string
          readonly createdAt: number
        }
        readonly kind: "primary_delivery" | "tool_output" | "session_snapshot"
        readonly uri: string
        readonly name: string
        readonly mime: string
        readonly sizeBytes: number
        readonly digest: string
      }>
      readonly usage: { readonly durationMs: number; readonly costMicros: number }
      readonly recordedAt: number
    }
    readonly retention: { readonly retainUntil?: number }
    readonly admissionDigest: string
    readonly lastError: string
    readonly revision: number
    readonly time: {
      readonly created: number
      readonly updated: number
      readonly started?: number
      readonly finished?: number
    }
  }
}["data"]

export type PersonalJobsCancelInput = {
  readonly sessionID: { readonly sessionID: string; readonly jobID: string }["sessionID"]
  readonly jobID: { readonly sessionID: string; readonly jobID: string }["jobID"]
  readonly expectedRevision: {
    readonly expectedRevision: number
    readonly reason?: string | undefined
  }["expectedRevision"]
  readonly reason?: { readonly expectedRevision: number; readonly reason?: string | undefined }["reason"]
}

export type PersonalJobsCancelOutput = {
  readonly data: {
    readonly id: string
    readonly sessionID: string
    readonly title: string
    readonly prompt: string
    readonly status: "awaiting_approval" | "queued" | "running" | "paused" | "completed" | "failed" | "cancelled"
    readonly visibility: { readonly mode: "background"; readonly label: "后台自动"; readonly userVisible: true }
    readonly schedule: {
      readonly kind: "once" | "cron"
      readonly label: string
      readonly cron?: string
      readonly nextRunAt: number
      readonly timezone: string
      readonly scheduledPromptID?: string
    }
    readonly credentialIDs: ReadonlyArray<string>
    readonly budget: {
      readonly maxAttempts: number
      readonly maxDurationMs: number
      readonly maxCostMicros: number
      readonly attemptsUsed: number
      readonly durationMsUsed: number
      readonly costMicrosUsed: number
    }
    readonly approvalPolicy: { readonly mode: "automatic" | "user_once" | "user_each_run"; readonly rationale: string }
    readonly approvalState: "not_required" | "pending" | "approved" | "rejected"
    readonly execution?: { readonly leaseID: string; readonly heartbeatAt: number }
    readonly occurrence?: { readonly version: 1; readonly messageID: string; readonly digest: string }
    readonly quietHours?: { readonly timezone: string; readonly startMinute: number; readonly endMinute: number }
    readonly notificationPolicy: {
      readonly mode: "none" | "in_app"
      readonly events: ReadonlyArray<
        "approval_required" | "started" | "completed" | "failed" | "paused" | "cancelled" | "budget_exhausted"
      >
    }
    readonly notifications: ReadonlyArray<{
      readonly id: string
      readonly jobID: string
      readonly kind:
        | "approval_required"
        | "started"
        | "completed"
        | "failed"
        | "paused"
        | "cancelled"
        | "budget_exhausted"
      readonly title: string
      readonly body: string
      readonly availableAt: number
      readonly readAt?: number
    }>
    readonly result?: {
      readonly status: "completed" | "failed"
      readonly summary: string
      readonly digest: string
      readonly artifactRefs: ReadonlyArray<string>
      readonly artifacts?: ReadonlyArray<{
        readonly id: string
        readonly artifactRef?: {
          readonly version: 1
          readonly artifactID: string
          readonly kind: string
          readonly digest: string
          readonly mime: string
          readonly sizeBytes: number
          readonly owner: { readonly scope: "session" | "profile" | "tenant"; readonly id: string }
          readonly retention: { readonly mode: "ephemeral" | "session" | "durable"; readonly expiresAt?: number }
          readonly retrievalHint: { readonly kind: "managed"; readonly handle: string }
          readonly label?: string
          readonly createdAt: number
        }
        readonly kind: "primary_delivery" | "tool_output" | "session_snapshot"
        readonly uri: string
        readonly name: string
        readonly mime: string
        readonly sizeBytes: number
        readonly digest: string
      }>
      readonly usage: { readonly durationMs: number; readonly costMicros: number }
      readonly recordedAt: number
    }
    readonly retention: { readonly retainUntil?: number }
    readonly admissionDigest: string
    readonly lastError: string
    readonly revision: number
    readonly time: {
      readonly created: number
      readonly updated: number
      readonly started?: number
      readonly finished?: number
    }
  }
}["data"]

export type PersonalJobsNotificationsInput = {
  readonly sessionID: { readonly sessionID: string; readonly jobID: string }["sessionID"]
  readonly jobID: { readonly sessionID: string; readonly jobID: string }["jobID"]
}

export type PersonalJobsNotificationsOutput = {
  readonly data: ReadonlyArray<{
    readonly id: string
    readonly jobID: string
    readonly kind:
      | "approval_required"
      | "started"
      | "completed"
      | "failed"
      | "paused"
      | "cancelled"
      | "budget_exhausted"
    readonly title: string
    readonly body: string
    readonly availableAt: number
    readonly readAt?: number
  }>
}["data"]

export type PersonalJobsNotificationReadInput = {
  readonly sessionID: {
    readonly sessionID: string
    readonly jobID: string
    readonly notificationID: string
  }["sessionID"]
  readonly jobID: { readonly sessionID: string; readonly jobID: string; readonly notificationID: string }["jobID"]
  readonly notificationID: {
    readonly sessionID: string
    readonly jobID: string
    readonly notificationID: string
  }["notificationID"]
  readonly expectedRevision: { readonly expectedRevision: number }["expectedRevision"]
}

export type PersonalJobsNotificationReadOutput = {
  readonly data: {
    readonly id: string
    readonly sessionID: string
    readonly title: string
    readonly prompt: string
    readonly status: "awaiting_approval" | "queued" | "running" | "paused" | "completed" | "failed" | "cancelled"
    readonly visibility: { readonly mode: "background"; readonly label: "后台自动"; readonly userVisible: true }
    readonly schedule: {
      readonly kind: "once" | "cron"
      readonly label: string
      readonly cron?: string
      readonly nextRunAt: number
      readonly timezone: string
      readonly scheduledPromptID?: string
    }
    readonly credentialIDs: ReadonlyArray<string>
    readonly budget: {
      readonly maxAttempts: number
      readonly maxDurationMs: number
      readonly maxCostMicros: number
      readonly attemptsUsed: number
      readonly durationMsUsed: number
      readonly costMicrosUsed: number
    }
    readonly approvalPolicy: { readonly mode: "automatic" | "user_once" | "user_each_run"; readonly rationale: string }
    readonly approvalState: "not_required" | "pending" | "approved" | "rejected"
    readonly execution?: { readonly leaseID: string; readonly heartbeatAt: number }
    readonly occurrence?: { readonly version: 1; readonly messageID: string; readonly digest: string }
    readonly quietHours?: { readonly timezone: string; readonly startMinute: number; readonly endMinute: number }
    readonly notificationPolicy: {
      readonly mode: "none" | "in_app"
      readonly events: ReadonlyArray<
        "approval_required" | "started" | "completed" | "failed" | "paused" | "cancelled" | "budget_exhausted"
      >
    }
    readonly notifications: ReadonlyArray<{
      readonly id: string
      readonly jobID: string
      readonly kind:
        | "approval_required"
        | "started"
        | "completed"
        | "failed"
        | "paused"
        | "cancelled"
        | "budget_exhausted"
      readonly title: string
      readonly body: string
      readonly availableAt: number
      readonly readAt?: number
    }>
    readonly result?: {
      readonly status: "completed" | "failed"
      readonly summary: string
      readonly digest: string
      readonly artifactRefs: ReadonlyArray<string>
      readonly artifacts?: ReadonlyArray<{
        readonly id: string
        readonly artifactRef?: {
          readonly version: 1
          readonly artifactID: string
          readonly kind: string
          readonly digest: string
          readonly mime: string
          readonly sizeBytes: number
          readonly owner: { readonly scope: "session" | "profile" | "tenant"; readonly id: string }
          readonly retention: { readonly mode: "ephemeral" | "session" | "durable"; readonly expiresAt?: number }
          readonly retrievalHint: { readonly kind: "managed"; readonly handle: string }
          readonly label?: string
          readonly createdAt: number
        }
        readonly kind: "primary_delivery" | "tool_output" | "session_snapshot"
        readonly uri: string
        readonly name: string
        readonly mime: string
        readonly sizeBytes: number
        readonly digest: string
      }>
      readonly usage: { readonly durationMs: number; readonly costMicros: number }
      readonly recordedAt: number
    }
    readonly retention: { readonly retainUntil?: number }
    readonly admissionDigest: string
    readonly lastError: string
    readonly revision: number
    readonly time: {
      readonly created: number
      readonly updated: number
      readonly started?: number
      readonly finished?: number
    }
  }
}["data"]

export type PersonalJobsDeleteInput = {
  readonly sessionID: { readonly sessionID: string; readonly jobID: string }["sessionID"]
  readonly jobID: { readonly sessionID: string; readonly jobID: string }["jobID"]
  readonly expectedRevision: { readonly expectedRevision: number }["expectedRevision"]
}

export type PersonalJobsDeleteOutput = void

export type PersonalWorkspaceSnapshotInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly limit?: number | undefined
  }["location"]
  readonly limit?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly limit?: number | undefined
  }["limit"]
}

export type PersonalWorkspaceSnapshotOutput = {
  readonly asOf: number
  readonly project: { readonly id: string; readonly directory: string }
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly projectID: string
    readonly projectDirectory: string
  }
  readonly sessions: ReadonlyArray<{
    readonly id: string
    readonly title: string
    readonly projectID: string
    readonly subpath?: string
    readonly state: "system_automatic" | "needs_human" | "human_visible" | "settled"
    readonly createdAt: number
    readonly updatedAt: number
    readonly taskCount: number
    readonly runCount: number
    readonly personalJobCount: number
    readonly attentionCount: number
  }>
  readonly tasks: ReadonlyArray<{
    readonly id: string
    readonly sessionID: string
    readonly title: string
    readonly status: "pending" | "in_progress" | "completed" | "cancelled"
    readonly state: "system_automatic" | "needs_human" | "human_visible" | "settled"
    readonly unresolvedBlockers: number
    readonly revision: number
    readonly createdAt: number
    readonly updatedAt: number
  }>
  readonly runs: ReadonlyArray<{
    readonly runID: string
    readonly sessionID: string
    readonly status:
      | "draft"
      | "preflight"
      | "awaiting_authorization"
      | "queued"
      | "running"
      | "paused"
      | "recovering"
      | "verifying"
      | "completed"
      | "failed"
      | "cancelled"
    readonly initiator: "user" | "agent" | "schedule" | "trigger" | "recovery" | "evolution"
    readonly authority: "automatic" | "scoped_grant" | "human" | "forbidden"
    readonly riskTier: "L0" | "L1" | "L2" | "L3" | "L4"
    readonly state: "system_automatic" | "needs_human" | "human_visible" | "settled"
    readonly recoveryRequired: boolean
    readonly budget: {
      readonly attemptsUsed: number
      readonly maxAttempts: number
      readonly durationMsUsed: number
      readonly maxDurationMs: number
      readonly costMicrosUsed: number
      readonly maxCostMicros: number
    }
    readonly createdAt: number
    readonly updatedAt: number
    readonly startedAt?: number
    readonly finishedAt?: number
  }>
  readonly personalJobs: ReadonlyArray<{
    readonly id: string
    readonly sessionID: string
    readonly title: string
    readonly status: "awaiting_approval" | "queued" | "running" | "paused" | "completed" | "failed" | "cancelled"
    readonly visibility: { readonly mode: "background"; readonly label: "后台自动"; readonly userVisible: true }
    readonly scheduleLabel: string
    readonly nextRunAt: number
    readonly approvalState: "not_required" | "pending" | "approved" | "rejected"
    readonly state: "system_automatic" | "needs_human" | "human_visible" | "settled"
    readonly needsHuman: boolean
    readonly budget: {
      readonly attemptsUsed: number
      readonly maxAttempts: number
      readonly durationMsUsed: number
      readonly maxDurationMs: number
      readonly costMicrosUsed: number
      readonly maxCostMicros: number
    }
    readonly artifactCount: number
    readonly createdAt: number
    readonly updatedAt: number
  }>
  readonly memoryCandidates: ReadonlyArray<{
    readonly candidateID: string
    readonly status: "proposed" | "approved" | "rejected" | "promoted" | "expired" | "superseded"
    readonly sensitivity: "public" | "internal" | "confidential" | "secret"
    readonly confidence: number
    readonly state: "system_automatic" | "needs_human" | "human_visible" | "settled"
    readonly needsHuman: boolean
    readonly createdAt: number
    readonly updatedAt: number
  }>
  readonly attention: ReadonlyArray<{
    readonly kind: "pending_approval" | "recovery_required" | "artifact_ready" | "memory_candidate" | "cost_review"
    readonly severity: "info" | "warning" | "critical"
    readonly resourceType: "personal_job" | "run" | "memory_candidate" | "workspace"
    readonly resourceID: string
    readonly sessionID?: string
    readonly title: string
    readonly detail: string
  }>
  readonly counts: {
    readonly sessions: number
    readonly activeSessions: number
    readonly tasks: number
    readonly pendingTasks: number
    readonly runs: number
    readonly activeRuns: number
    readonly recoveringRuns: number
    readonly personalJobs: number
    readonly pendingApprovals: number
    readonly artifacts: number
    readonly memoryCandidates: number
  }
  readonly cost: {
    readonly runUsedMicros: number
    readonly runLimitMicros: number
    readonly jobUsedMicros: number
    readonly jobLimitMicros: number
  }
}

export type TenantPlatformOverviewOutput = {
  readonly schema_version: 1
  readonly policy: {
    readonly schema_version: 1
    readonly tenant_id: string
    readonly region: string
    readonly retention_days: number
    readonly quota: { readonly currency: string; readonly limit_minor?: number }
    readonly rate_limit: { readonly requests_per_minute: number; readonly burst: number }
    readonly key_version: number
    readonly revision: number
    readonly updated_at: string
  }
  readonly usage: {
    readonly tenant_id: string
    readonly currency: string
    readonly settled_amount_minor: number
    readonly settled_records: number
    readonly source: "settled-runtime-usage"
  }
  readonly active_rate_window_count: number
  readonly pending_requests: number
}

export type TenantPlatformSetPolicyInput = {
  readonly region: {
    readonly region: string
    readonly retention_days: number
    readonly quota: { readonly currency: string; readonly limit_minor?: number }
    readonly rate_limit: { readonly requests_per_minute: number; readonly burst: number }
    readonly key_version: number
  }["region"]
  readonly retention_days: {
    readonly region: string
    readonly retention_days: number
    readonly quota: { readonly currency: string; readonly limit_minor?: number }
    readonly rate_limit: { readonly requests_per_minute: number; readonly burst: number }
    readonly key_version: number
  }["retention_days"]
  readonly quota: {
    readonly region: string
    readonly retention_days: number
    readonly quota: { readonly currency: string; readonly limit_minor?: number }
    readonly rate_limit: { readonly requests_per_minute: number; readonly burst: number }
    readonly key_version: number
  }["quota"]
  readonly rate_limit: {
    readonly region: string
    readonly retention_days: number
    readonly quota: { readonly currency: string; readonly limit_minor?: number }
    readonly rate_limit: { readonly requests_per_minute: number; readonly burst: number }
    readonly key_version: number
  }["rate_limit"]
  readonly key_version: {
    readonly region: string
    readonly retention_days: number
    readonly quota: { readonly currency: string; readonly limit_minor?: number }
    readonly rate_limit: { readonly requests_per_minute: number; readonly burst: number }
    readonly key_version: number
  }["key_version"]
}

export type TenantPlatformSetPolicyOutput = {
  readonly schema_version: 1
  readonly tenant_id: string
  readonly region: string
  readonly retention_days: number
  readonly quota: { readonly currency: string; readonly limit_minor?: number }
  readonly rate_limit: { readonly requests_per_minute: number; readonly burst: number }
  readonly key_version: number
  readonly revision: number
  readonly updated_at: string
}

export type TenantPlatformRequestDataInput = {
  readonly kind: { readonly kind: "tenant-export" | "tenant-delete"; readonly reason: string }["kind"]
  readonly reason: { readonly kind: "tenant-export" | "tenant-delete"; readonly reason: string }["reason"]
}

export type TenantPlatformRequestDataOutput = {
  readonly id: string
  readonly tenant_id: string
  readonly kind: "tenant-export" | "tenant-delete"
  readonly status: "requested" | "approved" | "executing" | "completed" | "rejected" | "failed"
  readonly requested_by: string
  readonly approved_by?: string
  readonly reason: string
  readonly request_digest: string
  readonly requested_at: string
  readonly completed_at?: string
}

export type TenantPlatformApproveDataInput = {
  readonly requestID: { readonly requestID: string }["requestID"]
  readonly approve: { readonly approve: boolean }["approve"]
}

export type TenantPlatformApproveDataOutput = {
  readonly id: string
  readonly tenant_id: string
  readonly kind: "tenant-export" | "tenant-delete"
  readonly status: "requested" | "approved" | "executing" | "completed" | "rejected" | "failed"
  readonly requested_by: string
  readonly approved_by?: string
  readonly reason: string
  readonly request_digest: string
  readonly requested_at: string
  readonly completed_at?: string
}

export type TenantPlatformCreateBackupInput = {
  readonly region: {
    readonly region: string
    readonly schema_revision: string
    readonly artifact_digest: string
  }["region"]
  readonly schema_revision: {
    readonly region: string
    readonly schema_revision: string
    readonly artifact_digest: string
  }["schema_revision"]
  readonly artifact_digest: {
    readonly region: string
    readonly schema_revision: string
    readonly artifact_digest: string
  }["artifact_digest"]
}

export type TenantPlatformCreateBackupOutput = {
  readonly id: string
  readonly tenant_id: string
  readonly region: string
  readonly schema_revision: string
  readonly artifact_digest: string
  readonly status: "created" | "verified" | "restored" | "failed"
  readonly created_at: string
  readonly verified_at?: string
}

export type TenantPlatformVerifyBackupInput = {
  readonly manifestID: { readonly manifestID: string }["manifestID"]
  readonly artifact_digest: { readonly artifact_digest: string }["artifact_digest"]
}

export type TenantPlatformVerifyBackupOutput = {
  readonly id: string
  readonly tenant_id: string
  readonly region: string
  readonly schema_revision: string
  readonly artifact_digest: string
  readonly status: "created" | "verified" | "restored" | "failed"
  readonly created_at: string
  readonly verified_at?: string
}

export type TenantPlatformExportAuditOutput = {
  readonly id: string
  readonly tenant_id: string
  readonly requested_by: string
  readonly item_count: number
  readonly export_digest: string
  readonly created_at: string
  readonly artifact_filename: string
  readonly artifact_media_type: "application/json"
  readonly artifact_json: string
}

export type TenantPlatformListSecretsOutput = ReadonlyArray<{
  readonly tenant_id: string
  readonly secret_id: string
  readonly key_version: number
  readonly fingerprint: string
  readonly status: "active" | "revoked"
  readonly created_at: string
  readonly revoked_at?: string
}>

export type TenantPlatformRevokeSecretInput = { readonly secretID: { readonly secretID: string }["secretID"] }

export type TenantPlatformRevokeSecretOutput = {
  readonly tenant_id: string
  readonly secret_id: string
  readonly key_version: number
  readonly fingerprint: string
  readonly status: "active" | "revoked"
  readonly created_at: string
  readonly revoked_at?: string
}

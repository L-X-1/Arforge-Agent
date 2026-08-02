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

export type ForbiddenError = { readonly _tag: "ForbiddenError"; readonly message: string }
export const isForbiddenError = (value: unknown): value is ForbiddenError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "ForbiddenError"

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

export type HealthGetOutput = { readonly healthy: true }

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
      readonly route?: {
        readonly agent?: string
        readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
      }
      readonly command?: { readonly name: string; readonly arguments: string }
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
      readonly route?: {
        readonly agent?: string
        readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
      }
      readonly command?: { readonly name: string; readonly arguments: string }
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
      readonly route?: {
        readonly agent?: string
        readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
      }
      readonly command?: { readonly name: string; readonly arguments: string }
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
      readonly route?: {
        readonly agent?: string
        readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
      }
      readonly command?: { readonly name: string; readonly arguments: string }
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
      readonly route?: {
        readonly agent?: string
        readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
      }
      readonly command?: { readonly name: string; readonly arguments: string }
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
      readonly route?: {
        readonly agent?: string
        readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
      }
      readonly command?: { readonly name: string; readonly arguments: string }
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
      readonly route?: {
        readonly agent?: string
        readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
      }
      readonly command?: { readonly name: string; readonly arguments: string }
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
      readonly route?: {
        readonly agent?: string
        readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
      }
      readonly command?: { readonly name: string; readonly arguments: string }
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
      readonly route?: {
        readonly agent?: string
        readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
      }
      readonly command?: { readonly name: string; readonly arguments: string }
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
        readonly delivery?: {
          readonly status: "normal" | "proactive"
          readonly sentAt: number
          readonly attachmentCount: number
          readonly attachments: ReadonlyArray<{
            readonly artifactID: string
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
            readonly route?: {
              readonly agent?: string
              readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
            }
            readonly command?: { readonly name: string; readonly arguments: string }
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
            readonly route?: {
              readonly agent?: string
              readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
            }
            readonly command?: { readonly name: string; readonly arguments: string }
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
            readonly route?: {
              readonly agent?: string
              readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
            }
            readonly command?: { readonly name: string; readonly arguments: string }
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
          readonly route?: {
            readonly agent?: string
            readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
          }
          readonly command?: { readonly name: string; readonly arguments: string }
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
          readonly route?: {
            readonly agent?: string
            readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
          }
          readonly command?: { readonly name: string; readonly arguments: string }
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
          readonly route?: {
            readonly agent?: string
            readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
          }
          readonly command?: { readonly name: string; readonly arguments: string }
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
        readonly delivery?: {
          readonly status: "normal" | "proactive"
          readonly sentAt: number
          readonly attachmentCount: number
          readonly attachments: ReadonlyArray<{
            readonly artifactID: string
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
        readonly route?: {
          readonly agent?: string
          readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
        }
        readonly command?: { readonly name: string; readonly arguments: string }
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

export type MemoriesDeleteInput = {
  readonly memoryID: { readonly memoryID: string }["memoryID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type MemoriesDeleteOutput = void

export type MemoriesDeleteManyInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
  readonly ids: { readonly ids: ReadonlyArray<string> }["ids"]
}

export type MemoriesDeleteManyOutput = {
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
    readonly algorithm: "hybrid_bm25_hashing_vector"
    readonly localOnly: true
    readonly items: ReadonlyArray<{
      readonly memory: {
        readonly id: string
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
    readonly recent: ReadonlyArray<{
      readonly id: string
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
  }["filename"]
  readonly extractedText?: {
    readonly filename: string
    readonly extractedText?: string | undefined
    readonly limit?: number | undefined
  }["extractedText"]
  readonly limit?: {
    readonly filename: string
    readonly extractedText?: string | undefined
    readonly limit?: number | undefined
  }["limit"]
}

export type DiagnosticsDiagnoseOutput = {
  readonly data: {
    readonly schemaVersion: 1
    readonly localOnly: true
    readonly modelCalls: 0
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
        | "permission-rules"
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
  readonly enabled: { readonly enabled: boolean }["enabled"]
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
  readonly enabled: { readonly enabled: boolean }["enabled"]
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
  }["token"]
  readonly name?: {
    readonly token: string
    readonly name?: string | undefined
    readonly replace?: boolean | undefined
  }["name"]
  readonly replace?: {
    readonly token: string
    readonly name?: string | undefined
    readonly replace?: boolean | undefined
  }["replace"]
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
  readonly recoveryID: { readonly recoveryID: string }["recoveryID"]
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
    }>
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
        readonly delivery?: {
          readonly status: "normal" | "proactive"
          readonly sentAt: number
          readonly attachmentCount: number
          readonly attachments: ReadonlyArray<{
            readonly artifactID: string
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
  }
}["data"]

export type PermissionsReplyInput = {
  readonly sessionID: { readonly sessionID: string; readonly requestID: string }["sessionID"]
  readonly requestID: { readonly sessionID: string; readonly requestID: string }["requestID"]
  readonly reply: { readonly reply: "once" | "always" | "reject"; readonly message?: string | undefined }["reply"]
  readonly message?: { readonly reply: "once" | "always" | "reject"; readonly message?: string | undefined }["message"]
}

export type PermissionsReplyOutput = void

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

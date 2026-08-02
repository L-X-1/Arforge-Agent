import type {
  HealthGetOutput,
  LocationGetInput,
  LocationGetOutput,
  AgentsListInput,
  AgentsListOutput,
  SessionsListInput,
  SessionsListOutput,
  SessionsCreateInput,
  SessionsCreateOutput,
  SessionsActiveOutput,
  SessionsGetInput,
  SessionsGetOutput,
  SessionsTagsUpdateInput,
  SessionsTagsUpdateOutput,
  SessionsCheckpointCreateInput,
  SessionsCheckpointCreateOutput,
  SessionsCheckpointListInput,
  SessionsCheckpointListOutput,
  SessionsRewindPreviewInput,
  SessionsRewindPreviewOutput,
  SessionsRewindApplyInput,
  SessionsRewindApplyOutput,
  SessionsSwitchAgentInput,
  SessionsSwitchAgentOutput,
  SessionsSwitchModelInput,
  SessionsSwitchModelOutput,
  SessionsPromptInput,
  SessionsPromptOutput,
  SessionsPromptQueueListInput,
  SessionsPromptQueueListOutput,
  SessionsPromptQueueUpdateInput,
  SessionsPromptQueueUpdateOutput,
  SessionsPromptQueueRemoveInput,
  SessionsPromptQueueRemoveOutput,
  SessionsCompactInput,
  SessionsCompactOutput,
  SessionsWaitInput,
  SessionsWaitOutput,
  SessionsStageInput,
  SessionsStageOutput,
  SessionsClearInput,
  SessionsClearOutput,
  SessionsCommitInput,
  SessionsCommitOutput,
  SessionsContextInput,
  SessionsContextOutput,
  SessionsHistoryInput,
  SessionsHistoryOutput,
  SessionsEventsInput,
  SessionsEventsOutput,
  SessionsInterruptInput,
  SessionsInterruptOutput,
  SessionsMessageInput,
  SessionsMessageOutput,
  GoalsListInput,
  GoalsListOutput,
  GoalsCreateInput,
  GoalsCreateOutput,
  GoalsGetInput,
  GoalsGetOutput,
  GoalsRunInput,
  GoalsRunOutput,
  GoalsPauseInput,
  GoalsPauseOutput,
  GoalsResumeInput,
  GoalsResumeOutput,
  GoalsCompleteInput,
  GoalsCompleteOutput,
  GoalsBlockInput,
  GoalsBlockOutput,
  GoalsCancelInput,
  GoalsCancelOutput,
  GoalsReplaceInput,
  GoalsReplaceOutput,
  GoalsDeleteQueuedInput,
  GoalsDeleteQueuedOutput,
  GoalsReorderInput,
  GoalsReorderOutput,
  ScheduledPromptsCreateInput,
  ScheduledPromptsCreateOutput,
  ScheduledPromptsListInput,
  ScheduledPromptsListOutput,
  ScheduledPromptsGetInput,
  ScheduledPromptsGetOutput,
  ScheduledPromptsUpdateInput,
  ScheduledPromptsUpdateOutput,
  ScheduledPromptsDeleteInput,
  ScheduledPromptsDeleteOutput,
  ScheduledPromptsRunInput,
  ScheduledPromptsRunOutput,
  ScheduledPromptsRunMissedInput,
  ScheduledPromptsRunMissedOutput,
  TasksCreateInput,
  TasksCreateOutput,
  TasksListInput,
  TasksListOutput,
  TasksGetInput,
  TasksGetOutput,
  TasksUpdateInput,
  TasksUpdateOutput,
  TasksClaimInput,
  TasksClaimOutput,
  TasksReleaseInput,
  TasksReleaseOutput,
  TasksCompleteInput,
  TasksCompleteOutput,
  TasksCancelInput,
  TasksCancelOutput,
  TasksDeleteInput,
  TasksDeleteOutput,
  TasksClearInput,
  TasksClearOutput,
  TeamsCreateInput,
  TeamsCreateOutput,
  TeamsGetInput,
  TeamsGetOutput,
  TeamsMemberAddInput,
  TeamsMemberAddOutput,
  TeamsMemberRemoveInput,
  TeamsMemberRemoveOutput,
  TeamsMessageSendInput,
  TeamsMessageSendOutput,
  TeamsMessageListInput,
  TeamsMessageListOutput,
  TeamsShutdownRequestInput,
  TeamsShutdownRequestOutput,
  TeamsDeleteInput,
  TeamsDeleteOutput,
  WaitsActiveInput,
  WaitsActiveOutput,
  WaitsWakeInput,
  WaitsWakeOutput,
  TriggersProfilesOutput,
  TriggersListInput,
  TriggersListOutput,
  TriggersGetInput,
  TriggersGetOutput,
  TriggersCreateInput,
  TriggersCreateOutput,
  TriggersUpdateInput,
  TriggersUpdateOutput,
  TriggersRunInput,
  TriggersRunOutput,
  MemoriesListInput,
  MemoriesListOutput,
  MemoriesCreateInput,
  MemoriesCreateOutput,
  MemoriesGetInput,
  MemoriesGetOutput,
  MemoriesUpdateInput,
  MemoriesUpdateOutput,
  MemoriesDeleteInput,
  MemoriesDeleteOutput,
  MemoriesDeleteManyInput,
  MemoriesDeleteManyOutput,
  MemoriesSemanticInput,
  MemoriesSemanticOutput,
  MemoriesFacetsInput,
  MemoriesFacetsOutput,
  MemoriesStatusInput,
  MemoriesStatusOutput,
  MemoriesRecallQualityInput,
  MemoriesRecallQualityOutput,
  MemoriesGovernancePreviewInput,
  MemoriesGovernancePreviewOutput,
  MemoriesGovernanceApplyInput,
  MemoriesGovernanceApplyOutput,
  LearningStatusInput,
  LearningStatusOutput,
  LearningRecordInput,
  LearningRecordOutput,
  LearningUndoInput,
  LearningUndoOutput,
  LearningSyncDogfoodInput,
  LearningSyncDogfoodOutput,
  FeedbackSubmitInput,
  FeedbackSubmitOutput,
  FeedbackListInput,
  FeedbackListOutput,
  FeedbackSummaryInput,
  FeedbackSummaryOutput,
  FeedbackDeleteInput,
  FeedbackDeleteOutput,
  DiagnosticsDiagnoseInput,
  DiagnosticsDiagnoseOutput,
  AgentCapabilitiesHealthInput,
  AgentCapabilitiesHealthOutput,
  AgentCapabilitiesListInput,
  AgentCapabilitiesListOutput,
  AgentCapabilitiesSystemOverviewInput,
  AgentCapabilitiesSystemOverviewOutput,
  AgentCapabilitiesDeepInsightsInput,
  AgentCapabilitiesDeepInsightsOutput,
  AgentCapabilitiesRepoScaleInput,
  AgentCapabilitiesRepoScaleOutput,
  AgentCapabilitiesRunListInput,
  AgentCapabilitiesRunListOutput,
  AgentCapabilitiesRunReportInput,
  AgentCapabilitiesRunReportOutput,
  AgentCapabilitiesQualityAssessInput,
  AgentCapabilitiesQualityAssessOutput,
  AgentCapabilitiesSkillListInput,
  AgentCapabilitiesSkillListOutput,
  AgentCapabilitiesSkillReadInput,
  AgentCapabilitiesSkillReadOutput,
  AgentCapabilitiesSkillRouteInput,
  AgentCapabilitiesSkillRouteOutput,
  AgentCapabilitiesSkillSetEnabledInput,
  AgentCapabilitiesSkillSetEnabledOutput,
  AgentCapabilitiesSkillRefreshInput,
  AgentCapabilitiesSkillRefreshOutput,
  AgentCapabilitiesPluginListInput,
  AgentCapabilitiesPluginListOutput,
  AgentCapabilitiesCustomizationListInput,
  AgentCapabilitiesCustomizationListOutput,
  AgentCapabilitiesCustomizationRenderInput,
  AgentCapabilitiesCustomizationRenderOutput,
  AgentCapabilitiesPluginSetEnabledInput,
  AgentCapabilitiesPluginSetEnabledOutput,
  AgentCapabilitiesPluginInspectInput,
  AgentCapabilitiesPluginInspectOutput,
  AgentCapabilitiesPluginApplyInput,
  AgentCapabilitiesPluginApplyOutput,
  AgentCapabilitiesPluginRemoveInput,
  AgentCapabilitiesPluginRemoveOutput,
  AgentCapabilitiesPluginRestoreInput,
  AgentCapabilitiesPluginRestoreOutput,
  AgentCapabilitiesWorkflowListInput,
  AgentCapabilitiesWorkflowListOutput,
  AgentCapabilitiesWorkflowPreviewInput,
  AgentCapabilitiesWorkflowPreviewOutput,
  AgentCapabilitiesWorkflowRunListInput,
  AgentCapabilitiesWorkflowRunListOutput,
  AgentCapabilitiesWorkflowRunGetInput,
  AgentCapabilitiesWorkflowRunGetOutput,
  AgentCapabilitiesWorkflowRunEventsInput,
  AgentCapabilitiesWorkflowRunEventsOutput,
  AgentCapabilitiesPlanPreviewInput,
  AgentCapabilitiesPlanPreviewOutput,
  AgentCapabilitiesRunTraceExportInput,
  AgentCapabilitiesRunTraceExportOutput,
  AgentCapabilitiesWorkflowStartInput,
  AgentCapabilitiesWorkflowStartOutput,
  AgentCapabilitiesWorkflowControlInput,
  AgentCapabilitiesWorkflowControlOutput,
  AgentCapabilitiesWorkflowApproveInput,
  AgentCapabilitiesWorkflowApproveOutput,
  AgentCapabilitiesWorkflowRetryInput,
  AgentCapabilitiesWorkflowRetryOutput,
  McpListInput,
  McpListOutput,
  McpResourceCatalogInput,
  McpResourceCatalogOutput,
  McpConnectInput,
  McpConnectOutput,
  McpDisconnectInput,
  McpDisconnectOutput,
  PrivateOperationsOverviewInput,
  PrivateOperationsOverviewOutput,
  MessagesListInput,
  MessagesListOutput,
  ModelsListInput,
  ModelsListOutput,
  ProvidersListInput,
  ProvidersListOutput,
  ProvidersGetInput,
  ProvidersGetOutput,
  IntegrationsListInput,
  IntegrationsListOutput,
  IntegrationsGetInput,
  IntegrationsGetOutput,
  IntegrationsConnectKeyInput,
  IntegrationsConnectKeyOutput,
  IntegrationsConnectOauthInput,
  IntegrationsConnectOauthOutput,
  IntegrationsAttemptStatusInput,
  IntegrationsAttemptStatusOutput,
  IntegrationsAttemptCompleteInput,
  IntegrationsAttemptCompleteOutput,
  IntegrationsAttemptCancelInput,
  IntegrationsAttemptCancelOutput,
  CredentialsUpdateInput,
  CredentialsUpdateOutput,
  CredentialsRemoveInput,
  CredentialsRemoveOutput,
  PermissionsListRequestsInput,
  PermissionsListRequestsOutput,
  PermissionsListSavedInput,
  PermissionsListSavedOutput,
  PermissionsRemoveSavedInput,
  PermissionsRemoveSavedOutput,
  PermissionsCreateInput,
  PermissionsCreateOutput,
  PermissionsListInput,
  PermissionsListOutput,
  PermissionsGetInput,
  PermissionsGetOutput,
  PermissionsReplyInput,
  PermissionsReplyOutput,
  FilesListInput,
  FilesListOutput,
  FilesFindInput,
  FilesFindOutput,
  CommandsListInput,
  CommandsListOutput,
  SkillsListInput,
  SkillsListOutput,
  EventsSubscribeOutput,
  PtysListInput,
  PtysListOutput,
  PtysCreateInput,
  PtysCreateOutput,
  PtysGetInput,
  PtysGetOutput,
  PtysUpdateInput,
  PtysUpdateOutput,
  PtysRemoveInput,
  PtysRemoveOutput,
  QuestionsListRequestsInput,
  QuestionsListRequestsOutput,
  QuestionsListInput,
  QuestionsListOutput,
  QuestionsReplyInput,
  QuestionsReplyOutput,
  QuestionsRejectInput,
  QuestionsRejectOutput,
  ReferencesListInput,
  ReferencesListOutput,
  ProjectCopiesListInput,
  ProjectCopiesListOutput,
  ProjectCopiesCreateInput,
  ProjectCopiesCreateOutput,
  ProjectCopiesRemoveInput,
  ProjectCopiesRemoveOutput,
  ProjectCopiesRefreshInput,
  ProjectCopiesRefreshOutput,
} from "./types"
import { ClientError } from "./client-error"

export interface ClientOptions {
  readonly baseUrl: string
  readonly fetch?: typeof globalThis.fetch
  readonly headers?: HeadersInit
}

export interface RequestOptions {
  readonly signal?: AbortSignal
  readonly headers?: HeadersInit
}

interface RequestDescriptor {
  readonly method: string
  readonly path: string
  readonly query?: Record<string, unknown>
  readonly headers?: Record<string, unknown>
  readonly body?: unknown
  readonly successStatus: number
  readonly declaredStatuses: ReadonlyArray<number>
  readonly empty: boolean
}

export function make(options: ClientOptions) {
  const fetch = options.fetch ?? globalThis.fetch

  const prepare = (descriptor: RequestDescriptor, requestOptions?: RequestOptions) => {
    const url = new URL(descriptor.path, options.baseUrl)
    for (const [key, value] of Object.entries(descriptor.query ?? {})) appendQuery(url.searchParams, key, value)
    const headers = new Headers(options.headers)
    for (const [key, value] of Object.entries(descriptor.headers ?? {})) {
      if (value !== undefined && value !== null) headers.set(key, String(value))
    }
    for (const [key, value] of new Headers(requestOptions?.headers)) headers.set(key, value)
    if (descriptor.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json")
    return {
      url,
      init: {
        method: descriptor.method,
        signal: requestOptions?.signal,
        headers,
        body: descriptor.body === undefined ? undefined : JSON.stringify(descriptor.body),
      } satisfies RequestInit,
    }
  }

  const execute = async (descriptor: RequestDescriptor, requestOptions?: RequestOptions) => {
    try {
      const prepared = prepare(descriptor, requestOptions)
      return await fetch(prepared.url, prepared.init)
    } catch (cause) {
      throw new ClientError("Transport", { cause })
    }
  }

  const responseError = async (response: Response, descriptor: RequestDescriptor): Promise<never> => {
    if (descriptor.declaredStatuses.includes(response.status)) throw await json(response)
    try {
      await response.body?.cancel()
    } catch {}
    throw new ClientError("UnexpectedStatus", { cause: { status: response.status } })
  }

  const request = async <A>(descriptor: RequestDescriptor, requestOptions?: RequestOptions): Promise<A> => {
    const response = await execute(descriptor, requestOptions)
    if (response.status !== descriptor.successStatus) return responseError(response, descriptor)
    if (descriptor.empty) {
      try {
        await response.body?.cancel()
      } catch {}
      return undefined as A
    }
    return (await json(response)) as A
  }

  const sse = <A>(descriptor: RequestDescriptor, requestOptions?: RequestOptions): AsyncIterable<A> => ({
    async *[Symbol.asyncIterator]() {
      const response = await execute(descriptor, requestOptions)
      if (response.status !== descriptor.successStatus) await responseError(response, descriptor)
      if (!isContentType(response, "text/event-stream")) {
        try {
          await response.body?.cancel()
        } catch {}
        throw new ClientError("UnsupportedContentType")
      }
      if (response.body === null) throw new ClientError("MalformedResponse")
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      try {
        while (true) {
          let next
          try {
            next = await reader.read()
          } catch (cause) {
            throw new ClientError("Transport", { cause })
          }
          buffer += decoder.decode(next.value, { stream: !next.done })
          if (buffer.length > 1_048_576) throw new ClientError("MalformedResponse")
          const trailingCarriageReturn = !next.done && buffer.endsWith("\r")
          if (trailingCarriageReturn) buffer = buffer.slice(0, -1)
          buffer = buffer.replaceAll("\r\n", "\n").replaceAll("\r", "\n")
          if (trailingCarriageReturn) buffer += "\r"
          if (next.done && buffer !== "") buffer += "\n\n"
          let boundary = buffer.indexOf("\n\n")
          while (boundary >= 0) {
            const block = buffer.slice(0, boundary)
            buffer = buffer.slice(boundary + 2)
            const data = block
              .split("\n")
              .flatMap((line) => (line.startsWith("data:") ? [line.slice(5).trimStart()] : []))
              .join("\n")
            if (data !== "") {
              try {
                yield JSON.parse(data) as A
              } catch (cause) {
                throw new ClientError("MalformedResponse", { cause })
              }
            }
            boundary = buffer.indexOf("\n\n")
          }
          if (next.done) return
        }
      } finally {
        try {
          await reader.cancel()
        } catch {}
        reader.releaseLock()
      }
    },
  })

  return {
    health: {
      get: (requestOptions?: RequestOptions) =>
        request<HealthGetOutput>(
          { method: "GET", path: `/api/health`, successStatus: 200, declaredStatuses: [401, 400], empty: false },
          requestOptions,
        ),
    },
    location: {
      get: (input?: LocationGetInput, requestOptions?: RequestOptions) =>
        request<LocationGetOutput>(
          {
            method: "GET",
            path: `/api/location`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ),
    },
    agents: {
      list: (input?: AgentsListInput, requestOptions?: RequestOptions) =>
        request<AgentsListOutput>(
          {
            method: "GET",
            path: `/api/agent`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ),
    },
    sessions: {
      list: (input?: SessionsListInput, requestOptions?: RequestOptions) =>
        request<SessionsListOutput>(
          {
            method: "GET",
            path: `/api/session`,
            query: {
              workspace: input?.["workspace"],
              limit: input?.["limit"],
              order: input?.["order"],
              search: input?.["search"],
              tags: input?.["tags"],
              directory: input?.["directory"],
              project: input?.["project"],
              subpath: input?.["subpath"],
              cursor: input?.["cursor"],
            },
            successStatus: 200,
            declaredStatuses: [400, 401],
            empty: false,
          },
          requestOptions,
        ),
      create: (input?: SessionsCreateInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionsCreateOutput }>(
          {
            method: "POST",
            path: `/api/session`,
            body: {
              id: input?.["id"],
              agent: input?.["agent"],
              model: input?.["model"],
              location: input?.["location"],
            },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      active: (requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionsActiveOutput }>(
          {
            method: "GET",
            path: `/api/session/active`,
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      get: (input: SessionsGetInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionsGetOutput }>(
          {
            method: "GET",
            path: `/api/session/${encodeURIComponent(input.sessionID)}`,
            successStatus: 200,
            declaredStatuses: [404, 400, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      tagsUpdate: (input: SessionsTagsUpdateInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionsTagsUpdateOutput }>(
          {
            method: "PUT",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/tags`,
            body: { tags: input["tags"] },
            successStatus: 200,
            declaredStatuses: [409, 400, 404, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      checkpointCreate: (input: SessionsCheckpointCreateInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionsCheckpointCreateOutput }>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/checkpoint`,
            body: { label: input["label"] },
            successStatus: 200,
            declaredStatuses: [409, 404, 400, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      checkpointList: (input: SessionsCheckpointListInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionsCheckpointListOutput }>(
          {
            method: "GET",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/checkpoint`,
            successStatus: 200,
            declaredStatuses: [404, 400, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      rewindPreview: (input: SessionsRewindPreviewInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionsRewindPreviewOutput }>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/rewind/preview`,
            body: { checkpointID: input["checkpointID"] },
            successStatus: 200,
            declaredStatuses: [404, 400, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      rewindApply: (input: SessionsRewindApplyInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionsRewindApplyOutput }>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/rewind/apply`,
            body: { checkpointID: input["checkpointID"], expectedLastSequence: input["expectedLastSequence"] },
            successStatus: 200,
            declaredStatuses: [404, 409, 400, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      switchAgent: (input: SessionsSwitchAgentInput, requestOptions?: RequestOptions) =>
        request<SessionsSwitchAgentOutput>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/agent`,
            body: { agent: input["agent"] },
            successStatus: 204,
            declaredStatuses: [404, 400, 401],
            empty: true,
          },
          requestOptions,
        ),
      switchModel: (input: SessionsSwitchModelInput, requestOptions?: RequestOptions) =>
        request<SessionsSwitchModelOutput>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/model`,
            body: { model: input["model"] },
            successStatus: 204,
            declaredStatuses: [404, 400, 401],
            empty: true,
          },
          requestOptions,
        ),
      prompt: (input: SessionsPromptInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionsPromptOutput }>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/prompt`,
            body: { id: input["id"], prompt: input["prompt"], delivery: input["delivery"], resume: input["resume"] },
            successStatus: 200,
            declaredStatuses: [409, 404, 400, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      promptQueueList: (input: SessionsPromptQueueListInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionsPromptQueueListOutput }>(
          {
            method: "GET",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/prompt/queue`,
            successStatus: 200,
            declaredStatuses: [404, 400, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      promptQueueUpdate: (input: SessionsPromptQueueUpdateInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionsPromptQueueUpdateOutput }>(
          {
            method: "PATCH",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/prompt/queue/${encodeURIComponent(input.messageID)}`,
            body: { expectedAdmittedSeq: input["expectedAdmittedSeq"], prompt: input["prompt"] },
            successStatus: 200,
            declaredStatuses: [409, 404, 400, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      promptQueueRemove: (input: SessionsPromptQueueRemoveInput, requestOptions?: RequestOptions) =>
        request<SessionsPromptQueueRemoveOutput>(
          {
            method: "DELETE",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/prompt/queue/${encodeURIComponent(input.messageID)}`,
            body: { expectedAdmittedSeq: input["expectedAdmittedSeq"] },
            successStatus: 204,
            declaredStatuses: [409, 404, 400, 401],
            empty: true,
          },
          requestOptions,
        ),
      compact: (input: SessionsCompactInput, requestOptions?: RequestOptions) =>
        request<SessionsCompactOutput>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/compact`,
            successStatus: 204,
            declaredStatuses: [404, 503, 400, 401],
            empty: true,
          },
          requestOptions,
        ),
      wait: (input: SessionsWaitInput, requestOptions?: RequestOptions) =>
        request<SessionsWaitOutput>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/wait`,
            successStatus: 204,
            declaredStatuses: [404, 503, 400, 401],
            empty: true,
          },
          requestOptions,
        ),
      stage: (input: SessionsStageInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionsStageOutput }>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/revert/stage`,
            body: { messageID: input["messageID"], files: input["files"] },
            successStatus: 200,
            declaredStatuses: [404, 500, 400, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      clear: (input: SessionsClearInput, requestOptions?: RequestOptions) =>
        request<SessionsClearOutput>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/revert/clear`,
            successStatus: 204,
            declaredStatuses: [404, 500, 400, 401],
            empty: true,
          },
          requestOptions,
        ),
      commit: (input: SessionsCommitInput, requestOptions?: RequestOptions) =>
        request<SessionsCommitOutput>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/revert/commit`,
            successStatus: 204,
            declaredStatuses: [404, 400, 401],
            empty: true,
          },
          requestOptions,
        ),
      context: (input: SessionsContextInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionsContextOutput }>(
          {
            method: "GET",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/context`,
            successStatus: 200,
            declaredStatuses: [404, 500, 400, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      history: (input: SessionsHistoryInput, requestOptions?: RequestOptions) =>
        request<SessionsHistoryOutput>(
          {
            method: "GET",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/history`,
            query: { limit: input["limit"], after: input["after"] },
            successStatus: 200,
            declaredStatuses: [404, 400, 401],
            empty: false,
          },
          requestOptions,
        ),
      events: (input: SessionsEventsInput, requestOptions?: RequestOptions): AsyncIterable<SessionsEventsOutput> =>
        sse<SessionsEventsOutput>(
          {
            method: "GET",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/event`,
            query: { after: input["after"] },
            successStatus: 200,
            declaredStatuses: [404, 400, 401],
            empty: false,
          },
          requestOptions,
        ),
      interrupt: (input: SessionsInterruptInput, requestOptions?: RequestOptions) =>
        request<SessionsInterruptOutput>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/interrupt`,
            successStatus: 204,
            declaredStatuses: [404, 400, 401],
            empty: true,
          },
          requestOptions,
        ),
      message: (input: SessionsMessageInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionsMessageOutput }>(
          {
            method: "GET",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/message/${encodeURIComponent(input.messageID)}`,
            successStatus: 200,
            declaredStatuses: [404, 400, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
    },
    goals: {
      list: (input: GoalsListInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: GoalsListOutput }>(
          {
            method: "GET",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/goal`,
            query: { history: input["history"] },
            successStatus: 200,
            declaredStatuses: [404, 400, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      create: (input: GoalsCreateInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: GoalsCreateOutput }>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/goal`,
            body: { objective: input["objective"], queue: input["queue"] },
            successStatus: 200,
            declaredStatuses: [404, 400, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      get: (input: GoalsGetInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: GoalsGetOutput }>(
          {
            method: "GET",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/goal/${encodeURIComponent(input.goalID)}`,
            successStatus: 200,
            declaredStatuses: [404, 400, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      run: (input: GoalsRunInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: GoalsRunOutput }>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/goal/${encodeURIComponent(input.goalID)}/run`,
            body: { expectedRevision: input["expectedRevision"] },
            successStatus: 200,
            declaredStatuses: [404, 409, 400, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      pause: (input: GoalsPauseInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: GoalsPauseOutput }>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/goal/${encodeURIComponent(input.goalID)}/pause`,
            body: { expectedRevision: input["expectedRevision"] },
            successStatus: 200,
            declaredStatuses: [404, 409, 400, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      resume: (input: GoalsResumeInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: GoalsResumeOutput }>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/goal/${encodeURIComponent(input.goalID)}/resume`,
            body: { expectedRevision: input["expectedRevision"] },
            successStatus: 200,
            declaredStatuses: [404, 409, 400, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      complete: (input: GoalsCompleteInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: GoalsCompleteOutput }>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/goal/${encodeURIComponent(input.goalID)}/complete`,
            body: { expectedRevision: input["expectedRevision"] },
            successStatus: 200,
            declaredStatuses: [404, 409, 400, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      block: (input: GoalsBlockInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: GoalsBlockOutput }>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/goal/${encodeURIComponent(input.goalID)}/block`,
            body: { expectedRevision: input["expectedRevision"], error: input["error"] },
            successStatus: 200,
            declaredStatuses: [404, 409, 400, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      cancel: (input: GoalsCancelInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: GoalsCancelOutput }>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/goal/${encodeURIComponent(input.goalID)}/cancel`,
            body: { expectedRevision: input["expectedRevision"] },
            successStatus: 200,
            declaredStatuses: [404, 409, 400, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      replace: (input: GoalsReplaceInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: GoalsReplaceOutput }>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/goal/${encodeURIComponent(input.goalID)}/replace`,
            body: { expectedRevision: input["expectedRevision"], objective: input["objective"] },
            successStatus: 200,
            declaredStatuses: [404, 409, 400, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      deleteQueued: (input: GoalsDeleteQueuedInput, requestOptions?: RequestOptions) =>
        request<GoalsDeleteQueuedOutput>(
          {
            method: "DELETE",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/goal/${encodeURIComponent(input.goalID)}`,
            body: { expectedRevision: input["expectedRevision"] },
            successStatus: 204,
            declaredStatuses: [404, 409, 400, 401],
            empty: true,
          },
          requestOptions,
        ),
      reorder: (input: GoalsReorderInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: GoalsReorderOutput }>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/goal/reorder`,
            body: { goals: input["goals"] },
            successStatus: 200,
            declaredStatuses: [404, 409, 400, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
    },
    scheduledPrompts: {
      create: (input: ScheduledPromptsCreateInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: ScheduledPromptsCreateOutput }>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/schedule`,
            body: {
              name: input["name"],
              cron: input["cron"],
              prompt: input["prompt"],
              recurring: input["recurring"],
              durable: input["durable"],
            },
            successStatus: 200,
            declaredStatuses: [409, 400, 404, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      list: (input: ScheduledPromptsListInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: ScheduledPromptsListOutput }>(
          {
            method: "GET",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/schedule`,
            successStatus: 200,
            declaredStatuses: [404, 400, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      get: (input: ScheduledPromptsGetInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: ScheduledPromptsGetOutput }>(
          {
            method: "GET",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/schedule/${encodeURIComponent(input.scheduleID)}`,
            successStatus: 200,
            declaredStatuses: [404, 400, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      update: (input: ScheduledPromptsUpdateInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: ScheduledPromptsUpdateOutput }>(
          {
            method: "PATCH",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/schedule/${encodeURIComponent(input.scheduleID)}`,
            body: {
              expectedRevision: input["expectedRevision"],
              name: input["name"],
              cron: input["cron"],
              prompt: input["prompt"],
              enabled: input["enabled"],
              recurring: input["recurring"],
            },
            successStatus: 200,
            declaredStatuses: [409, 400, 404, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      delete: (input: ScheduledPromptsDeleteInput, requestOptions?: RequestOptions) =>
        request<ScheduledPromptsDeleteOutput>(
          {
            method: "DELETE",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/schedule/${encodeURIComponent(input.scheduleID)}`,
            body: { expectedRevision: input["expectedRevision"] },
            successStatus: 204,
            declaredStatuses: [409, 400, 404, 401],
            empty: true,
          },
          requestOptions,
        ),
      run: (input: ScheduledPromptsRunInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: ScheduledPromptsRunOutput }>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/schedule/${encodeURIComponent(input.scheduleID)}/run`,
            body: { expectedRevision: input["expectedRevision"] },
            successStatus: 200,
            declaredStatuses: [409, 400, 404, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      runMissed: (input: ScheduledPromptsRunMissedInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: ScheduledPromptsRunMissedOutput }>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/schedule/${encodeURIComponent(input.scheduleID)}/run-missed`,
            body: { expectedRevision: input["expectedRevision"] },
            successStatus: 200,
            declaredStatuses: [409, 400, 404, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
    },
    tasks: {
      create: (input: TasksCreateInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: TasksCreateOutput }>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/task`,
            body: {
              title: input["title"],
              description: input["description"],
              activeForm: input["activeForm"],
              metadata: input["metadata"],
              blockedBy: input["blockedBy"],
            },
            successStatus: 200,
            declaredStatuses: [409, 400, 404, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      list: (input: TasksListInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: TasksListOutput }>(
          {
            method: "GET",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/task`,
            query: { status: input["status"], owner: input["owner"], search: input["search"] },
            successStatus: 200,
            declaredStatuses: [404, 400, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      get: (input: TasksGetInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: TasksGetOutput }>(
          {
            method: "GET",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/task/${encodeURIComponent(input.taskID)}`,
            successStatus: 200,
            declaredStatuses: [404, 400, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      update: (input: TasksUpdateInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: TasksUpdateOutput }>(
          {
            method: "PATCH",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/task/${encodeURIComponent(input.taskID)}`,
            body: {
              expectedRevision: input["expectedRevision"],
              title: input["title"],
              description: input["description"],
              activeForm: input["activeForm"],
              metadata: input["metadata"],
              blocks: input["blocks"],
              blockedBy: input["blockedBy"],
            },
            successStatus: 200,
            declaredStatuses: [409, 400, 404, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      claim: (input: TasksClaimInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: TasksClaimOutput }>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/task/${encodeURIComponent(input.taskID)}/claim`,
            body: { expectedRevision: input["expectedRevision"], owner: input["owner"] },
            successStatus: 200,
            declaredStatuses: [409, 400, 404, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      release: (input: TasksReleaseInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: TasksReleaseOutput }>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/task/${encodeURIComponent(input.taskID)}/release`,
            body: { expectedRevision: input["expectedRevision"], owner: input["owner"] },
            successStatus: 200,
            declaredStatuses: [409, 400, 404, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      complete: (input: TasksCompleteInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: TasksCompleteOutput }>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/task/${encodeURIComponent(input.taskID)}/complete`,
            body: { expectedRevision: input["expectedRevision"] },
            successStatus: 200,
            declaredStatuses: [409, 400, 404, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      cancel: (input: TasksCancelInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: TasksCancelOutput }>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/task/${encodeURIComponent(input.taskID)}/cancel`,
            body: { expectedRevision: input["expectedRevision"] },
            successStatus: 200,
            declaredStatuses: [409, 400, 404, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      delete: (input: TasksDeleteInput, requestOptions?: RequestOptions) =>
        request<TasksDeleteOutput>(
          {
            method: "DELETE",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/task/${encodeURIComponent(input.taskID)}`,
            body: { expectedRevision: input["expectedRevision"] },
            successStatus: 204,
            declaredStatuses: [409, 400, 404, 401],
            empty: true,
          },
          requestOptions,
        ),
      clear: (input: TasksClearInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: TasksClearOutput }>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/task/clear`,
            body: { terminalOnly: input["terminalOnly"] },
            successStatus: 200,
            declaredStatuses: [404, 400, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
    },
    teams: {
      create: (input: TeamsCreateInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: TeamsCreateOutput }>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/team`,
            body: { name: input["name"], description: input["description"] },
            successStatus: 200,
            declaredStatuses: [409, 403, 400, 404, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      get: (input: TeamsGetInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: TeamsGetOutput }>(
          {
            method: "GET",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/team`,
            successStatus: 200,
            declaredStatuses: [404, 400, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      memberAdd: (input: TeamsMemberAddInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: TeamsMemberAddOutput }>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/team/member`,
            body: { memberName: input["memberName"], agentID: input["agentID"] },
            successStatus: 200,
            declaredStatuses: [409, 403, 400, 404, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      memberRemove: (input: TeamsMemberRemoveInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: TeamsMemberRemoveOutput }>(
          {
            method: "DELETE",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/team/member/${encodeURIComponent(input.memberName)}`,
            successStatus: 200,
            declaredStatuses: [409, 403, 400, 404, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      messageSend: (input: TeamsMessageSendInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: TeamsMessageSendOutput }>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/team/message`,
            body: {
              recipient: input["recipient"],
              message: input["message"],
              summary: input["summary"],
              kind: input["kind"],
            },
            successStatus: 200,
            declaredStatuses: [409, 403, 400, 404, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      messageList: (input: TeamsMessageListInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: TeamsMessageListOutput }>(
          {
            method: "GET",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/team/message`,
            query: { afterSequence: input["afterSequence"], limit: input["limit"] },
            successStatus: 200,
            declaredStatuses: [404, 400, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      shutdownRequest: (input: TeamsShutdownRequestInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: TeamsShutdownRequestOutput }>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/team/member/${encodeURIComponent(input.memberName)}/shutdown`,
            body: { reason: input["reason"] },
            successStatus: 200,
            declaredStatuses: [409, 403, 400, 404, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      delete: (input: TeamsDeleteInput, requestOptions?: RequestOptions) =>
        request<TeamsDeleteOutput>(
          {
            method: "DELETE",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/team`,
            successStatus: 204,
            declaredStatuses: [409, 403, 404, 400, 401],
            empty: true,
          },
          requestOptions,
        ),
    },
    waits: {
      active: (input: WaitsActiveInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: WaitsActiveOutput }>(
          {
            method: "GET",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/wait`,
            successStatus: 200,
            declaredStatuses: [404, 400, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      wake: (input: WaitsWakeInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: WaitsWakeOutput }>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/wait/${encodeURIComponent(input.waitID)}/wake`,
            successStatus: 200,
            declaredStatuses: [409, 404, 400, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
    },
    triggers: {
      profiles: (requestOptions?: RequestOptions) =>
        request<{ readonly data: TriggersProfilesOutput }>(
          {
            method: "GET",
            path: `/api/trigger/profile`,
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      list: (input: TriggersListInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: TriggersListOutput }>(
          {
            method: "GET",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/trigger/${encodeURIComponent(input.profile)}`,
            successStatus: 200,
            declaredStatuses: [404, 400, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      get: (input: TriggersGetInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: TriggersGetOutput }>(
          {
            method: "GET",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/trigger/${encodeURIComponent(input.profile)}/${encodeURIComponent(input.triggerID)}`,
            successStatus: 200,
            declaredStatuses: [404, 400, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      create: (input: TriggersCreateInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: TriggersCreateOutput }>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/trigger/${encodeURIComponent(input.profile)}`,
            body: { body: input["body"] },
            successStatus: 200,
            declaredStatuses: [404, 400, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      update: (input: TriggersUpdateInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: TriggersUpdateOutput }>(
          {
            method: "PATCH",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/trigger/${encodeURIComponent(input.profile)}/${encodeURIComponent(input.triggerID)}`,
            body: { body: input["body"] },
            successStatus: 200,
            declaredStatuses: [404, 400, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      run: (input: TriggersRunInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: TriggersRunOutput }>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/trigger/${encodeURIComponent(input.profile)}/${encodeURIComponent(input.triggerID)}/run`,
            successStatus: 200,
            declaredStatuses: [404, 400, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
    },
    memories: {
      list: (input?: MemoriesListInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: MemoriesListOutput }>(
          {
            method: "GET",
            path: `/api/memory`,
            query: {
              location: input?.["location"],
              query: input?.["query"],
              type: input?.["type"],
              tag: input?.["tag"],
              source: input?.["source"],
              minimumImportance: input?.["minimumImportance"],
              includeGlobal: input?.["includeGlobal"],
              limit: input?.["limit"],
            },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      create: (input: MemoriesCreateInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: MemoriesCreateOutput }>(
          {
            method: "POST",
            path: `/api/memory`,
            query: { location: input["location"] },
            body: {
              content: input["content"],
              type: input["type"],
              tags: input["tags"],
              importance: input["importance"],
              source: input["source"],
              scope: input["scope"],
              relatedTo: input["relatedTo"],
              strength: input["strength"],
              reviewLevel: input["reviewLevel"],
            },
            successStatus: 200,
            declaredStatuses: [409, 400, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      get: (input: MemoriesGetInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: MemoriesGetOutput }>(
          {
            method: "GET",
            path: `/api/memory/${encodeURIComponent(input.memoryID)}`,
            query: { location: input["location"] },
            successStatus: 200,
            declaredStatuses: [404, 401, 400],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      update: (input: MemoriesUpdateInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: MemoriesUpdateOutput }>(
          {
            method: "PATCH",
            path: `/api/memory/${encodeURIComponent(input.memoryID)}`,
            query: { location: input["location"] },
            body: {
              content: input["content"],
              type: input["type"],
              tags: input["tags"],
              source: input["source"],
              importance: input["importance"],
              strength: input["strength"],
              reviewLevel: input["reviewLevel"],
            },
            successStatus: 200,
            declaredStatuses: [409, 400, 404, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      delete: (input: MemoriesDeleteInput, requestOptions?: RequestOptions) =>
        request<MemoriesDeleteOutput>(
          {
            method: "DELETE",
            path: `/api/memory/${encodeURIComponent(input.memoryID)}`,
            query: { location: input["location"] },
            successStatus: 204,
            declaredStatuses: [401, 400],
            empty: true,
          },
          requestOptions,
        ),
      deleteMany: (input: MemoriesDeleteManyInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: MemoriesDeleteManyOutput }>(
          {
            method: "POST",
            path: `/api/memory/delete`,
            query: { location: input["location"] },
            body: { ids: input["ids"] },
            successStatus: 200,
            declaredStatuses: [400, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      semantic: (input: MemoriesSemanticInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: MemoriesSemanticOutput }>(
          {
            method: "GET",
            path: `/api/memory/semantic`,
            query: {
              location: input["location"],
              query: input["query"],
              topK: input["topK"],
              includeGlobal: input["includeGlobal"],
              indexLimit: input["indexLimit"],
            },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      facets: (input?: MemoriesFacetsInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: MemoriesFacetsOutput }>(
          {
            method: "GET",
            path: `/api/memory/facets`,
            query: { location: input?.["location"], includeGlobal: input?.["includeGlobal"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      status: (input?: MemoriesStatusInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: MemoriesStatusOutput }>(
          {
            method: "GET",
            path: `/api/memory/status`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      recallQuality: (input?: MemoriesRecallQualityInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: MemoriesRecallQualityOutput }>(
          {
            method: "GET",
            path: `/api/memory/recall-quality`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      governancePreview: (input?: MemoriesGovernancePreviewInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: MemoriesGovernancePreviewOutput }>(
          {
            method: "GET",
            path: `/api/memory/governance/preview`,
            query: {
              location: input?.["location"],
              scanLimit: input?.["scanLimit"],
              sampleLimit: input?.["sampleLimit"],
            },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      governanceApply: (input?: MemoriesGovernanceApplyInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: MemoriesGovernanceApplyOutput }>(
          {
            method: "POST",
            path: `/api/memory/governance/apply`,
            query: { location: input?.["location"] },
            body: { scanLimit: input?.["scanLimit"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
    },
    learning: {
      status: (input?: LearningStatusInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: LearningStatusOutput }>(
          {
            method: "GET",
            path: `/api/learning/status`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      record: (input: LearningRecordInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: LearningRecordOutput }>(
          {
            method: "POST",
            path: `/api/learning/outcome`,
            query: { location: input["location"] },
            body: {
              userInput: input["userInput"],
              intent: input["intent"],
              route: input["route"],
              tools: input["tools"],
              success: input["success"],
              errorType: input["errorType"],
              errorMessage: input["errorMessage"],
              userFeedback: input["userFeedback"],
              fixStrategy: input["fixStrategy"],
              regression: input["regression"],
              tokenCount: input["tokenCount"],
              responseTimeMs: input["responseTimeMs"],
              tags: input["tags"],
              importance: input["importance"],
              injectedContextSize: input["injectedContextSize"],
            },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      undo: (input: LearningUndoInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: LearningUndoOutput }>(
          {
            method: "DELETE",
            path: `/api/learning/outcome/${encodeURIComponent(input.outcomeID)}`,
            query: { location: input["location"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      syncDogfood: (input: LearningSyncDogfoodInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: LearningSyncDogfoodOutput }>(
          {
            method: "POST",
            path: `/api/learning/dogfood/sync`,
            query: { location: input["location"] },
            body: { candidates: input["candidates"] },
            successStatus: 200,
            declaredStatuses: [400, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
    },
    feedback: {
      submit: (input: FeedbackSubmitInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: FeedbackSubmitOutput }>(
          {
            method: "POST",
            path: `/api/feedback`,
            query: { location: input["location"] },
            body: {
              category: input["category"],
              rating: input["rating"],
              message: input["message"],
              sessionID: input["sessionID"],
            },
            successStatus: 200,
            declaredStatuses: [400, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      list: (input?: FeedbackListInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: FeedbackListOutput }>(
          {
            method: "GET",
            path: `/api/feedback`,
            query: { location: input?.["location"], limit: input?.["limit"], category: input?.["category"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      summary: (input?: FeedbackSummaryInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: FeedbackSummaryOutput }>(
          {
            method: "GET",
            path: `/api/feedback/summary`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      delete: (input: FeedbackDeleteInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: FeedbackDeleteOutput }>(
          {
            method: "DELETE",
            path: `/api/feedback/${encodeURIComponent(input.feedbackID)}`,
            query: { location: input["location"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
    },
    diagnostics: {
      diagnose: (input: DiagnosticsDiagnoseInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: DiagnosticsDiagnoseOutput }>(
          {
            method: "POST",
            path: `/api/diagnostics/multimodal`,
            query: { location: input["location"] },
            body: { filename: input["filename"], extractedText: input["extractedText"], limit: input["limit"] },
            successStatus: 200,
            declaredStatuses: [400, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
    },
    agentCapabilities: {
      health: (input?: AgentCapabilitiesHealthInput, requestOptions?: RequestOptions) =>
        request<AgentCapabilitiesHealthOutput>(
          {
            method: "GET",
            path: `/api/agent-capabilities/health`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [503, 401, 400],
            empty: false,
          },
          requestOptions,
        ),
      list: (input?: AgentCapabilitiesListInput, requestOptions?: RequestOptions) =>
        request<AgentCapabilitiesListOutput>(
          {
            method: "GET",
            path: `/api/agent-capabilities`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [503, 401, 400],
            empty: false,
          },
          requestOptions,
        ),
      systemOverview: (input?: AgentCapabilitiesSystemOverviewInput, requestOptions?: RequestOptions) =>
        request<AgentCapabilitiesSystemOverviewOutput>(
          {
            method: "GET",
            path: `/api/agent-capabilities/system-overview`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [503, 401, 400],
            empty: false,
          },
          requestOptions,
        ),
      deepInsights: (input?: AgentCapabilitiesDeepInsightsInput, requestOptions?: RequestOptions) =>
        request<AgentCapabilitiesDeepInsightsOutput>(
          {
            method: "GET",
            path: `/api/agent-capabilities/deep-insights`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [400, 503, 401],
            empty: false,
          },
          requestOptions,
        ),
      repoScale: (input?: AgentCapabilitiesRepoScaleInput, requestOptions?: RequestOptions) =>
        request<AgentCapabilitiesRepoScaleOutput>(
          {
            method: "POST",
            path: `/api/agent-capabilities/repository-scale`,
            query: { location: input?.["location"] },
            body: {
              path: input?.["path"],
              query: input?.["query"],
              maxFiles: input?.["maxFiles"],
              limit: input?.["limit"],
            },
            successStatus: 200,
            declaredStatuses: [400, 503, 401],
            empty: false,
          },
          requestOptions,
        ),
      runList: (input?: AgentCapabilitiesRunListInput, requestOptions?: RequestOptions) =>
        request<AgentCapabilitiesRunListOutput>(
          {
            method: "GET",
            path: `/api/agent-capabilities/runs`,
            query: { location: input?.["location"], limit: input?.["limit"] },
            successStatus: 200,
            declaredStatuses: [400, 503, 401],
            empty: false,
          },
          requestOptions,
        ),
      runReport: (input?: AgentCapabilitiesRunReportInput, requestOptions?: RequestOptions) =>
        request<AgentCapabilitiesRunReportOutput>(
          {
            method: "GET",
            path: `/api/agent-capabilities/run-report`,
            query: { location: input?.["location"], runID: input?.["runID"] },
            successStatus: 200,
            declaredStatuses: [400, 503, 401],
            empty: false,
          },
          requestOptions,
        ),
      qualityAssess: (input?: AgentCapabilitiesQualityAssessInput, requestOptions?: RequestOptions) =>
        request<AgentCapabilitiesQualityAssessOutput>(
          {
            method: "POST",
            path: `/api/agent-capabilities/quality`,
            query: { location: input?.["location"] },
            body: { files: input?.["files"], patchText: input?.["patchText"] },
            successStatus: 200,
            declaredStatuses: [400, 503, 401],
            empty: false,
          },
          requestOptions,
        ),
      skillList: (input?: AgentCapabilitiesSkillListInput, requestOptions?: RequestOptions) =>
        request<AgentCapabilitiesSkillListOutput>(
          {
            method: "GET",
            path: `/api/agent-capabilities/skills`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [503, 401, 400],
            empty: false,
          },
          requestOptions,
        ),
      skillRead: (input: AgentCapabilitiesSkillReadInput, requestOptions?: RequestOptions) =>
        request<AgentCapabilitiesSkillReadOutput>(
          {
            method: "GET",
            path: `/api/agent-capabilities/skills/${encodeURIComponent(input.skillID)}`,
            query: { location: input["location"], maxChars: input["maxChars"] },
            successStatus: 200,
            declaredStatuses: [400, 503, 401],
            empty: false,
          },
          requestOptions,
        ),
      skillRoute: (input: AgentCapabilitiesSkillRouteInput, requestOptions?: RequestOptions) =>
        request<AgentCapabilitiesSkillRouteOutput>(
          {
            method: "POST",
            path: `/api/agent-capabilities/skills/route`,
            query: { location: input["location"] },
            body: { request: input["request"] },
            successStatus: 200,
            declaredStatuses: [400, 503, 401],
            empty: false,
          },
          requestOptions,
        ),
      skillSetEnabled: (input: AgentCapabilitiesSkillSetEnabledInput, requestOptions?: RequestOptions) =>
        request<AgentCapabilitiesSkillSetEnabledOutput>(
          {
            method: "POST",
            path: `/api/agent-capabilities/skills/${encodeURIComponent(input.skillID)}/enabled`,
            query: { location: input["location"] },
            body: { enabled: input["enabled"] },
            successStatus: 200,
            declaredStatuses: [400, 503, 401],
            empty: false,
          },
          requestOptions,
        ),
      skillRefresh: (input?: AgentCapabilitiesSkillRefreshInput, requestOptions?: RequestOptions) =>
        request<AgentCapabilitiesSkillRefreshOutput>(
          {
            method: "POST",
            path: `/api/agent-capabilities/skills/refresh`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [503, 401, 400],
            empty: false,
          },
          requestOptions,
        ),
      pluginList: (input?: AgentCapabilitiesPluginListInput, requestOptions?: RequestOptions) =>
        request<AgentCapabilitiesPluginListOutput>(
          {
            method: "GET",
            path: `/api/agent-capabilities/plugins`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [503, 401, 400],
            empty: false,
          },
          requestOptions,
        ),
      customizationList: (input?: AgentCapabilitiesCustomizationListInput, requestOptions?: RequestOptions) =>
        request<AgentCapabilitiesCustomizationListOutput>(
          {
            method: "GET",
            path: `/api/agent-capabilities/customizations`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [503, 401, 400],
            empty: false,
          },
          requestOptions,
        ),
      customizationRender: (input: AgentCapabilitiesCustomizationRenderInput, requestOptions?: RequestOptions) =>
        request<AgentCapabilitiesCustomizationRenderOutput>(
          {
            method: "POST",
            path: `/api/agent-capabilities/customizations/render`,
            query: { location: input["location"] },
            body: { name: input["name"], args: input["args"] },
            successStatus: 200,
            declaredStatuses: [400, 503, 401],
            empty: false,
          },
          requestOptions,
        ),
      pluginSetEnabled: (input: AgentCapabilitiesPluginSetEnabledInput, requestOptions?: RequestOptions) =>
        request<AgentCapabilitiesPluginSetEnabledOutput>(
          {
            method: "POST",
            path: `/api/agent-capabilities/plugins/${encodeURIComponent(input.name)}/enabled`,
            query: { location: input["location"] },
            body: { enabled: input["enabled"] },
            successStatus: 200,
            declaredStatuses: [400, 503, 401],
            empty: false,
          },
          requestOptions,
        ),
      pluginInspect: (input: AgentCapabilitiesPluginInspectInput, requestOptions?: RequestOptions) =>
        request<AgentCapabilitiesPluginInspectOutput>(
          {
            method: "POST",
            path: `/api/agent-capabilities/plugins/install/inspect`,
            query: { location: input["location"] },
            body: { source: input["source"] },
            successStatus: 200,
            declaredStatuses: [400, 503, 401],
            empty: false,
          },
          requestOptions,
        ),
      pluginApply: (input: AgentCapabilitiesPluginApplyInput, requestOptions?: RequestOptions) =>
        request<AgentCapabilitiesPluginApplyOutput>(
          {
            method: "POST",
            path: `/api/agent-capabilities/plugins/install/apply`,
            query: { location: input["location"] },
            body: { token: input["token"], name: input["name"], replace: input["replace"] },
            successStatus: 200,
            declaredStatuses: [400, 503, 401],
            empty: false,
          },
          requestOptions,
        ),
      pluginRemove: (input: AgentCapabilitiesPluginRemoveInput, requestOptions?: RequestOptions) =>
        request<AgentCapabilitiesPluginRemoveOutput>(
          {
            method: "POST",
            path: `/api/agent-capabilities/plugins/${encodeURIComponent(input.name)}/remove`,
            query: { location: input["location"] },
            successStatus: 200,
            declaredStatuses: [400, 503, 401],
            empty: false,
          },
          requestOptions,
        ),
      pluginRestore: (input: AgentCapabilitiesPluginRestoreInput, requestOptions?: RequestOptions) =>
        request<AgentCapabilitiesPluginRestoreOutput>(
          {
            method: "POST",
            path: `/api/agent-capabilities/plugins/restore`,
            query: { location: input["location"] },
            body: { recoveryID: input["recoveryID"] },
            successStatus: 200,
            declaredStatuses: [400, 503, 401],
            empty: false,
          },
          requestOptions,
        ),
      workflowList: (input?: AgentCapabilitiesWorkflowListInput, requestOptions?: RequestOptions) =>
        request<AgentCapabilitiesWorkflowListOutput>(
          {
            method: "GET",
            path: `/api/agent-capabilities/workflows`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [503, 401, 400],
            empty: false,
          },
          requestOptions,
        ),
      workflowPreview: (input: AgentCapabilitiesWorkflowPreviewInput, requestOptions?: RequestOptions) =>
        request<AgentCapabilitiesWorkflowPreviewOutput>(
          {
            method: "POST",
            path: `/api/agent-capabilities/workflows/preview`,
            query: { location: input["location"] },
            body: { path: input["path"] },
            successStatus: 200,
            declaredStatuses: [400, 503, 401],
            empty: false,
          },
          requestOptions,
        ),
      workflowRunList: (input?: AgentCapabilitiesWorkflowRunListInput, requestOptions?: RequestOptions) =>
        request<AgentCapabilitiesWorkflowRunListOutput>(
          {
            method: "GET",
            path: `/api/agent-capabilities/workflow-runs`,
            query: { location: input?.["location"], sessionID: input?.["sessionID"], limit: input?.["limit"] },
            successStatus: 200,
            declaredStatuses: [400, 503, 401],
            empty: false,
          },
          requestOptions,
        ),
      workflowRunGet: (input: AgentCapabilitiesWorkflowRunGetInput, requestOptions?: RequestOptions) =>
        request<AgentCapabilitiesWorkflowRunGetOutput>(
          {
            method: "GET",
            path: `/api/agent-capabilities/workflow-runs/${encodeURIComponent(input.runID)}`,
            query: { location: input["location"] },
            successStatus: 200,
            declaredStatuses: [400, 503, 401],
            empty: false,
          },
          requestOptions,
        ),
      workflowRunEvents: (input: AgentCapabilitiesWorkflowRunEventsInput, requestOptions?: RequestOptions) =>
        request<AgentCapabilitiesWorkflowRunEventsOutput>(
          {
            method: "GET",
            path: `/api/agent-capabilities/workflow-runs/${encodeURIComponent(input.runID)}/events`,
            query: { location: input["location"], after: input["after"], limit: input["limit"] },
            successStatus: 200,
            declaredStatuses: [400, 503, 401],
            empty: false,
          },
          requestOptions,
        ),
      planPreview: (input: AgentCapabilitiesPlanPreviewInput, requestOptions?: RequestOptions) =>
        request<AgentCapabilitiesPlanPreviewOutput>(
          {
            method: "POST",
            path: `/api/agent-capabilities/plan-preview`,
            query: { location: input["location"] },
            body: {
              task: input["task"],
              planText: input["planText"],
              exploredFiles: input["exploredFiles"],
              estimatedSteps: input["estimatedSteps"],
            },
            successStatus: 200,
            declaredStatuses: [400, 503, 401],
            empty: false,
          },
          requestOptions,
        ),
      runTraceExport: (input: AgentCapabilitiesRunTraceExportInput, requestOptions?: RequestOptions) =>
        request<AgentCapabilitiesRunTraceExportOutput>(
          {
            method: "GET",
            path: `/api/agent-capabilities/runs/${encodeURIComponent(input.runID)}/trace`,
            query: { location: input["location"] },
            successStatus: 200,
            declaredStatuses: [400, 503, 401],
            empty: false,
          },
          requestOptions,
        ),
      workflowStart: (input: AgentCapabilitiesWorkflowStartInput, requestOptions?: RequestOptions) =>
        request<AgentCapabilitiesWorkflowStartOutput>(
          {
            method: "POST",
            path: `/api/agent-capabilities/workflow-runs/start`,
            query: { location: input["location"] },
            body: {
              path: input["path"],
              sessionID: input["sessionID"],
              permissionMode: input["permissionMode"],
              maxParallel: input["maxParallel"],
            },
            successStatus: 200,
            declaredStatuses: [400, 503, 401],
            empty: false,
          },
          requestOptions,
        ),
      workflowControl: (input: AgentCapabilitiesWorkflowControlInput, requestOptions?: RequestOptions) =>
        request<AgentCapabilitiesWorkflowControlOutput>(
          {
            method: "POST",
            path: `/api/agent-capabilities/workflow-runs/${encodeURIComponent(input.runID)}/control`,
            query: { location: input["location"] },
            body: { action: input["action"] },
            successStatus: 200,
            declaredStatuses: [400, 503, 401],
            empty: false,
          },
          requestOptions,
        ),
      workflowApprove: (input: AgentCapabilitiesWorkflowApproveInput, requestOptions?: RequestOptions) =>
        request<AgentCapabilitiesWorkflowApproveOutput>(
          {
            method: "POST",
            path: `/api/agent-capabilities/workflow-runs/${encodeURIComponent(input.runID)}/approve`,
            query: { location: input["location"] },
            body: { nodeID: input["nodeID"], approved: input["approved"], comment: input["comment"] },
            successStatus: 200,
            declaredStatuses: [400, 503, 401],
            empty: false,
          },
          requestOptions,
        ),
      workflowRetry: (input: AgentCapabilitiesWorkflowRetryInput, requestOptions?: RequestOptions) =>
        request<AgentCapabilitiesWorkflowRetryOutput>(
          {
            method: "POST",
            path: `/api/agent-capabilities/workflow-runs/${encodeURIComponent(input.runID)}/retry`,
            query: { location: input["location"] },
            body: { nodeID: input["nodeID"], includeDescendants: input["includeDescendants"] },
            successStatus: 200,
            declaredStatuses: [400, 503, 401],
            empty: false,
          },
          requestOptions,
        ),
    },
    mcp: {
      list: (input?: McpListInput, requestOptions?: RequestOptions) =>
        request<McpListOutput>(
          {
            method: "GET",
            path: `/api/mcp`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ),
      resourceCatalog: (input?: McpResourceCatalogInput, requestOptions?: RequestOptions) =>
        request<McpResourceCatalogOutput>(
          {
            method: "GET",
            path: `/api/mcp/resource`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ),
      connect: (input: McpConnectInput, requestOptions?: RequestOptions) =>
        request<McpConnectOutput>(
          {
            method: "POST",
            path: `/api/mcp/${encodeURIComponent(input.server)}/connect`,
            query: { location: input["location"] },
            successStatus: 204,
            declaredStatuses: [404, 401, 400],
            empty: true,
          },
          requestOptions,
        ),
      disconnect: (input: McpDisconnectInput, requestOptions?: RequestOptions) =>
        request<McpDisconnectOutput>(
          {
            method: "POST",
            path: `/api/mcp/${encodeURIComponent(input.server)}/disconnect`,
            query: { location: input["location"] },
            successStatus: 204,
            declaredStatuses: [404, 401, 400],
            empty: true,
          },
          requestOptions,
        ),
    },
    privateOperations: {
      overview: (input?: PrivateOperationsOverviewInput, requestOptions?: RequestOptions) =>
        request<PrivateOperationsOverviewOutput>(
          {
            method: "GET",
            path: `/api/private-operations/overview`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ),
    },
    messages: {
      list: (input: MessagesListInput, requestOptions?: RequestOptions) =>
        request<MessagesListOutput>(
          {
            method: "GET",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/message`,
            query: { limit: input["limit"], order: input["order"], cursor: input["cursor"] },
            successStatus: 200,
            declaredStatuses: [400, 404, 500, 401],
            empty: false,
          },
          requestOptions,
        ),
    },
    models: {
      list: (input?: ModelsListInput, requestOptions?: RequestOptions) =>
        request<ModelsListOutput>(
          {
            method: "GET",
            path: `/api/model`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [503, 401, 400],
            empty: false,
          },
          requestOptions,
        ),
    },
    providers: {
      list: (input?: ProvidersListInput, requestOptions?: RequestOptions) =>
        request<ProvidersListOutput>(
          {
            method: "GET",
            path: `/api/provider`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [503, 401, 400],
            empty: false,
          },
          requestOptions,
        ),
      get: (input: ProvidersGetInput, requestOptions?: RequestOptions) =>
        request<ProvidersGetOutput>(
          {
            method: "GET",
            path: `/api/provider/${encodeURIComponent(input.providerID)}`,
            query: { location: input["location"] },
            successStatus: 200,
            declaredStatuses: [404, 503, 401, 400],
            empty: false,
          },
          requestOptions,
        ),
    },
    integrations: {
      list: (input?: IntegrationsListInput, requestOptions?: RequestOptions) =>
        request<IntegrationsListOutput>(
          {
            method: "GET",
            path: `/api/integration`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ),
      get: (input: IntegrationsGetInput, requestOptions?: RequestOptions) =>
        request<IntegrationsGetOutput>(
          {
            method: "GET",
            path: `/api/integration/${encodeURIComponent(input.integrationID)}`,
            query: { location: input["location"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ),
      connectKey: (input: IntegrationsConnectKeyInput, requestOptions?: RequestOptions) =>
        request<IntegrationsConnectKeyOutput>(
          {
            method: "POST",
            path: `/api/integration/${encodeURIComponent(input.integrationID)}/connect/key`,
            query: { location: input["location"] },
            body: { key: input["key"], label: input["label"] },
            successStatus: 204,
            declaredStatuses: [400, 401],
            empty: true,
          },
          requestOptions,
        ),
      connectOauth: (input: IntegrationsConnectOauthInput, requestOptions?: RequestOptions) =>
        request<IntegrationsConnectOauthOutput>(
          {
            method: "POST",
            path: `/api/integration/${encodeURIComponent(input.integrationID)}/connect/oauth`,
            query: { location: input["location"] },
            body: { methodID: input["methodID"], inputs: input["inputs"], label: input["label"] },
            successStatus: 200,
            declaredStatuses: [400, 401],
            empty: false,
          },
          requestOptions,
        ),
      attemptStatus: (input: IntegrationsAttemptStatusInput, requestOptions?: RequestOptions) =>
        request<IntegrationsAttemptStatusOutput>(
          {
            method: "GET",
            path: `/api/integration/attempt/${encodeURIComponent(input.attemptID)}`,
            query: { location: input["location"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ),
      attemptComplete: (input: IntegrationsAttemptCompleteInput, requestOptions?: RequestOptions) =>
        request<IntegrationsAttemptCompleteOutput>(
          {
            method: "POST",
            path: `/api/integration/attempt/${encodeURIComponent(input.attemptID)}/complete`,
            query: { location: input["location"] },
            body: { code: input["code"] },
            successStatus: 204,
            declaredStatuses: [400, 401],
            empty: true,
          },
          requestOptions,
        ),
      attemptCancel: (input: IntegrationsAttemptCancelInput, requestOptions?: RequestOptions) =>
        request<IntegrationsAttemptCancelOutput>(
          {
            method: "DELETE",
            path: `/api/integration/attempt/${encodeURIComponent(input.attemptID)}`,
            query: { location: input["location"] },
            successStatus: 204,
            declaredStatuses: [401, 400],
            empty: true,
          },
          requestOptions,
        ),
    },
    credentials: {
      update: (input: CredentialsUpdateInput, requestOptions?: RequestOptions) =>
        request<CredentialsUpdateOutput>(
          {
            method: "PATCH",
            path: `/api/credential/${encodeURIComponent(input.credentialID)}`,
            query: { location: input["location"] },
            body: { label: input["label"] },
            successStatus: 204,
            declaredStatuses: [401, 400],
            empty: true,
          },
          requestOptions,
        ),
      remove: (input: CredentialsRemoveInput, requestOptions?: RequestOptions) =>
        request<CredentialsRemoveOutput>(
          {
            method: "DELETE",
            path: `/api/credential/${encodeURIComponent(input.credentialID)}`,
            query: { location: input["location"] },
            successStatus: 204,
            declaredStatuses: [401, 400],
            empty: true,
          },
          requestOptions,
        ),
    },
    permissions: {
      listRequests: (input?: PermissionsListRequestsInput, requestOptions?: RequestOptions) =>
        request<PermissionsListRequestsOutput>(
          {
            method: "GET",
            path: `/api/permission/request`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ),
      listSaved: (input?: PermissionsListSavedInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: PermissionsListSavedOutput }>(
          {
            method: "GET",
            path: `/api/permission/saved`,
            query: { projectID: input?.["projectID"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      removeSaved: (input: PermissionsRemoveSavedInput, requestOptions?: RequestOptions) =>
        request<PermissionsRemoveSavedOutput>(
          {
            method: "DELETE",
            path: `/api/permission/saved/${encodeURIComponent(input.id)}`,
            successStatus: 204,
            declaredStatuses: [401, 400],
            empty: true,
          },
          requestOptions,
        ),
      create: (input: PermissionsCreateInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: PermissionsCreateOutput }>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/permission`,
            body: {
              id: input["id"],
              action: input["action"],
              resources: input["resources"],
              save: input["save"],
              metadata: input["metadata"],
              source: input["source"],
              agent: input["agent"],
            },
            successStatus: 200,
            declaredStatuses: [404, 400, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      list: (input: PermissionsListInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: PermissionsListOutput }>(
          {
            method: "GET",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/permission`,
            successStatus: 200,
            declaredStatuses: [404, 400, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      get: (input: PermissionsGetInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: PermissionsGetOutput }>(
          {
            method: "GET",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/permission/${encodeURIComponent(input.requestID)}`,
            successStatus: 200,
            declaredStatuses: [404, 400, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      reply: (input: PermissionsReplyInput, requestOptions?: RequestOptions) =>
        request<PermissionsReplyOutput>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/permission/${encodeURIComponent(input.requestID)}/reply`,
            body: { reply: input["reply"], message: input["message"] },
            successStatus: 204,
            declaredStatuses: [404, 400, 401],
            empty: true,
          },
          requestOptions,
        ),
    },
    files: {
      list: (input?: FilesListInput, requestOptions?: RequestOptions) =>
        request<FilesListOutput>(
          {
            method: "GET",
            path: `/api/fs/list`,
            query: { location: input?.["location"], path: input?.["path"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ),
      find: (input: FilesFindInput, requestOptions?: RequestOptions) =>
        request<FilesFindOutput>(
          {
            method: "GET",
            path: `/api/fs/find`,
            query: { location: input["location"], query: input["query"], type: input["type"], limit: input["limit"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ),
    },
    commands: {
      list: (input?: CommandsListInput, requestOptions?: RequestOptions) =>
        request<CommandsListOutput>(
          {
            method: "GET",
            path: `/api/command`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ),
    },
    skills: {
      list: (input?: SkillsListInput, requestOptions?: RequestOptions) =>
        request<SkillsListOutput>(
          {
            method: "GET",
            path: `/api/skill`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ),
    },
    events: {
      subscribe: (requestOptions?: RequestOptions): AsyncIterable<EventsSubscribeOutput> =>
        sse<EventsSubscribeOutput>(
          { method: "GET", path: `/api/event`, successStatus: 200, declaredStatuses: [401, 400], empty: false },
          requestOptions,
        ),
    },
    ptys: {
      list: (input?: PtysListInput, requestOptions?: RequestOptions) =>
        request<PtysListOutput>(
          {
            method: "GET",
            path: `/api/pty`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ),
      create: (input?: PtysCreateInput, requestOptions?: RequestOptions) =>
        request<PtysCreateOutput>(
          {
            method: "POST",
            path: `/api/pty`,
            query: { location: input?.["location"] },
            body: {
              command: input?.["command"],
              args: input?.["args"],
              cwd: input?.["cwd"],
              title: input?.["title"],
              env: input?.["env"],
            },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ),
      get: (input: PtysGetInput, requestOptions?: RequestOptions) =>
        request<PtysGetOutput>(
          {
            method: "GET",
            path: `/api/pty/${encodeURIComponent(input.ptyID)}`,
            query: { location: input["location"] },
            successStatus: 200,
            declaredStatuses: [404, 401, 400],
            empty: false,
          },
          requestOptions,
        ),
      update: (input: PtysUpdateInput, requestOptions?: RequestOptions) =>
        request<PtysUpdateOutput>(
          {
            method: "PUT",
            path: `/api/pty/${encodeURIComponent(input.ptyID)}`,
            query: { location: input["location"] },
            body: { title: input["title"], size: input["size"] },
            successStatus: 200,
            declaredStatuses: [404, 401, 400],
            empty: false,
          },
          requestOptions,
        ),
      remove: (input: PtysRemoveInput, requestOptions?: RequestOptions) =>
        request<PtysRemoveOutput>(
          {
            method: "DELETE",
            path: `/api/pty/${encodeURIComponent(input.ptyID)}`,
            query: { location: input["location"] },
            successStatus: 204,
            declaredStatuses: [404, 401, 400],
            empty: true,
          },
          requestOptions,
        ),
    },
    questions: {
      listRequests: (input?: QuestionsListRequestsInput, requestOptions?: RequestOptions) =>
        request<QuestionsListRequestsOutput>(
          {
            method: "GET",
            path: `/api/question/request`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ),
      list: (input: QuestionsListInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: QuestionsListOutput }>(
          {
            method: "GET",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/question`,
            successStatus: 200,
            declaredStatuses: [404, 400, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      reply: (input: QuestionsReplyInput, requestOptions?: RequestOptions) =>
        request<QuestionsReplyOutput>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/question/${encodeURIComponent(input.requestID)}/reply`,
            body: { answers: input["answers"] },
            successStatus: 204,
            declaredStatuses: [404, 400, 401],
            empty: true,
          },
          requestOptions,
        ),
      reject: (input: QuestionsRejectInput, requestOptions?: RequestOptions) =>
        request<QuestionsRejectOutput>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/question/${encodeURIComponent(input.requestID)}/reject`,
            successStatus: 204,
            declaredStatuses: [404, 400, 401],
            empty: true,
          },
          requestOptions,
        ),
    },
    references: {
      list: (input?: ReferencesListInput, requestOptions?: RequestOptions) =>
        request<ReferencesListOutput>(
          {
            method: "GET",
            path: `/api/reference`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ),
    },
    projectCopies: {
      list: (input: ProjectCopiesListInput, requestOptions?: RequestOptions) =>
        request<ProjectCopiesListOutput>(
          {
            method: "GET",
            path: `/experimental/project/${encodeURIComponent(input.projectID)}/copy`,
            query: { location: input["location"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ),
      create: (input: ProjectCopiesCreateInput, requestOptions?: RequestOptions) =>
        request<ProjectCopiesCreateOutput>(
          {
            method: "POST",
            path: `/experimental/project/${encodeURIComponent(input.projectID)}/copy`,
            query: { location: input["location"] },
            body: { strategy: input["strategy"], directory: input["directory"], name: input["name"] },
            successStatus: 200,
            declaredStatuses: [400, 401],
            empty: false,
          },
          requestOptions,
        ),
      remove: (input: ProjectCopiesRemoveInput, requestOptions?: RequestOptions) =>
        request<ProjectCopiesRemoveOutput>(
          {
            method: "DELETE",
            path: `/experimental/project/${encodeURIComponent(input.projectID)}/copy`,
            query: { location: input["location"] },
            body: { directory: input["directory"], force: input["force"] },
            successStatus: 204,
            declaredStatuses: [400, 401],
            empty: true,
          },
          requestOptions,
        ),
      refresh: (input: ProjectCopiesRefreshInput, requestOptions?: RequestOptions) =>
        request<ProjectCopiesRefreshOutput>(
          {
            method: "POST",
            path: `/experimental/project/${encodeURIComponent(input.projectID)}/copy/refresh`,
            query: { location: input["location"] },
            successStatus: 204,
            declaredStatuses: [400, 401],
            empty: true,
          },
          requestOptions,
        ),
    },
  }
}

function appendQuery(params: URLSearchParams, key: string, value: unknown): void {
  if (value === undefined || value === null) return
  if (Array.isArray(value)) {
    for (const item of value) appendQuery(params, key, item)
    return
  }
  if (typeof value === "object") {
    for (const [child, item] of Object.entries(value)) appendQuery(params, `${key}[${child}]`, item)
    return
  }
  params.append(key, String(value))
}

async function json(response: Response): Promise<unknown> {
  if (!isContentType(response, "application/json") && !response.headers.get("content-type")?.includes("+json")) {
    try {
      await response.body?.cancel()
    } catch {}
    throw new ClientError("UnsupportedContentType")
  }
  let text: string
  try {
    text = await response.text()
  } catch (cause) {
    throw new ClientError("Transport", { cause })
  }
  if (text === "") throw new ClientError("MalformedResponse")
  try {
    return JSON.parse(text)
  } catch (cause) {
    throw new ClientError("MalformedResponse", { cause })
  }
}

function isContentType(response: Response, expected: string) {
  return response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() === expected
}

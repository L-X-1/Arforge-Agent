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
  ArtifactsReadInput,
  ArtifactsReadOutput,
  ArtifactsReadRangeInput,
  ArtifactsReadRangeOutput,
  ArtifactsReadScopedInput,
  ArtifactsReadScopedOutput,
  ArtifactsReadScopedRangeInput,
  ArtifactsReadScopedRangeOutput,
  ArtifactsOwnerContextOutput,
  ArtifactsMaintenanceContextInput,
  ArtifactsMaintenanceContextOutput,
  ArtifactsCatalogInput,
  ArtifactsCatalogOutput,
  ArtifactsCatalogScopedInput,
  ArtifactsCatalogScopedOutput,
  ArtifactsAuditInput,
  ArtifactsAuditOutput,
  ArtifactsAuditScopedInput,
  ArtifactsAuditScopedOutput,
  SubagentControlChildrenInput,
  SubagentControlChildrenOutput,
  SubagentControlSteerInput,
  SubagentControlSteerOutput,
  SubagentControlFollowupInput,
  SubagentControlFollowupOutput,
  SubagentControlWaitInput,
  SubagentControlWaitOutput,
  SubagentControlCancelInput,
  SubagentControlCancelOutput,
  SubagentControlStatusInput,
  SubagentControlStatusOutput,
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
  MemoriesCorrectInput,
  MemoriesCorrectOutput,
  MemoriesCorrectionHistoryInput,
  MemoriesCorrectionHistoryOutput,
  MemoriesUndoCorrectionInput,
  MemoriesUndoCorrectionOutput,
  MemoriesConflictListInput,
  MemoriesConflictListOutput,
  MemoriesConflictScanInput,
  MemoriesConflictScanOutput,
  MemoriesResolveConflictInput,
  MemoriesResolveConflictOutput,
  MemoriesDismissConflictInput,
  MemoriesDismissConflictOutput,
  MemoriesUndoConflictInput,
  MemoriesUndoConflictOutput,
  MemoriesCandidateReviewInput,
  MemoriesCandidateReviewOutput,
  MemoriesCandidateApproveInput,
  MemoriesCandidateApproveOutput,
  MemoriesCandidateRejectInput,
  MemoriesCandidateRejectOutput,
  MemoriesCandidateActivateInput,
  MemoriesCandidateActivateOutput,
  MemoriesMaintenanceDeleteInput,
  MemoriesMaintenanceDeleteOutput,
  MemoriesMaintenanceDeleteManyInput,
  MemoriesMaintenanceDeleteManyOutput,
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
  LearningDreamInput,
  LearningDreamOutput,
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
  AgentCapabilitiesEvolutionStatusInput,
  AgentCapabilitiesEvolutionStatusOutput,
  AgentCapabilitiesEvolutionCandidatesInput,
  AgentCapabilitiesEvolutionCandidatesOutput,
  AgentCapabilitiesEvolutionExposuresInput,
  AgentCapabilitiesEvolutionExposuresOutput,
  AgentCapabilitiesEvolutionExposureArchivePreviewInput,
  AgentCapabilitiesEvolutionExposureArchivePreviewOutput,
  AgentCapabilitiesEvolutionExposureArchiveApplyInput,
  AgentCapabilitiesEvolutionExposureArchiveApplyOutput,
  AgentCapabilitiesEvolutionExposureArchivesInput,
  AgentCapabilitiesEvolutionExposureArchivesOutput,
  AgentCapabilitiesEvolutionExposureArchiveGetInput,
  AgentCapabilitiesEvolutionExposureArchiveGetOutput,
  AgentCapabilitiesEvolutionExposureRestorePreviewInput,
  AgentCapabilitiesEvolutionExposureRestorePreviewOutput,
  AgentCapabilitiesEvolutionExposureRestoreApplyInput,
  AgentCapabilitiesEvolutionExposureRestoreApplyOutput,
  AgentCapabilitiesEvolutionExposureArchiveExportInput,
  AgentCapabilitiesEvolutionExposureArchiveExportOutput,
  AgentCapabilitiesEvolutionAuditEventsInput,
  AgentCapabilitiesEvolutionAuditEventsOutput,
  AgentCapabilitiesEvolutionCandidateGetInput,
  AgentCapabilitiesEvolutionCandidateGetOutput,
  AgentCapabilitiesEvolutionOpportunitiesInput,
  AgentCapabilitiesEvolutionOpportunitiesOutput,
  AgentCapabilitiesEvolutionCreateInput,
  AgentCapabilitiesEvolutionCreateOutput,
  AgentCapabilitiesEvolutionFromPatternInput,
  AgentCapabilitiesEvolutionFromPatternOutput,
  AgentCapabilitiesEvolutionTransitionInput,
  AgentCapabilitiesEvolutionTransitionOutput,
  AgentCapabilitiesEvolutionCanaryReportInput,
  AgentCapabilitiesEvolutionCanaryReportOutput,
  AgentCapabilitiesEvolutionContextPreviewInput,
  AgentCapabilitiesEvolutionContextPreviewOutput,
  AgentCapabilitiesExperienceCandidateListInput,
  AgentCapabilitiesExperienceCandidateListOutput,
  AgentCapabilitiesExperienceCandidateGetInput,
  AgentCapabilitiesExperienceCandidateGetOutput,
  AgentCapabilitiesExperienceCandidateReviewInput,
  AgentCapabilitiesExperienceCandidateReviewOutput,
  AgentCapabilitiesExperienceSourceListInput,
  AgentCapabilitiesExperienceSourceListOutput,
  AgentCapabilitiesSkillLifecycleCandidateListInput,
  AgentCapabilitiesSkillLifecycleCandidateListOutput,
  AgentCapabilitiesSkillLifecycleCandidateGetInput,
  AgentCapabilitiesSkillLifecycleCandidateGetOutput,
  AgentCapabilitiesSkillLifecycleCandidateCreateInput,
  AgentCapabilitiesSkillLifecycleCandidateCreateOutput,
  AgentCapabilitiesSkillLifecycleEvaluateInput,
  AgentCapabilitiesSkillLifecycleEvaluateOutput,
  AgentCapabilitiesSkillLifecycleCanaryObservationInput,
  AgentCapabilitiesSkillLifecycleCanaryObservationOutput,
  AgentCapabilitiesSkillLifecycleCanaryStartInput,
  AgentCapabilitiesSkillLifecycleCanaryStartOutput,
  AgentCapabilitiesSkillLifecyclePromoteInput,
  AgentCapabilitiesSkillLifecyclePromoteOutput,
  AgentCapabilitiesSkillLifecycleRollbackInput,
  AgentCapabilitiesSkillLifecycleRollbackOutput,
  AgentCapabilitiesSkillLifecycleDeploymentGetInput,
  AgentCapabilitiesSkillLifecycleDeploymentGetOutput,
  McpListInput,
  McpListOutput,
  McpResourceCatalogInput,
  McpResourceCatalogOutput,
  McpCapabilitiesInput,
  McpCapabilitiesOutput,
  McpActionReconciliationInput,
  McpActionReconciliationOutput,
  McpRecordReconciliationInput,
  McpRecordReconciliationOutput,
  McpConnectInput,
  McpConnectOutput,
  McpDisconnectInput,
  McpDisconnectOutput,
  PrivateOperationsOverviewInput,
  PrivateOperationsOverviewOutput,
  RuntimeInsightSnapshotInput,
  RuntimeInsightSnapshotOutput,
  RuntimeInsightActionRecoveryInput,
  RuntimeInsightActionRecoveryOutput,
  RuntimeInsightActionRecoveryReviewInput,
  RuntimeInsightActionRecoveryReviewOutput,
  RuntimeInsightActionRecoveryRollbackInput,
  RuntimeInsightActionRecoveryRollbackOutput,
  RuntimeInsightArtifactMaintenanceInput,
  RuntimeInsightArtifactMaintenanceOutput,
  RuntimeInsightArtifactMaintenanceSweepInput,
  RuntimeInsightArtifactMaintenanceSweepOutput,
  RuntimeInsightAuditVerifyInput,
  RuntimeInsightAuditVerifyOutput,
  RuntimeInsightChildSettlementAuditInput,
  RuntimeInsightChildSettlementAuditOutput,
  RuntimeInsightChildSettlementRecoverInput,
  RuntimeInsightChildSettlementRecoverOutput,
  RuntimeInsightChildSettlementRecoverySweepInput,
  RuntimeInsightChildSettlementRecoverySweepOutput,
  MessagesListInput,
  MessagesListOutput,
  ModelsDefaultInput,
  ModelsDefaultOutput,
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
  FilesOpenInput,
  FilesOpenOutput,
  FilesCloseInput,
  FilesCloseOutput,
  FilesReadInput,
  FilesReadOutput,
  FilesSaveInput,
  FilesSaveOutput,
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
  PersonalJobsCreateInput,
  PersonalJobsCreateOutput,
  PersonalJobsListInput,
  PersonalJobsListOutput,
  PersonalJobsGetInput,
  PersonalJobsGetOutput,
  PersonalJobsApproveInput,
  PersonalJobsApproveOutput,
  PersonalJobsRejectInput,
  PersonalJobsRejectOutput,
  PersonalJobsStartInput,
  PersonalJobsStartOutput,
  PersonalJobsExecuteInput,
  PersonalJobsExecuteOutput,
  PersonalJobsDispatchInput,
  PersonalJobsDispatchOutput,
  PersonalJobsPauseInput,
  PersonalJobsPauseOutput,
  PersonalJobsResumeInput,
  PersonalJobsResumeOutput,
  PersonalJobsCancelInput,
  PersonalJobsCancelOutput,
  PersonalJobsNotificationsInput,
  PersonalJobsNotificationsOutput,
  PersonalJobsNotificationReadInput,
  PersonalJobsNotificationReadOutput,
  PersonalJobsDeleteInput,
  PersonalJobsDeleteOutput,
  PersonalWorkspaceSnapshotInput,
  PersonalWorkspaceSnapshotOutput,
  TenantPlatformOverviewOutput,
  TenantPlatformSetPolicyInput,
  TenantPlatformSetPolicyOutput,
  TenantPlatformRequestDataInput,
  TenantPlatformRequestDataOutput,
  TenantPlatformApproveDataInput,
  TenantPlatformApproveDataOutput,
  TenantPlatformCreateBackupInput,
  TenantPlatformCreateBackupOutput,
  TenantPlatformVerifyBackupInput,
  TenantPlatformVerifyBackupOutput,
  TenantPlatformExportAuditOutput,
  TenantPlatformListSecretsOutput,
  TenantPlatformRevokeSecretInput,
  TenantPlatformRevokeSecretOutput,
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
  readonly binary: boolean
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
    if (descriptor.binary) {
      try {
        return new Uint8Array(await response.arrayBuffer()) as A
      } catch (cause) {
        throw new ClientError("Transport", { cause })
      }
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
          {
            method: "GET",
            path: `/api/health`,
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
            binary: false,
          },
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            declaredStatuses: [404, 503, 500, 400, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ).then((value) => value.data),
      clear: (input: SessionsClearInput, requestOptions?: RequestOptions) =>
        request<SessionsClearOutput>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/revert/clear`,
            successStatus: 204,
            declaredStatuses: [404, 503, 500, 400, 401],
            empty: true,
            binary: false,
          },
          requestOptions,
        ),
      commit: (input: SessionsCommitInput, requestOptions?: RequestOptions) =>
        request<SessionsCommitOutput>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/revert/commit`,
            successStatus: 204,
            declaredStatuses: [404, 503, 400, 401],
            empty: true,
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
          },
          requestOptions,
        ).then((value) => value.data),
    },
    artifacts: {
      read: (input: ArtifactsReadInput, requestOptions?: RequestOptions) =>
        request<ArtifactsReadOutput>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/artifacts/read`,
            body: { reference: input["reference"], maxBytes: input["maxBytes"] },
            successStatus: 200,
            declaredStatuses: [403, 400, 429, 404, 401],
            empty: false,
            binary: true,
          },
          requestOptions,
        ),
      readRange: (input: ArtifactsReadRangeInput, requestOptions?: RequestOptions) =>
        request<ArtifactsReadRangeOutput>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/artifacts/read-range`,
            body: {
              reference: input["reference"],
              offset: input["offset"],
              length: input["length"],
              ifMatch: input["ifMatch"],
            },
            successStatus: 206,
            declaredStatuses: [403, 400, 429, 404, 401],
            empty: false,
            binary: true,
          },
          requestOptions,
        ),
      readScoped: (input: ArtifactsReadScopedInput, requestOptions?: RequestOptions) =>
        request<ArtifactsReadScopedOutput>(
          {
            method: "POST",
            path: `/api/artifacts/read`,
            body: { reference: input["reference"], maxBytes: input["maxBytes"] },
            successStatus: 200,
            declaredStatuses: [403, 400, 429, 404, 401],
            empty: false,
            binary: true,
          },
          requestOptions,
        ),
      readScopedRange: (input: ArtifactsReadScopedRangeInput, requestOptions?: RequestOptions) =>
        request<ArtifactsReadScopedRangeOutput>(
          {
            method: "POST",
            path: `/api/artifacts/read-range`,
            body: {
              reference: input["reference"],
              offset: input["offset"],
              length: input["length"],
              ifMatch: input["ifMatch"],
            },
            successStatus: 206,
            declaredStatuses: [403, 400, 429, 404, 401],
            empty: false,
            binary: true,
          },
          requestOptions,
        ),
      ownerContext: (requestOptions?: RequestOptions) =>
        request<ArtifactsOwnerContextOutput>(
          {
            method: "GET",
            path: `/api/artifacts/owner-context`,
            successStatus: 200,
            declaredStatuses: [403, 401, 400],
            empty: false,
            binary: false,
          },
          requestOptions,
        ),
      maintenanceContext: (input?: ArtifactsMaintenanceContextInput, requestOptions?: RequestOptions) =>
        request<ArtifactsMaintenanceContextOutput>(
          {
            method: "GET",
            path: `/api/artifacts/maintenance-context`,
            query: { scope: input?.["scope"] },
            successStatus: 200,
            declaredStatuses: [403, 400, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ),
      catalog: (input: ArtifactsCatalogInput, requestOptions?: RequestOptions) =>
        request<ArtifactsCatalogOutput>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/artifacts/catalog`,
            body: { limit: input["limit"], beforeSequence: input["beforeSequence"] },
            successStatus: 200,
            declaredStatuses: [403, 400, 404, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ),
      catalogScoped: (input: ArtifactsCatalogScopedInput, requestOptions?: RequestOptions) =>
        request<ArtifactsCatalogScopedOutput>(
          {
            method: "POST",
            path: `/api/artifacts/catalog`,
            body: { owner: input["owner"], limit: input["limit"], beforeSequence: input["beforeSequence"] },
            successStatus: 200,
            declaredStatuses: [403, 400, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ),
      audit: (input: ArtifactsAuditInput, requestOptions?: RequestOptions) =>
        request<ArtifactsAuditOutput>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/artifacts/audit`,
            body: { limit: input["limit"], beforeSequence: input["beforeSequence"] },
            successStatus: 200,
            declaredStatuses: [403, 400, 404, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ),
      auditScoped: (input: ArtifactsAuditScopedInput, requestOptions?: RequestOptions) =>
        request<ArtifactsAuditScopedOutput>(
          {
            method: "POST",
            path: `/api/artifacts/audit`,
            body: { owner: input["owner"], limit: input["limit"], beforeSequence: input["beforeSequence"] },
            successStatus: 200,
            declaredStatuses: [403, 400, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ),
    },
    subagentControl: {
      children: (input: SubagentControlChildrenInput, requestOptions?: RequestOptions) =>
        request<SubagentControlChildrenOutput>(
          {
            method: "GET",
            path: `/api/subagent-control/${encodeURIComponent(input.parentRunID)}/children`,
            query: { location: input["location"] },
            successStatus: 200,
            declaredStatuses: [400, 409, 403, 503, 404, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ),
      steer: (input: SubagentControlSteerInput, requestOptions?: RequestOptions) =>
        request<SubagentControlSteerOutput>(
          {
            method: "POST",
            path: `/api/subagent-control/${encodeURIComponent(input.parentRunID)}/${encodeURIComponent(input.childRunID)}/steer`,
            query: { location: input["location"] },
            body: { requestID: input["requestID"], prompt: input["prompt"] },
            successStatus: 200,
            declaredStatuses: [400, 409, 403, 503, 404, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ),
      followup: (input: SubagentControlFollowupInput, requestOptions?: RequestOptions) =>
        request<SubagentControlFollowupOutput>(
          {
            method: "POST",
            path: `/api/subagent-control/${encodeURIComponent(input.parentRunID)}/${encodeURIComponent(input.childRunID)}/followup`,
            query: { location: input["location"] },
            body: { requestID: input["requestID"], prompt: input["prompt"] },
            successStatus: 200,
            declaredStatuses: [400, 409, 403, 503, 404, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ),
      wait: (input: SubagentControlWaitInput, requestOptions?: RequestOptions) =>
        request<SubagentControlWaitOutput>(
          {
            method: "POST",
            path: `/api/subagent-control/${encodeURIComponent(input.parentRunID)}/${encodeURIComponent(input.childRunID)}/wait`,
            query: { location: input["location"] },
            body: { requestID: input["requestID"], timeoutMs: input["timeoutMs"] },
            successStatus: 200,
            declaredStatuses: [400, 409, 403, 503, 404, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ),
      cancel: (input: SubagentControlCancelInput, requestOptions?: RequestOptions) =>
        request<SubagentControlCancelOutput>(
          {
            method: "POST",
            path: `/api/subagent-control/${encodeURIComponent(input.parentRunID)}/${encodeURIComponent(input.childRunID)}/cancel`,
            query: { location: input["location"] },
            body: {
              requestID: input["requestID"],
              reason: input["reason"],
              recursive: input["recursive"],
              timeoutMs: input["timeoutMs"],
            },
            successStatus: 200,
            declaredStatuses: [400, 409, 403, 503, 404, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ),
      status: (input: SubagentControlStatusInput, requestOptions?: RequestOptions) =>
        request<SubagentControlStatusOutput>(
          {
            method: "GET",
            path: `/api/subagent-control/${encodeURIComponent(input.parentRunID)}/${encodeURIComponent(input.childRunID)}/${encodeURIComponent(input.operation)}/${encodeURIComponent(input.requestID)}`,
            query: { location: input["location"] },
            successStatus: 200,
            declaredStatuses: [400, 409, 403, 503, 404, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ),
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
          },
          requestOptions,
        ).then((value) => value.data),
      correct: (input: MemoriesCorrectInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: MemoriesCorrectOutput }>(
          {
            method: "POST",
            path: `/api/memory/${encodeURIComponent(input.memoryID)}/correct`,
            query: { location: input["location"] },
            body: { content: input["content"], reason: input["reason"], expectedUpdatedAt: input["expectedUpdatedAt"] },
            successStatus: 200,
            declaredStatuses: [409, 400, 404, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ).then((value) => value.data),
      correctionHistory: (input: MemoriesCorrectionHistoryInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: MemoriesCorrectionHistoryOutput }>(
          {
            method: "GET",
            path: `/api/memory/${encodeURIComponent(input.memoryID)}/corrections`,
            query: { location: input["location"] },
            successStatus: 200,
            declaredStatuses: [404, 401, 400],
            empty: false,
            binary: false,
          },
          requestOptions,
        ).then((value) => value.data),
      undoCorrection: (input: MemoriesUndoCorrectionInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: MemoriesUndoCorrectionOutput }>(
          {
            method: "POST",
            path: `/api/memory/corrections/${encodeURIComponent(input.correctionID)}/undo`,
            query: { location: input["location"] },
            body: { expectedSuccessorUpdatedAt: input["expectedSuccessorUpdatedAt"] },
            successStatus: 200,
            declaredStatuses: [409, 401, 400],
            empty: false,
            binary: false,
          },
          requestOptions,
        ).then((value) => value.data),
      conflictList: (input?: MemoriesConflictListInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: MemoriesConflictListOutput }>(
          {
            method: "GET",
            path: `/api/memory/conflicts`,
            query: { location: input?.["location"], includeClosed: input?.["includeClosed"], limit: input?.["limit"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
            binary: false,
          },
          requestOptions,
        ).then((value) => value.data),
      conflictScan: (input?: MemoriesConflictScanInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: MemoriesConflictScanOutput }>(
          {
            method: "POST",
            path: `/api/memory/conflicts/scan`,
            query: { location: input?.["location"] },
            body: { scanLimit: input?.["scanLimit"], resultLimit: input?.["resultLimit"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
            binary: false,
          },
          requestOptions,
        ).then((value) => value.data),
      resolveConflict: (input: MemoriesResolveConflictInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: MemoriesResolveConflictOutput }>(
          {
            method: "POST",
            path: `/api/memory/conflicts/${encodeURIComponent(input.conflictID)}/resolve`,
            query: { location: input["location"] },
            body: {
              chosenMemoryID: input["chosenMemoryID"],
              reason: input["reason"],
              expectedLeftUpdatedAt: input["expectedLeftUpdatedAt"],
              expectedRightUpdatedAt: input["expectedRightUpdatedAt"],
            },
            successStatus: 200,
            declaredStatuses: [409, 401, 400],
            empty: false,
            binary: false,
          },
          requestOptions,
        ).then((value) => value.data),
      dismissConflict: (input: MemoriesDismissConflictInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: MemoriesDismissConflictOutput }>(
          {
            method: "POST",
            path: `/api/memory/conflicts/${encodeURIComponent(input.conflictID)}/dismiss`,
            query: { location: input["location"] },
            body: {
              reason: input["reason"],
              expectedLeftUpdatedAt: input["expectedLeftUpdatedAt"],
              expectedRightUpdatedAt: input["expectedRightUpdatedAt"],
            },
            successStatus: 200,
            declaredStatuses: [409, 401, 400],
            empty: false,
            binary: false,
          },
          requestOptions,
        ).then((value) => value.data),
      undoConflict: (input: MemoriesUndoConflictInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: MemoriesUndoConflictOutput }>(
          {
            method: "POST",
            path: `/api/memory/conflicts/${encodeURIComponent(input.conflictID)}/undo`,
            query: { location: input["location"] },
            body: {
              expectedLeftUpdatedAt: input["expectedLeftUpdatedAt"],
              expectedRightUpdatedAt: input["expectedRightUpdatedAt"],
            },
            successStatus: 200,
            declaredStatuses: [409, 401, 400],
            empty: false,
            binary: false,
          },
          requestOptions,
        ).then((value) => value.data),
      candidateReview: (input: MemoriesCandidateReviewInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: MemoriesCandidateReviewOutput }>(
          {
            method: "GET",
            path: `/api/memory/candidates/${encodeURIComponent(input.candidateID)}`,
            query: { location: input["location"] },
            successStatus: 200,
            declaredStatuses: [400, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ).then((value) => value.data),
      candidateApprove: (input: MemoriesCandidateApproveInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: MemoriesCandidateApproveOutput }>(
          {
            method: "POST",
            path: `/api/memory/candidates/${encodeURIComponent(input.candidateID)}/approve`,
            query: { location: input["location"] },
            body: { expectedUpdatedAt: input["expectedUpdatedAt"], reason: input["reason"] },
            successStatus: 200,
            declaredStatuses: [409, 400, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ).then((value) => value.data),
      candidateReject: (input: MemoriesCandidateRejectInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: MemoriesCandidateRejectOutput }>(
          {
            method: "POST",
            path: `/api/memory/candidates/${encodeURIComponent(input.candidateID)}/reject`,
            query: { location: input["location"] },
            body: { expectedUpdatedAt: input["expectedUpdatedAt"], reason: input["reason"] },
            successStatus: 200,
            declaredStatuses: [409, 400, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ).then((value) => value.data),
      candidateActivate: (input: MemoriesCandidateActivateInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: MemoriesCandidateActivateOutput }>(
          {
            method: "POST",
            path: `/api/memory/candidates/${encodeURIComponent(input.candidateID)}/activate`,
            query: { location: input["location"] },
            body: { expectedUpdatedAt: input["expectedUpdatedAt"], reason: input["reason"] },
            successStatus: 200,
            declaredStatuses: [409, 400, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ).then((value) => value.data),
      maintenanceDelete: (input: MemoriesMaintenanceDeleteInput, requestOptions?: RequestOptions) =>
        request<MemoriesMaintenanceDeleteOutput>(
          {
            method: "DELETE",
            path: `/api/memory/maintenance/${encodeURIComponent(input.memoryID)}`,
            query: { location: input["location"] },
            body: {
              expectedVersion: input["expectedVersion"],
              actionID: input["actionID"],
              redactionEvidenceID: input["redactionEvidenceID"],
              reason: input["reason"],
            },
            successStatus: 204,
            declaredStatuses: [401, 400],
            empty: true,
            binary: false,
          },
          requestOptions,
        ),
      maintenanceDeleteMany: (input: MemoriesMaintenanceDeleteManyInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: MemoriesMaintenanceDeleteManyOutput }>(
          {
            method: "POST",
            path: `/api/memory/maintenance/delete`,
            query: { location: input["location"] },
            body: { items: input["items"] },
            successStatus: 200,
            declaredStatuses: [400, 401],
            empty: false,
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
          },
          requestOptions,
        ).then((value) => value.data),
    },
    learning: {
      dream: (input?: LearningDreamInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: LearningDreamOutput }>(
          {
            method: "GET",
            path: `/api/learning/dream`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
            binary: false,
          },
          requestOptions,
        ).then((value) => value.data),
      status: (input?: LearningStatusInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: LearningStatusOutput }>(
          {
            method: "GET",
            path: `/api/learning/status`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            body: {
              filename: input["filename"],
              extractedText: input["extractedText"],
              limit: input["limit"],
              mode: input["mode"],
            },
            successStatus: 200,
            declaredStatuses: [400, 401],
            empty: false,
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
          },
          requestOptions,
        ),
      skillSetEnabled: (input: AgentCapabilitiesSkillSetEnabledInput, requestOptions?: RequestOptions) =>
        request<AgentCapabilitiesSkillSetEnabledOutput>(
          {
            method: "POST",
            path: `/api/agent-capabilities/skills/${encodeURIComponent(input.skillID)}/enabled`,
            query: { location: input["location"] },
            body: { enabled: input["enabled"], requestID: input["requestID"] },
            successStatus: 200,
            declaredStatuses: [400, 503, 401],
            empty: false,
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
          },
          requestOptions,
        ),
      pluginSetEnabled: (input: AgentCapabilitiesPluginSetEnabledInput, requestOptions?: RequestOptions) =>
        request<AgentCapabilitiesPluginSetEnabledOutput>(
          {
            method: "POST",
            path: `/api/agent-capabilities/plugins/${encodeURIComponent(input.name)}/enabled`,
            query: { location: input["location"] },
            body: { enabled: input["enabled"], requestID: input["requestID"] },
            successStatus: 200,
            declaredStatuses: [400, 503, 401],
            empty: false,
            binary: false,
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
            binary: false,
          },
          requestOptions,
        ),
      pluginApply: (input: AgentCapabilitiesPluginApplyInput, requestOptions?: RequestOptions) =>
        request<AgentCapabilitiesPluginApplyOutput>(
          {
            method: "POST",
            path: `/api/agent-capabilities/plugins/install/apply`,
            query: { location: input["location"] },
            body: {
              token: input["token"],
              name: input["name"],
              replace: input["replace"],
              requestID: input["requestID"],
            },
            successStatus: 200,
            declaredStatuses: [400, 503, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ),
      pluginRemove: (input: AgentCapabilitiesPluginRemoveInput, requestOptions?: RequestOptions) =>
        request<AgentCapabilitiesPluginRemoveOutput>(
          {
            method: "POST",
            path: `/api/agent-capabilities/plugins/${encodeURIComponent(input.name)}/remove`,
            query: { location: input["location"] },
            body: { requestID: input["requestID"] },
            successStatus: 200,
            declaredStatuses: [400, 503, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ),
      pluginRestore: (input: AgentCapabilitiesPluginRestoreInput, requestOptions?: RequestOptions) =>
        request<AgentCapabilitiesPluginRestoreOutput>(
          {
            method: "POST",
            path: `/api/agent-capabilities/plugins/restore`,
            query: { location: input["location"] },
            body: { recoveryID: input["recoveryID"], requestID: input["requestID"] },
            successStatus: 200,
            declaredStatuses: [400, 503, 401],
            empty: false,
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
          },
          requestOptions,
        ),
      evolutionStatus: (input?: AgentCapabilitiesEvolutionStatusInput, requestOptions?: RequestOptions) =>
        request<AgentCapabilitiesEvolutionStatusOutput>(
          {
            method: "GET",
            path: `/api/agent-capabilities/evolution/status`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [400, 503, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ),
      evolutionCandidates: (input?: AgentCapabilitiesEvolutionCandidatesInput, requestOptions?: RequestOptions) =>
        request<AgentCapabilitiesEvolutionCandidatesOutput>(
          {
            method: "GET",
            path: `/api/agent-capabilities/evolution/candidates`,
            query: { location: input?.["location"], status: input?.["status"], limit: input?.["limit"] },
            successStatus: 200,
            declaredStatuses: [400, 503, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ),
      evolutionExposures: (input?: AgentCapabilitiesEvolutionExposuresInput, requestOptions?: RequestOptions) =>
        request<AgentCapabilitiesEvolutionExposuresOutput>(
          {
            method: "GET",
            path: `/api/agent-capabilities/evolution/exposures`,
            query: { location: input?.["location"], status: input?.["status"], limit: input?.["limit"] },
            successStatus: 200,
            declaredStatuses: [400, 503, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ),
      evolutionExposureArchivePreview: (
        input?: AgentCapabilitiesEvolutionExposureArchivePreviewInput,
        requestOptions?: RequestOptions,
      ) =>
        request<AgentCapabilitiesEvolutionExposureArchivePreviewOutput>(
          {
            method: "GET",
            path: `/api/agent-capabilities/evolution/exposures/archive`,
            query: { location: input?.["location"], keepRecorded: input?.["keepRecorded"] },
            successStatus: 200,
            declaredStatuses: [400, 503, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ),
      evolutionExposureArchiveApply: (
        input: AgentCapabilitiesEvolutionExposureArchiveApplyInput,
        requestOptions?: RequestOptions,
      ) =>
        request<AgentCapabilitiesEvolutionExposureArchiveApplyOutput>(
          {
            method: "POST",
            path: `/api/agent-capabilities/evolution/exposures/archive/apply`,
            query: { location: input["location"] },
            body: {
              keepRecorded: input["keepRecorded"],
              expectedPlanDigest: input["expectedPlanDigest"],
              reason: input["reason"],
            },
            successStatus: 200,
            declaredStatuses: [400, 503, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ),
      evolutionExposureArchives: (
        input?: AgentCapabilitiesEvolutionExposureArchivesInput,
        requestOptions?: RequestOptions,
      ) =>
        request<AgentCapabilitiesEvolutionExposureArchivesOutput>(
          {
            method: "GET",
            path: `/api/agent-capabilities/evolution/exposures/archives`,
            query: { location: input?.["location"], limit: input?.["limit"] },
            successStatus: 200,
            declaredStatuses: [400, 503, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ),
      evolutionExposureArchiveGet: (
        input: AgentCapabilitiesEvolutionExposureArchiveGetInput,
        requestOptions?: RequestOptions,
      ) =>
        request<AgentCapabilitiesEvolutionExposureArchiveGetOutput>(
          {
            method: "GET",
            path: `/api/agent-capabilities/evolution/exposures/archives/${encodeURIComponent(input.archiveID)}`,
            query: { location: input["location"], limit: input["limit"] },
            successStatus: 200,
            declaredStatuses: [400, 503, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ),
      evolutionExposureRestorePreview: (
        input: AgentCapabilitiesEvolutionExposureRestorePreviewInput,
        requestOptions?: RequestOptions,
      ) =>
        request<AgentCapabilitiesEvolutionExposureRestorePreviewOutput>(
          {
            method: "GET",
            path: `/api/agent-capabilities/evolution/exposures/archives/${encodeURIComponent(input.archiveID)}/restore`,
            query: { location: input["location"] },
            successStatus: 200,
            declaredStatuses: [400, 503, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ),
      evolutionExposureRestoreApply: (
        input: AgentCapabilitiesEvolutionExposureRestoreApplyInput,
        requestOptions?: RequestOptions,
      ) =>
        request<AgentCapabilitiesEvolutionExposureRestoreApplyOutput>(
          {
            method: "POST",
            path: `/api/agent-capabilities/evolution/exposures/archives/${encodeURIComponent(input.archiveID)}/restore/apply`,
            query: { location: input["location"] },
            body: { expectedPlanDigest: input["expectedPlanDigest"], reason: input["reason"] },
            successStatus: 200,
            declaredStatuses: [400, 503, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ),
      evolutionExposureArchiveExport: (
        input: AgentCapabilitiesEvolutionExposureArchiveExportInput,
        requestOptions?: RequestOptions,
      ) =>
        request<AgentCapabilitiesEvolutionExposureArchiveExportOutput>(
          {
            method: "GET",
            path: `/api/agent-capabilities/evolution/exposures/archives/${encodeURIComponent(input.archiveID)}/export`,
            query: { location: input["location"] },
            successStatus: 200,
            declaredStatuses: [400, 503, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ),
      evolutionAuditEvents: (input?: AgentCapabilitiesEvolutionAuditEventsInput, requestOptions?: RequestOptions) =>
        request<AgentCapabilitiesEvolutionAuditEventsOutput>(
          {
            method: "GET",
            path: `/api/agent-capabilities/evolution/audit/events`,
            query: {
              location: input?.["location"],
              limit: input?.["limit"],
              beforeSequence: input?.["beforeSequence"],
            },
            successStatus: 200,
            declaredStatuses: [400, 503, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ),
      evolutionCandidateGet: (input: AgentCapabilitiesEvolutionCandidateGetInput, requestOptions?: RequestOptions) =>
        request<AgentCapabilitiesEvolutionCandidateGetOutput>(
          {
            method: "GET",
            path: `/api/agent-capabilities/evolution/candidates/${encodeURIComponent(input.candidateID)}`,
            query: { location: input["location"] },
            successStatus: 200,
            declaredStatuses: [400, 503, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ),
      evolutionOpportunities: (input?: AgentCapabilitiesEvolutionOpportunitiesInput, requestOptions?: RequestOptions) =>
        request<AgentCapabilitiesEvolutionOpportunitiesOutput>(
          {
            method: "GET",
            path: `/api/agent-capabilities/evolution/opportunities`,
            query: { location: input?.["location"], limit: input?.["limit"] },
            successStatus: 200,
            declaredStatuses: [400, 503, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ),
      evolutionCreate: (input: AgentCapabilitiesEvolutionCreateInput, requestOptions?: RequestOptions) =>
        request<AgentCapabilitiesEvolutionCreateOutput>(
          {
            method: "POST",
            path: `/api/agent-capabilities/evolution/candidates`,
            query: { location: input["location"] },
            body: {
              title: input["title"],
              target: input["target"],
              instruction: input["instruction"],
              rationale: input["rationale"],
              evidenceRefs: input["evidenceRefs"],
              sourceExperienceIDs: input["sourceExperienceIDs"],
            },
            successStatus: 200,
            declaredStatuses: [400, 503, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ),
      evolutionFromPattern: (input: AgentCapabilitiesEvolutionFromPatternInput, requestOptions?: RequestOptions) =>
        request<AgentCapabilitiesEvolutionFromPatternOutput>(
          {
            method: "POST",
            path: `/api/agent-capabilities/evolution/patterns/${encodeURIComponent(input.patternID)}/candidate`,
            query: { location: input["location"] },
            successStatus: 200,
            declaredStatuses: [400, 503, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ),
      evolutionTransition: (input: AgentCapabilitiesEvolutionTransitionInput, requestOptions?: RequestOptions) =>
        request<AgentCapabilitiesEvolutionTransitionOutput>(
          {
            method: "POST",
            path: `/api/agent-capabilities/evolution/candidates/${encodeURIComponent(input.candidateID)}/transition`,
            query: { location: input["location"] },
            body: {
              action: input["action"],
              expectedRevision: input["expectedRevision"],
              reason: input["reason"],
              trafficPercent: input["trafficPercent"],
            },
            successStatus: 200,
            declaredStatuses: [400, 503, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ),
      evolutionCanaryReport: (input: AgentCapabilitiesEvolutionCanaryReportInput, requestOptions?: RequestOptions) =>
        request<AgentCapabilitiesEvolutionCanaryReportOutput>(
          {
            method: "GET",
            path: `/api/agent-capabilities/evolution/candidates/${encodeURIComponent(input.candidateID)}/canary`,
            query: { location: input["location"] },
            successStatus: 200,
            declaredStatuses: [400, 503, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ),
      evolutionContextPreview: (
        input: AgentCapabilitiesEvolutionContextPreviewInput,
        requestOptions?: RequestOptions,
      ) =>
        request<AgentCapabilitiesEvolutionContextPreviewOutput>(
          {
            method: "POST",
            path: `/api/agent-capabilities/evolution/context`,
            query: { location: input["location"] },
            body: { userInput: input["userInput"], cohortKey: input["cohortKey"] },
            successStatus: 200,
            declaredStatuses: [400, 503, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ),
      experienceCandidateList: (
        input?: AgentCapabilitiesExperienceCandidateListInput,
        requestOptions?: RequestOptions,
      ) =>
        request<AgentCapabilitiesExperienceCandidateListOutput>(
          {
            method: "GET",
            path: `/api/agent-capabilities/experience/candidates`,
            query: { location: input?.["location"], status: input?.["status"], limit: input?.["limit"] },
            successStatus: 200,
            declaredStatuses: [400, 503, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ),
      experienceCandidateGet: (input: AgentCapabilitiesExperienceCandidateGetInput, requestOptions?: RequestOptions) =>
        request<AgentCapabilitiesExperienceCandidateGetOutput>(
          {
            method: "GET",
            path: `/api/agent-capabilities/experience/candidates/${encodeURIComponent(input.candidateID)}`,
            query: { location: input["location"] },
            successStatus: 200,
            declaredStatuses: [400, 503, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ),
      experienceCandidateReview: (
        input: AgentCapabilitiesExperienceCandidateReviewInput,
        requestOptions?: RequestOptions,
      ) =>
        request<AgentCapabilitiesExperienceCandidateReviewOutput>(
          {
            method: "POST",
            path: `/api/agent-capabilities/experience/candidates/${encodeURIComponent(input.candidateID)}/review`,
            query: { location: input["location"] },
            body: { expectedRevision: input["expectedRevision"], decision: input["decision"], reason: input["reason"] },
            successStatus: 200,
            declaredStatuses: [400, 503, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ),
      experienceSourceList: (input?: AgentCapabilitiesExperienceSourceListInput, requestOptions?: RequestOptions) =>
        request<AgentCapabilitiesExperienceSourceListOutput>(
          {
            method: "GET",
            path: `/api/agent-capabilities/experience/sources`,
            query: { location: input?.["location"], limit: input?.["limit"] },
            successStatus: 200,
            declaredStatuses: [400, 503, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ),
      skillLifecycleCandidateList: (
        input?: AgentCapabilitiesSkillLifecycleCandidateListInput,
        requestOptions?: RequestOptions,
      ) =>
        request<AgentCapabilitiesSkillLifecycleCandidateListOutput>(
          {
            method: "GET",
            path: `/api/agent-capabilities/skill-lifecycle/candidates`,
            query: {
              location: input?.["location"],
              skillID: input?.["skillID"],
              status: input?.["status"],
              limit: input?.["limit"],
            },
            successStatus: 200,
            declaredStatuses: [400, 503, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ),
      skillLifecycleCandidateGet: (
        input: AgentCapabilitiesSkillLifecycleCandidateGetInput,
        requestOptions?: RequestOptions,
      ) =>
        request<AgentCapabilitiesSkillLifecycleCandidateGetOutput>(
          {
            method: "GET",
            path: `/api/agent-capabilities/skill-lifecycle/candidates/${encodeURIComponent(input.candidateID)}`,
            query: { location: input["location"] },
            successStatus: 200,
            declaredStatuses: [400, 503, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ),
      skillLifecycleCandidateCreate: (
        input: AgentCapabilitiesSkillLifecycleCandidateCreateInput,
        requestOptions?: RequestOptions,
      ) =>
        request<AgentCapabilitiesSkillLifecycleCandidateCreateOutput>(
          {
            method: "POST",
            path: `/api/agent-capabilities/skill-lifecycle/candidates`,
            query: { location: input["location"] },
            body: {
              skillID: input["skillID"],
              version: input["version"],
              purpose: input["purpose"],
              triggers: input["triggers"],
              allowedTools: input["allowedTools"],
              allowedCapabilities: input["allowedCapabilities"],
              inputSchema: input["inputSchema"],
              outputSchema: input["outputSchema"],
              instructions: input["instructions"],
              assets: input["assets"],
              scripts: input["scripts"],
              sourceExperienceIDs: input["sourceExperienceIDs"],
              testCases: input["testCases"],
              policyVersion: input["policyVersion"],
            },
            successStatus: 200,
            declaredStatuses: [400, 503, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ),
      skillLifecycleEvaluate: (input: AgentCapabilitiesSkillLifecycleEvaluateInput, requestOptions?: RequestOptions) =>
        request<AgentCapabilitiesSkillLifecycleEvaluateOutput>(
          {
            method: "POST",
            path: `/api/agent-capabilities/skill-lifecycle/candidates/${encodeURIComponent(input.candidateID)}/evaluate`,
            query: { location: input["location"] },
            body: { expectedRevision: input["expectedRevision"], observations: input["observations"] },
            successStatus: 200,
            declaredStatuses: [400, 503, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ),
      skillLifecycleCanaryObservation: (
        input: AgentCapabilitiesSkillLifecycleCanaryObservationInput,
        requestOptions?: RequestOptions,
      ) =>
        request<AgentCapabilitiesSkillLifecycleCanaryObservationOutput>(
          {
            method: "POST",
            path: `/api/agent-capabilities/skill-lifecycle/candidates/${encodeURIComponent(input.candidateID)}/canary/observations`,
            query: { location: input["location"] },
            body: {
              expectedRevision: input["expectedRevision"],
              idempotencyKey: input["idempotencyKey"],
              cohortKey: input["cohortKey"],
              runID: input["runID"],
              evaluationID: input["evaluationID"],
              evidenceIDs: input["evidenceIDs"],
              success: input["success"],
              safetyIncident: input["safetyIncident"],
            },
            successStatus: 200,
            declaredStatuses: [400, 503, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ),
      skillLifecycleCanaryStart: (
        input: AgentCapabilitiesSkillLifecycleCanaryStartInput,
        requestOptions?: RequestOptions,
      ) =>
        request<AgentCapabilitiesSkillLifecycleCanaryStartOutput>(
          {
            method: "POST",
            path: `/api/agent-capabilities/skill-lifecycle/candidates/${encodeURIComponent(input.candidateID)}/canary`,
            query: { location: input["location"] },
            body: {
              expectedRevision: input["expectedRevision"],
              trafficPercent: input["trafficPercent"],
              reason: input["reason"],
            },
            successStatus: 200,
            declaredStatuses: [400, 503, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ),
      skillLifecyclePromote: (input: AgentCapabilitiesSkillLifecyclePromoteInput, requestOptions?: RequestOptions) =>
        request<AgentCapabilitiesSkillLifecyclePromoteOutput>(
          {
            method: "POST",
            path: `/api/agent-capabilities/skill-lifecycle/candidates/${encodeURIComponent(input.candidateID)}/promote`,
            query: { location: input["location"] },
            body: { expectedRevision: input["expectedRevision"], reason: input["reason"] },
            successStatus: 200,
            declaredStatuses: [400, 503, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ),
      skillLifecycleRollback: (input: AgentCapabilitiesSkillLifecycleRollbackInput, requestOptions?: RequestOptions) =>
        request<AgentCapabilitiesSkillLifecycleRollbackOutput>(
          {
            method: "POST",
            path: `/api/agent-capabilities/skill-lifecycle/candidates/${encodeURIComponent(input.candidateID)}/rollback`,
            query: { location: input["location"] },
            body: { expectedRevision: input["expectedRevision"], reason: input["reason"] },
            successStatus: 200,
            declaredStatuses: [400, 503, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ),
      skillLifecycleDeploymentGet: (
        input: AgentCapabilitiesSkillLifecycleDeploymentGetInput,
        requestOptions?: RequestOptions,
      ) =>
        request<AgentCapabilitiesSkillLifecycleDeploymentGetOutput>(
          {
            method: "GET",
            path: `/api/agent-capabilities/skill-lifecycle/deployments/${encodeURIComponent(input.skillID)}`,
            query: { location: input["location"] },
            successStatus: 200,
            declaredStatuses: [400, 503, 401],
            empty: false,
            binary: false,
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
            binary: false,
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
            binary: false,
          },
          requestOptions,
        ),
      capabilities: (input?: McpCapabilitiesInput, requestOptions?: RequestOptions) =>
        request<McpCapabilitiesOutput>(
          {
            method: "GET",
            path: `/api/mcp/capabilities`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
            binary: false,
          },
          requestOptions,
        ),
      actionReconciliation: (input: McpActionReconciliationInput, requestOptions?: RequestOptions) =>
        request<McpActionReconciliationOutput>(
          {
            method: "GET",
            path: `/api/mcp/actions/${encodeURIComponent(input.actionID)}/reconciliation`,
            query: {
              location: input["location"],
              intentDigest: input["intentDigest"],
              idempotencyKey: input["idempotencyKey"],
            },
            successStatus: 200,
            declaredStatuses: [400, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ),
      recordReconciliation: (input: McpRecordReconciliationInput, requestOptions?: RequestOptions) =>
        request<McpRecordReconciliationOutput>(
          {
            method: "POST",
            path: `/api/mcp/actions/${encodeURIComponent(input.actionID)}/reconciliation/record`,
            query: {
              location: input["location"],
              intentDigest: input["intentDigest"],
              idempotencyKey: input["idempotencyKey"],
            },
            body: { expectedEvidenceDigest: input["expectedEvidenceDigest"], approval: input["approval"] },
            successStatus: 200,
            declaredStatuses: [403, 400, 401],
            empty: false,
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
          },
          requestOptions,
        ),
    },
    runtimeInsight: {
      snapshot: (input?: RuntimeInsightSnapshotInput, requestOptions?: RequestOptions) =>
        request<RuntimeInsightSnapshotOutput>(
          {
            method: "GET",
            path: `/api/runtime-insight/snapshot`,
            query: { location: input?.["location"], limit: input?.["limit"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
            binary: false,
          },
          requestOptions,
        ),
      actionRecovery: (input: RuntimeInsightActionRecoveryInput, requestOptions?: RequestOptions) =>
        request<RuntimeInsightActionRecoveryOutput>(
          {
            method: "GET",
            path: `/api/runtime-insight/actions/${encodeURIComponent(input.actionID)}/recovery`,
            query: { location: input["location"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
            binary: false,
          },
          requestOptions,
        ),
      actionRecoveryReview: (input: RuntimeInsightActionRecoveryReviewInput, requestOptions?: RequestOptions) =>
        request<RuntimeInsightActionRecoveryReviewOutput>(
          {
            method: "POST",
            path: `/api/runtime-insight/actions/${encodeURIComponent(input.actionID)}/recovery/review`,
            query: { location: input["location"] },
            body: {
              transactionID: input["transactionID"],
              expectedPhase: input["expectedPhase"],
              observationDigest: input["observationDigest"],
              decision: input["decision"],
              inspectedDecision: input["inspectedDecision"],
            },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
            binary: false,
          },
          requestOptions,
        ),
      actionRecoveryRollback: (input: RuntimeInsightActionRecoveryRollbackInput, requestOptions?: RequestOptions) =>
        request<RuntimeInsightActionRecoveryRollbackOutput>(
          {
            method: "POST",
            path: `/api/runtime-insight/actions/${encodeURIComponent(input.actionID)}/recovery/rollback`,
            query: { location: input["location"] },
            body: {
              transactionID: input["transactionID"],
              expectedPhase: input["expectedPhase"],
              observationDigest: input["observationDigest"],
              inspectedDecision: input["inspectedDecision"],
              approval: input["approval"],
            },
            successStatus: 200,
            declaredStatuses: [403, 400, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ),
      artifactMaintenance: (input?: RuntimeInsightArtifactMaintenanceInput, requestOptions?: RequestOptions) =>
        request<RuntimeInsightArtifactMaintenanceOutput>(
          {
            method: "GET",
            path: `/api/runtime-insight/artifacts/maintenance`,
            query: { location: input?.["location"], scanID: input?.["scanID"], cursor: input?.["cursor"] },
            successStatus: 200,
            declaredStatuses: [403, 400, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ),
      artifactMaintenanceSweep: (input: RuntimeInsightArtifactMaintenanceSweepInput, requestOptions?: RequestOptions) =>
        request<RuntimeInsightArtifactMaintenanceSweepOutput>(
          {
            method: "POST",
            path: `/api/runtime-insight/artifacts/maintenance`,
            query: { location: input["location"] },
            body: {
              scanID: input["scanID"],
              approval: input["approval"],
              maxAgeMs: input["maxAgeMs"],
              enforceQuota: input["enforceQuota"],
            },
            successStatus: 200,
            declaredStatuses: [403, 400, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ),
      auditVerify: (input?: RuntimeInsightAuditVerifyInput, requestOptions?: RequestOptions) =>
        request<RuntimeInsightAuditVerifyOutput>(
          {
            method: "GET",
            path: `/api/runtime-insight/audit/verify`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
            binary: false,
          },
          requestOptions,
        ),
      childSettlementAudit: (input: RuntimeInsightChildSettlementAuditInput, requestOptions?: RequestOptions) =>
        request<RuntimeInsightChildSettlementAuditOutput>(
          {
            method: "GET",
            path: `/api/runtime-insight/settlements/${encodeURIComponent(input.parentRunID)}/${encodeURIComponent(input.childRunID)}`,
            query: { location: input["location"] },
            successStatus: 200,
            declaredStatuses: [403, 400, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ),
      childSettlementRecover: (input: RuntimeInsightChildSettlementRecoverInput, requestOptions?: RequestOptions) =>
        request<RuntimeInsightChildSettlementRecoverOutput>(
          {
            method: "POST",
            path: `/api/runtime-insight/settlements/${encodeURIComponent(input.parentRunID)}/${encodeURIComponent(input.childRunID)}/recover`,
            query: { location: input["location"] },
            body: { approval: input["approval"] },
            successStatus: 200,
            declaredStatuses: [403, 400, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ),
      childSettlementRecoverySweep: (
        input: RuntimeInsightChildSettlementRecoverySweepInput,
        requestOptions?: RequestOptions,
      ) =>
        request<RuntimeInsightChildSettlementRecoverySweepOutput>(
          {
            method: "POST",
            path: `/api/runtime-insight/settlements/recover-pending`,
            query: { location: input["location"] },
            body: { approval: input["approval"], status: input["status"], limit: input["limit"] },
            successStatus: 200,
            declaredStatuses: [403, 400, 401],
            empty: false,
            binary: false,
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
            binary: false,
          },
          requestOptions,
        ),
    },
    models: {
      default: (input?: ModelsDefaultInput, requestOptions?: RequestOptions) =>
        request<ModelsDefaultOutput>(
          {
            method: "GET",
            path: `/api/model/default`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [503, 401, 400],
            empty: false,
            binary: false,
          },
          requestOptions,
        ),
      list: (input?: ModelsListInput, requestOptions?: RequestOptions) =>
        request<ModelsListOutput>(
          {
            method: "GET",
            path: `/api/model`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [503, 401, 400],
            empty: false,
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
          },
          requestOptions,
        ),
    },
    files: {
      open: (input: FilesOpenInput, requestOptions?: RequestOptions) =>
        request<FilesOpenOutput>(
          {
            method: "POST",
            path: `/api/fs/preview/open`,
            query: { location: input["location"] },
            body: { path: input["path"] },
            successStatus: 200,
            declaredStatuses: [400, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ),
      close: (input: FilesCloseInput, requestOptions?: RequestOptions) =>
        request<FilesCloseOutput>(
          {
            method: "POST",
            path: `/api/fs/preview/close`,
            query: { location: input["location"] },
            body: { id: input["id"] },
            successStatus: 200,
            declaredStatuses: [400, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ),
      read: (input: FilesReadInput, requestOptions?: RequestOptions) =>
        request<FilesReadOutput>(
          {
            method: "GET",
            path: `/api/fs/text`,
            query: { location: input["location"], path: input["path"] },
            successStatus: 200,
            declaredStatuses: [400, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ),
      save: (input: FilesSaveInput, requestOptions?: RequestOptions) =>
        request<FilesSaveOutput>(
          {
            method: "PUT",
            path: `/api/fs/text`,
            query: { location: input["location"] },
            body: { path: input["path"], baseVersion: input["baseVersion"], text: input["text"] },
            successStatus: 200,
            declaredStatuses: [400, 409, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ),
      list: (input?: FilesListInput, requestOptions?: RequestOptions) =>
        request<FilesListOutput>(
          {
            method: "GET",
            path: `/api/fs/list`,
            query: { location: input?.["location"], path: input?.["path"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
          },
          requestOptions,
        ),
    },
    events: {
      subscribe: (requestOptions?: RequestOptions): AsyncIterable<EventsSubscribeOutput> =>
        sse<EventsSubscribeOutput>(
          {
            method: "GET",
            path: `/api/event`,
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
            binary: false,
          },
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
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
            binary: false,
          },
          requestOptions,
        ),
    },
    personalJobs: {
      create: (input: PersonalJobsCreateInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: PersonalJobsCreateOutput }>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/personal-job`,
            body: {
              idempotencyKey: input["idempotencyKey"],
              title: input["title"],
              prompt: input["prompt"],
              schedule: input["schedule"],
              credentialIDs: input["credentialIDs"],
              budget: input["budget"],
              approvalPolicy: input["approvalPolicy"],
              quietHours: input["quietHours"],
              notificationPolicy: input["notificationPolicy"],
              retainUntil: input["retainUntil"],
            },
            successStatus: 200,
            declaredStatuses: [409, 400, 404, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ).then((value) => value.data),
      list: (input: PersonalJobsListInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: PersonalJobsListOutput }>(
          {
            method: "GET",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/personal-job`,
            query: { status: input["status"] },
            successStatus: 200,
            declaredStatuses: [409, 400, 404, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ).then((value) => value.data),
      get: (input: PersonalJobsGetInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: PersonalJobsGetOutput }>(
          {
            method: "GET",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/personal-job/${encodeURIComponent(input.jobID)}`,
            successStatus: 200,
            declaredStatuses: [409, 400, 404, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ).then((value) => value.data),
      approve: (input: PersonalJobsApproveInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: PersonalJobsApproveOutput }>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/personal-job/${encodeURIComponent(input.jobID)}/approve`,
            body: { expectedRevision: input["expectedRevision"] },
            successStatus: 200,
            declaredStatuses: [409, 400, 404, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ).then((value) => value.data),
      reject: (input: PersonalJobsRejectInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: PersonalJobsRejectOutput }>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/personal-job/${encodeURIComponent(input.jobID)}/reject`,
            body: { expectedRevision: input["expectedRevision"], reason: input["reason"] },
            successStatus: 200,
            declaredStatuses: [409, 400, 404, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ).then((value) => value.data),
      start: (input: PersonalJobsStartInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: PersonalJobsStartOutput }>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/personal-job/${encodeURIComponent(input.jobID)}/start`,
            body: { expectedRevision: input["expectedRevision"] },
            successStatus: 200,
            declaredStatuses: [409, 400, 404, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ).then((value) => value.data),
      execute: (input: PersonalJobsExecuteInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: PersonalJobsExecuteOutput }>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/personal-job/${encodeURIComponent(input.jobID)}/execute`,
            body: { expectedRevision: input["expectedRevision"] },
            successStatus: 200,
            declaredStatuses: [409, 400, 404, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ).then((value) => value.data),
      dispatch: (input: PersonalJobsDispatchInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: PersonalJobsDispatchOutput }>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/personal-job/dispatch`,
            body: { limit: input["limit"] },
            successStatus: 200,
            declaredStatuses: [409, 400, 404, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ).then((value) => value.data),
      pause: (input: PersonalJobsPauseInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: PersonalJobsPauseOutput }>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/personal-job/${encodeURIComponent(input.jobID)}/pause`,
            body: { expectedRevision: input["expectedRevision"] },
            successStatus: 200,
            declaredStatuses: [409, 400, 404, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ).then((value) => value.data),
      resume: (input: PersonalJobsResumeInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: PersonalJobsResumeOutput }>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/personal-job/${encodeURIComponent(input.jobID)}/resume`,
            body: { expectedRevision: input["expectedRevision"] },
            successStatus: 200,
            declaredStatuses: [409, 400, 404, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ).then((value) => value.data),
      cancel: (input: PersonalJobsCancelInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: PersonalJobsCancelOutput }>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/personal-job/${encodeURIComponent(input.jobID)}/cancel`,
            body: { expectedRevision: input["expectedRevision"], reason: input["reason"] },
            successStatus: 200,
            declaredStatuses: [409, 400, 404, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ).then((value) => value.data),
      notifications: (input: PersonalJobsNotificationsInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: PersonalJobsNotificationsOutput }>(
          {
            method: "GET",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/personal-job/${encodeURIComponent(input.jobID)}/notifications`,
            successStatus: 200,
            declaredStatuses: [409, 400, 404, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ).then((value) => value.data),
      notificationRead: (input: PersonalJobsNotificationReadInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: PersonalJobsNotificationReadOutput }>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/personal-job/${encodeURIComponent(input.jobID)}/notifications/${encodeURIComponent(input.notificationID)}/read`,
            body: { expectedRevision: input["expectedRevision"] },
            successStatus: 200,
            declaredStatuses: [409, 400, 404, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ).then((value) => value.data),
      delete: (input: PersonalJobsDeleteInput, requestOptions?: RequestOptions) =>
        request<PersonalJobsDeleteOutput>(
          {
            method: "DELETE",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/personal-job/${encodeURIComponent(input.jobID)}`,
            body: { expectedRevision: input["expectedRevision"] },
            successStatus: 204,
            declaredStatuses: [409, 400, 404, 401],
            empty: true,
            binary: false,
          },
          requestOptions,
        ),
    },
    personalWorkspace: {
      snapshot: (input?: PersonalWorkspaceSnapshotInput, requestOptions?: RequestOptions) =>
        request<PersonalWorkspaceSnapshotOutput>(
          {
            method: "GET",
            path: `/api/personal-workspace`,
            query: { location: input?.["location"], limit: input?.["limit"] },
            successStatus: 200,
            declaredStatuses: [400, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ),
    },
    tenantPlatform: {
      overview: (requestOptions?: RequestOptions) =>
        request<TenantPlatformOverviewOutput>(
          {
            method: "GET",
            path: `/api/tenant-platform/overview`,
            successStatus: 200,
            declaredStatuses: [400, 503, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ),
      setPolicy: (input: TenantPlatformSetPolicyInput, requestOptions?: RequestOptions) =>
        request<TenantPlatformSetPolicyOutput>(
          {
            method: "POST",
            path: `/api/tenant-platform/policy`,
            body: {
              region: input["region"],
              retention_days: input["retention_days"],
              quota: input["quota"],
              rate_limit: input["rate_limit"],
              key_version: input["key_version"],
            },
            successStatus: 200,
            declaredStatuses: [400, 503, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ),
      requestData: (input: TenantPlatformRequestDataInput, requestOptions?: RequestOptions) =>
        request<TenantPlatformRequestDataOutput>(
          {
            method: "POST",
            path: `/api/tenant-platform/data-requests`,
            body: { kind: input["kind"], reason: input["reason"] },
            successStatus: 200,
            declaredStatuses: [400, 503, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ),
      approveData: (input: TenantPlatformApproveDataInput, requestOptions?: RequestOptions) =>
        request<TenantPlatformApproveDataOutput>(
          {
            method: "POST",
            path: `/api/tenant-platform/data-requests/${encodeURIComponent(input.requestID)}/approval`,
            body: { approve: input["approve"] },
            successStatus: 200,
            declaredStatuses: [400, 503, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ),
      createBackup: (input: TenantPlatformCreateBackupInput, requestOptions?: RequestOptions) =>
        request<TenantPlatformCreateBackupOutput>(
          {
            method: "POST",
            path: `/api/tenant-platform/backups`,
            body: {
              region: input["region"],
              schema_revision: input["schema_revision"],
              artifact_digest: input["artifact_digest"],
            },
            successStatus: 200,
            declaredStatuses: [400, 503, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ),
      verifyBackup: (input: TenantPlatformVerifyBackupInput, requestOptions?: RequestOptions) =>
        request<TenantPlatformVerifyBackupOutput>(
          {
            method: "POST",
            path: `/api/tenant-platform/backups/${encodeURIComponent(input.manifestID)}/verify`,
            body: { artifact_digest: input["artifact_digest"] },
            successStatus: 200,
            declaredStatuses: [400, 503, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ),
      exportAudit: (requestOptions?: RequestOptions) =>
        request<TenantPlatformExportAuditOutput>(
          {
            method: "POST",
            path: `/api/tenant-platform/audit/export`,
            successStatus: 200,
            declaredStatuses: [400, 503, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ),
      listSecrets: (requestOptions?: RequestOptions) =>
        request<TenantPlatformListSecretsOutput>(
          {
            method: "GET",
            path: `/api/tenant-platform/secrets`,
            successStatus: 200,
            declaredStatuses: [400, 503, 401],
            empty: false,
            binary: false,
          },
          requestOptions,
        ),
      revokeSecret: (input: TenantPlatformRevokeSecretInput, requestOptions?: RequestOptions) =>
        request<TenantPlatformRevokeSecretOutput>(
          {
            method: "POST",
            path: `/api/tenant-platform/secrets/${encodeURIComponent(input.secretID)}/revoke`,
            successStatus: 200,
            declaredStatuses: [400, 503, 401],
            empty: false,
            binary: false,
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

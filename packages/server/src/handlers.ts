import { Layer } from "effect"
import { MessageHandler } from "./handlers/message"
import { ModelHandler } from "./handlers/model"
import { ProviderHandler } from "./handlers/provider"
import { SessionHandler } from "./handlers/session"
import { PermissionHandler } from "./handlers/permission"
import { FileSystemHandler } from "./handlers/fs"
import { CommandHandler } from "./handlers/command"
import { SkillHandler } from "./handlers/skill"
import { EventHandler } from "./handlers/event"
import { AgentHandler } from "./handlers/agent"
import { HealthHandler } from "./handlers/health"
import { PtyHandler } from "./handlers/pty"
import { QuestionHandler } from "./handlers/question"
import { ReferenceHandler } from "./handlers/reference"
import { LocationHandler } from "./handlers/location"
import { IntegrationHandler } from "./handlers/integration"
import { CredentialHandler } from "./handlers/credential"
import { ProjectCopyHandler } from "./handlers/project-copy"
import { GoalHandler } from "./handlers/goal"
import { ScheduledPromptHandler } from "./handlers/scheduled-prompt"
import { TaskGraphHandler } from "./handlers/task-graph"
import { TeamHandler } from "./handlers/team"
import { CooperativeWaitHandler } from "./handlers/cooperative-wait"
import { TriggerHandler } from "./handlers/trigger"
import { MemoryHandler } from "./handlers/memory"
import { LearningHandler } from "./handlers/learning"
import { FeedbackHandler } from "./handlers/feedback"
import { MultimodalDiagnosisHandler } from "./handlers/multimodal-diagnosis"
import { AgentCapabilityHandler } from "./handlers/agent-capability"
import { McpHandler } from "./handlers/mcp"
import { PrivateOperationHandler } from "./handlers/private-operation"

export const handlers = Layer.mergeAll(
  HealthHandler,
  LocationHandler,
  AgentHandler,
  SessionHandler,
  GoalHandler,
  ScheduledPromptHandler,
  TaskGraphHandler,
  TeamHandler,
  CooperativeWaitHandler,
  TriggerHandler,
  MemoryHandler,
  LearningHandler,
  FeedbackHandler,
  MultimodalDiagnosisHandler,
  AgentCapabilityHandler,
  McpHandler,
  PrivateOperationHandler,
  MessageHandler,
  ModelHandler,
  ProviderHandler,
  IntegrationHandler,
  CredentialHandler,
  PermissionHandler,
  FileSystemHandler,
  CommandHandler,
  SkillHandler,
  EventHandler,
  PtyHandler,
  QuestionHandler,
  ReferenceHandler,
  ProjectCopyHandler,
)

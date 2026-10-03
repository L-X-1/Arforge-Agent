export * as TeamTools from "./team"

import { ToolFailure } from "@arforge-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { AgentV2 } from "../agent"
import { makeLocationNode } from "../effect/app-node"
import { NonNegativeInt, PositiveInt } from "../schema"
import { TeamV2 } from "../team"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { automaticRead, scopedChange } from "./effect-semantics"

const TeamOutput = Schema.Struct({ team: TeamV2.Info })
const MemberOutput = Schema.Struct({ member: TeamV2.Member })
const MessageOutput = Schema.Struct({ message: TeamV2.Message })
const InboxOutput = Schema.Struct({ inbox: TeamV2.Inbox })
const ShutdownOutput = Schema.Struct({ shutdown: TeamV2.Shutdown })
const DeletedOutput = Schema.Struct({ deleted: TeamV2.ID })

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.BuiltIns
    const teams = yield* TeamV2.Service
    const agents = yield* AgentV2.Service

    const actor = (context: Tool.Context) =>
      teams.resolveActor({ sessionID: context.sessionID, agentID: context.agent }).pipe(toolError)

    const requireLead = (member: TeamV2.MemberName) =>
      member.toLowerCase() === "lead"
        ? Effect.void
        : Effect.fail(new ToolFailure({ message: "Only the current session's team lead can use this lifecycle tool" }))

    const requireCreateLead = (context: Tool.Context) =>
      Effect.gen(function* () {
        const agent = yield* agents.get(context.agent)
        if (agent?.mode === "subagent" || (!agent && context.agent !== AgentV2.defaultID))
          return yield* new ToolFailure({ message: "Only a primary session agent can create a team" })
      })

    const authorize = (action: string, resources: ReadonlyArray<string>, context: Tool.Context) =>
      context.permission.assert({
        action,
        resources: [...resources],
        save: [...resources],
        sessionID: context.sessionID,
        agent: context.agent,
        source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
      })

    yield* tools
      .register({
        team_create: Tool.make({
          description:
            "Create the one durable collaboration team owned by this lead session. Team lifecycle operations are lead-only.",
          input: Schema.Struct({
            name: TeamV2.Name,
            description: TeamV2.Description.pipe(Schema.optional),
          }),
          output: TeamOutput,
          effects: scopedChange({
            externalServices: ["durable-team-store"],
            expectedArtifacts: ["session-owned team"],
            successCriteria: ["the current primary session owns exactly one durable team"],
          }),
          toModelOutput: json,
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* requireCreateLead(context)
              yield* authorize("team_create", ["team"], context)
              return { team: yield* teams.create({ ...input, sessionID: context.sessionID }) }
            }).pipe(toolError),
        }),
        team_get: Tool.make({
          description: "Show the current session-owned team, bounded members, lifecycle states, and mailbox counts.",
          input: Schema.Struct({}),
          output: TeamOutput,
          effects: automaticRead({
            externalServices: ["durable-team-store"],
            expectedArtifacts: ["team state and mailbox counts"],
            successCriteria: ["the current session-owned team is returned without mutation"],
          }),
          toModelOutput: json,
          execute: (_, context) =>
            Effect.gen(function* () {
              const member = yield* actor(context)
              yield* requireLead(member)
              return { team: yield* teams.get(context.sessionID) }
            }).pipe(toolError),
        }),
        team_member_add: Tool.make({
          description:
            "Add a uniquely named collaborator backed by one existing subagent-mode agent. A team supports at most eight collaborators.",
          input: Schema.Struct({
            memberName: TeamV2.CollaboratorName,
            agentID: AgentV2.ID,
          }),
          output: MemberOutput,
          effects: (input) =>
            scopedChange({
              externalServices: ["durable-team-store"],
              expectedArtifacts: [`team member:${input.memberName}`],
              successCriteria: [`member ${input.memberName} is bound to the requested subagent agent`],
            }),
          toModelOutput: json,
          execute: (input, context) =>
            Effect.gen(function* () {
              const member = yield* actor(context)
              yield* requireLead(member)
              yield* authorize("team_member_add", [input.memberName, input.agentID], context)
              return {
                member: yield* teams.addMember({
                  sessionID: context.sessionID,
                  name: input.memberName,
                  agentID: input.agentID,
                  actor: member,
                }),
              }
            }).pipe(toolError),
        }),
        team_message_send: Tool.make({
          description:
            "Send a bounded direct message to one member or broadcast to '*' within only the current session-owned team.",
          input: Schema.Struct({
            recipient: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(32)),
            message: TeamV2.MessageText,
            summary: TeamV2.Summary.pipe(Schema.optional),
            kind: Schema.Literals(["info", "request", "result", "alert"]).pipe(Schema.optional),
          }),
          output: MessageOutput,
          effects: (input) =>
            scopedChange({
              idempotency: "non_idempotent",
              retryability: "never",
              reversibility: "not_applicable",
              externalServices: ["durable-team-mailbox"],
              expectedArtifacts: [`team message:${input.recipient}`],
              successCriteria: [`one bounded message is persisted for ${input.recipient}`],
            }),
          toModelOutput: json,
          execute: (input, context) =>
            Effect.gen(function* () {
              const member = yield* actor(context)
              return {
                message: yield* teams.sendMessage({
                  ...input,
                  sessionID: context.sessionID,
                  actor: member,
                }),
              }
            }).pipe(toolError),
        }),
        team_message_list: Tool.make({
          description:
            "Read only messages addressed to the current lead or registered subagent member; no team or session override is accepted.",
          input: Schema.Struct({
            afterSequence: NonNegativeInt.pipe(Schema.optional),
            limit: PositiveInt.check(Schema.isLessThanOrEqualTo(100)).pipe(Schema.optional),
          }),
          output: InboxOutput,
          effects: automaticRead({
            externalServices: ["durable-team-mailbox"],
            expectedArtifacts: ["bounded team inbox"],
            successCriteria: ["only messages visible to the current team actor are returned"],
          }),
          toModelOutput: json,
        execute: (input, context) =>
          Effect.gen(function* () {
            const member = yield* actor(context)
            yield* authorize("team_message_list", [member], context)
            return {
              inbox: yield* teams.listMessages({
                  ...input,
                  sessionID: context.sessionID,
                  actor: member,
                }),
              }
            }).pipe(toolError),
        }),
        team_shutdown_request: Tool.make({
          description: "Ask one active collaborator to approve or reject a graceful shutdown before removal.",
          input: Schema.Struct({
            memberName: TeamV2.CollaboratorName,
            reason: TeamV2.ShutdownReason.pipe(Schema.optional),
          }),
          output: ShutdownOutput,
          effects: (input) =>
            scopedChange({
              externalServices: ["durable-team-store"],
              expectedArtifacts: [`shutdown request:${input.memberName}`],
              successCriteria: [`a shutdown request is persisted for ${input.memberName}`],
            }),
          toModelOutput: json,
          execute: (input, context) =>
            Effect.gen(function* () {
              const member = yield* actor(context)
              yield* requireLead(member)
              yield* authorize("team_shutdown_request", [input.memberName], context)
              return {
                shutdown: yield* teams.requestShutdown({
                  sessionID: context.sessionID,
                  member: input.memberName,
                  reason: input.reason,
                  actor: member,
                }),
              }
            }).pipe(toolError),
        }),
        team_shutdown_respond: Tool.make({
          description:
            "Approve or reject only the current member's own pending shutdown request. Rejection requires a reason.",
          input: Schema.Struct({
            requestID: TeamV2.ShutdownID,
            approve: Schema.Boolean,
            reason: TeamV2.ShutdownReason.pipe(Schema.optional),
          }),
          output: ShutdownOutput,
          effects: (input) =>
            scopedChange({
              externalServices: ["durable-team-store"],
              expectedArtifacts: [`shutdown response:${input.requestID}`],
              successCriteria: [`shutdown request ${input.requestID} is resolved with the requested decision`],
            }),
          toModelOutput: json,
          execute: (input, context) =>
            Effect.gen(function* () {
              const member = yield* actor(context)
              return {
                shutdown: yield* teams.respondShutdown({
                  sessionID: context.sessionID,
                  shutdownID: input.requestID,
                  approve: input.approve,
                  reason: input.reason,
                  actor: member,
                }),
              }
            }).pipe(toolError),
        }),
        team_member_remove: Tool.make({
          description: "Remove a collaborator only after that same member explicitly approved shutdown.",
          input: Schema.Struct({ memberName: TeamV2.CollaboratorName }),
          output: MemberOutput,
          effects: (input) =>
            scopedChange({
              externalServices: ["durable-team-store"],
              expectedArtifacts: [`team member:${input.memberName}`],
              successCriteria: [`member ${input.memberName} is removed only after approved shutdown`],
            }),
          toModelOutput: json,
          execute: (input, context) =>
            Effect.gen(function* () {
              const member = yield* actor(context)
              yield* requireLead(member)
              yield* authorize("team_member_remove", [input.memberName], context)
              return {
                member: yield* teams.removeMember({
                  sessionID: context.sessionID,
                  member: input.memberName,
                  actor: member,
                }),
              }
            }).pipe(toolError),
        }),
        team_delete: Tool.make({
          description:
            "Delete the complete session-owned team, mailbox, and shutdown metadata only after all collaborators stopped.",
          input: Schema.Struct({}),
          output: DeletedOutput,
          effects: scopedChange({
            externalServices: ["durable-team-store", "durable-team-mailbox"],
            expectedArtifacts: ["deleted session-owned team"],
            successCriteria: ["team, mailbox, and shutdown metadata are deleted after all members stop"],
          }),
          toModelOutput: json,
          execute: (_, context) =>
            Effect.gen(function* () {
              const member = yield* actor(context)
              yield* requireLead(member)
              yield* authorize("team_delete", ["team"], context)
              return { deleted: yield* teams.delete({ sessionID: context.sessionID, actor: member }) }
            }).pipe(toolError),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/team",
  layer,
  deps: [AgentV2.node, TeamV2.node, ToolRegistry.node, ToolRegistry.builtInsNode],
})

function json({ output }: { output: unknown }) {
  return [{ type: "text" as const, text: JSON.stringify(output, null, 2) }]
}

const toolError = Effect.mapError(
  (error: unknown) => Tool.toToolFailure(error) ?? new ToolFailure({ message: describe(error) }),
)

function describe(error: unknown) {
  if (error instanceof ToolFailure) return error.message
  if (typeof error === "object" && error !== null && "_tag" in error) {
    switch (error._tag) {
      case "Team.NotFoundError":
        return "The current session does not own a durable team"
      case "Team.ExistsError":
        return "The current session already owns a durable team"
      case "Team.MemberNotFoundError":
        return "The member does not belong to the current session's team"
      case "Team.MemberExistsError":
        return "A member with this name already exists in the current team"
      case "Team.RoleInUseError":
        return "This subagent role is already assigned to another team member"
      case "Team.InvalidRoleError":
        return "The requested agent does not exist or is not configured as a subagent"
      case "Team.LimitError":
        return "The team already has the maximum of eight collaborators"
      case "Team.AccessDeniedError":
        return "The current agent is not authorized for this team operation"
      case "Team.InvalidRecipientError":
        return "The recipient is invalid for this team mailbox"
      case "Team.MemberStoppedError":
        return "The requested team member has already stopped"
      case "Team.InvalidStateError":
        return (error as TeamV2.InvalidStateError).message
      case "Team.ShutdownNotFoundError":
        return "The shutdown request does not belong to this team"
    }
  }
  return error instanceof Error ? error.message : "Unable to operate on the durable team"
}

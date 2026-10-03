import { expect, test } from "bun:test"
import { OpenApi } from "effect/unstable/httpapi"
import { Api } from "./api"

test("verified Experience and the governed Skill lifecycle are present in the server contract", () => {
  const spec = OpenApi.fromApi(Api) as {
    paths?: Record<string, Record<string, { operationId?: string }>>
    components?: { schemas?: Record<string, unknown> }
  }

  expect(spec.paths?.["/api/agent-capabilities/experience/sources"]?.get?.operationId).toBe(
    "server.agentCapability.agentCapability.experienceSourceList",
  )
  expect(spec.paths?.["/api/agent-capabilities/skill-lifecycle/candidates"]?.post?.operationId).toBe(
    "server.agentCapability.agentCapability.skillLifecycleCandidateCreate",
  )
  expect(
    spec.paths?.["/api/agent-capabilities/skill-lifecycle/candidates/{candidateID}/evaluate"]?.post?.operationId,
  ).toBe("server.agentCapability.agentCapability.skillLifecycleEvaluate")
  expect(
    spec.paths?.["/api/agent-capabilities/skill-lifecycle/candidates/{candidateID}/canary/observations"]?.post
      ?.operationId,
  ).toBe("server.agentCapability.agentCapability.skillLifecycleCanaryObservation")
  expect(spec.components?.schemas?.["AgentCapability.SkillLifecycleCandidateDetail"]).toBeDefined()
  expect(spec.components?.schemas?.["AgentCapability.SkillCanarySummary"]).toBeDefined()
})

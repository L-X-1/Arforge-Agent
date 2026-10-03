import type {
  AgentListOutput,
  ModelDefaultOutput,
  ModelListOutput,
  PermissionV2Request,
  ProviderListOutput,
} from "@arforge-ai/client/promise"
import type { Agent, PermissionRequest, Project, Provider, ProviderListResponse } from "@arforge-ai/sdk/v2/client"
import type { Project as CurrentProject } from "@arforge-ai/client/promise"
import type { Agent as RuntimeAgent } from "@arforge-ai/schema/agent"
import { NormalizedProviderListResponse } from "@arforge-ai/session-ui/context"
export { pathKey as directoryKey, type PathKey as DirectoryKey } from "@/utils/path-key"

export const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

export function normalizeAgentList(
  input: Array<AgentListOutput["data"][number] | RuntimeAgent.Info | Agent>,
): Agent[] {
  if (input.every((agent) => !("request" in agent))) return input as Agent[]
  return input.map((agent) => {
    if (!("request" in agent)) return agent
    // The canonical runtime stores model parameters in body. Older vendor
    // clients expose settings alongside body; preserve their settings when
    // present, and never mix request headers into model options.
    const settings = ("settings" in agent.request ? agent.request.settings : undefined) ?? agent.request.body ?? {}
    const topP = settings.topP ?? settings.top_p
    return {
      name: agent.id,
      description: agent.description,
      mode: agent.mode,
      hidden: agent.hidden,
      temperature: typeof settings.temperature === "number" ? settings.temperature : undefined,
      topP: typeof topP === "number" ? topP : undefined,
      color: agent.color,
      permission: agent.permissions.map((rule) => ({
        permission: rule.action,
        pattern: rule.resource,
        action: rule.effect,
      })),
      model: agent.model && { providerID: agent.model.providerID, modelID: agent.model.id },
      variant: agent.model?.variant,
      prompt: agent.system,
      options: settings,
      steps: agent.steps,
    }
  })
}

export function normalizePermissionRequest(input: PermissionV2Request | PermissionRequest): PermissionRequest {
  if ("permission" in input) return input
  const requiresHumanConfirmation =
    "requiresHumanConfirmation" in input &&
    (input as PermissionV2Request & { readonly requiresHumanConfirmation?: unknown }).requiresHumanConfirmation === true
  return {
    id: input.id,
    sessionID: input.sessionID,
    permission: input.action,
    patterns: input.resources,
    always: input.save ?? [],
    metadata: input.metadata ?? {},
    ...(requiresHumanConfirmation ? { requiresHumanConfirmation: true } : {}),
    tool:
      input.source?.type === "tool" ? { messageID: input.source.messageID, callID: input.source.callID } : undefined,
  }
}

function modelReleaseDate(released: number): string {
  // The runtime uses zero for an unknown release date. Do not turn it into
  // 1970-01-01, which the model picker treats as an old, hidden model.
  if (!Number.isFinite(released) || released <= 0) return ""
  const date = new Date(released)
  if (Number.isNaN(date.getTime())) return ""
  return date.toISOString().slice(0, 10)
}

export function normalizeProviderList(
  providers: ProviderListOutput["data"] | ProviderListResponse,
  models?: ModelListOutput["data"],
  defaultModel?: ModelDefaultOutput["data"],
): NormalizedProviderListResponse {
  if (!Array.isArray(providers)) {
    return {
      ...providers,
      all: new Map(
        providers.all.map((provider) => [
          provider.id,
          {
            ...provider,
            models: Object.fromEntries(
              Object.entries(provider.models).filter(([, model]) => model.status !== "deprecated"),
            ),
          },
        ]),
      ),
    }
  }
  const all = new Map<string, Provider>()

  for (const provider of providers) {
    all.set(provider.id, {
      id: provider.id,
      name: provider.name,
      source: "custom",
      env: [],
      options: provider.settings ?? {},
      models: {},
    })
  }

  for (const model of models ?? []) {
    const provider = all.get(model.providerID)
    if (!provider || model.status === "deprecated") continue
    const cost = model.cost.find((item) => item.tier === undefined) ?? model.cost[0]
    provider.models[model.id] = {
      id: model.id,
      providerID: model.providerID,
      api: {
        id: model.modelID,
        url: "",
        npm: model.package ?? provider.id,
      },
      name: model.name,
      family: model.family,
      capabilities: {
        temperature: false,
        reasoning: false,
        attachment: model.capabilities.input.some((item) => item !== "text"),
        toolcall: model.capabilities.tools,
        input: {
          text: model.capabilities.input.includes("text"),
          audio: model.capabilities.input.includes("audio"),
          image: model.capabilities.input.includes("image"),
          video: model.capabilities.input.includes("video"),
          pdf: model.capabilities.input.includes("pdf"),
        },
        output: {
          text: model.capabilities.output.includes("text"),
          audio: model.capabilities.output.includes("audio"),
          image: model.capabilities.output.includes("image"),
          video: model.capabilities.output.includes("video"),
          pdf: model.capabilities.output.includes("pdf"),
        },
        interleaved: false,
      },
      cost: {
        input: cost?.input ?? 0,
        output: cost?.output ?? 0,
        cache: {
          read: cost?.cache.read ?? 0,
          write: cost?.cache.write ?? 0,
        },
      },
      limit: model.limit,
      status: model.status,
      options: model.settings ?? {},
      headers: model.headers ?? {},
      release_date: modelReleaseDate(model.time.released),
      variants: Object.fromEntries(model.variants.map((variant) => [variant.id, variant.settings ?? {}])),
    }
  }

  return {
    all,
    connected: providers.map((provider) => provider.id),
    default: Object.fromEntries(
      providers.flatMap((provider) => {
        const model =
          defaultModel?.providerID === provider.id
            ? defaultModel
            : models?.find((item) => item.providerID === provider.id && item.status !== "deprecated")
        return model ? [[provider.id, model.id]] : []
      }),
    ),
  }
}

export function sanitizeProject(project: Project) {
  if (!project.icon?.url && !project.icon?.override) return project
  return {
    ...project,
    icon: {
      ...project.icon,
      url: undefined,
      override: undefined,
    },
  }
}

export function normalizeProjectInfo(project: Project | CurrentProject): Project {
  return {
    ...project,
    vcs: project.vcs === "git" ? "git" : undefined,
  }
}

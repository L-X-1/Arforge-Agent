import { Context } from "effect"
import type { InstanceContext } from "@/project/instance-context"
import type { WorkspaceV2 } from "@arforge-ai/core/workspace"

export const InstanceRef = Context.Reference<InstanceContext | undefined>("~arforge/InstanceRef", {
  defaultValue: () => undefined,
})

export const WorkspaceRef = Context.Reference<WorkspaceV2.ID | undefined>("~arforge/WorkspaceRef", {
  defaultValue: () => undefined,
})

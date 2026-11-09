import { describe, expect, test } from "bun:test"
import {
  ARFORGE_SETTINGS_TABS,
  MEMORY_RECALL_EVIDENCE_VIEW_ID,
  PERSONAL_WORKSPACE_MEMORY_CANDIDATES_ID,
  arforgeSettingsTab,
  createNavigationScopeRequest,
  isArforgeSettingsValue,
  isNavigationScopeCurrent,
  isSessionLocationPage,
  requestedNavigationView,
  sessionLocationSource,
  settingsLocationReady,
} from "./navigation"

describe("Arforge settings navigation", () => {
  test("uses unique namespaced values for every integrated page", () => {
    const values = ARFORGE_SETTINGS_TABS.map((item) => item.value)

    expect(values).toHaveLength(11)
    expect(new Set(values).size).toBe(values.length)
    expect(values.every((value) => value.startsWith("arforge-"))).toBe(true)
  })

  test("resolves valid pages without accepting unrelated settings tabs", () => {
    expect(isArforgeSettingsValue("arforge-overview")).toBe(true)
    expect(isArforgeSettingsValue("providers")).toBe(false)
    expect(arforgeSettingsTab("arforge-diagnostics")?.icon).toBe("checklist")
    expect(arforgeSettingsTab("arforge-evolution")?.label).toBe("受控自主进化")
    expect(arforgeSettingsTab("arforge-runtime")?.label).toBe("运行时透视")
    expect(arforgeSettingsTab("missing")).toBeUndefined()
  })

  test("focused memory navigation reuses the existing workspace section and recall view ids", () => {
    expect(PERSONAL_WORKSPACE_MEMORY_CANDIDATES_ID).toBe("personal-workspace-memory-candidates")
    expect(MEMORY_RECALL_EVIDENCE_VIEW_ID).toBe("memory-2")
    // The outer memory panel only owns its two existing category views.
    const memoryPanel = [{ id: "entries" }, { id: "governance" }]
    expect(requestedNavigationView(memoryPanel, "governance")).toBe("governance")
    expect(requestedNavigationView(memoryPanel, MEMORY_RECALL_EVIDENCE_VIEW_ID)).toBeUndefined()
    // The recall evidence id resolves only inside the mounted governance owner.
    const governanceViews = [{ id: "memory-0" }, { id: "memory-1" }, { id: MEMORY_RECALL_EVIDENCE_VIEW_ID }]
    expect(requestedNavigationView(governanceViews, MEMORY_RECALL_EVIDENCE_VIEW_ID)).toBe(MEMORY_RECALL_EVIDENCE_VIEW_ID)
    expect(requestedNavigationView(governanceViews, "not-a-view")).toBeUndefined()
    expect(requestedNavigationView(memoryPanel, undefined)).toBeUndefined()
  })

  test("drops a queued focused navigation when the project or workspace changes", () => {
    const request = createNavigationScopeRequest({ directory: "E:/workspace-a", workspace: "workspace-a" })
    expect(isNavigationScopeCurrent(request, { directory: "E:/workspace-a", workspace: "workspace-a" })).toBe(true)
    expect(isNavigationScopeCurrent(request, { directory: "E:/workspace-b", workspace: "workspace-a" })).toBe(false)
    expect(isNavigationScopeCurrent(request, { directory: "E:/workspace-a", workspace: "workspace-b" })).toBe(false)
    // A request without a workspace is not current for a workspace-scoped location.
    expect(isNavigationScopeCurrent(request, { directory: "E:/workspace-a" })).toBe(false)
    expect(isNavigationScopeCurrent(undefined, { directory: "E:/workspace-a", workspace: "workspace-a" })).toBe(false)
  })

  test("keeps a focused navigation from a session in a non-default workspace", () => {
    const sessionID = "ses_non_default_workspace"
    // The memory page must resolve the shared session source, exactly like the
    // Personal Workspace page, instead of first resolving the default location.
    expect(isSessionLocationPage("arforge-memory")).toBe(true)
    expect(isSessionLocationPage("arforge-workspace")).toBe(true)
    expect(sessionLocationSource("arforge-memory", sessionID)).toBe(sessionID)
    expect(sessionLocationSource("arforge-workspace", sessionID)).toBe(sessionID)
    // Other settings pages keep their previous default-location behavior.
    expect(sessionLocationSource("arforge-overview", sessionID)).toBeUndefined()
    expect(sessionLocationSource("arforge-memory", undefined)).toBeUndefined()
    expect(sessionLocationSource("arforge-memory", "")).toBeUndefined()

    const request = createNavigationScopeRequest({
      directory: "E:/session-workspace",
      workspace: "workspace-session",
    })
    // Both pages resolve the session workspace, so the queued request survives the
    // tab switch to Personal Workspace and focuses once after its data is ready.
    expect(
      isNavigationScopeCurrent(request, { directory: "E:/session-workspace", workspace: "workspace-session" }),
    ).toBe(true)
    // The default-location scope captured by the old code would have been dropped.
    expect(
      isNavigationScopeCurrent(request, { directory: "E:/default-workspace", workspace: "workspace-default" }),
    ).toBe(false)
  })

  test("a failed session-source resolution leaves memory pages unready instead of reusing the old workspace", () => {
    // After a failed source switch, state.location can still hold the previous
    // workspace. Memory navigation and its sub-views must follow Personal
    // Workspace's !state.error readiness instead of acting on that stale directory.
    expect(settingsLocationReady(false, "Location resolution failed", true)).toBe(false)
    expect(settingsLocationReady(true, "", true)).toBe(false)
    expect(settingsLocationReady(false, "", false)).toBe(false)
    expect(settingsLocationReady(false, "", true)).toBe(true)
  })
})

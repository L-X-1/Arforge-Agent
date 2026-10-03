import { describe, expect, test } from "bun:test"
import { ControlPrincipal } from "@arforge-ai/core/runtime/control-principal"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { ProjectID } from "@arforge-ai/schema/project-id"
import { HttpControlSubject } from "../../src/control-plane/http-control-subject"

const one = { tenantID: "ten_contract_one", userID: "usr_contract_one" }
const two = { tenantID: "ten_contract_two", userID: "usr_contract_two" }

const subjectFor = (principal: typeof one, action = "worktree.create") =>
  HttpControlSubject.make({
    directory: "/contract-project",
    projectID: ProjectID.global,
    action,
    requestID: AgentRuntime.ControlPlaneRequestID.create(),
    principal,
  })

describe("control principal binding contract", () => {
  test("principal reference and subject ID are server-recomputable and opaque", () => {
    const subject = subjectFor(one)
    expect(subject.principalRef).toBe(ControlPrincipal.principalRef(one))
    expect(subject.id).toBe(
      ControlPrincipal.controlPlaneID(one, {
        location: "/contract-project",
        projectID: ProjectID.global,
        action: "worktree.create",
      }),
    )
    expect(subject.id).not.toBe(subjectFor(two).id)
    expect(subject.id).not.toContain(one.tenantID)
    expect(subject.id).not.toContain(one.userID)
  })

  test("request aliases do not change subject ownership, while principal or operation does", () => {
    const subject = subjectFor(one)
    const sameScope = HttpControlSubject.ownedBy(subject, {
      directory: "/contract-project",
      projectID: ProjectID.global,
      action: "worktree.create",
      principal: one,
    })
    const foreignPrincipal = HttpControlSubject.ownedBy(subject, {
      directory: "/contract-project",
      projectID: ProjectID.global,
      action: "worktree.create",
      principal: two,
    })
    const forgedID = { ...subject, id: AgentRuntime.ControlPlaneID.make("ctl_forged_contract") }
    expect(sameScope).toBe(true)
    expect(foreignPrincipal).toBe(false)
    expect(
      HttpControlSubject.ownedBy(forgedID, {
        directory: "/contract-project",
        projectID: ProjectID.global,
        action: "worktree.create",
        principal: one,
      }),
    ).toBe(false)
    expect(subject.id).not.toBe(subjectFor(one, "worktree.reset").id)
  })
})

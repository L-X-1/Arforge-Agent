import { expect, test } from "bun:test"
import type { GlobalSession } from "@arforge-ai/sdk/v2/client"
import { buildHomeArchivedSessionRecords, filterHomeArchivedSessionRecords } from "./home-archived-sessions-model"

function session(input: {
  id: string
  archived?: number
  parentID?: string
  title?: string
  directory?: string
  projectName?: string
}) {
  return {
    id: input.id,
    slug: input.id,
    projectID: "project",
    directory: input.directory ?? "/projects/arforge",
    parentID: input.parentID,
    title: input.title ?? input.id,
    version: "test",
    time: { created: 1, updated: 2, archived: input.archived },
    project: input.projectName
      ? { id: "project", name: input.projectName, worktree: input.directory ?? "/projects/arforge" }
      : null,
  } satisfies GlobalSession
}

test("builds a newest-first list containing only archived root sessions", () => {
  const result = buildHomeArchivedSessionRecords([
    session({ id: "active" }),
    session({ id: "child", archived: 30, parentID: "root" }),
    session({ id: "older", archived: 10 }),
    session({ id: "newer", archived: 20 }),
  ])

  expect(result.map((record) => record.session.id)).toEqual(["newer", "older"])
})

test("searches archived sessions by title, project, directory, and id", () => {
  const records = buildHomeArchivedSessionRecords([
    session({
      id: "ses_alpha",
      archived: 20,
      title: "Release notes",
      projectName: "Arforge",
      directory: "/projects/arforge",
    }),
  ])

  expect(filterHomeArchivedSessionRecords(records, "release")).toHaveLength(1)
  expect(filterHomeArchivedSessionRecords(records, "ARFORGE")).toHaveLength(1)
  expect(filterHomeArchivedSessionRecords(records, "/projects")).toHaveLength(1)
  expect(filterHomeArchivedSessionRecords(records, "ses_alpha")).toHaveLength(1)
  expect(filterHomeArchivedSessionRecords(records, "missing")).toHaveLength(0)
})

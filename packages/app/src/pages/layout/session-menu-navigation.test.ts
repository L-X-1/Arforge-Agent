import { expect, test } from "bun:test"
import { createSessionMenuCommands, type SessionMenuSource } from "./session-menu-navigation"

const session = (
  id: string,
  extra: { projectID?: string; directory?: string; parentID?: string; time?: { archived?: number } } = {},
) => ({ id, projectID: "project-a", directory: "C:/owned/project", time: {}, ...extra })
type Item = ReturnType<typeof session>
const source = (rows: Item[] = [session("first"), session("second")]): SessionMenuSource<Item, string> => ({
  owner: {},
  server: "owned-server",
  current: rows[0],
  directories: ["C:/owned/project"],
  sessions: rows,
})
const options = { previous: "Previous", next: "Next", category: "Session" }

test("new workspace registers both declared session commands and wraps over legitimate roots", () => {
  let state = source()
  const selected: string[] = []
  const commands = createSessionMenuCommands({
    ...options,
    snapshot: () => state,
    select: (_source, row) => {
      selected.push(row.id)
      state = { ...state, current: row }
    },
  })
  expect(commands.map((command) => [command.id, command.keybind, command.disabled])).toEqual([
    ["session.previous", "alt+arrowup", false],
    ["session.next", "alt+arrowdown", false],
  ])
  commands[0].onSelect()
  commands[1].onSelect()
  expect(selected).toEqual(["second", "first"])
})

test("navigation excludes foreign projects/directories, child sessions, archived sessions and duplicate roots", () => {
  const state = source([
    session("first"),
    session("foreign-project", { projectID: "foreign" }),
    session("foreign-directory", { directory: "C:/other" }),
    session("child", { parentID: "first" }),
    session("archived", { time: { archived: 42 } }),
    session("second"),
    session("second"),
  ])
  const chosen: string[] = []
  const commands = createSessionMenuCommands({
    ...options,
    snapshot: () => state,
    select: (_source, row) => {
      chosen.push(row.id)
    },
  })
  commands[0].onSelect()
  expect(chosen[0]).toBe("second")
  expect(state.sessions).toHaveLength(7)
})

test("a source change between capture and selection cannot navigate a different server owner", () => {
  const first = source(),
    second = { ...source(), server: "other-server" }
  let reads = 0,
    selected = 0
  const commands = createSessionMenuCommands({
    ...options,
    snapshot: () => (++reads < 4 ? first : second),
    select: () => {
      selected++
    },
  })
  commands[0].onSelect()
  expect(selected).toBe(0)
})

test("missing source or only one root keeps commands registered but disabled", () => {
  for (const state of [undefined, source([session("only")])]) {
    const commands = createSessionMenuCommands({
      ...options,
      snapshot: () => state,
      select: () => {
        throw new Error("disabled")
      },
    })
    expect(commands.map((command) => command.disabled)).toEqual([true, true])
    commands.forEach((command) => command.onSelect())
  }
})

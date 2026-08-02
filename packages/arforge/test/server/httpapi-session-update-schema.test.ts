import { expect, test } from "bun:test"
import { Schema } from "effect"
import { UpdatePayload } from "../../src/server/routes/instance/httpapi/groups/session"

test("session update accepts null to clear the archived timestamp", () => {
  expect(Schema.decodeUnknownSync(UpdatePayload)({ time: { archived: null } })).toEqual({
    time: { archived: null },
  })
})

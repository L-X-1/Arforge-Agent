import { describe, expect, test } from "bun:test"
import { Database } from "../src/database/database"

describe("database principal routing", () => {
  test("recognizes only the built-in private-server principal", () => {
    expect(Database.isDefaultLocalPrincipal({ tenantID: "ten_local", userID: "usr_local" })).toBe(true)
    expect(Database.isDefaultLocalPrincipal({ tenantID: "ten_other", userID: "usr_local" })).toBe(false)
    expect(Database.isDefaultLocalPrincipal({ tenantID: "ten_local", userID: "usr_other" })).toBe(false)
  })
})

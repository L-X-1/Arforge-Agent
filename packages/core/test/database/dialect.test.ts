import { expect, test } from "bun:test"
import { isPostgresUrl } from "../../src/database/dialect"

test("database dialect recognises PostgreSQL URLs without mistaking SQLite URLs for PostgreSQL", () => {
  expect(isPostgresUrl("postgres://user:secret@localhost/arforge")).toBe(true)
  expect(isPostgresUrl("postgresql://user:secret@localhost/arforge")).toBe(true)
  expect(isPostgresUrl("sqlite:///:memory:")).toBe(false)
  expect(isPostgresUrl("sqlite:///C:/tmp/arforge.db")).toBe(false)
  expect(isPostgresUrl("https://example.test/arforge")).toBe(false)
  expect(isPostgresUrl("not-a-url")).toBe(false)
  expect(isPostgresUrl(undefined)).toBe(false)
})

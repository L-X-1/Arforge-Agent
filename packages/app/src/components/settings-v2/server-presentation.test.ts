import { describe, expect, test } from "bun:test"
import { managementServerAddress } from "./server-presentation"

describe("public management server address", () => {
  test("keeps the exact origin and service path while excluding credential and query material", () => {
    expect(
      managementServerAddress(
        "https://fixture-user:fixture-pass@host.fixture.invalid:8443/service/?token=fixture-token&region=fixture#fragment",
      ),
    ).toBe("https://host.fixture.invalid:8443/service")
    expect(managementServerAddress("http://127.0.0.1:4096")).toBe("http://127.0.0.1:4096")
    expect(managementServerAddress("https://[::1]:8443/api")).toBe("https://[::1]:8443/api")
  })
  test("does not echo malformed or unsupported addresses", () => {
    expect(managementServerAddress("invalid fixture credential text")).toBeUndefined()
    expect(managementServerAddress("javascript:fixture")).toBeUndefined()
    expect(managementServerAddress("file:///fixture")).toBeUndefined()
  })
})

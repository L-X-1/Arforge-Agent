import { expect, test } from "bun:test"
import { evaluateReleaseEnvironment } from "../../../script/release-environment-preflight"

const readyEnvironment = {
  ARFORGE_WINDOWS_SIGNING_PROVIDER: "digicert-keylocker",
  SM_HOST: "https://client.digicert.example",
  SM_API_KEY: "redacted-test-presence-only",
  SM_CLIENT_CERT_FILE: "C:/runner-temp/client.p12",
  SM_CLIENT_CERT_PASSWORD: "redacted-test-presence-only",
  ARFORGE_WINDOWS_KEYPAIR_ALIAS: "arforge-beta",
  ARFORGE_WINDOWS_EXPECTED_SIGNER_SUBJECT: "CN=Arforge Test",
  ARFORGE_STAGING_URL: "https://staging.example.test",
  OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.example.test",
  ARFORGE_DB_URL: "postgresql://app.example.test/arforge",
  ARFORGE_DB_ADMIN_URL: "postgresql://admin.example.test/arforge",
} as const

test("release environment preflight is blocked without external credentials and endpoints", () => {
  const report = evaluateReleaseEnvironment({ env: {} })

  expect(report.status).toBe("blocked")
  expect(report.secretsPrinted).toBe(false)
  expect(report.missing).toContain("signing.provider")
  expect(report.missing).toContain("staging.origin")
  expect(report.missing).toContain("telemetry.otlp_endpoint")
  expect(report.missing).toContain("database.application_url")
  expect(report.invalid).toHaveLength(0)
})

test("release environment preflight accepts complete non-secret configuration without exposing values", () => {
  const report = evaluateReleaseEnvironment({
    env: readyEnvironment,
    fileExists: (path) => path === readyEnvironment.SM_CLIENT_CERT_FILE,
  })

  expect(report).toMatchObject({ schema_version: 1, status: "ready", secretsPrinted: false, missing: [], invalid: [] })
  expect(report.checks.every((check) => check.status === "pass")).toBe(true)
  expect(JSON.stringify(report)).not.toContain(readyEnvironment.SM_API_KEY)
  expect(JSON.stringify(report)).not.toContain(readyEnvironment.SM_CLIENT_CERT_PASSWORD)
})

test("release environment preflight rejects unsafe origins, wrong provider, invalid DB URLs, and missing certificate", () => {
  const report = evaluateReleaseEnvironment({
    env: {
      ...readyEnvironment,
      ARFORGE_WINDOWS_SIGNING_PROVIDER: "other-provider",
      ARFORGE_STAGING_URL: "https://user:password@staging.example.test?token=bad",
      OTEL_EXPORTER_OTLP_ENDPOINT: "not-a-url",
      ARFORGE_DB_URL: "sqlite://local",
    },
    fileExists: () => false,
  })

  expect(report.status).toBe("blocked")
  expect(report.invalid).toEqual(
    expect.arrayContaining([
      "signing.provider",
      "signing.client_certificate_file",
      "staging.origin",
      "telemetry.otlp_endpoint",
      "database.application_url",
    ]),
  )
})

import { expect, test } from "bun:test"
import { base64Encode } from "@arforge-ai/core/util/encode"
import { fixture } from "../timeline/session-timeline-stress.fixture"
import { stressSessionHref } from "../timeline/timeline-test-helpers"

test("builds stress session links for the benchmark server", () => {
  expect(stressSessionHref(fixture.sourceID)).toBe(
    `/server/${base64Encode("http://127.0.0.1:4096")}/session/${fixture.sourceID}`,
  )
})

test("uses the isolated production origin when Playwright selected a temporary port", () => {
  const previous = process.env.ARFORGE_PLAYWRIGHT_TEMP_PORT
  process.env.ARFORGE_PLAYWRIGHT_TEMP_PORT = "43210"
  try {
    expect(stressSessionHref(fixture.sourceID)).toBe(
      `/server/${base64Encode("http://127.0.0.1:43210")}/session/${fixture.sourceID}`,
    )
  } finally {
    if (previous === undefined) delete process.env.ARFORGE_PLAYWRIGHT_TEMP_PORT
    else process.env.ARFORGE_PLAYWRIGHT_TEMP_PORT = previous
  }
})

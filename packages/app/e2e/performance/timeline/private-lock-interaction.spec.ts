import { expect, test } from "@playwright/test"
import { expectSessionTitle } from "../../utils/waits"
import { fixture } from "./session-timeline-stress.fixture"
import {
  installStressSessionTabs,
  installTimelineSettings,
  mockStressTimeline,
  stressSessionHref,
} from "./timeline-test-helpers"

test("private lock control does not cover the review control", async ({ page }) => {
  await mockStressTimeline(page)
  await installTimelineSettings(page)
  await installStressSessionTabs(page, { sessionIDs: [fixture.sourceID] })
  await page.goto(stressSessionHref(fixture.sourceID))
  await expectSessionTitle(page, fixture.expected.sourceTitle)

  const review = page.getByRole("button", { name: "Toggle review" })
  const lock = page.locator(".arforge-private-app__lock")
  await expect(review).toBeVisible()
  await expect(lock).toBeVisible()

  const [reviewBox, lockBox] = await Promise.all([review.boundingBox(), lock.boundingBox()])
  expect(reviewBox).not.toBeNull()
  expect(lockBox).not.toBeNull()
  expect(intersects(reviewBox!, lockBox!)).toBe(false)

  await review.click()
  await expect(page.locator("#review-panel")).toBeVisible()
})

function intersects(
  left: { x: number; y: number; width: number; height: number },
  right: { x: number; y: number; width: number; height: number },
) {
  return (
    left.x < right.x + right.width &&
    left.x + left.width > right.x &&
    left.y < right.y + right.height &&
    left.y + left.height > right.y
  )
}

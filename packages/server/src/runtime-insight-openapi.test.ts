import { expect, test } from "bun:test"
import { OpenApi } from "effect/unstable/httpapi"
import { Api } from "./api"

test("runtime insight exposes recovery inspection and review endpoints with a narrow mutation surface", () => {
  const spec = OpenApi.fromApi(Api) as {
    paths?: Record<string, Record<string, { operationId?: string }> | undefined>
  }
  const item = spec.paths?.["/api/runtime-insight/actions/{actionID}/recovery"]
  const reviewItem = spec.paths?.["/api/runtime-insight/actions/{actionID}/recovery/review"]

  expect(item?.get?.operationId).toBe("v2.runtimeInsight.actionRecovery")
  expect(item?.post).toBeUndefined()
  expect(reviewItem?.post?.operationId).toBe("v2.runtimeInsight.actionRecoveryReview")
  expect(reviewItem?.get).toBeUndefined()
  expect(reviewItem?.put).toBeUndefined()
  expect(reviewItem?.patch).toBeUndefined()
  expect(reviewItem?.delete).toBeUndefined()
  expect(item?.put).toBeUndefined()
  expect(item?.patch).toBeUndefined()
  expect(item?.delete).toBeUndefined()
})

test("runtime insight exposes explicit child-settlement audit and recovery endpoints", () => {
  const spec = OpenApi.fromApi(Api) as {
    paths?: Record<string, Record<string, { operationId?: string }> | undefined>
  }
  const audit = spec.paths?.["/api/runtime-insight/settlements/{parentRunID}/{childRunID}"]
  const recover = spec.paths?.["/api/runtime-insight/settlements/{parentRunID}/{childRunID}/recover"]

  expect(audit?.get?.operationId).toBe("v2.runtimeInsight.childSettlementAudit")
  expect(audit?.post).toBeUndefined()
  expect(audit?.delete).toBeUndefined()
  expect(recover?.post?.operationId).toBe("v2.runtimeInsight.childSettlementRecover")
  expect(recover?.get).toBeUndefined()
  expect(recover?.delete).toBeUndefined()

  const sweep = spec.paths?.["/api/runtime-insight/settlements/recover-pending"]
  expect(sweep?.post?.operationId).toBe("v2.runtimeInsight.childSettlementRecoverySweep")
  expect(sweep?.get).toBeUndefined()
  expect(sweep?.delete).toBeUndefined()
})

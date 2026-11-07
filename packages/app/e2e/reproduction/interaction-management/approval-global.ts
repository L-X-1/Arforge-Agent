import { mockGlobal, fixture } from "../ui-v2-approval-acceptance/sdk-fixture"
const sdks = new WeakMap<object, object>()
const audit = { lists: 0, reads: [] as unknown[], failStatus: false, phase: "executing" }
const stale = new URLSearchParams(location.search).has("stale")
const wrapSDK = (sdk: any) => {
  const cached = sdks.get(sdk)
  if (cached) return cached
  const wrapped = new Proxy(sdk, { get(target, key) {
    if (key !== "createClient") return Reflect.get(target, key)
    return (options: any) => {
      const client = target.createClient(options)
      return { experimental: {
        controlApproval: {
          list: async () => { audit.lists++; if (stale) throw new Error("500 ENOENT Fixture originating directory no longer exists"); return client.experimental.controlApproval.list() },
          reply: (input: any) => client.experimental.controlApproval.reply(input),
        },
        controlOperation: { status: async (input: any) => {
          audit.reads.push({ options, input })
          if (audit.failStatus) throw new Error("500 Fixture execution reader unavailable")
          return { data: { requestID: input.requestID, operation: input.operation, phase: audit.phase, runID: "run_fixture", actionID: "action_fixture", recovery: "none", canApprove: false } }
        } },
      } }
    }
  } })
  sdks.set(sdk, wrapped); return wrapped
}
const global = new Proxy(mockGlobal, { get(target, key) {
  if (key !== "ensureServerCtx") return Reflect.get(target, key)
  return (connection: any) => {
    const context = target.ensureServerCtx(connection)
    return new Proxy(context, { get(target, key) { return key === "sdk" ? wrapSDK(target.sdk) : Reflect.get(target, key) } })
  }
} })
export const useGlobal = () => global
Object.assign(window, { __approvalAudit: { snapshot: () => structuredClone(audit), failStatus: (value: boolean) => { audit.failStatus = value }, replaceSource: () => fixture.replaceSource("same-url-instance") } })
declare global { interface Window { __approvalAudit: { snapshot: () => typeof audit; failStatus: (value: boolean) => void; replaceSource: () => Promise<void> } } }

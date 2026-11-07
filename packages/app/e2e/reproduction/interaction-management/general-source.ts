import { createStore } from "solid-js/store"
const [state, setState] = createStore({ calls: 0, recover: false })
const sync = { data: { config: { shell: "" } }, session: { lineage: { peek: () => undefined } }, updateConfig: async () => { throw new Error("Unexpected write to shell settings") } }
const sdk = { protocol: Promise.resolve("v2"), api: { pty: { shells: async () => {
  setState("calls", n => n + 1)
  if (!state.recover) throw Object.assign(new Error("400 Shell catalogue is unsupported for this fixture source"), { status: 400 })
  return { data: [{ path: "C:/Isolated/shell.exe", name: "Fixture shell", acceptable: true }] }
} } } }
export const useServerSDK = () => () => sdk
export const useServerSync = () => () => sync
Object.assign(window, { __generalAudit: { snapshot: () => ({ calls: state.calls }), recover: () => setState("recover", true) } })
declare global { interface Window { __generalAudit: { snapshot: () => { calls: number }; recover: () => void } } }

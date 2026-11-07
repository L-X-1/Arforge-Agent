import { render } from "solid-js/web"
import { createStore } from "solid-js/store"
import { DialogProvider } from "@arforge-ai/ui/context/dialog"
import { PlatformProvider } from "../../../src/context/platform"
import { LanguageProvider } from "../../../src/context/language"
import { SettingsWorkspace } from "../../../src/components/settings-v2/dialog-settings-v2"
import type { usePermission } from "../../../src/context/permission"
const query = new URLSearchParams(location.search)
const [state, setState] = createStore({ tab: query.get("tab") ?? "general", returned: false })
const forbidden = () => { throw new Error("Native action forbidden in isolated navigation regression") }
render(() => <PlatformProvider value={{ platform: "web", openLink: forbidden, restart: async () => forbidden(), back: forbidden, forward: forbidden, notify: async () => forbidden() }}>
  <LanguageProvider locale="en"><DialogProvider><div style={{ height: "950px", width: "100%" }}>
    <SettingsWorkspace permission={{} as ReturnType<typeof usePermission>} defaultValue={state.tab} sessionID={query.has("sessionID") ? "ses_fixture" : undefined}
      onTabChange={tab => setState("tab", tab)} onReturnToWorkspace={() => setState("returned", true)} />
    <output data-testid="navigation-state">{JSON.stringify(state)}</output>
  </div></DialogProvider></LanguageProvider>
</PlatformProvider>, document.getElementById("root")!)

import { DialogProvider } from "@arforge-ai/ui/context/dialog"
import "../../../src/index.css"
import { applyTheme, arforgeDefaultTheme } from "@arforge-ai/ui/theme"
import { Show } from "solid-js"
import { render } from "solid-js/web"
import { TabsV2 } from "@arforge-ai/ui/v2/tabs-v2"
import { PlatformProvider } from "../../../src/context/platform"
import { LanguageProvider } from "../../../src/context/language"
import { ServerSDKProvider } from "../../../src/context/server-sdk"
import { SessionSettingsPanels } from "../../../src/components/session/session-operations-dialog"
import { fixture, forbidNative } from "./sdk-fixture"
const panel = new URL(location.href).searchParams.get("panel") === "tasks" ? "session-goal-task" : "session-automation"
applyTheme(arforgeDefaultTheme, "arforge-default")
render(() => <PlatformProvider value={{ platform: "web", openLink: () => forbidNative("openLink"),
  restart: async () => forbidNative("restart"), back: () => forbidNative("back"),
  forward: () => forbidNative("forward"), notify: async () => forbidNative("notify"),
}}><LanguageProvider locale="en"><DialogProvider><Show when={fixture.state.mounted}><ServerSDKProvider>
  <main class="p-6 max-w-5xl mx-auto"><p>Current production automation panels; all business requests use memory data.</p>
    <TabsV2 value={panel}><TabsV2.List><TabsV2.Trigger value={panel}>Automation</TabsV2.Trigger></TabsV2.List>
      <SessionSettingsPanels sessionID={fixture.state.sessionID} value={panel} />
    </TabsV2>
  </main>
</ServerSDKProvider></Show></DialogProvider></LanguageProvider></PlatformProvider>, document.getElementById("root")!)

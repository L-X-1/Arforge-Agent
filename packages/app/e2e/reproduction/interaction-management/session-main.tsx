import { render } from "solid-js/web"
import { Show } from "solid-js"
import { DialogProvider } from "@arforge-ai/ui/context/dialog"
import { TabsV2 } from "@arforge-ai/ui/v2/tabs-v2"
import { PlatformProvider } from "../../../src/context/platform"
import { LanguageProvider } from "../../../src/context/language"
import { ServerSDKProvider } from "../../../src/context/server-sdk"
import { SessionSettingsPanels } from "../../../src/components/session/session-operations-dialog"
import { fixture, forbidNative } from "../ui-v2-automation-acceptance/sdk-fixture"
render(() => <PlatformProvider value={{ platform: "web", openLink: () => forbidNative("openLink"), restart: async () => forbidNative("restart"), back: () => forbidNative("back"), forward: () => forbidNative("forward"), notify: async () => forbidNative("notify") }}>
  <LanguageProvider locale="en"><DialogProvider><Show when={fixture.state.mounted}><ServerSDKProvider>
    <main class="settings-v2-surface" style={{ padding: "16px" }}><TabsV2 value="session-automation"><TabsV2.List><TabsV2.Trigger value="session-automation">Automation</TabsV2.Trigger></TabsV2.List>
      <SessionSettingsPanels sessionID={fixture.state.sessionID} value="session-automation" />
    </TabsV2></main>
  </ServerSDKProvider></Show></DialogProvider></LanguageProvider>
</PlatformProvider>, document.getElementById("root")!)

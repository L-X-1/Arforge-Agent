import {DialogProvider} from "@arforge-ai/ui/context/dialog"
import "../../../src/index.css"
import { render } from "solid-js/web"
import { Show,onCleanup } from "solid-js"
import { PlatformProvider } from "../../../src/context/platform"
import { LanguageProvider } from "../../../src/context/language"
import { ServerSDKProvider } from "../../../src/context/server-sdk"
import { ArforgeSettingsPanels } from "../../../src/components/control-center/dialog-control-center"
import { useControlCenterText } from "../../../src/components/control-center/control-center-text"
import { TabsV2 } from "@arforge-ai/ui/v2/tabs-v2"
import { bindProbe,connection,control,fixture,forbidNative } from "./sdk-fixture"

function Host(){
 const t=useControlCenterText()
 bindProbe(()=>({labels:{refreshParent:t("刷新"),refreshAll:t("Refresh all"),preview:t("Preview"),start:t("Start"),
 pause:t("Pause"),resume:t("Resume"),cancel:t("Cancel…"),permission:t("Permission mode"),rescan:t("Rescan")}}))
 onCleanup(()=>bindProbe(undefined))
 return <TabsV2 variant="settings" value={control.tab} onChange={value=>fixture.navigate(value)}>
  <TabsV2.List><TabsV2.Trigger value="arforge-extensions">Extensions</TabsV2.Trigger></TabsV2.List>
  <ArforgeSettingsPanels value={control.tab} sessionID={control.sessionID} onNavigate={fixture.navigate}/>
 </TabsV2>
}
render(()=><PlatformProvider value={{platform:"web",openLink:()=>forbidNative("openLink"),
 restart:async()=>forbidNative("restart"),back:()=>forbidNative("back"),forward:()=>forbidNative("forward"),notify:async()=>forbidNative("notify")}}>
 <LanguageProvider locale="en"><DialogProvider><main data-testid="production-extensions-host">
 <Show when={control.mounted}><ServerSDKProvider server={connection}><Host/></ServerSDKProvider></Show>
 </main></DialogProvider></LanguageProvider>
</PlatformProvider>,document.getElementById("root")!)

import '../../../src/index.css'
import { render } from 'solid-js/web'
import { Router, Route } from '@solidjs/router'
import { DialogProvider } from '@arforge-ai/ui/context/dialog'
import { TabsV2 } from '@arforge-ai/ui/v2/tabs-v2'
import { LanguageProvider } from '../../../src/context/language'
import { PlatformProvider } from '../../../src/context/platform'
import { ServerSDKProvider } from '../../../src/context/server-sdk'
import { ArforgeSettingsPanels } from '../../../src/components/control-center/dialog-control-center'
const forbidden=()=>{throw new Error('Native actions forbidden in isolated project-copy fixture')}
const Body=()=> <ServerSDKProvider><main class="settings-v2-surface p-4"><TabsV2 value="arforge-operations"><ArforgeSettingsPanels value="arforge-operations" onNavigate={forbidden}/></TabsV2></main></ServerSDKProvider>
render(()=><PlatformProvider value={{platform:'web',openLink:forbidden,restart:async()=>forbidden(),back:forbidden,forward:forbidden,notify:async()=>forbidden()}}><LanguageProvider locale="zh"><DialogProvider><Router><Route path="*" component={Body}/></Router></DialogProvider></LanguageProvider></PlatformProvider>,document.getElementById('root')!)

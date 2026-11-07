import "../../../src/index.css"
import { render } from "solid-js/web"
import { Router, Route } from "@solidjs/router"
import { DialogProvider } from "@arforge-ai/ui/context/dialog"
import { applyTheme, arforgeDefaultTheme } from "@arforge-ai/ui/theme"
import { PlatformProvider } from "../../../src/context/platform"
import { LanguageProvider } from "../../../src/context/language"
import { MemoryControl } from "../../../src/components/control-center/dialog-control-center"
import { MemoryLearningGovernance } from "../../../src/components/control-center/capability-workbench"
import { EvolutionWorkbench } from "../../../src/components/control-center/evolution-workbench"
import { api, fixture, state } from "./state"
const query = new URLSearchParams(location.search)
applyTheme(arforgeDefaultTheme, "arforge-default")
Object.assign(window, { __lifecycleWorkbench: fixture })
const forbidden = () => { throw new Error("Native actions forbidden in lifecycle fixture") }
const Body = () => <main class="settings-v2-surface p-4"><div class="settings-v2-panel arforge-control-center-panel"><div class="arforge-control-center-body">
  {query.get("page") === "evolution"
    ? <EvolutionWorkbench api={() => api} location={() => ({ location: { directory: state.directory } })} ready={() => state.ready} />
    : <><div data-testid="memory-persisted"><MemoryControl api={() => api} location={() => ({ location: { directory: state.directory } })} ready={() => state.ready} /></div>
      <div data-testid="memory-governance"><MemoryLearningGovernance api={() => api} location={() => ({ location: { directory: state.directory } })} ready={() => state.ready} /></div></>}
</div></div></main>
render(() => <PlatformProvider value={{ platform: "web", openLink: forbidden, restart: async () => forbidden(), back: forbidden, forward: forbidden, notify: async () => forbidden() }}>
  <LanguageProvider locale={query.get("locale") === "zh" ? "zh" : "en"}><DialogProvider><Router><Route path="*" component={Body} /></Router></DialogProvider></LanguageProvider>
</PlatformProvider>, document.getElementById("root")!)

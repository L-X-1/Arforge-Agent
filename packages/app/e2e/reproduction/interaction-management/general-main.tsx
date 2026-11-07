import { render } from "solid-js/web"
import { Router, Route } from "@solidjs/router"
import { DialogProvider } from "@arforge-ai/ui/context/dialog"
import { ThemeProvider } from "@arforge-ai/ui/theme/context"
import { PlatformProvider } from "../../../src/context/platform"
import { LanguageProvider } from "../../../src/context/language"
import { SettingsProvider } from "../../../src/context/settings"
import { OnboardingProvider } from "../../../src/context/onboarding"
import { SettingsGeneralV2 } from "../../../src/components/settings-v2/general"
import type { usePermission } from "../../../src/context/permission"
const permission = { isAutoAccepting: () => false } as unknown as ReturnType<typeof usePermission>
const forbidden = () => { throw new Error("Native action forbidden in isolated settings regression") }
render(() => <PlatformProvider value={{ platform: "web", openLink: forbidden, restart: async () => forbidden(), back: forbidden, forward: forbidden, notify: async () => forbidden() }}>
  <LanguageProvider locale="en"><ThemeProvider><SettingsProvider><OnboardingProvider><DialogProvider>
    <Router><Route path="*" component={() => <main class="settings-v2-surface"><SettingsGeneralV2 permission={permission} /></main>} /></Router>
  </DialogProvider></OnboardingProvider></SettingsProvider></ThemeProvider></LanguageProvider>
</PlatformProvider>, document.getElementById("root")!)

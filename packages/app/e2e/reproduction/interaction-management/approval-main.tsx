import { render } from "solid-js/web"
import { DialogProvider, useDialog } from "@arforge-ai/ui/context/dialog"
import { PlatformProvider } from "../../../src/context/platform"
import { LanguageProvider } from "../../../src/context/language"
import { ControlApprovalProvider, useControlApproval } from "../../../src/context/control-approval"
import { ControlApprovalDialog } from "../../../src/components/control-approval/control-approval-center"
import { forbidNative, fixture } from "../ui-v2-approval-acceptance/sdk-fixture"
function Launcher() { const dialog = useDialog(), approval = useControlApproval(); return <>
  <button onClick={() => void dialog.show(() => <ControlApprovalDialog />)}>Open isolated approvals</button>
  <button data-testid="register-location" onClick={() => approval.registerLocation(fixture.directory)}>Register current directory</button>
</> }
render(() => <PlatformProvider value={{ platform: "web", openLink: () => forbidNative("openLink"), restart: async () => forbidNative("restart"), back: () => forbidNative("back"), forward: () => forbidNative("forward"), notify: async () => forbidNative("notify") }}>
  <LanguageProvider locale="en"><ControlApprovalProvider><DialogProvider><Launcher /></DialogProvider></ControlApprovalProvider></LanguageProvider>
</PlatformProvider>, document.getElementById("root")!)

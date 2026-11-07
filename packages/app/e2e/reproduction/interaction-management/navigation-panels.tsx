import { TabsV2 } from "@arforge-ai/ui/v2/tabs-v2"
// Only child business panels are mocked here. Navigation, selection, responsive
// keyboard/focus behavior and all production tab IDs remain the real component.
export const SettingsGeneralV2 = () => <h2>Fixture general content</h2>
export const SettingsKeybinds = () => <h2>Fixture shortcut content</h2>
export const SettingsProvidersV2 = () => <h2>Fixture provider content</h2>
export const SettingsModelsV2 = () => <h2>Fixture model content</h2>
export const SettingsServersV2 = () => <h2>Fixture server content</h2>
const Panel = (props: { value: string }) => <TabsV2.Content value={props.value} class="settings-v2-panel"><h2>{props.value}</h2><button>Fixture content focus target</button></TabsV2.Content>
export const ArforgeSettingsPanels = Panel
export const SessionSettingsPanels = Panel

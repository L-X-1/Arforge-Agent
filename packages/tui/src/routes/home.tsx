import { Prompt, type PromptRef } from "../component/prompt"
import { createEffect, createMemo, createSignal, onMount } from "solid-js"
import { HomeChrome, agentLabel, homeComposerGap, homeContentWidth } from "../component/screen-chrome"
import { useSync } from "../context/sync"
import { Toast } from "../ui/toast"
import { useArgs } from "../context/args"
import { useRouteData } from "../context/route"
import { usePromptRef } from "../context/prompt"
import { useLocal } from "../context/local"
import { usePluginRuntime } from "../plugin/runtime"
import { useEditorContext } from "../context/editor"
import { useTerminalDimensions } from "@opentui/solid"
import { useTuiConfig } from "../config"
import { HomeSessionDestinationProvider } from "./home/session-destination"
import { useTheme } from "../context/theme"
import { useTuiPaths } from "../context/runtime"

let once = false
const placeholder = {
  normal: ["修复代码库中的一个 TODO", "分析这个项目使用的技术栈", "修复失败的测试"],
  shell: ["ls -la", "git status", "pwd"],
}

export function Home() {
  const pluginRuntime = usePluginRuntime()
  const sync = useSync()
  const route = useRouteData("home")
  const promptRef = usePromptRef()
  const [ref, setRef] = createSignal<PromptRef | undefined>()
  const args = useArgs()
  const local = useLocal()
  const editor = useEditorContext()
  const dimensions = useTerminalDimensions()
  const tuiConfig = useTuiConfig()
  const paths = useTuiPaths()
  const { theme } = useTheme()
  const compact = createMemo(() => dimensions().width < 82 || dimensions().height < 25)
  const promptMaxWidth = createMemo(() => homeContentWidth(dimensions().width, tuiConfig.prompt?.max_width))
  const composerGap = createMemo(() => homeComposerGap(dimensions().height, compact()))
  const agentName = createMemo(() => agentLabel(local.agent.current()?.name))
  let sent = false

  onMount(() => {
    editor.clearSelection()
  })

  const bind = (r: PromptRef | undefined) => {
    setRef(r)
    promptRef.set(r)
    if (once || !r) return
    if (route.prompt) {
      r.set(route.prompt)
      once = true
      return
    }
    if (!args.prompt) return
    r.set({ input: args.prompt, parts: [] })
    once = true
  }

  // Wait for sync and model store to be ready before auto-submitting --prompt
  createEffect(() => {
    const r = ref()
    if (sent) return
    if (!r) return
    if (!sync.ready || !local.model.ready) return
    if (!args.prompt) return
    if (r.current.input !== args.prompt) return
    sent = true
    r.submit()
  })

  return (
    <HomeSessionDestinationProvider>
      <box flexGrow={1} minHeight={0} alignItems="center" paddingLeft={2} paddingRight={2}>
        <box width="100%" maxWidth={promptMaxWidth()} flexShrink={0} paddingTop={1}>
          <pluginRuntime.Slot name="home_logo" mode="replace">
            <HomeChrome
              theme={theme}
              agent={agentName()}
              model={local.model.parsed().model ?? "未选择"}
              directory={paths.cwd}
              compact={compact()}
            />
          </pluginRuntime.Slot>
        </box>
        <box height={composerGap()} flexShrink={0} />
        <box width="100%" maxWidth={promptMaxWidth()} flexShrink={0} paddingBottom={1}>
          <box width="100%" zIndex={1000} flexShrink={0}>
            <pluginRuntime.Slot name="home_prompt" mode="replace" ref={bind}>
              <Prompt ref={bind} right={<pluginRuntime.Slot name="home_prompt_right" />} placeholders={placeholder} />
            </pluginRuntime.Slot>
          </box>
          <pluginRuntime.Slot name="home_bottom" />
        </box>
        <Toast />
      </box>
      <box width="100%" flexShrink={0}>
        <pluginRuntime.Slot name="home_footer" mode="single_winner" />
      </box>
    </HomeSessionDestinationProvider>
  )
}

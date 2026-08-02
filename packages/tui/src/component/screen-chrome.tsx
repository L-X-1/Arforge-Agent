import type { RGBA } from "@opentui/core"
import { Show } from "solid-js"
import { LogoWordmark } from "./logo"

export type ChromeTheme = {
  background: RGBA
  primary: RGBA
  success: RGBA
  warning: RGBA
  error: RGBA
  text: RGBA
  textMuted: RGBA
  borderSubtle: RGBA
}

export type Activity = "idle" | "busy" | "retry"

const productIntro = "面向开发工作区的本地优先 AI 智能体"

const agentNames: Record<string, string> = {
  build: "构建",
  plan: "规划",
  explore: "探索",
  general: "通用",
}

export function agentLabel(name?: string) {
  if (!name) return "未选择"
  return agentNames[name] ?? name
}

export function homeContentWidth(terminalWidth: number, configured?: number | "auto") {
  const available = Math.max(40, terminalWidth - 4)
  if (configured === undefined || configured === "auto") return available
  return Math.min(available, configured)
}

export function homeComposerGap(terminalHeight: number, compact: boolean) {
  return Math.max(1, terminalHeight - (compact ? 20 : 23))
}

export function promptModeLabel(mode: "normal" | "shell", automatic: boolean) {
  if (mode === "shell") return "命令行模式"
  return automatic ? "自动模式开启" : "确认模式"
}

function ActivityBadge(props: { activity: Activity; theme: ChromeTheme }) {
  const color = () => {
    if (props.activity === "busy") return props.theme.primary
    if (props.activity === "retry") return props.theme.warning
    return props.theme.success
  }
  const label = () => {
    if (props.activity === "busy") return "运行中"
    if (props.activity === "retry") return "重试中"
    return "就绪"
  }

  return (
    <text fg={color()} flexShrink={0} wrapMode="none">
      ● {label()}
    </text>
  )
}

function Brand(props: { activity: Activity; compact?: boolean; theme: ChromeTheme }) {
  return (
    <Show
      when={!props.compact}
      fallback={
        <box flexDirection="row" gap={2}>
          <text fg={props.theme.primary} wrapMode="none">
            <span style={{ bold: true }}>ARFORGE</span>
          </text>
          <ActivityBadge activity={props.activity} theme={props.theme} />
        </box>
      }
    >
      <box width="100%" flexDirection="row" alignItems="flex-end" gap={2}>
        <LogoWordmark theme={props.theme} />
        <ActivityBadge activity={props.activity} theme={props.theme} />
      </box>
    </Show>
  )
}

export function HomeChrome(props: {
  theme: ChromeTheme
  agent: string
  model: string
  directory: string
  compact?: boolean
}) {
  return (
    <box width="100%" flexDirection="column" flexShrink={0}>
      <Brand activity="idle" compact={props.compact} theme={props.theme} />
      <text fg={props.theme.textMuted} wrapMode="none" flexShrink={1}>
        {productIntro}
        <Show when={!props.compact}>
          <span style={{ fg: props.theme.text }}> · {props.model}</span> · {props.agent}
        </Show>
      </text>
      <box width="100%" flexDirection="row" gap={1}>
        <text fg={props.theme.textMuted} wrapMode="none" flexShrink={0}>
          工作区
        </text>
        <text fg={props.theme.text} wrapMode="none" flexShrink={1}>
          {props.directory}
        </text>
        <text fg={props.theme.textMuted} wrapMode="none" flexShrink={0}>
          · /move 切换
        </text>
      </box>
    </box>
  )
}

export function SessionChrome(props: {
  theme: ChromeTheme
  directory: string
  agent: string
  model: string
  activity: Activity
  compact?: boolean
}) {
  return (
    <box width="100%" flexDirection="column" paddingTop={1} paddingBottom={2} flexShrink={0}>
      <Brand activity={props.activity} compact={props.compact} theme={props.theme} />
      <text fg={props.theme.textMuted} wrapMode="none" flexShrink={1}>
        {productIntro}
        <Show when={!props.compact}>
          <span style={{ fg: props.theme.text }}> · {props.model}</span> · {props.agent}
        </Show>
      </text>
      <box width="100%" flexDirection="row" gap={1}>
        <text fg={props.theme.textMuted} wrapMode="none" flexShrink={0}>
          工作区
        </text>
        <text fg={props.theme.text} wrapMode="none" flexShrink={1}>
          {props.directory}
        </text>
        <text fg={props.theme.textMuted} wrapMode="none" flexShrink={0}>
          · /move 切换
        </text>
      </box>
    </box>
  )
}

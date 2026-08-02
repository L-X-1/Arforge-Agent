import type { TuiPluginApi } from "@arforge-ai/plugin/tui"
import { createMemo, For, type Accessor } from "solid-js"
import { DEFAULT_THEMES, useTheme } from "../../context/theme"
import { useCommandShortcut } from "../../keymap"

const themeCount = Object.keys(DEFAULT_THEMES).length

type TipPart = { text: string; highlight: boolean }
type TipShortcut = Accessor<string>
type Shortcuts = {
  agentCycle: TipShortcut
  childFirst: TipShortcut
  childNext: TipShortcut
  childPrevious: TipShortcut
  commandList: TipShortcut
  editorOpen: TipShortcut
  helpShow: TipShortcut
  inputClear: TipShortcut
  inputNewline: TipShortcut
  inputPaste: TipShortcut
  inputUndo: TipShortcut
  leader: TipShortcut
  messagesCopy: TipShortcut
  messagesFirst: TipShortcut
  messagesLast: TipShortcut
  messagesPageDown: TipShortcut
  messagesPageUp: TipShortcut
  messagesToggleConceal: TipShortcut
  modelCycleRecent: TipShortcut
  modelList: TipShortcut
  sessionExport: TipShortcut
  sessionInterrupt: TipShortcut
  sessionList: TipShortcut
  sessionNew: TipShortcut
  sessionParent: TipShortcut
  sessionPinToggle: TipShortcut
  sessionQuickSwitch1: TipShortcut
  sessionQuickSwitch9: TipShortcut
  sessionSidebarToggle: TipShortcut
  sessionTimeline: TipShortcut
  statusView: TipShortcut
  terminalSuspend: TipShortcut
  themeList: TipShortcut
}
type Tip = string | ((shortcuts: Shortcuts) => string | undefined)

function parse(tip: string): TipPart[] {
  const parts: TipPart[] = []
  const regex = /\{highlight\}(.*?)\{\/highlight\}/g
  const found = Array.from(tip.matchAll(regex))
  const state = found.reduce(
    (acc, match) => {
      const start = match.index ?? 0
      if (start > acc.index) {
        acc.parts.push({ text: tip.slice(acc.index, start), highlight: false })
      }
      acc.parts.push({ text: match[1], highlight: true })
      acc.index = start + match[0].length
      return acc
    },
    { parts, index: 0 },
  )

  if (state.index < tip.length) {
    parts.push({ text: tip.slice(state.index), highlight: false })
  }

  return parts
}

const NO_MODELS_TIP = "运行 {highlight}/connect{/highlight} 连接 AI 提供商，然后开始工作"
const NO_MODELS_PARTS = parse(NO_MODELS_TIP)

function shortcutText(value: string) {
  return `{highlight}${value}{/highlight}`
}

function commandText(command: string, shortcut: string) {
  if (!shortcut) return shortcutText(command)
  return `${shortcutText(command)} 或 ${shortcutText(shortcut)}`
}

function press(shortcut: string, text: string) {
  if (!shortcut) return undefined
  return `按 ${shortcutText(shortcut)} ${text}`
}

function configShortcut(api: TuiPluginApi, command: string): TipShortcut {
  return () =>
    api.tuiConfig.keybinds
      .get(command)
      .map((binding) => api.keys.formatSequence(Array.from(api.keymap.parseKeySequence(binding.key))))
      .filter(Boolean)
      .join(", ")
}

export function Tips(props: { api: TuiPluginApi; connected?: boolean }) {
  const theme = useTheme().theme
  const tipOffset = Math.random()
  const shortcuts: Shortcuts = {
    agentCycle: useCommandShortcut("agent.cycle"),
    childFirst: configShortcut(props.api, "session.child.first"),
    childNext: configShortcut(props.api, "session.child.next"),
    childPrevious: configShortcut(props.api, "session.child.previous"),
    commandList: useCommandShortcut("command.palette.show"),
    editorOpen: useCommandShortcut("prompt.editor"),
    helpShow: useCommandShortcut("help.show"),
    inputClear: useCommandShortcut("prompt.clear"),
    inputNewline: useCommandShortcut("input.newline"),
    inputPaste: useCommandShortcut("prompt.paste"),
    inputUndo: useCommandShortcut("input.undo"),
    leader: configShortcut(props.api, "leader"),
    messagesCopy: configShortcut(props.api, "messages.copy"),
    messagesFirst: configShortcut(props.api, "session.first"),
    messagesLast: configShortcut(props.api, "session.last"),
    messagesPageDown: configShortcut(props.api, "session.page.down"),
    messagesPageUp: configShortcut(props.api, "session.page.up"),
    messagesToggleConceal: configShortcut(props.api, "session.toggle.conceal"),
    modelCycleRecent: useCommandShortcut("model.cycle_recent"),
    modelList: useCommandShortcut("model.list"),
    sessionExport: configShortcut(props.api, "session.export"),
    sessionInterrupt: configShortcut(props.api, "session.interrupt"),
    sessionList: useCommandShortcut("session.list"),
    sessionNew: useCommandShortcut("session.new"),
    sessionParent: configShortcut(props.api, "session.parent"),
    sessionPinToggle: configShortcut(props.api, "session.pin.toggle"),
    sessionQuickSwitch1: useCommandShortcut("session.quick_switch.1"),
    sessionQuickSwitch9: useCommandShortcut("session.quick_switch.9"),
    sessionSidebarToggle: configShortcut(props.api, "session.sidebar.toggle"),
    sessionTimeline: configShortcut(props.api, "session.timeline"),
    statusView: useCommandShortcut("arforge.status"),
    terminalSuspend: useCommandShortcut("terminal.suspend"),
    themeList: useCommandShortcut("theme.switch"),
  }
  const tip = createMemo(() => {
    if (props.connected === false) return NO_MODELS_TIP
    const tips = [...TIPS, process.platform !== "win32" ? TERMINAL_SUSPEND_TIP : INPUT_UNDO_TIP].flatMap((item) => {
      const value = typeof item === "string" ? item : item(shortcuts)
      return value ? [value] : []
    })
    return tips[Math.floor(tipOffset * tips.length)] ?? NO_MODELS_TIP
  }, NO_MODELS_TIP)
  // Solid can expose a memo's initial value while a pure computation is pending.
  const parts = createMemo(() => {
    const value = tip()
    if (typeof value === "string") return parse(value)
    return NO_MODELS_PARTS
  }, NO_MODELS_PARTS)

  return (
    <box flexDirection="row" maxWidth="100%">
      <text flexShrink={0} style={{ fg: theme.warning }}>
        ● 提示{" "}
      </text>
      <text flexShrink={1} wrapMode="word">
        <For each={parts()}>
          {(part) => <span style={{ fg: part.highlight ? theme.text : theme.textMuted }}>{part.text}</span>}
        </For>
      </text>
    </box>
  )
}

const TIPS: Tip[] = [
  "输入 {highlight}@{/highlight} 后接文件名，可模糊搜索并附加文件",
  "以 {highlight}!{/highlight} 开头可运行 Shell 命令，例如 {highlight}!dir{/highlight}",
  (shortcuts) => press(shortcuts.agentCycle(), "可在构建与规划智能体之间切换"),
  "使用 {highlight}/undo{/highlight} 撤销上一条消息及对应的文件更改",
  "使用 {highlight}/redo{/highlight} 恢复刚刚撤销的消息和文件更改",
  "可将图片或 PDF 拖入终端，作为当前会话的上下文",
  (shortcuts) => press(shortcuts.inputPaste(), "可把剪贴板中的图片粘贴到输入框"),
  (shortcuts) => `使用 ${commandText("/editor", shortcuts.editorOpen())} 在外部编辑器中编写消息`,
  "运行 {highlight}/init{/highlight} 可根据代码库生成项目规则",
  (shortcuts) => `使用 ${commandText("/models", shortcuts.modelList())} 切换可用模型`,
  (shortcuts) => `使用 ${commandText("/themes", shortcuts.themeList())} 切换 ${themeCount} 个内置主题`,
  (shortcuts) => `使用 ${commandText("/new", shortcuts.sessionNew())} 新建会话`,
  (shortcuts) => `使用 ${commandText("/sessions", shortcuts.sessionList())} 查看、固定并继续会话`,
  (shortcuts) => press(shortcuts.sessionPinToggle(), "可将会话固定到列表顶部"),
  "长会话接近上下文上限时，可运行 {highlight}/compact{/highlight} 进行摘要压缩",
  (shortcuts) => `使用 ${commandText("/export", shortcuts.sessionExport())} 将会话保存为 Markdown`,
  (shortcuts) => press(shortcuts.messagesCopy(), "可复制助手的最后一条消息"),
  (shortcuts) => press(shortcuts.commandList(), "可查看全部可用操作和命令"),
  (shortcuts) => `主快捷键是 ${shortcutText(shortcuts.leader())}，可与其他按键组合执行快捷操作`,
  (shortcuts) => press(shortcuts.modelCycleRecent(), "可快速切换最近使用的模型"),
  (shortcuts) => press(shortcuts.sessionSidebarToggle(), "可显示或隐藏会话侧边栏"),
  (shortcuts) =>
    shortcuts.messagesPageUp() && shortcuts.messagesPageDown()
      ? `使用 ${shortcutText(shortcuts.messagesPageUp())}/${shortcutText(shortcuts.messagesPageDown())} 浏览会话历史`
      : undefined,
  (shortcuts) => press(shortcuts.messagesFirst(), "可跳转到会话开头"),
  (shortcuts) => press(shortcuts.messagesLast(), "可跳转到最新消息"),
  (shortcuts) => press(shortcuts.inputNewline(), "可在输入中换行"),
  (shortcuts) => press(shortcuts.inputClear(), "可清空当前输入"),
  (shortcuts) => press(shortcuts.sessionInterrupt(), "可中断 AI 的当前响应"),
  "切换到 {highlight}Plan{/highlight} 智能体，可先获取建议而不修改文件",
  "在输入中使用 {highlight}@智能体名称{/highlight} 可调用专用子智能体",
  "服务器配置使用 {highlight}arforge.json{/highlight}，终端界面配置使用 {highlight}tui.json{/highlight}",
  "全局终端界面配置位于 {highlight}~/.config/arforge/tui.json{/highlight}",
  "在配置中设置 {highlight}model{/highlight} 可指定默认模型",
  "在 {highlight}tui.json{/highlight} 的 {highlight}keybinds{/highlight} 中可覆盖任意快捷键",
  "把快捷键设为 {highlight}none{/highlight} 可彻底禁用它",
  "在 {highlight}mcp{/highlight} 配置段中可配置本地或远程 MCP 服务器",
  "在 {highlight}.arforge/commands/{/highlight} 中添加 Markdown 文件可创建复用命令",
  "在 {highlight}.arforge/agents/{/highlight} 中添加 Markdown 文件可创建专用智能体",
  "使用 {highlight}arforge run{/highlight} 可执行非交互脚本",
  "使用 {highlight}arforge --continue{/highlight} 可继续最近一次会话",
  "使用 {highlight}--format json{/highlight} 可输出便于脚本处理的 JSON",
  "运行 {highlight}arforge serve{/highlight} 可启动仅监听本机的无界面服务",
  "运行 {highlight}arforge auth list{/highlight} 可查看已配置的提供商",
  "运行 {highlight}arforge debug config{/highlight} 可排查配置问题",
  (shortcuts) => `使用 ${commandText("/timeline", shortcuts.sessionTimeline())} 跳转到指定消息`,
  (shortcuts) => `使用 ${commandText("/status", shortcuts.statusView())} 查看系统状态`,
  (shortcuts) => `使用 ${commandText("/help", shortcuts.helpShow())} 打开帮助对话框`,
  "使用 {highlight}/rename{/highlight} 可重命名当前会话",
]

const INPUT_UNDO_TIP: Tip = (shortcuts) => press(shortcuts.inputUndo(), "可撤销输入框中的更改")
const TERMINAL_SUSPEND_TIP: Tip = (shortcuts) => press(shortcuts.terminalSuspend(), "可挂起终端界面并返回 Shell")

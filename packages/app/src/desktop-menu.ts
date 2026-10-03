export type DesktopMenuPlatform = "macos" | "windows"

export type DesktopMenuAction =
  | "app.relaunch"
  | "edit.undo"
  | "edit.redo"
  | "edit.cut"
  | "edit.copy"
  | "edit.paste"
  | "edit.delete"
  | "edit.selectAll"
  | "view.reload"
  | "view.toggleDevTools"
  | "view.resetZoom"
  | "view.zoomIn"
  | "view.zoomOut"
  | "view.toggleFullscreen"
  | "window.new"
  | "window.browser"
  | "window.close"
  | "window.minimize"
  | "window.toggleMaximize"

export type DesktopMenuRole =
  | "about"
  | "close"
  | "copy"
  | "cut"
  | "hide"
  | "hideOthers"
  | "paste"
  | "quit"
  | "redo"
  | "reload"
  | "resetZoom"
  | "selectAll"
  | "toggleDevTools"
  | "togglefullscreen"
  | "undo"
  | "unhide"
  | "windowMenu"
  | "zoomIn"
  | "zoomOut"

export type DesktopMenuItem = {
  type: "item"
  label?: string
  command?: string
  action?: DesktopMenuAction
  role?: DesktopMenuRole
  href?: string
  accelerator?: Partial<Record<DesktopMenuPlatform, string>>
  platforms?: DesktopMenuPlatform[]
}

export type DesktopMenuSeparator = {
  type: "separator"
  platforms?: DesktopMenuPlatform[]
}

export type DesktopMenuEntry = DesktopMenuItem | DesktopMenuSeparator

export type DesktopMenu = {
  id: string
  label: string
  role?: DesktopMenuRole
  items?: DesktopMenuEntry[]
  platforms?: DesktopMenuPlatform[]
}

export const DESKTOP_MENU: DesktopMenu[] = [
  {
    id: "app",
    label: "Arforge",
    platforms: ["macos"],
    items: [
      { type: "item", role: "about" },
      { type: "item", label: "设置", command: "settings.open", accelerator: { macos: "Cmd+," } },
      { type: "item", label: "重新加载界面", action: "view.reload" },
      { type: "item", label: "重新启动", action: "app.relaunch" },
      { type: "item", label: "导出日志…", command: "logs.export" },
      { type: "separator" },
      { type: "item", role: "hide" },
      { type: "item", role: "hideOthers" },
      { type: "item", role: "unhide" },
      { type: "separator" },
      { type: "item", role: "quit" },
    ],
  },
  {
    id: "file",
    label: "文件",
    items: [
      {
        type: "item",
        label: "新建会话",
        command: "session.new",
        accelerator: { macos: "Shift+Cmd+S" },
      },
      { type: "item", label: "打开项目…", command: "project.open", accelerator: { macos: "Cmd+O" } },
      { type: "item", label: "隔离浏览器…", action: "window.browser" },
      {
        type: "item",
        label: "设置",
        command: "settings.open",
        accelerator: { windows: "Ctrl+," },
        platforms: ["windows"],
      },
      {
        type: "item",
        label: "Arforge 设置",
        command: "control-center.open",
        accelerator: { windows: "Ctrl+Shift+," },
      },
      {
        type: "item",
        label: "新建窗口",
        action: "window.new",
        accelerator: { macos: "Cmd+Shift+N", windows: "Ctrl+Shift+N" },
      },
      { type: "separator" },
      { type: "item", label: "关闭窗口", action: "window.close", role: "close" },
    ],
  },
  {
    id: "edit",
    label: "编辑",
    items: [
      { type: "item", label: "撤销", action: "edit.undo", role: "undo", accelerator: { windows: "Ctrl+Z" } },
      { type: "item", label: "重做", action: "edit.redo", role: "redo", accelerator: { windows: "Ctrl+Y" } },
      { type: "separator" },
      { type: "item", label: "剪切", action: "edit.cut", role: "cut", accelerator: { windows: "Ctrl+X" } },
      { type: "item", label: "复制", action: "edit.copy", role: "copy", accelerator: { windows: "Ctrl+C" } },
      { type: "item", label: "粘贴", action: "edit.paste", role: "paste", accelerator: { windows: "Ctrl+V" } },
      { type: "item", label: "删除", action: "edit.delete" },
      {
        type: "item",
        label: "全选",
        action: "edit.selectAll",
        role: "selectAll",
        accelerator: { windows: "Ctrl+A" },
      },
    ],
  },
  {
    id: "view",
    label: "视图",
    items: [
      { type: "item", label: "切换侧边栏", command: "sidebar.toggle" },
      { type: "item", label: "切换终端", command: "terminal.toggle", accelerator: { macos: "Ctrl+`" } },
      { type: "item", label: "切换文件树", command: "fileTree.toggle" },
      { type: "separator" },
      { type: "item", label: "重新加载", action: "view.reload", role: "reload" },
      { type: "item", label: "切换开发者工具", action: "view.toggleDevTools", role: "toggleDevTools" },
      { type: "separator" },
      {
        type: "item",
        label: "实际大小",
        action: "view.resetZoom",
        role: "resetZoom",
        accelerator: { windows: "Ctrl+0" },
      },
      { type: "item", label: "放大", action: "view.zoomIn", role: "zoomIn", accelerator: { windows: "Ctrl++" } },
      { type: "item", label: "缩小", action: "view.zoomOut", role: "zoomOut", accelerator: { windows: "Ctrl+-" } },
      { type: "separator" },
      { type: "item", label: "切换全屏", action: "view.toggleFullscreen", role: "togglefullscreen" },
    ],
  },
  {
    id: "go",
    label: "前往",
    items: [
      { type: "item", label: "后退", command: "common.goBack", accelerator: { macos: "Cmd+[" } },
      { type: "item", label: "前进", command: "common.goForward", accelerator: { macos: "Cmd+]" } },
      { type: "separator" },
      { type: "item", label: "上一个会话", command: "session.previous", accelerator: { macos: "Option+Up" } },
      { type: "item", label: "下一个会话", command: "session.next", accelerator: { macos: "Option+Down" } },
      { type: "separator" },
      {
        type: "item",
        label: "上一个项目",
        command: "project.previous",
        accelerator: { macos: "Cmd+Option+Up" },
      },
      {
        type: "item",
        label: "下一个项目",
        command: "project.next",
        accelerator: { macos: "Cmd+Option+Down" },
      },
    ],
  },
  {
    id: "window",
    label: "窗口",
    role: "windowMenu",
    items: [
      { type: "item", label: "最小化", action: "window.minimize" },
      { type: "item", label: "最大化", action: "window.toggleMaximize" },
      { type: "separator" },
      { type: "item", label: "关闭窗口", action: "window.close" },
    ],
  },
  {
    id: "help",
    label: "帮助",
    items: [{ type: "item", label: "导出日志…", command: "logs.export" }],
  },
]

export function desktopMenuVisible(item: { platforms?: DesktopMenuPlatform[] }, platform: DesktopMenuPlatform) {
  return !item.platforms || item.platforms.includes(platform)
}

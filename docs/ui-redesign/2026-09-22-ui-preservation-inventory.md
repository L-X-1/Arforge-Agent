# 全界面保留矩阵与源码证据
日期：2026-09-22
状态：设计范围和保留约束；不是“实现已保留全部功能”的测试结论。

## 证据口径
- 本轮读取了当前路由、全局能力映射、UI 能力解释、控制中心导航、设置入口、会话操作语义、桌面菜单等，并盘点现有组件目录。
- 下列源码路径有两种证据强度：核心入口/映射有内容证据，部分子组件有当前目录和引用证据。没有把文件存在等同于功能测试通过。
- 预览中的“新增”或“查看”均为设计动作，实际请求和权限语义继续属于现有组件与 typed API。
- 内部能力仍为内部能力；自动化 ingest、受鉴权产物读取、传输订阅与事务不是必须加一个前端按钮。
- 旧/新布局入口与服务器/会话深链接兼容应保留；不把 56 个设计画面误当成 56 个新增业务路由。

## 页面 / 状态 / 平台画面清单
| 编号 | 画面 | 范围与保留要求 | 现有来源 | 预览 |
|---|---|---|---|---|
| 01 | 主会话 | 对话居中，文件、执行与历史预览按需展开。 | `packages/app/src/app.tsx` | [PNG](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/screens/01-chat.png) / [HTML](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/index.html?view=chat) |
| 02 | 深色会话 | 温润石墨与柔白强调，同一套交互与内容层级。 | `packages/app/src/context/settings.tsx` | [PNG](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/screens/02-chat-dark.png) / [HTML](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/index.html?view=chat-dark) |
| 03 | 首页与新会话 | 项目、草稿与最近会话，减少首次开始的步骤。 | `packages/app/src/app.tsx` | [PNG](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/screens/03-home.png) / [HTML](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/index.html?view=home) |
| 04 | 会话搜索与管理 | 保留搜索、固定、归档、重命名、分享与分支入口。 | `packages/app/src/app.tsx` | [PNG](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/screens/04-sessions.png) / [HTML](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/index.html?view=sessions) |
| 05 | 文件工作台 | 文件树、文件标签、检索、原位预览与在外部应用打开。 | `packages/app/src/pages/session/session-side-panel.tsx` | [PNG](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/screens/05-files.png) / [HTML](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/index.html?view=files) |
| 06 | 变更审查 | 文件差异、行级评论、变更导航及受控回退。 | `packages/app/src/pages/session/session-side-panel.tsx` | [PNG](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/screens/06-diff.png) / [HTML](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/index.html?view=diff) |
| 07 | 隔离浏览器 | 桌面嵌入浏览器保留地址栏、前进后退、停止、刷新与作用域隔离。 | `packages/app/src/components/browser-workbench-panel.tsx` | [PNG](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/screens/07-browser.png) / [HTML](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/index.html?view=browser) |
| 08 | PDF 预览 | 页码、缩放、搜索、下载与加载失败恢复；保持真实文档内容。 | `packages/app/src/components/preview/pdf-preview.tsx` | [PNG](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/screens/08-preview-pdf.png) / [HTML](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/index.html?view=preview-pdf) |
| 09 | Word 预览 | 独立文档画布与信息面板，不宣称与 Office 原生分页完全一致。 | `packages/app/src/components/preview/office-preview.tsx` | [PNG](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/screens/09-preview-word.png) / [HTML](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/index.html?view=preview-word) |
| 10 | 表格预览 | 工作表切换、固定表头与横向滚动；不伪装成完整电子表格编辑器。 | `packages/app/src/components/preview/office-preview.tsx` | [PNG](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/screens/10-preview-sheet.png) / [HTML](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/index.html?view=preview-sheet) |
| 11 | 演示文稿预览 | 缩略图导航、页面舞台、缩放与外部打开。 | `packages/app/src/components/preview/office-preview.tsx` | [PNG](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/screens/11-preview-slides.png) / [HTML](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/index.html?view=preview-slides) |
| 12 | Markdown 与文本编辑 | 源码与预览并排，草稿、未保存提示、冲突与保存回执不丢失。 | `packages/app/src/components/preview/text-document-editor.tsx`<br>`packages/app/src/components/preview/markdown-preview.tsx` | [PNG](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/screens/12-preview-markdown.png) / [HTML](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/index.html?view=preview-markdown) |
| 13 | HTML 与元素预览 | 沙箱预览与元素检查分离，修改前看范围和差异。 | `packages/app/src/components/preview/html-preview.tsx`<br>`packages/app/src/components/preview/html-element-preview.tsx` | [PNG](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/screens/13-preview-html.png) / [HTML](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/index.html?view=preview-html) |
| 14 | 图像与其他附件 | 按支持的类型展示预览，不能内嵌时说明原因并保留下载入口。 | `packages/app/src/components/preview/file-preview.tsx` | [PNG](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/screens/14-preview-media.png) / [HTML](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/index.html?view=preview-media) |
| 15 | 会话内终端 | 保留会话内 PTY、标签切换、调整尺寸与重连；不是改造 CLI/TUI。 | `packages/app/src/pages/session/terminal-panel-v2.tsx` | [PNG](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/screens/15-terminal.png) / [HTML](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/index.html?view=terminal) |
| 16 | 执行详情 | 步骤、工具输入输出、运行历史和停止控制，详情默认折叠。 | `packages/app/src/pages/session/session-execution-dock.tsx`<br>`packages/app/src/components/session/session-run-history.tsx` | [PNG](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/screens/16-execution.png) / [HTML](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/index.html?view=execution) |
| 17 | 上下文与用量 | 来源、上下文构成、预算与压缩入口，避免把估算当作结算。 | `packages/app/src/components/session/session-context-tab.tsx` | [PNG](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/screens/17-context.png) / [HTML](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/index.html?view=context) |
| 18 | 目标与任务 | 目标生命周期、任务依赖、领取与完成；保留 revision 和权限检查。 | `packages/app/src/components/session/session-goal-control.tsx`<br>`packages/app/src/components/session/session-operations-dialog.tsx` | [PNG](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/screens/18-goals.png) / [HTML](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/index.html?view=goals) |
| 19 | 待发送消息 | FIFO 顺序、编辑、移除与投递状态，不混淆排队和立即引导。 | `packages/app/src/components/session/session-prompt-queue-control.tsx` | [PNG](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/screens/19-queue.png) / [HTML](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/index.html?view=queue) |
| 20 | 定时消息 | 时间、时区、错过执行及手动运行，危险操作维持现有空闲限制。 | `packages/app/src/components/session/session-operations-dialog.tsx` | [PNG](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/screens/20-schedules.png) / [HTML](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/index.html?view=schedules) |
| 21 | 触发器 | 触发配置、来源、事件结构、试运行与错误信息。 | `packages/app/src/components/session/session-operations-dialog.tsx` | [PNG](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/screens/21-triggers.png) / [HTML](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/index.html?view=triggers) |
| 22 | 协作等待 | 等待原因、来源与唤醒入口，不显示虚假的运行进度。 | `packages/app/src/components/session/session-operations-dialog.tsx` | [PNG](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/screens/22-waits.png) / [HTML](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/index.html?view=waits) |
| 23 | 团队与子代理 | 团队成员、隔离消息箱、子代理状态、跟进与取消。 | `packages/app/src/components/session/session-operations-dialog.tsx` | [PNG](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/screens/23-team.png) / [HTML](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/index.html?view=team) |
| 24 | 检查点与对话回退 | 对话回退只归档后续消息，不撤销文件、命令、Git 或外部状态。 | `packages/app/src/components/session/session-operations-dialog.tsx` | [PNG](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/screens/24-checkpoints.png) / [HTML](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/index.html?view=checkpoints) |
| 25 | 会话反馈 | 类别、评分与说明；本地保存，保持凭据遮蔽边界。 | `packages/app/src/components/session/session-feedback-control.tsx` | [PNG](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/screens/25-feedback.png) / [HTML](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/index.html?view=feedback) |
| 26 | 个人后台任务 | 批准、启动、暂停、恢复、取消、删除及通知已读。 | `packages/app/src/components/session/session-personal-jobs-control.tsx` | [PNG](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/screens/26-jobs.png) / [HTML](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/index.html?view=jobs) |
| 27 | 个人工作区 | 项目、Location、会话、任务、运行和后台工作统一视图。 | `packages/app/src/components/control-center/personal-workspace.tsx` | [PNG](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/screens/27-workspace.png) / [HTML](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/index.html?view=workspace) |
| 28 | 系统概览 | 只读系统状态与安全入口，示例值不是当前运行诊断。 | `packages/app/src/components/control-center/navigation.ts` | [PNG](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/screens/28-overview.png) / [HTML](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/index.html?view=overview) |
| 29 | 模型服务商 | 连接、OAuth、API Key、凭据更新与移除，失败不丢表单。 | `packages/app/src/components/settings-v2/providers.tsx` | [PNG](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/screens/29-providers.png) / [HTML](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/index.html?view=providers) |
| 30 | 模型管理 | 搜索、能力筛选、可见性与当前选择，付费限制明确提示。 | `packages/app/src/components/settings-v2/models.tsx` | [PNG](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/screens/30-models.png) / [HTML](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/index.html?view=models) |
| 31 | 服务器 | 本地、远程与 WSL 连接，保留身份、作用域和故障恢复。 | `packages/app/src/components/settings-v2/servers.tsx` | [PNG](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/screens/31-servers.png) / [HTML](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/index.html?view=servers) |
| 32 | 权限与安全 | 待处理请求与持久权限分开显示，单条撤销保持精确确认。 | `packages/app/src/components/control-center/navigation.ts` | [PNG](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/screens/32-permissions.png) / [HTML](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/index.html?view=permissions) |
| 33 | 记忆与学习 | 搜索、召回质量、候选审查、纠错、冲突和撤销保持完整。 | `packages/app/src/components/control-center/capability-workbench.tsx` | [PNG](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/screens/33-memory.png) / [HTML](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/index.html?view=memory) |
| 34 | 受控自主进化 | 候选、证据、评测、批准、灰度、回滚与暴露记录归档。 | `packages/app/src/components/control-center/evolution-workbench.tsx` | [PNG](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/screens/34-evolution.png) / [HTML](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/index.html?view=evolution) |
| 35 | 运行时透视 | 上下文编译、路由、独立验证、审计与恢复审查。 | `packages/app/src/components/control-center/runtime-insight-workbench.tsx` | [PNG](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/screens/35-runtime.png) / [HTML](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/index.html?view=runtime) |
| 36 | 代理配置 | 保留已有自定义代理的可见性、配置入口和会话切换能力。 | `packages/app/src/components/prompt-input-v2.tsx`<br>`packages/app/src/components/settings-v2/general.tsx` | [PNG](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/screens/36-agents.png) / [HTML](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/index.html?view=agents) |
| 37 | 技能 | 读取、路由、刷新、启停及候选评测、灰度、推广、回滚。 | `packages/app/src/components/control-center/dialog-control-center.tsx` | [PNG](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/screens/37-skills.png) / [HTML](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/index.html?view=skills) |
| 38 | 插件 | 检查、安装、更新、启停、卸载与恢复分开确认。 | `packages/app/src/components/control-center/dialog-control-center.tsx` | [PNG](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/screens/38-plugins.png) / [HTML](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/index.html?view=plugins) |
| 39 | 工作流 | 预览、启动、事件、控制、审批与重试，不跳过执行边界。 | `packages/app/src/components/control-center/dialog-control-center.tsx` | [PNG](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/screens/39-workflows.png) / [HTML](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/index.html?view=workflows) |
| 40 | MCP 与资源 | 连接状态、资源目录及会话引用；内部发现与对账不冒充普通按钮。 | `packages/app/src/capabilities/ui-capability-review.ts` | [PNG](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/screens/40-mcp.png) / [HTML](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/index.html?view=mcp) |
| 41 | 诊断与运行报告 | 运行记录、诊断、质量评估、计划预览和 trace 导出。 | `packages/app/src/components/control-center/capability-workbench.tsx` | [PNG](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/screens/41-diagnostics.png) / [HTML](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/index.html?view=diagnostics) |
| 42 | 数据库与本地运维 | 安全运维说明、迁移要求、日志与恢复入口；不一键执行破坏性操作。 | `packages/app/src/components/control-center/navigation.ts` | [PNG](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/screens/42-operations.png) / [HTML](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/index.html?view=operations) |
| 43 | 开发者能力映射 | 按语义功能展示能力归属与边界，不为内部 API 增加多余按钮。 | `packages/app/src/capabilities/control-center-map.ts` | [PNG](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/screens/43-coverage.png) / [HTML](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/index.html?view=coverage) |
| 44 | 数据与租户治理 | 政策、数据申请、批准、备份、验证、审计导出和密钥撤销。 | `packages/app/src/components/control-center/governance-workbench.tsx`<br>`packages/app/src/capabilities/control-center-map.ts` | [PNG](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/screens/44-tenant.png) / [HTML](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/index.html?view=tenant) |
| 45 | 产物与审计证据 | 目录、归属与审计证据，不将受鉴权字节读取变成任意路径打开。 | `packages/app/src/components/control-center/artifact-evidence-workbench.tsx` | [PNG](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/screens/45-artifacts.png) / [HTML](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/index.html?view=artifacts) |
| 46 | 通用与外观设置 | 语言、字体、主题、显示、Shell、通知、声音、更新与引导。 | `packages/app/src/components/settings-v2/general.tsx`<br>`packages/app/src/context/settings.tsx` | [PNG](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/screens/46-settings.png) / [HTML](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/index.html?view=settings) |
| 47 | 快捷键 | 现有绑定优先；搜索、修改、冲突提示与恢复默认。 | `packages/app/src/components/settings-keybinds.tsx` | [PNG](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/screens/47-shortcuts.png) / [HTML](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/index.html?view=shortcuts) |
| 48 | 首次启动引导 | 连接服务器、模型与项目；可稍后完成并从设置重新进入。 | `packages/app/src/components/onboarding/home-first-run-guide.tsx` | [PNG](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/screens/48-onboarding.png) / [HTML](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/index.html?view=onboarding) |
| 49 | 空白、加载与异常 | 启动、重连、数据库迁移、空数据、无权限、保存冲突、额度与更新。 | `packages/app/src/app.tsx`<br>`packages/app/src/components/route-loading-fallback.tsx` | [PNG](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/screens/49-states.png) / [HTML](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/index.html?view=states) |
| 50 | 弹窗、菜单与选择器 | 命令、项目、模型、MCP、服务商、分享、分支、发布说明等入口完整保留。 | `packages/app/src/components` | [PNG](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/screens/50-dialogs.png) / [HTML](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/index.html?view=dialogs) |
| 51 | 审批与提问 | 权限、问题、操作影响和恢复回执，当前作用域始终可见。 | `packages/app/src/components/control-approval/control-approval-center.tsx`<br>`packages/app/src/capabilities/ui-capability-review.ts` | [PNG](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/screens/51-approvals.png) / [HTML](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/index.html?view=approvals) |
| 52 | 完整内容排版 | 标题、段落、引用、有序/无序列表、代码、表格、数学与链接。 | `docs/ui-redesign/2026-09-21-ui-planning-baseline.md` | [PNG](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/screens/52-typography.png) / [HTML](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/index.html?view=typography) |
| 53 | 手机 Web 会话 | 单列阅读、抽屉导航、固定工具栏与安全区域适配。 | `packages/app/src/app.tsx` | [PNG](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/screens/53-mobile.png) / [HTML](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/index.html?view=mobile) |
| 54 | 手机历史预览 | 轻点刻度预览，再明确跳转；关闭按钮、点外部或成功跳转后收起。 | `docs/ui-redesign/2026-09-21-ui-planning-baseline.md` | [PNG](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/screens/54-mobile-history.png) / [HTML](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/index.html?view=mobile-history) |
| 55 | 窄窗口工作区 | 聊天与文件通过单个主面板切换，避免挤成两列窄内容。 | `packages/app/src/pages/session/session-side-panel.tsx` | [PNG](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/screens/55-tablet.png) / [HTML](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/index.html?view=tablet) |
| 56 | 桌面标题栏与原生菜单 | Windows / macOS 各自遵循平台窗口与菜单行为，保留缩放、多窗口及日志导出。 | `packages/app/src/desktop-menu.ts` | [PNG](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/screens/56-desktop-menus.png) / [HTML](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-20260922/index.html?view=desktop-menus) |

## 29 条源码能力映射的设计归属
主要证据：[control-center-map.ts](E:/Arforge-Agent/packages/app/src/capabilities/control-center-map.ts)、[ui-capability-review.ts](E:/Arforge-Agent/packages/app/src/capabilities/ui-capability-review.ts)。

| 语义功能 | 现有 Surface | 风险边界 | 设计画面 ID |
|---|---|---|---|
| `system-overview` | `global-control-center` | `read` | `overview` |
| `providers-models-integrations` | `global-control-center` | `write` | `providers`, `models` |
| `saved-permission-governance` | `global-control-center` | `confirm` | `permissions`, `approvals` |
| `memory-learning-governance` | `global-control-center` | `preview-confirm` | `memory`, `evolution` |
| `experience-and-skill-lifecycle-governance` | `global-control-center` | `confirm` | `skills`, `evolution` |
| `agent-diagnostics-and-runs` | `global-control-center` | `read` | `diagnostics`, `execution` |
| `runtime-insight` | `global-control-center` | `read` | `runtime` |
| `artifact-receipts-and-audit` | `global-control-center` | `read` | `artifacts` |
| `runtime-insight-recovery-review` | `global-control-center` | `confirm` | `runtime`, `approvals` |
| `mcp-capability-observability` | `global-control-center` | `read` | `mcp`, `coverage` |
| `mcp-action-reconciliation-observability` | `global-control-center` | `read` | `coverage` |
| `mcp-action-reconciliation-maintenance` | `global-control-center` | `confirm` | `coverage`, `operations` |
| `workflow-plugin-skill-mcp` | `global-control-center` | `preview-confirm` | `workflows`, `plugins`, `skills`, `mcp` |
| `experience-and-skill-lifecycle-governance` | `global-control-center` | `read` | `skills`, `evolution` |
| `project-copies` | `global-control-center` | `preview-confirm` | `workspace`, `dialogs` |
| `private-operations-overview` | `global-control-center` | `read` | `operations` |
| `tenant-platform-observability` | `global-control-center` | `read` | `tenant` |
| `tenant-platform-data-governance` | `global-control-center` | `preview-confirm` | `tenant` |
| `tenant-platform-secret-governance` | `global-control-center` | `confirm` | `tenant` |
| `session-lifecycle-and-recovery` | `session-control-center` | `preview-confirm` | `sessions`, `queue`, `checkpoints` |
| `goal-lifecycle` | `session-control-center` | `write` | `goals` |
| `schedule-task-trigger-wait` | `session-control-center` | `confirm` | `schedules`, `triggers`, `waits`, `goals` |
| `team-and-subagent` | `session-control-center` | `confirm` | `team` |
| `personal-background-jobs` | `session-control-center` | `read` | `jobs` |
| `personal-background-jobs` | `session-control-center` | `preview-confirm` | `jobs` |
| `permission-question-settlement` | `session-control-center` | `write` | `approvals` |
| `files-commands-terminal-references` | `workspace-surface` | `write` | `files`, `terminal`, `dialogs` |
| `workspace-snapshots` | `workspace-surface` | `preview-confirm` | `workspace` |
| `streaming-pagination-and-session-transaction` | `transport-internal` | `internal` | `coverage` |

## 高风险与内部能力不退化
| 能力 | 必须保留 |
|---|---|
| 对话回退 | 只归档消息，不假装撤销文件、Git 或外部操作 |
| 会话与文件回退 | 与纯对话回退区分；使用现有范围预览、审批与恢复机制 |
| 发布/撤销分享 | 显式显示发布范围与撤销操作，不默认公开 |
| 插件安装/启用 | 两步分开；检查、更新、卸载与恢复均保留 |
| Skill / Evolution | 证据、评测、审批、灰度、推广、回滚与审计不省略 |
| 记忆 | 候选、激活、纠错、冲突、撤销、来源与理由 |
| 租户/数据 | 政策、申请、批准、备份、验证、秘密撤销和审计范围 |
| 工作树/副本 | 创建、移除、重置、刷新前保留安全预览，不触碰非目标路径 |
| 后台任务 | 批准、拒绝、启动、执行、分发、暂停、恢复、取消与通知 |
| Server / Session | owner、revision、作用域、身份与路由边界保持 |
| 内部传输 | SSE、分页、session transaction 不新增重复 UI 控件 |
| MCP 对账 / 发现 | 维持维护者/内部边界，不伪造普通用户重试授权 |
| 产物字节读取 | 保持鉴权、范围与所有权，不暴露任意路径或秘密内容 |

## 所有画面共用的状态合同
每个数据表/表单/面板均按适用情况保留：初始加载、空数据、空搜索、成功、部分成功、失败、取消、无权限、只读、过期、冲突、离线、重试、忙碌、完成、焦点、禁用及窄窗口状态。
状态画面是共用组件规范，不意味着只有“状态页”处理错误。

## 源码关键约束
- [app.tsx](E:/Arforge-Agent/packages/app/src/app.tsx)：共享 Provider、Server 身份、草稿、会话路由、ConnectionGate。
- [navigation.ts](E:/Arforge-Agent/packages/app/src/components/control-center/navigation.ts)：11 个 Arforge 管理导航项。
- [dialog-settings-v2.tsx](E:/Arforge-Agent/packages/app/src/components/settings-v2/dialog-settings-v2.tsx)：通用、快捷键、服务器、服务商、模型及 Arforge/Session 分组。
- [session-operations-text.ts](E:/Arforge-Agent/packages/app/src/components/session/session-operations-text.ts)：会话忙碌限制、FIFO、任务依赖、隔离收件箱和回退边界。
- [session-side-panel.tsx](E:/Arforge-Agent/packages/app/src/pages/session/session-side-panel.tsx)：文件/变更/上下文、标签、宽度和原位预览。
- [desktop-menu.ts](E:/Arforge-Agent/packages/app/src/desktop-menu.ts)：平台菜单、编辑、视图、跳转、多窗口、缩放与日志导出。
- [settings.tsx](E:/Arforge-Agent/packages/app/src/context/settings.tsx)：既有持久化设置和兼容迁移，不允许重置覆盖。
- 其他路径用于定位现有能力，不表示本轮已运行这些组件或确认全部业务行为正确。

## 不应被误报为完成
- UI 重构代码尚未实施。
- 全量应用回归、可访问性认证、实际字体分发核查尚未执行。
- Office 完美分页、真实原生文件验收不因预览图片而视为通过。
- 30 倍极限压力专项未通过；安装包验收继续延期。

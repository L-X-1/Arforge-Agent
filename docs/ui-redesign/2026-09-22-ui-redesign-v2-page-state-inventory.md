# Arforge V2：页面、状态与功能保留清单

日期：2026-09-22
状态：设计覆盖清单，不是业务回归通过报告。
[总览入口](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-v2-20260922/gallery.html) · [设计计划](E:/Arforge-Agent/docs/ui-redesign/2026-09-22-ui-redesign-v2-review-plan.md) · [决策矩阵](E:/Arforge-Agent/docs/ui-redesign/2026-09-22-ui-redesign-v2-decision-matrix.md)

## 1. 来源与证据边界

本清单基于此前已读取的应用入口、控制中心能力映射、会话操作文案、选取的组件源码片段，以及已有页面 / 组件目录盘点。部分来源只做过元数据或片段盘点，不代表对每个组件完整实现做过审查。

来源路径用于后续实施定位，不等于已验证每个页面路由、接口、平台行为或依赖可以直接复用。预览是独立示意，不访问这些业务文件。正式实施前必须按实际受影响模块做一次明确范围的适配分析。

## 2. 64 个画面

| 序号 | 页面与图片 | 设计归组 | 预览类型 | 保留动作 |
| --- | --- | --- | --- | --- |
| 01 | [主会话](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-v2-20260922/screens/01-chat.png) | 01 对话与工作区 | chat | 文件、执行 |
| 02 | [深色会话](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-v2-20260922/screens/02-chat-dark.png) | 01 对话与工作区 | chat | 保留当前页面原有局部操作 |
| 03 | [首页与新会话](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-v2-20260922/screens/03-home.png) | 01 对话与工作区 | home | 打开项目、新建会话 |
| 04 | [会话搜索与管理](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-v2-20260922/screens/04-sessions.png) | 01 对话与工作区 | table | 新建会话 |
| 05 | [文件工作台](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-v2-20260922/screens/05-files.png) | 01 对话与工作区 | files | 查找文件、在应用中打开 |
| 06 | [变更审查](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-v2-20260922/screens/06-diff.png) | 01 对话与工作区 | diff | 并排查看、添加评论 |
| 07 | [隔离浏览器](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-v2-20260922/screens/07-browser.png) | 01 对话与工作区 | browser | 重新加载、关闭浏览器 |
| 08 | [PDF 预览](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-v2-20260922/screens/08-preview-pdf.png) | 02 文件与内容预览 | document | 适合宽度、下载 |
| 09 | [Word 预览](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-v2-20260922/screens/09-preview-word.png) | 02 文件与内容预览 | document | 在应用中打开、下载 |
| 10 | [表格预览](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-v2-20260922/screens/10-preview-sheet.png) | 02 文件与内容预览 | sheet | 切换工作表、下载 |
| 11 | [演示文稿预览](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-v2-20260922/screens/11-preview-slides.png) | 02 文件与内容预览 | slides | 适合页面、在应用中打开 |
| 12 | [Markdown 与文本编辑](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-v2-20260922/screens/12-preview-markdown.png) | 02 文件与内容预览 | editor | 预览、保存草稿 |
| 13 | [HTML 与元素预览](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-v2-20260922/screens/13-preview-html.png) | 02 文件与内容预览 | html | 选择元素、查看修改预览 |
| 14 | [图像与其他附件](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-v2-20260922/screens/14-preview-media.png) | 02 文件与内容预览 | media | 原始尺寸、下载 |
| 15 | [会话内终端](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-v2-20260922/screens/15-terminal.png) | 01 对话与工作区 | terminal | 新建终端、收起 |
| 16 | [执行详情](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-v2-20260922/screens/16-execution.png) | 03 会话管理 | execution | 停止、运行历史 |
| 17 | [上下文与用量](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-v2-20260922/screens/17-context.png) | 03 会话管理 | context | 查看来源、压缩预览 |
| 18 | [目标与任务](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-v2-20260922/screens/18-goals.png) | 03 会话管理 | tasks | 新增目标、新增任务 |
| 19 | [待发送消息](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-v2-20260922/screens/19-queue.png) | 03 会话管理 | table | 添加到队列 |
| 20 | [定时消息](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-v2-20260922/screens/20-schedules.png) | 03 会话管理 | table | 新增定时消息 |
| 21 | [触发器](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-v2-20260922/screens/21-triggers.png) | 03 会话管理 | table | 新增触发器 |
| 22 | [协作等待](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-v2-20260922/screens/22-waits.png) | 03 会话管理 | timeline | 查看等待条件 |
| 23 | [团队与子代理](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-v2-20260922/screens/23-team.png) | 03 会话管理 | team | 添加成员、发送消息 |
| 24 | [检查点与对话回退](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-v2-20260922/screens/24-checkpoints.png) | 03 会话管理 | timeline | 创建检查点、预览对话回退 |
| 25 | [会话反馈](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-v2-20260922/screens/25-feedback.png) | 03 会话管理 | form | 保存反馈 |
| 26 | [个人后台任务](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-v2-20260922/screens/26-jobs.png) | 03 会话管理 | table | 新建后台任务 |
| 27 | [个人工作区](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-v2-20260922/screens/27-workspace.png) | 04 控制中心 | workspace | 工作区快照、管理项目副本 |
| 28 | [系统概览](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-v2-20260922/screens/28-overview.png) | 04 控制中心 | overview | 刷新状态 |
| 29 | [模型服务商](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-v2-20260922/screens/29-providers.png) | 05 连接与设置 | table | 连接服务商 |
| 30 | [模型管理](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-v2-20260922/screens/30-models.png) | 05 连接与设置 | table | 管理可见模型 |
| 31 | [服务器](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-v2-20260922/screens/31-servers.png) | 05 连接与设置 | table | 添加服务器 |
| 32 | [权限与安全](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-v2-20260922/screens/32-permissions.png) | 04 控制中心 | table | 待处理请求、查看已保存规则 |
| 33 | [记忆与学习](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-v2-20260922/screens/33-memory.png) | 04 控制中心 | memory | 新增记忆、查看候选 |
| 34 | [受控自主进化](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-v2-20260922/screens/34-evolution.png) | 04 控制中心 | pipeline | 查看候选、查看审计 |
| 35 | [运行时透视](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-v2-20260922/screens/35-runtime.png) | 04 控制中心 | runtime | 刷新快照、恢复审查 |
| 36 | [代理配置](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-v2-20260922/screens/36-agents.png) | 04 控制中心 | table | 选择现有代理 |
| 37 | [技能](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-v2-20260922/screens/37-skills.png) | 04 控制中心 | table | 刷新技能、查看生命周期 |
| 38 | [插件](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-v2-20260922/screens/38-plugins.png) | 04 控制中心 | table | 检查插件 |
| 39 | [工作流](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-v2-20260922/screens/39-workflows.png) | 04 控制中心 | pipeline | 预览工作流、查看运行 |
| 40 | [MCP 与资源](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-v2-20260922/screens/40-mcp.png) | 04 控制中心 | table | 连接服务、资源目录 |
| 41 | [诊断与运行报告](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-v2-20260922/screens/41-diagnostics.png) | 04 控制中心 | table | 选择诊断模式、导出报告 |
| 42 | [数据库与本地运维](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-v2-20260922/screens/42-operations.png) | 04 控制中心 | operations | 导出日志、查看安全说明 |
| 43 | [开发者能力映射](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-v2-20260922/screens/43-coverage.png) | 04 控制中心 | table | 筛选能力 |
| 44 | [数据与租户治理](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-v2-20260922/screens/44-tenant.png) | 04 控制中心 | table | 查看政策、审计导出 |
| 45 | [产物与审计证据](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-v2-20260922/screens/45-artifacts.png) | 04 控制中心 | table | 查看审计 |
| 46 | [通用与外观设置](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-v2-20260922/screens/46-settings.png) | 05 连接与设置 | settings | 恢复默认值 |
| 47 | [快捷键](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-v2-20260922/screens/47-shortcuts.png) | 05 连接与设置 | table | 恢复默认绑定 |
| 48 | [首次启动引导](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-v2-20260922/screens/48-onboarding.png) | 06 状态与组件 | onboarding | 开始配置、稍后 |
| 49 | [空白、加载与异常](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-v2-20260922/screens/49-states.png) | 06 状态与组件 | states | 查看状态规范 |
| 50 | [弹窗、菜单与选择器](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-v2-20260922/screens/50-dialogs.png) | 06 状态与组件 | dialogs | 查看确认流程 |
| 51 | [审批与提问](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-v2-20260922/screens/51-approvals.png) | 06 状态与组件 | approvals | 查看操作范围 |
| 52 | [完整内容排版](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-v2-20260922/screens/52-typography.png) | 06 状态与组件 | typography | 查看设计参数 |
| 53 | [手机 Web 会话](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-v2-20260922/screens/53-mobile.png) | 07 多尺寸与平台 | chat | 保留当前页面原有局部操作 |
| 54 | [手机历史预览](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-v2-20260922/screens/54-mobile-history.png) | 07 多尺寸与平台 | chat | 保留当前页面原有局部操作 |
| 55 | [窄窗口工作区](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-v2-20260922/screens/55-tablet.png) | 07 多尺寸与平台 | files | 保留当前页面原有局部操作 |
| 56 | [桌面标题栏与原生菜单](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-v2-20260922/screens/56-desktop-menus.png) | 07 多尺寸与平台 | menus | 保留当前页面原有局部操作 |
| 57 | [模型选择器](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-v2-20260922/screens/57-model-picker.png) | 06 状态与组件 | chat | 保留当前页面原有局部操作 |
| 58 | [深色模型选择器](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-v2-20260922/screens/58-model-picker-dark.png) | 06 状态与组件 | chat | 保留当前页面原有局部操作 |
| 59 | [模型搜索无结果](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-v2-20260922/screens/59-model-picker-empty.png) | 06 状态与组件 | chat | 保留当前页面原有局部操作 |
| 60 | [模型不可用与恢复](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-v2-20260922/screens/60-model-picker-error.png) | 06 状态与组件 | chat | 保留当前页面原有局部操作 |
| 61 | [全局搜索](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-v2-20260922/screens/61-search-global.png) | 01 对话与工作区 | search | 搜索 |
| 62 | [项目与工作区切换](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-v2-20260922/screens/62-project-switcher.png) | 01 对话与工作区 | projects | 打开项目 |
| 63 | [触屏模型选择器](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-v2-20260922/screens/63-mobile-model-picker.png) | 07 多尺寸与平台 | chat | 保留当前页面原有局部操作 |
| 64 | [深色设置](C:/Users/14181/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-ui-review-v2-20260922/screens/64-settings-dark.png) | 05 连接与设置 | settings | 恢复默认值 |


## 3. 每页状态设计与来源

### 01 主会话

对话居中，文件、执行与历史预览按需展开。

状态设计：草稿 / 发送中 / 流式 / 向上阅读 / 已完成 / 工具审批 / 失败重试。

来源定位：[packages/app/src/app.tsx](E:/Arforge-Agent/packages/app/src/app.tsx)。

边界：该页预览仅展示一种代表性布局；这里列出的所有状态应在实施时分别接入与验收，不把一张截图当成全部状态已实现。

### 02 深色会话

温润石墨与柔白强调，同一套交互与内容层级。

状态设计：草稿 / 发送中 / 流式 / 向上阅读 / 已完成 / 工具审批 / 失败重试。

来源定位：[packages/app/src/context/settings.tsx](E:/Arforge-Agent/packages/app/src/context/settings.tsx)。

边界：该页预览仅展示一种代表性布局；这里列出的所有状态应在实施时分别接入与验收，不把一张截图当成全部状态已实现。

### 03 首页与新会话

项目、草稿与最近会话，减少首次开始的步骤。

状态设计：首次无配置 / 已配置 / 最近草稿 / 无项目 / 连接失败。

来源定位：[packages/app/src/app.tsx](E:/Arforge-Agent/packages/app/src/app.tsx)。

边界：该页预览仅展示一种代表性布局；这里列出的所有状态应在实施时分别接入与验收，不把一张截图当成全部状态已实现。

### 04 会话搜索与管理

保留搜索、固定、归档、重命名、分享与分支入口。

状态设计：加载 / 空数据 / 无筛选结果 / 选中详情 / 分页 / 无权限 / 写入与冲突。

来源定位：[packages/app/src/app.tsx](E:/Arforge-Agent/packages/app/src/app.tsx)。

边界：该页预览仅展示一种代表性布局；这里列出的所有状态应在实施时分别接入与验收，不把一张截图当成全部状态已实现。

### 05 文件工作台

文件树、文件标签、检索、原位预览与在外部应用打开。

状态设计：临时预览 / 固定标签 / dirty / 只读 / 保存冲突 / 空树 / 加载失败。

来源定位：[packages/app/src/pages/session/session-side-panel.tsx](E:/Arforge-Agent/packages/app/src/pages/session/session-side-panel.tsx)。

边界：该页预览仅展示一种代表性布局；这里列出的所有状态应在实施时分别接入与验收，不把一张截图当成全部状态已实现。

### 06 变更审查

文件差异、行级评论、变更导航及受控回退。

状态设计：无变更 / 文件差异 / 并排与统一 / 行评论 / 回退预览 / 权限不足。

来源定位：[packages/app/src/pages/session/session-side-panel.tsx](E:/Arforge-Agent/packages/app/src/pages/session/session-side-panel.tsx)。

边界：该页预览仅展示一种代表性布局；这里列出的所有状态应在实施时分别接入与验收，不把一张截图当成全部状态已实现。

### 07 隔离浏览器

桌面嵌入浏览器保留地址栏、前进后退、停止、刷新与作用域隔离。

状态设计：空白 / 加载 / 停止 / 网络错误 / 身份隔离 / 不支持平台。

来源定位：[packages/app/src/components/browser-workbench-panel.tsx](E:/Arforge-Agent/packages/app/src/components/browser-workbench-panel.tsx)。

边界：该页预览仅展示一种代表性布局；这里列出的所有状态应在实施时分别接入与验收，不把一张截图当成全部状态已实现。

### 08 PDF 预览

页码、缩放、搜索、下载与加载失败恢复；保持真实文档内容。

状态设计：加载 / 页码与缩放 / 查找无结果 / 受限 / 解析失败 / 下载。

来源定位：[packages/app/src/components/preview/pdf-preview.tsx](E:/Arforge-Agent/packages/app/src/components/preview/pdf-preview.tsx)。

边界：该页预览仅展示一种代表性布局；这里列出的所有状态应在实施时分别接入与验收，不把一张截图当成全部状态已实现。

### 09 Word 预览

独立文档画布与信息面板，不宣称与 Office 原生分页完全一致。

状态设计：加载 / 页码与缩放 / 查找无结果 / 受限 / 解析失败 / 下载。

来源定位：[packages/app/src/components/preview/office-preview.tsx](E:/Arforge-Agent/packages/app/src/components/preview/office-preview.tsx)。

边界：该页预览仅展示一种代表性布局；这里列出的所有状态应在实施时分别接入与验收，不把一张截图当成全部状态已实现。

### 10 表格预览

工作表切换、固定表头与横向滚动；不伪装成完整电子表格编辑器。

状态设计：多工作表 / 横向滚动 / 空表 / 不支持格式 / 读取失败。

来源定位：[packages/app/src/components/preview/office-preview.tsx](E:/Arforge-Agent/packages/app/src/components/preview/office-preview.tsx)。

边界：该页预览仅展示一种代表性布局；这里列出的所有状态应在实施时分别接入与验收，不把一张截图当成全部状态已实现。

### 11 演示文稿预览

缩略图导航、页面舞台、缩放与外部打开。

状态设计：缩略图 / 当前页 / 适合窗口 / 缺失资源 / 解析失败。

来源定位：[packages/app/src/components/preview/office-preview.tsx](E:/Arforge-Agent/packages/app/src/components/preview/office-preview.tsx)。

边界：该页预览仅展示一种代表性布局；这里列出的所有状态应在实施时分别接入与验收，不把一张截图当成全部状态已实现。

### 12 Markdown 与文本编辑

源码与预览并排，草稿、未保存提示、冲突与保存回执不丢失。

状态设计：源码 / 预览 / 草稿 / 保存中 / 版本冲突 / 只读。

来源定位：[packages/app/src/components/preview/text-document-editor.tsx](E:/Arforge-Agent/packages/app/src/components/preview/text-document-editor.tsx)、[packages/app/src/components/preview/markdown-preview.tsx](E:/Arforge-Agent/packages/app/src/components/preview/markdown-preview.tsx)。

边界：该页预览仅展示一种代表性布局；这里列出的所有状态应在实施时分别接入与验收，不把一张截图当成全部状态已实现。

### 13 HTML 与元素预览

沙箱预览与元素检查分离，修改前看范围和差异。

状态设计：加载 / 沙箱限制 / 元素选择 / 修改差异 / 脚本错误。

来源定位：[packages/app/src/components/preview/html-preview.tsx](E:/Arforge-Agent/packages/app/src/components/preview/html-preview.tsx)、[packages/app/src/components/preview/html-element-preview.tsx](E:/Arforge-Agent/packages/app/src/components/preview/html-element-preview.tsx)。

边界：该页预览仅展示一种代表性布局；这里列出的所有状态应在实施时分别接入与验收，不把一张截图当成全部状态已实现。

### 14 图像与其他附件

按支持的类型展示预览，不能内嵌时说明原因并保留下载入口。

状态设计：图片 / 音频 / 视频 / 格式不支持 / 下载失败 / 权限。

来源定位：[packages/app/src/components/preview/file-preview.tsx](E:/Arforge-Agent/packages/app/src/components/preview/file-preview.tsx)。

边界：该页预览仅展示一种代表性布局；这里列出的所有状态应在实施时分别接入与验收，不把一张截图当成全部状态已实现。

### 15 会话内终端

保留会话内 PTY、标签切换、调整尺寸与重连；不是改造 CLI/TUI。

状态设计：连接中 / 活跃PTY / 断线 / 重连 / 多标签 / 退出。

来源定位：[packages/app/src/pages/session/terminal-panel-v2.tsx](E:/Arforge-Agent/packages/app/src/pages/session/terminal-panel-v2.tsx)。

边界：该页预览仅展示一种代表性布局；这里列出的所有状态应在实施时分别接入与验收，不把一张截图当成全部状态已实现。

### 16 执行详情

步骤、工具输入输出、运行历史和停止控制，详情默认折叠。

状态设计：待启动 / 运行 / 审批暂停 / 成功 / 失败 / 取消 / 历史。

来源定位：[packages/app/src/pages/session/session-execution-dock.tsx](E:/Arforge-Agent/packages/app/src/pages/session/session-execution-dock.tsx)、[packages/app/src/components/session/session-run-history.tsx](E:/Arforge-Agent/packages/app/src/components/session/session-run-history.tsx)。

边界：该页预览仅展示一种代表性布局；这里列出的所有状态应在实施时分别接入与验收，不把一张截图当成全部状态已实现。

### 17 上下文与用量

来源、上下文构成、预算与压缩入口，避免把估算当作结算。

状态设计：来源加载 / 预算估算 / 超限 / 压缩预览 / 权限限制。

来源定位：[packages/app/src/components/session/session-context-tab.tsx](E:/Arforge-Agent/packages/app/src/components/session/session-context-tab.tsx)。

边界：该页预览仅展示一种代表性布局；这里列出的所有状态应在实施时分别接入与验收，不把一张截图当成全部状态已实现。

### 18 目标与任务

目标生命周期、任务依赖、领取与完成；保留 revision 和权限检查。

状态设计：新目标 / 依赖等待 / 领取 / 执行 / 暂停 / 完成 / revision冲突。

来源定位：[packages/app/src/components/session/session-goal-control.tsx](E:/Arforge-Agent/packages/app/src/components/session/session-goal-control.tsx)、[packages/app/src/components/session/session-operations-dialog.tsx](E:/Arforge-Agent/packages/app/src/components/session/session-operations-dialog.tsx)。

边界：该页预览仅展示一种代表性布局；这里列出的所有状态应在实施时分别接入与验收，不把一张截图当成全部状态已实现。

### 19 待发送消息

FIFO 顺序、编辑、移除与投递状态，不混淆排队和立即引导。

状态设计：加载 / 空数据 / 无筛选结果 / 选中详情 / 分页 / 无权限 / 写入与冲突。

来源定位：[packages/app/src/components/session/session-prompt-queue-control.tsx](E:/Arforge-Agent/packages/app/src/components/session/session-prompt-queue-control.tsx)。

边界：该页预览仅展示一种代表性布局；这里列出的所有状态应在实施时分别接入与验收，不把一张截图当成全部状态已实现。

### 20 定时消息

时间、时区、错过执行及手动运行，危险操作维持现有空闲限制。

状态设计：加载 / 空数据 / 无筛选结果 / 选中详情 / 分页 / 无权限 / 写入与冲突。

来源定位：[packages/app/src/components/session/session-operations-dialog.tsx](E:/Arforge-Agent/packages/app/src/components/session/session-operations-dialog.tsx)。

边界：该页预览仅展示一种代表性布局；这里列出的所有状态应在实施时分别接入与验收，不把一张截图当成全部状态已实现。

### 21 触发器

触发配置、来源、事件结构、试运行与错误信息。

状态设计：加载 / 空数据 / 无筛选结果 / 选中详情 / 分页 / 无权限 / 写入与冲突。

来源定位：[packages/app/src/components/session/session-operations-dialog.tsx](E:/Arforge-Agent/packages/app/src/components/session/session-operations-dialog.tsx)。

边界：该页预览仅展示一种代表性布局；这里列出的所有状态应在实施时分别接入与验收，不把一张截图当成全部状态已实现。

### 22 协作等待

等待原因、来源与唤醒入口，不显示虚假的运行进度。

状态设计：空记录 / 当前锚点 / 历史来源 / 范围预览 / 忙碌限制。

来源定位：[packages/app/src/components/session/session-operations-dialog.tsx](E:/Arforge-Agent/packages/app/src/components/session/session-operations-dialog.tsx)。

边界：该页预览仅展示一种代表性布局；这里列出的所有状态应在实施时分别接入与验收，不把一张截图当成全部状态已实现。

### 23 团队与子代理

团队成员、隔离消息箱、子代理状态、跟进与取消。

状态设计：成员列表 / 隔离收件箱 / 等待输入 / 运行 / 跟进 / 取消。

来源定位：[packages/app/src/components/session/session-operations-dialog.tsx](E:/Arforge-Agent/packages/app/src/components/session/session-operations-dialog.tsx)。

边界：该页预览仅展示一种代表性布局；这里列出的所有状态应在实施时分别接入与验收，不把一张截图当成全部状态已实现。

### 24 检查点与对话回退

对话回退只归档后续消息，不撤销文件、命令、Git 或外部状态。

状态设计：空记录 / 当前锚点 / 历史来源 / 范围预览 / 忙碌限制。

来源定位：[packages/app/src/components/session/session-operations-dialog.tsx](E:/Arforge-Agent/packages/app/src/components/session/session-operations-dialog.tsx)。

边界：该页预览仅展示一种代表性布局；这里列出的所有状态应在实施时分别接入与验收，不把一张截图当成全部状态已实现。

### 25 会话反馈

类别、评分与说明；本地保存，保持凭据遮蔽边界。

状态设计：未填写 / 校验错误 / 保存中 / 保存失败 / 本地回执。

来源定位：[packages/app/src/components/session/session-feedback-control.tsx](E:/Arforge-Agent/packages/app/src/components/session/session-feedback-control.tsx)。

边界：该页预览仅展示一种代表性布局；这里列出的所有状态应在实施时分别接入与验收，不把一张截图当成全部状态已实现。

### 26 个人后台任务

批准、启动、暂停、恢复、取消、删除及通知已读。

状态设计：加载 / 空数据 / 无筛选结果 / 选中详情 / 分页 / 无权限 / 写入与冲突。

来源定位：[packages/app/src/components/session/session-personal-jobs-control.tsx](E:/Arforge-Agent/packages/app/src/components/session/session-personal-jobs-control.tsx)。

边界：该页预览仅展示一种代表性布局；这里列出的所有状态应在实施时分别接入与验收，不把一张截图当成全部状态已实现。

### 27 个人工作区

项目、Location、会话、任务、运行和后台工作统一视图。

状态设计：当前项目 / 最近项目 / 切换 / 副本预览 / 快照 / 删除确认。

来源定位：[packages/app/src/components/control-center/personal-workspace.tsx](E:/Arforge-Agent/packages/app/src/components/control-center/personal-workspace.tsx)。

边界：该页预览仅展示一种代表性布局；这里列出的所有状态应在实施时分别接入与验收，不把一张截图当成全部状态已实现。

### 28 系统概览

只读系统状态与安全入口，示例值不是当前运行诊断。

状态设计：连接正常示例 / 状态未知 / 服务失败 / 刷新中 / 部分可用。

来源定位：[packages/app/src/components/control-center/navigation.ts](E:/Arforge-Agent/packages/app/src/components/control-center/navigation.ts)。

边界：该页预览仅展示一种代表性布局；这里列出的所有状态应在实施时分别接入与验收，不把一张截图当成全部状态已实现。

### 29 模型服务商

连接、OAuth、API Key、凭据更新与移除，失败不丢表单。

状态设计：加载 / 空数据 / 无筛选结果 / 选中详情 / 分页 / 无权限 / 写入与冲突。

来源定位：[packages/app/src/components/settings-v2/providers.tsx](E:/Arforge-Agent/packages/app/src/components/settings-v2/providers.tsx)。

边界：该页预览仅展示一种代表性布局；这里列出的所有状态应在实施时分别接入与验收，不把一张截图当成全部状态已实现。

### 30 模型管理

搜索、能力筛选、可见性与当前选择，付费限制明确提示。

状态设计：加载 / 空数据 / 无筛选结果 / 选中详情 / 分页 / 无权限 / 写入与冲突。

来源定位：[packages/app/src/components/settings-v2/models.tsx](E:/Arforge-Agent/packages/app/src/components/settings-v2/models.tsx)。

边界：该页预览仅展示一种代表性布局；这里列出的所有状态应在实施时分别接入与验收，不把一张截图当成全部状态已实现。

### 31 服务器

本地、远程与 WSL 连接，保留身份、作用域和故障恢复。

状态设计：加载 / 空数据 / 无筛选结果 / 选中详情 / 分页 / 无权限 / 写入与冲突。

来源定位：[packages/app/src/components/settings-v2/servers.tsx](E:/Arforge-Agent/packages/app/src/components/settings-v2/servers.tsx)。

边界：该页预览仅展示一种代表性布局；这里列出的所有状态应在实施时分别接入与验收，不把一张截图当成全部状态已实现。

### 32 权限与安全

待处理请求与持久权限分开显示，单条撤销保持精确确认。

状态设计：加载 / 空数据 / 无筛选结果 / 选中详情 / 分页 / 无权限 / 写入与冲突。

来源定位：[packages/app/src/components/control-center/navigation.ts](E:/Arforge-Agent/packages/app/src/components/control-center/navigation.ts)。

边界：该页预览仅展示一种代表性布局；这里列出的所有状态应在实施时分别接入与验收，不把一张截图当成全部状态已实现。

### 33 记忆与学习

搜索、召回质量、候选审查、纠错、冲突和撤销保持完整。

状态设计：生效 / 候选 / 证据 / 冲突 / 纠错 / 撤销 / 无权限。

来源定位：[packages/app/src/components/control-center/capability-workbench.tsx](E:/Arforge-Agent/packages/app/src/components/control-center/capability-workbench.tsx)。

边界：该页预览仅展示一种代表性布局；这里列出的所有状态应在实施时分别接入与验收，不把一张截图当成全部状态已实现。

### 34 受控自主进化

候选、证据、评测、批准、灰度、回滚与暴露记录归档。

状态设计：未开始 / 等待依赖 / 运行 / 审批 / 失败重试 / 回滚。

来源定位：[packages/app/src/components/control-center/evolution-workbench.tsx](E:/Arforge-Agent/packages/app/src/components/control-center/evolution-workbench.tsx)。

边界：该页预览仅展示一种代表性布局；这里列出的所有状态应在实施时分别接入与验收，不把一张截图当成全部状态已实现。

### 35 运行时透视

上下文编译、路由、独立验证、审计与恢复审查。

状态设计：快照 / 路由依据 / 未验证 / 审计 / 恢复审批 / 来源不可用。

来源定位：[packages/app/src/components/control-center/runtime-insight-workbench.tsx](E:/Arforge-Agent/packages/app/src/components/control-center/runtime-insight-workbench.tsx)。

边界：该页预览仅展示一种代表性布局；这里列出的所有状态应在实施时分别接入与验收，不把一张截图当成全部状态已实现。

### 36 代理配置

保留已有自定义代理的可见性、配置入口和会话切换能力。

状态设计：加载 / 空数据 / 无筛选结果 / 选中详情 / 分页 / 无权限 / 写入与冲突。

来源定位：[packages/app/src/components/prompt-input-v2.tsx](E:/Arforge-Agent/packages/app/src/components/prompt-input-v2.tsx)、[packages/app/src/components/settings-v2/general.tsx](E:/Arforge-Agent/packages/app/src/components/settings-v2/general.tsx)。

边界：该页预览仅展示一种代表性布局；这里列出的所有状态应在实施时分别接入与验收，不把一张截图当成全部状态已实现。

### 37 技能

读取、路由、刷新、启停及候选评测、灰度、推广、回滚。

状态设计：加载 / 空数据 / 无筛选结果 / 选中详情 / 分页 / 无权限 / 写入与冲突。

来源定位：[packages/app/src/components/control-center/dialog-control-center.tsx](E:/Arforge-Agent/packages/app/src/components/control-center/dialog-control-center.tsx)。

边界：该页预览仅展示一种代表性布局；这里列出的所有状态应在实施时分别接入与验收，不把一张截图当成全部状态已实现。

### 38 插件

检查、安装、更新、启停、卸载与恢复分开确认。

状态设计：加载 / 空数据 / 无筛选结果 / 选中详情 / 分页 / 无权限 / 写入与冲突。

来源定位：[packages/app/src/components/control-center/dialog-control-center.tsx](E:/Arforge-Agent/packages/app/src/components/control-center/dialog-control-center.tsx)。

边界：该页预览仅展示一种代表性布局；这里列出的所有状态应在实施时分别接入与验收，不把一张截图当成全部状态已实现。

### 39 工作流

预览、启动、事件、控制、审批与重试，不跳过执行边界。

状态设计：未开始 / 等待依赖 / 运行 / 审批 / 失败重试 / 回滚。

来源定位：[packages/app/src/components/control-center/dialog-control-center.tsx](E:/Arforge-Agent/packages/app/src/components/control-center/dialog-control-center.tsx)。

边界：该页预览仅展示一种代表性布局；这里列出的所有状态应在实施时分别接入与验收，不把一张截图当成全部状态已实现。

### 40 MCP 与资源

连接状态、资源目录及会话引用；内部发现与对账不冒充普通按钮。

状态设计：加载 / 空数据 / 无筛选结果 / 选中详情 / 分页 / 无权限 / 写入与冲突。

来源定位：[packages/app/src/capabilities/ui-capability-review.ts](E:/Arforge-Agent/packages/app/src/capabilities/ui-capability-review.ts)。

边界：该页预览仅展示一种代表性布局；这里列出的所有状态应在实施时分别接入与验收，不把一张截图当成全部状态已实现。

### 41 诊断与运行报告

运行记录、诊断、质量评估、计划预览和 trace 导出。

状态设计：加载 / 空数据 / 无筛选结果 / 选中详情 / 分页 / 无权限 / 写入与冲突。

来源定位：[packages/app/src/components/control-center/capability-workbench.tsx](E:/Arforge-Agent/packages/app/src/components/control-center/capability-workbench.tsx)。

边界：该页预览仅展示一种代表性布局；这里列出的所有状态应在实施时分别接入与验收，不把一张截图当成全部状态已实现。

### 42 数据库与本地运维

安全运维说明、迁移要求、日志与恢复入口；不一键执行破坏性操作。

状态设计：健康未知 / 迁移阻塞 / 权限不足 / 日志脱敏 / 安全恢复。

来源定位：[packages/app/src/components/control-center/navigation.ts](E:/Arforge-Agent/packages/app/src/components/control-center/navigation.ts)。

边界：该页预览仅展示一种代表性布局；这里列出的所有状态应在实施时分别接入与验收，不把一张截图当成全部状态已实现。

### 43 开发者能力映射

按语义功能展示能力归属与边界，不为内部 API 增加多余按钮。

状态设计：加载 / 空数据 / 无筛选结果 / 选中详情 / 分页 / 无权限 / 写入与冲突。

来源定位：[packages/app/src/capabilities/control-center-map.ts](E:/Arforge-Agent/packages/app/src/capabilities/control-center-map.ts)。

边界：该页预览仅展示一种代表性布局；这里列出的所有状态应在实施时分别接入与验收，不把一张截图当成全部状态已实现。

### 44 数据与租户治理

政策、数据申请、批准、备份、验证、审计导出和密钥撤销。

状态设计：加载 / 空数据 / 无筛选结果 / 选中详情 / 分页 / 无权限 / 写入与冲突。

来源定位：[packages/app/src/components/control-center/governance-workbench.tsx](E:/Arforge-Agent/packages/app/src/components/control-center/governance-workbench.tsx)、[packages/app/src/capabilities/control-center-map.ts](E:/Arforge-Agent/packages/app/src/capabilities/control-center-map.ts)。

边界：该页预览仅展示一种代表性布局；这里列出的所有状态应在实施时分别接入与验收，不把一张截图当成全部状态已实现。

### 45 产物与审计证据

目录、归属与审计证据，不将受鉴权字节读取变成任意路径打开。

状态设计：加载 / 空数据 / 无筛选结果 / 选中详情 / 分页 / 无权限 / 写入与冲突。

来源定位：[packages/app/src/components/control-center/artifact-evidence-workbench.tsx](E:/Arforge-Agent/packages/app/src/components/control-center/artifact-evidence-workbench.tsx)。

边界：该页预览仅展示一种代表性布局；这里列出的所有状态应在实施时分别接入与验收，不把一张截图当成全部状态已实现。

### 46 通用与外观设置

语言、字体、主题、显示、Shell、通知、声音、更新与引导。

状态设计：缺省 / 已有偏好 / 即时预览 / 保存失败 / 迁移 / 限定重置。

来源定位：[packages/app/src/components/settings-v2/general.tsx](E:/Arforge-Agent/packages/app/src/components/settings-v2/general.tsx)、[packages/app/src/context/settings.tsx](E:/Arforge-Agent/packages/app/src/context/settings.tsx)。

边界：该页预览仅展示一种代表性布局；这里列出的所有状态应在实施时分别接入与验收，不把一张截图当成全部状态已实现。

### 47 快捷键

现有绑定优先；搜索、修改、冲突提示与恢复默认。

状态设计：加载 / 空数据 / 无筛选结果 / 选中详情 / 分页 / 无权限 / 写入与冲突。

来源定位：[packages/app/src/components/settings-keybinds.tsx](E:/Arforge-Agent/packages/app/src/components/settings-keybinds.tsx)。

边界：该页预览仅展示一种代表性布局；这里列出的所有状态应在实施时分别接入与验收，不把一张截图当成全部状态已实现。

### 48 首次启动引导

连接服务器、模型与项目；可稍后完成并从设置重新进入。

状态设计：未开始 / 部分完成 / 连接失败 / 已有配置 / 稍后继续。

来源定位：[packages/app/src/components/onboarding/home-first-run-guide.tsx](E:/Arforge-Agent/packages/app/src/components/onboarding/home-first-run-guide.tsx)。

边界：该页预览仅展示一种代表性布局；这里列出的所有状态应在实施时分别接入与验收，不把一张截图当成全部状态已实现。

### 49 空白、加载与异常

启动、重连、数据库迁移、空数据、无权限、保存冲突、额度与更新。

状态设计：全局加载 / 空数据 / 离线 / 认证 / 权限 / 冲突 / 迁移 / 更新。

来源定位：[packages/app/src/app.tsx](E:/Arforge-Agent/packages/app/src/app.tsx)、[packages/app/src/components/route-loading-fallback.tsx](E:/Arforge-Agent/packages/app/src/components/route-loading-fallback.tsx)。

边界：该页预览仅展示一种代表性布局；这里列出的所有状态应在实施时分别接入与验收，不把一张截图当成全部状态已实现。

### 50 弹窗、菜单与选择器

命令、项目、模型、MCP、服务商、分享、分支、发布说明等入口完整保留。

状态设计：打开 / 关闭 / 取消 / 提交 / 失败保留 / 作用域确认。

来源定位：[packages/app/src/components](E:/Arforge-Agent/packages/app/src/components)。

边界：该页预览仅展示一种代表性布局；这里列出的所有状态应在实施时分别接入与验收，不把一张截图当成全部状态已实现。

### 51 审批与提问

权限、问题、操作影响和恢复回执，当前作用域始终可见。

状态设计：待处理 / 允许一次 / 持久策略 / 拒绝 / 过期 / 已处理。

来源定位：[packages/app/src/components/control-approval/control-approval-center.tsx](E:/Arforge-Agent/packages/app/src/components/control-approval/control-approval-center.tsx)、[packages/app/src/capabilities/ui-capability-review.ts](E:/Arforge-Agent/packages/app/src/capabilities/ui-capability-review.ts)。

边界：该页预览仅展示一种代表性布局；这里列出的所有状态应在实施时分别接入与验收，不把一张截图当成全部状态已实现。

### 52 完整内容排版

标题、段落、引用、有序/无序列表、代码、表格、数学与链接。

状态设计：所有Markdown内容 / 长行 / 嵌套 / 首尾 / 深色 / 放大。

来源定位：[docs/ui-redesign/2026-09-21-ui-planning-baseline.md](E:/Arforge-Agent/docs/ui-redesign/2026-09-21-ui-planning-baseline.md)。

边界：该页预览仅展示一种代表性布局；这里列出的所有状态应在实施时分别接入与验收，不把一张截图当成全部状态已实现。

### 53 手机 Web 会话

单列阅读、抽屉导航、固定工具栏与安全区域适配。

状态设计：草稿 / 发送中 / 流式 / 向上阅读 / 已完成 / 工具审批 / 失败重试。

来源定位：[packages/app/src/app.tsx](E:/Arforge-Agent/packages/app/src/app.tsx)。

边界：该页预览仅展示一种代表性布局；这里列出的所有状态应在实施时分别接入与验收，不把一张截图当成全部状态已实现。

### 54 手机历史预览

轻点刻度预览，再明确跳转；关闭按钮、点外部或成功跳转后收起。

状态设计：草稿 / 发送中 / 流式 / 向上阅读 / 已完成 / 工具审批 / 失败重试。

来源定位：[docs/ui-redesign/2026-09-21-ui-planning-baseline.md](E:/Arforge-Agent/docs/ui-redesign/2026-09-21-ui-planning-baseline.md)。

边界：该页预览仅展示一种代表性布局；这里列出的所有状态应在实施时分别接入与验收，不把一张截图当成全部状态已实现。

### 55 窄窗口工作区

聊天与文件通过单个主面板切换，避免挤成两列窄内容。

状态设计：临时预览 / 固定标签 / dirty / 只读 / 保存冲突 / 空树 / 加载失败。

来源定位：[packages/app/src/pages/session/session-side-panel.tsx](E:/Arforge-Agent/packages/app/src/pages/session/session-side-panel.tsx)。

边界：该页预览仅展示一种代表性布局；这里列出的所有状态应在实施时分别接入与验收，不把一张截图当成全部状态已实现。

### 56 桌面标题栏与原生菜单

Windows / macOS 各自遵循平台窗口与菜单行为，保留缩放、多窗口及日志导出。

状态设计：Windows / macOS / Web能力差异 / 快捷键冲突 / 多窗口。

来源定位：[packages/app/src/desktop-menu.ts](E:/Arforge-Agent/packages/app/src/desktop-menu.ts)。

边界：该页预览仅展示一种代表性布局；这里列出的所有状态应在实施时分别接入与验收，不把一张截图当成全部状态已实现。

### 57 模型选择器

已确认规则整合：服务商分组、搜索、当前会话切换与焦点恢复。

状态设计：草稿 / 发送中 / 流式 / 向上阅读 / 已完成 / 工具审批 / 失败重试。

来源定位：[packages/app/src/components/prompt-input-v2.tsx](E:/Arforge-Agent/packages/app/src/components/prompt-input-v2.tsx)。

边界：该页预览仅展示一种代表性布局；这里列出的所有状态应在实施时分别接入与验收，不把一张截图当成全部状态已实现。

### 58 深色模型选择器

已确认交互不变，深色控件颜色属于待审建议。

状态设计：草稿 / 发送中 / 流式 / 向上阅读 / 已完成 / 工具审批 / 失败重试。

来源定位：[packages/app/src/components/prompt-input-v2.tsx](E:/Arforge-Agent/packages/app/src/components/prompt-input-v2.tsx)。

边界：该页预览仅展示一种代表性布局；这里列出的所有状态应在实施时分别接入与验收，不把一张截图当成全部状态已实现。

### 59 模型搜索无结果

保留搜索词与当前模型，提供清空搜索及配置入口。

状态设计：草稿 / 发送中 / 流式 / 向上阅读 / 已完成 / 工具审批 / 失败重试。

来源定位：[packages/app/src/components/prompt-input-v2.tsx](E:/Arforge-Agent/packages/app/src/components/prompt-input-v2.tsx)。

边界：该页预览仅展示一种代表性布局；这里列出的所有状态应在实施时分别接入与验收，不把一张截图当成全部状态已实现。

### 60 模型不可用与恢复

保留当前选择，不静默降级；显示原因和重试入口。

状态设计：草稿 / 发送中 / 流式 / 向上阅读 / 已完成 / 工具审批 / 失败重试。

来源定位：[packages/app/src/components/prompt-input-v2.tsx](E:/Arforge-Agent/packages/app/src/components/prompt-input-v2.tsx)。

边界：该页预览仅展示一种代表性布局；这里列出的所有状态应在实施时分别接入与验收，不把一张截图当成全部状态已实现。

### 61 全局搜索

会话、文件和命令分类检索，保留来源与键盘入口。

状态设计：未输入 / 搜索中 / 分类 / 无结果 / 权限过滤 / 键盘定位。

来源定位：[packages/app/src/components/prompt-input-v2.tsx](E:/Arforge-Agent/packages/app/src/components/prompt-input-v2.tsx)、[packages/app/src/context/settings.tsx](E:/Arforge-Agent/packages/app/src/context/settings.tsx)。

边界：该页预览仅展示一种代表性布局；这里列出的所有状态应在实施时分别接入与验收，不把一张截图当成全部状态已实现。

### 62 项目与工作区切换

显示服务器与目录作用域，切换不修改模型全局偏好。

状态设计：当前 / 最近 / 未连接 / 目录不可用 / 切换保护 / 权限。

来源定位：[packages/app/src/app.tsx](E:/Arforge-Agent/packages/app/src/app.tsx)。

边界：该页预览仅展示一种代表性布局；这里列出的所有状态应在实施时分别接入与验收，不把一张截图当成全部状态已实现。

### 63 触屏模型选择器

触屏底部面板为待审建议；保留搜索、分组与完整模型信息。

状态设计：草稿 / 发送中 / 流式 / 向上阅读 / 已完成 / 工具审批 / 失败重试。

来源定位：[packages/app/src/components/prompt-input-v2.tsx](E:/Arforge-Agent/packages/app/src/components/prompt-input-v2.tsx)。

边界：该页预览仅展示一种代表性布局；这里列出的所有状态应在实施时分别接入与验收，不把一张截图当成全部状态已实现。

### 64 深色设置

统一深色表单层次，保留已有偏好及所有设置入口。

状态设计：缺省 / 已有偏好 / 即时预览 / 保存失败 / 迁移 / 限定重置。

来源定位：[packages/app/src/components/settings-v2/general.tsx](E:/Arforge-Agent/packages/app/src/components/settings-v2/general.tsx)。

边界：该页预览仅展示一种代表性布局；这里列出的所有状态应在实施时分别接入与验收，不把一张截图当成全部状态已实现。


## 4. 详细实体字段与动作边界

### 会话搜索与管理

列表列：会话、项目、状态、最近活动。

详情 / 表单字段：名称、所属项目、标签、固定 / 归档、分享状态。

风险与保留规则：删除、分享、回退分别显示影响范围；分支不覆盖原会话。

### 待发送消息

列表列：待发送内容、投递状态、顺序、操作说明。

详情 / 表单字段：消息正文、附件与引用、绑定模型、FIFO 位置、投递回执。

风险与保留规则：编辑保留原位置；移除仅影响选中条目。已提交模型绑定不因输入框切换而暗改。

### 定时消息

列表列：定时消息、计划时间、时区 / 限制、状态。

详情 / 表单字段：名称、消息正文、一次性 / Cron、时区、错过执行策略、启停状态、模型绑定。

风险与保留规则：手动运行遵循当前忙碌限制；保存显示下一次触发时间，校验失败不清空表单。

### 触发器

列表列：触发器、条件、作用域、状态。

详情 / 表单字段：名称、来源类型、条件 / JSON、目标会话、模板与模型、启停状态。

风险与保留规则：试运行先展示事件与作用域；凭据遮蔽，重复事件按原机制去重。

### 个人后台任务

列表列：任务、状态、运行范围、下一步。

详情 / 表单字段：名称、工作区、任务描述、批准记录、运行策略、通知偏好。

风险与保留规则：批准、启动、暂停、恢复、取消、删除不同按钮与回执；不以删除代替取消。

### 模型服务商

列表列：服务商、认证方式、凭据说明、状态。

详情 / 表单字段：显示名称、服务商类型、API 地址、API Key / OAuth、模型目录、连接诊断。

风险与保留规则：秘密默认遮蔽，不写入 URL / 日志；连接失败保留非敏感输入。移除显示受影响模型。

### 模型管理

列表列：模型、能力、服务商、状态。

详情 / 表单字段：显示名称、原始 ID、来源服务商、能力标签、可见性、默认设置。

风险与保留规则：可见性不等于删除配置；当前会话选择与新会话默认分开。不可用原因不得隐藏。

### 服务器

列表列：服务器、连接方式、状态、说明。

详情 / 表单字段：名称、本地 / 远程 / WSL、地址、身份与凭据、连接结果、工作区范围。

风险与保留规则：切换服务器隔离缓存、草稿与异步结果；不把另一个服务器响应写入当前会话。

### 权限与安全

列表列：权限对象、作用域、状态、策略。

详情 / 表单字段：请求来源、目标资源、动作、仅本次 / 持久、到期 / 撤销、审计依据。

风险与保留规则：默认不扩权；允许一次、拒绝、持久规则分开。撤销仅作用于明确规则。

### 代理配置

列表列：代理、来源、可用性、说明。

详情 / 表单字段：名称、来源配置、说明、能力边界、可见性。

风险与保留规则：保留现有自定义代理配置和切换机制，不凭预览新增跨作用域代理。

### 技能

列表列：技能、来源、状态、操作边界。

详情 / 表单字段：名称与版本、来源、内容、路由、权限、评测证据、启停 / 生命周期。

风险与保留规则：启用、更新、推广与回滚分别确认；候选不是已经生效的技能。

### 插件

列表列：插件、版本状态、启用状态、下一步。

详情 / 表单字段：名称与版本、安装来源、权限清单、更新差异、生命周期、审计。

风险与保留规则：安装 / 更新 / 卸载 / 恢复预览影响；网络与文件权限不能被外观重构绕过。

### MCP 与资源

列表列：资源、连接来源、状态、操作。

详情 / 表单字段：服务名称、连接配置、授权状态、资源目录、工具描述、会话引用。

风险与保留规则：展示经过鉴权的资源；内部发现、协调和事务接口不直接暴露成普通执行按钮。

### 诊断与运行报告

列表列：诊断项目、输入类型、状态、范围。

详情 / 表单字段：诊断模式、目录 / 文件、问题描述、运行 ID、trace / 报告、证据。

风险与保留规则：显式选择范围后运行；未启动与未验证不能显示通过。日志导出说明可能包含的敏感信息。

### 开发者能力映射

列表列：语义能力、入口、风险等级、保留策略。

详情 / 表单字段：能力标识、归属界面、读写风险、来源、验证证据。

风险与保留规则：内部 transport 能力不新增入口；映射覆盖不是回归测试通过。

### 数据与租户治理

列表列：治理对象、作用域、状态、下一步。

详情 / 表单字段：租户 / 工作区、政策、申请与批准、备份校验、密钥元数据、审计范围。

风险与保留规则：数据删除、恢复、密钥撤销显示精确对象和不可逆影响；不默认勾选整租户。

### 产物与审计证据

列表列：产物、归属、类型、访问边界。

详情 / 表单字段：名称、来源会话 / 运行、内容类型、访问权限、回执、审计证据。

风险与保留规则：仅通过鉴权适配器读取；不接受任意磁盘路径，不绕过受限产物权限。

### 快捷键

列表列：动作、快捷键、作用域、行为。

详情 / 表单字段：动作、键位、全局 / 局部、冲突、恢复范围。

风险与保留规则：已配置绑定优先；IME 组词不发送。覆盖冲突前明确确认，重置不影响账号与会话。


## 5. 其他复杂页面字段

| 页面 | 必须保留的信息与输入 |
| --- | --- |
| 目标与任务 | 目标文本、生命周期、任务依赖、负责人 / 领取、修订号、完成证据 |
| 团队与子代理 | 成员身份、子代理状态、任务依赖、隔离消息箱、跟进正文、取消范围 |
| 检查点与对话回退 | 检查点名称、消息锚点、创建时间、后续消息范围、回退预览、确认回执 |
| 会话反馈 | 反馈类别、评分、说明、附带上下文范围、敏感信息遮蔽、本地保存状态 |
| 记忆与学习 | 内容、来源证据、归属作用域、候选 / 生效、冲突对照、纠错 / 撤销 |
| 受控自主进化 | 候选、证据、隔离评测、批准、灰度暴露、回滚与审计 |
| 工作流 | 输入、依赖、步骤、事件、审批、重试与回执 |
| 运行时透视 | 上下文来源、路由依据、编译快照、验证证据、审计链、恢复范围 |
| 个人工作区 | 项目目录、Location、项目副本、会话、任务 / 运行、快照范围 |
| 数据库与本地运维 | 本地服务状态、数据库版本、迁移要求、脱敏日志、恢复说明、权限边界 |
| 上下文与用量 | 模型上下文预算、消息来源、文件与引用、估算依据、压缩预览、用量口径 |
| 执行详情 | 运行 ID、步骤状态、工具输入、完整输出、耗时、停止目标 |
| 协作等待 | 等待原因、来源对象、唤醒条件、最近事件、手动唤醒、回执 |


## 6. 29 条语义能力映射记录

这里统计的是映射记录，不是29项互不重复的功能；同一feature可以有不同风险层级。映射覆盖不等于测试通过。

| 归属 | 语义能力 | 风险 | 对应预览 |
| --- | --- | --- | --- |
| global-control-center | system-overview | read | 系统概览 |
| global-control-center | providers-models-integrations | write | 模型服务商、模型管理 |
| global-control-center | saved-permission-governance | confirm | 权限与安全、审批与提问 |
| global-control-center | memory-learning-governance | preview-confirm | 记忆与学习、受控自主进化 |
| global-control-center | experience-and-skill-lifecycle-governance | confirm | 技能、受控自主进化 |
| global-control-center | agent-diagnostics-and-runs | read | 诊断与运行报告、执行详情 |
| global-control-center | runtime-insight | read | 运行时透视 |
| global-control-center | artifact-receipts-and-audit | read | 产物与审计证据 |
| global-control-center | runtime-insight-recovery-review | confirm | 运行时透视、审批与提问 |
| global-control-center | mcp-capability-observability | read | MCP 与资源、开发者能力映射 |
| global-control-center | mcp-action-reconciliation-observability | read | 开发者能力映射 |
| global-control-center | mcp-action-reconciliation-maintenance | confirm | 开发者能力映射、数据库与本地运维 |
| global-control-center | workflow-plugin-skill-mcp | preview-confirm | 工作流、插件、技能、MCP 与资源 |
| global-control-center | experience-and-skill-lifecycle-governance | read | 技能、受控自主进化 |
| global-control-center | project-copies | preview-confirm | 个人工作区、弹窗、菜单与选择器 |
| global-control-center | private-operations-overview | read | 数据库与本地运维 |
| global-control-center | tenant-platform-observability | read | 数据与租户治理 |
| global-control-center | tenant-platform-data-governance | preview-confirm | 数据与租户治理 |
| global-control-center | tenant-platform-secret-governance | confirm | 数据与租户治理 |
| session-control-center | session-lifecycle-and-recovery | preview-confirm | 会话搜索与管理、待发送消息、检查点与对话回退 |
| session-control-center | goal-lifecycle | write | 目标与任务 |
| session-control-center | schedule-task-trigger-wait | confirm | 定时消息、触发器、协作等待、目标与任务 |
| session-control-center | team-and-subagent | confirm | 团队与子代理 |
| session-control-center | personal-background-jobs | read | 个人后台任务 |
| session-control-center | personal-background-jobs | preview-confirm | 个人后台任务 |
| session-control-center | permission-question-settlement | write | 审批与提问 |
| workspace-surface | files-commands-terminal-references | write | 文件工作台、会话内终端、弹窗、菜单与选择器 |
| workspace-surface | workspace-snapshots | preview-confirm | 个人工作区 |
| transport-internal | streaming-pagination-and-session-transaction | internal | 开发者能力映射 |


## 7. 所有页面共同保留项

- 当前服务器、工作区、会话及对象来源可追溯，不跨范围覆盖状态。
- 既有导航、链接、快捷键、菜单和适用的平台能力有明确去向。
- 读、写、确认、预览后确认和内部能力不能被一种通用按钮混同。
- 加载、空数据、筛选无结果、失败、部分失败、无权限与过期分别表达。
- 表单校验、保存中、重复提交保护、revision冲突、错误保留和回执完整。
- 受限资源通过原鉴权适配器读取；秘密不进入URL、截图数据或日志。
- 触屏与键盘能到达动作；可见性不能依赖鼠标悬停。
- 用户偏好、系统缩放、草稿、选区、滚动锚点和未保存文件不因换布局丢失。
- 真实状态由业务回执驱动，不能用预览示例冒充运行成功。
- 跨端差异明确说明，不用假按钮表示未支持能力。

## 8. 列表与表单统一策略

列表使用稳定ID和来源范围，异步筛选不让旧结果覆盖新条件。分页或虚拟化保留选中对象及键盘锚点。显示名变化不能改变唯一身份。

编辑时区分服务端初值、本地dirty字段和提交快照。关闭有未保存修改的弹窗先确认。保存失败保留输入，服务端返回字段错误映射到对应输入；不能只在页面角落弹一个无法定位的问题。

批量操作必须列明选中对象、隐藏项是否包含、作用域和不可逆影响。部分成功时只重试失败项。危险动作的默认焦点优先安全选项，不能把“点击外部”当作批准。

## 9. 安装、性能与运行验收排除

本轮没有启动或修复实际桌面 / CLI 服务，没有执行数据库迁移，没有改动业务源码，没有运行应用测试或静态检查。64 个画面是设计审查材料，不是64条测试通过。

30倍极限压力问题仍未完成。安装包验收按用户决定继续暂缓。Office预览与原生Office分页一致性没有被验证。

## 10. 审查记录模板

| 页面 / P编号 | 当前建议 | 用户意见 | 最终决定 | 是否批准实施 |
| --- | --- | --- | --- | --- |
| 待填写 | 见V2预览与矩阵 | 待审 | 未定 | 否 |
| 已确认项 | 保留原决定 | 仅发生冲突时提出 | 以确认记录为准 | 本轮仍不实施 |


可以集中反馈布局、颜色、尺寸和操作规则；不再要求先回答完所有微小数值才能看完整稿。设计修改与应用实施批准仍是两个独立步骤。

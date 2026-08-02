# Arforge 前后端能力映射合同（方案 B）

状态：已批准，实施基线  
版本：1.2
最后更新：2026-08-02

## 1. 目标

Arforge 不采用“一个 HTTP endpoint 对应一个按钮”的机械映射。产品采用两级信息架构，并以用户可理解、可验证的语义闭环作为映射单位：

1. **设置 > Arforge**：跨会话、跨工作区或属于产品治理的能力；不再创建第二个独立设置窗口。
2. **设置 > Session**：只影响当前会话聚合根的 Goal、Task、Prompt Queue、Schedule、Trigger、Wait、Team 和 Checkpoint；不再创建独立大窗口。

每个公开 Server API 必须被登记为下列一种归属：

- `global-control-center`：全局控制中心直接展示或操作。
- `session-control-center`：当前会话控制中心直接展示或操作。
- `workspace-surface`：文件树、终端、模型选择器、消息时间线等已有工作区界面承担。
- `transport-internal`：SSE、分页取数、单项读取、请求编排等内部协议；不得伪装成用户按钮。

`packages/app/src/capabilities/control-center-map.ts` 是机器可读的唯一登记源。测试必须保证当前生成客户端的全部方法均被登记且只登记一次。

## 2. 全局控制中心

全局能力以“设置”窗口中的 `Arforge` 分组呈现。标题栏、命令面板和桌面菜单中的 Arforge 入口都必须打开同一设置窗口，并默认定位到“系统概览”。分组内页面切换只能更新当前设置页，不得嵌套打开第二个设置对话框。导航栏和内容区分别滚动，长列表不得覆盖版本信息或造成横向溢出。

| 分区                 | 用户语义                                                        | 主要后端能力                                             | 安全边界                                     |
| -------------------- | --------------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------- |
| 系统概览             | 当前 Server、工作区、Agent 能力健康与可用性                     | health/location/agents/agentCapabilities.health/list     | 只读                                         |
| Provider / 模型      | Provider、模型、集成连接与凭据生命周期                          | providers/models/integrations/credentials                | 删除凭据二次确认                             |
| 权限 / 安全          | 待处理请求、已保存权限规则、规则撤销                            | permissions.listRequests/listSaved/removeSaved           | 撤销规则二次确认                             |
| Memory / Learning    | 列表、关键词/语义检索、facets、质量、编辑、批量删除、治理       | memories._、learning._                                   | 批量删除及治理应用二次确认                   |
| Workflow / 自动化    | Workflow 定义、预检、运行、运行详情、暂停/恢复/取消、审批/重试  | agentCapabilities.workflow\*                             | fullAccess 明示；取消二次确认                |
| Plugin / Skill / MCP | 插件预检/安装/恢复、Skill 开关/刷新、MCP 连接                   | agentCapabilities.plugin*/skill*、skills、mcp            | 安装先预检；删除保留 recovery ID             |
| 诊断 / 运行报告      | 多模态诊断、质量门禁、Repo Scale、持久运行报告                  | diagnostics、qualityAssess、repoScale、runList/runReport | 只读或显式触发                               |
| 私有运维             | Doctor、Stats、凭据扫描、日志保留、PostgreSQL 备份/恢复演练状态 | CLI 私有运维命令                                         | 首阶段只读说明；破坏性操作不得从普通按钮直达 |

## 3. 会话控制中心

会话能力以“设置”窗口中的 `Session` 分组呈现。只有当前路由存在有效 Session ID 时页面才可操作；无活动会话时，导航必须显示不可用状态和原因。会话标题栏入口统一打开“设置 > Session > Goal / Task”。页面使用设置窗口的垂直导航，不再使用横向页签加锚点滚动，也不得在设置窗口上再次叠加完整控制中心对话框。

| 分区                      | 用户闭环                                         |
| ------------------------- | ------------------------------------------------ |
| Goal / Task               | 创建、排队、领取、更新、完成、阻塞、取消、清理   |
| Prompt Queue              | 查看、改写、删除、调整顺序，并与当前发送状态一致 |
| Schedule / Trigger / Wait | 新建、详情、编辑、立即运行、错过补跑、唤醒       |
| Team / Subagent           | 团队、成员、消息、关闭请求                       |
| Checkpoint / Rewind       | 创建检查点、预览回退影响、确认应用               |

Python Core 的 `run.list / run.report` 当前以工作区持久化目录为边界，报告结构没有 `sessionID`，因此归全局控制中心的“诊断 / 运行报告”，不得在界面上伪装成当前会话的运行历史。未来只有在后端报告模型持久化并校验 `sessionID` 后，才允许增加会话过滤入口。

## 4. 高风险交互合同

1. 删除、撤销、取消、批量操作必须明确显示目标和影响范围。
2. 可预览的操作必须先预览再应用；预览 token 或 revision 不得由界面伪造。
3. `clear-data`、数据库恢复和日志实际删除不进入普通控制中心按钮；必须经过专用管理模式、再次认证、备份检查和最终确认。
4. Renderer 不得直接访问本机文件、数据库或子进程；桌面本机能力只能通过 preload 暴露的 `window.api` 和主进程 IPC。
5. 所有错误必须转为可操作的公开信息，不显示密钥、连接串或内部堆栈。

## 5. 验收条件

1. 生成客户端的所有公开方法在能力登记中覆盖率为 100%，重复归属为 0。
2. 全局入口同时存在于命令面板、桌面菜单和新版标题栏，且统一打开“设置 > Arforge > 系统概览”。
3. 全局控制中心在没有活动会话时仍能打开；会话控制中心只操作当前 session ID。
4. 已保存权限规则可查看并撤销。
5. Memory 支持语义检索、facets、recall quality、详情/编辑与批量删除。
6. Schedule、Task、Trigger 和 Workflow 具备详情与更新路径，不再依赖不可验证的自由 JSON 作为唯一交互。
7. 所有新增组件通过单元测试、类型检查和生产构建。
8. 桌面端只在用户批准后重启，并进行真实点击验收。
9. Arforge 分组中的工作区解析提供加载、失败和重试反馈；页面内部跳转不得创建嵌套对话框。
10. Session 分组在当前会话上下文中提供 6 个可理解的页面；加载、保存、失败、空状态和运行中限制均有可见反馈。
11. Goal、Task 和 Prompt Queue 编辑使用设置页内表单完成，不依赖系统 Prompt；取消编辑不会提交变更。

## 6. 明确不做的错误映射

- 不为 SSE subscribe、cursor、分页加载、单条 GET、内部 wait transport 创建独立按钮。
- 不把 CLI 破坏性命令包装成“一键清理”。
- 不把“页面上出现 capability 名称”当成能力已映射；必须能完成查看或操作闭环。
- 不通过 `any` 或原始 bridge method 字符串绕过 typed Server API。

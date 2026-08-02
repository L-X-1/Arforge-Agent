# Arforge-Agent 融合工作清单

## 状态定义

- `verified`：当前证据可证明行为存在。
- `migrating`：目标包已引入，纵向适配尚未完成。
- `pending`：尚未开始。
- `retired`：等价能力、数据恢复和所有者批准后已退役。

## 工作区

| 项目 | 状态 | 证据 / 下一步 |
| --- | --- | --- |
| Python 特色核心 | verified | `arforge/`、`tests/` |
| Bun/TypeScript 包工作区 | verified | 当前源框架 4,914 个非许可文件逐文件对账：4,696 个 SHA-256 一致、174 个深度融合修改、44 个按范围明确排除 |
| 统一开发命令 | verified | 根 `package.json` 统一提供 TypeScript、Desktop、Web 与 Python 命令；工作区 23/23 类型检查任务通过 |
| 原目录运行依赖为零 | verified | 4,687 个依赖重解析点、Junction 和运行进程均已审计为 0；Desktop、CLI、Server 和 Python 能力引擎都从当前工程解析 |

## 产品入口

| 项目 | 状态 | 证据 / 下一步 |
| --- | --- | --- |
| Python CLI 产品入口 | retired | 特色 Python 能力保留在受限能力服务，旧产品启动器已移入回收站 |
| TypeScript CLI/TUI | verified | 会话、Goal、Task、Prompt Queue、Workflow、Plugin、Skill 和私人运维命令均进入统一入口 |
| Tauri Desktop | retired | 独有行为完成归属与界面可达性门禁后，旧产品壳已移入回收站 |
| Electron Desktop | verified | `packages/desktop` 已完成真实启动、会话、模型流式响应、CLI 同库和生产构建验收；发布安装包不在本阶段范围 |
| Web App | verified | `packages/app` 通过生成 SDK 使用同一 Server/Core 能力和身份契约 |
| VS Code / JetBrains | verified | 现有 Bridge 1.2；后续切统一协议 |

## 核心域

| 域 | 最终权威 | 状态 | 冲突处理 |
| --- | --- | --- | --- |
| Session/Event | TypeScript Core | verified | Python 禁止独立产品会话双写 |
| Permission | TypeScript Core | verified | Python 管理边界受显式 allowlist 限制，产品写操作归 Core |
| Tool Registry | TypeScript Core | verified | 当前代理权限下的统一工具目录已进入 CLI/TUI/Agent Loop |
| Multi-agent/Team | 共享会话 + Python 能力 | verified | Team、mailbox、wait/wake 和子代理都绑定统一会话 |
| Memory/Learning | 共享契约 + Python 算法 | verified | PostgreSQL 单写、显式工作区/全局作用域 |
| Eval/Dogfood | Python 能力 | verified | 结果作为类型化诊断事件 |
| Auth/Session Cookie | Server | verified | 桌面、本地 CLI 和私有 HTTPS 共用 |
| PostgreSQL | 统一数据库层 | verified | 主库 48 表并包含 3 张 Workflow Graph 表；独立 `arforge_ma` 保留 23 条任务和 48 条对话。两库应用角色最小权限、备份、隔离恢复和旧 SQLite 空数据指纹复核均通过 |

## 完成前硬门槛

- [x] Python 基线回归有新鲜结果。
- [x] 所有迁入 TypeScript 包完成依赖安装。
- [x] Core/Server/CLI/App/Desktop 类型检查通过。
- [x] 特色能力至少完成一个端到端纵向切片。
- [x] CLI 与桌面针对同一会话行为一致。
- [x] PostgreSQL 备份恢复演练通过。
- [x] 无原工程绝对路径或 Junction 运行依赖。
- [x] 品牌与来源审计通过。
- [x] 旧 Tauri/Python 产品入口完成逐项等价证据、所有者审批和可恢复退役。

## 新鲜验证记录

- 2026-07-27：Bun `1.3.14` 安装成功，1,672 个包可由本工程锁文件解析。
- 2026-07-27：Core、Server、CLI、App、Desktop 五个关键包类型检查通过。
- 2026-07-27：根工作区类型检查 `23 successful / 23 total`，覆盖全部参与
  TypeScript 包；旧 Tauri Desktop 独立类型检查同时通过。
- 2026-07-27：`packages/agent-python` 类型检查通过，真实 Bridge 1.2 回归
  `3 passed / 0 failed`，并验证运行时根与任意工作区分离。
- 2026-07-27：Core 作用域服务真实调用 Python `health` 和
  `capabilities.list`，回归 `1 passed / 0 failed`，并验证子进程自动回收。
- 2026-07-27：Server 的两个受保护能力端点、生成式 JavaScript SDK、Web App
  能力面板和 `arforge capabilities --json` 形成第一条端到端纵向切片；
  新端点在 HTTP exerciser 的覆盖、Effect 与鉴权模式均通过。
- 2026-07-27：产品版本统一为运行时 `1.0.0-test.1` / Python 分发
  `1.0.0.dev1`，Cargo 锁定元数据、Python Bridge 与桌面版本契约通过。
- 2026-07-27：修复“失败校验后清理临时助手却跳过复验”的自纠回归；
  12/12 self-correct 契约通过。
- 2026-07-27：Python 产品桥接、会话、扩展、桌面入口、桌面版本与文档
  分片回归 `98 passed / 0 failed`。
- 2026-07-27：第一次 Python 全量基线超过十分钟且原命令输出通道超时，
  不能据此宣称通过；后续改为可留存结果的分片回归。
- 2026-07-27：真实 Electron Desktop 修复了 Bun 专用 `import.meta.dir` 在
  Node Sidecar 中变为 `undefined` 的启动故障；开发环境由桌面入口显式传入
  `ARFORGE_AGENT_RUNTIME_ROOT`，Sidecar 已达到 `server ready`。
- 2026-07-27：补齐共享 `/api/mcp`、资源目录、连接和断开协议，实际 Server
  回归 `6 passed / 0 failed / 32 assertions`；修复后桌面冷加载无 HTTP 失败、
  无非取消网络失败、无控制台错误。
- 2026-07-27：在真实桌面会话使用 `DeepSeek V4 Pro` 发送最小消息，模型在
  1 秒内返回 `Arforge模型链路正常`；全程无 HTTP 4xx/5xx、网络失败或控制台错误。
- 2026-07-27：桌面开发启动器改为从当前工作区 Electron 包解析并规范化
  `path.txt`，显式设置 `ELECTRON_EXEC_PATH`，不再依赖手工环境变量绕过换行问题。
- 2026-07-27：CLI 在 `E:\python study` 新建并完成
  `CLI-Desktop PostgreSQL Parity` 会话，Electron Desktop 随后读取到同一标题、
  用户消息和模型回复，证明两端共享 PostgreSQL 会话事实源。
- 2026-07-27：新增早期私有环境加载器；清除父进程中的数据库和模型变量后，
  CLI 与 Desktop 均从 `%USERPROFILE%\.arforge\.env` 正确加载配置并读取同一会话。
- 2026-07-27：运行账户由 PostgreSQL 超级用户切换为 `arforge_app`；最小权限
  审计的读写回环通过，并确认禁止 SUPERUSER、CREATEDB、CREATEROLE、REPLICATION、
  BYPASSRLS、Schema CREATE 与临时表。
- 2026-07-27：生成 AES-256-CBC + HMAC-SHA256 加密备份并执行隔离恢复；
  45 张表、生产与恢复各 58 行、0 个不一致，临时恢复数据库清理后数量为 0。
- 2026-07-27：所有者批准分层清理方案 C；统一 CLI 新增两阶段
  `clear-data --scope workspace|all`。计划阶段强制盘点和加密备份，执行阶段
  校验一次性短语、数据库指纹和备份 SHA-256；all 强制独立管理连接，并保留
  账号、凭据和迁移账本。8 项安全回归、61 个断言通过；真实工作区只完成计划
  和备份冒烟，没有执行删除。
- 2026-07-28：重新对 `E:\Arforge` 当前框架做逐文件 SHA-256 对账。排除依赖、
  缓存、构建产物和 3 个许可类文件后共有 4,914 个文件：4,696 个原样一致、
  174 个在目标中完成融合修改、44 个明确不迁入。44 个由 21 个上游多语言
  README、10 个 Nix/安装/容器发布文件、8 个 IDE/Husky 配置和 5 个上游协作/
  截图/统计/第三方通知文件组成；运行功能缺失 0。
- 2026-07-27：`packages/agent-python` 启动 Python 时固定使用受限
  `capability` 模式。该模式只公布完整只读能力与 15 个审查后的
  Skill/Plugin/Workflow 管理操作，在 Python 入口再次拒绝旧 Session、Goal、
  Task、审批和文件写入方法；启动与只读请求不再创建
  `bridge_state.db`、`bridge_tasks.db`、`goals.db`、`prompt_queue.db`、
  `feedback.db` 或 `sidecar.lock`。
- 2026-07-27：能力进程统一使用用户私有 `ARFORGE_HOME`；Skill 与 Plugin
  Profile 状态增加跨进程锁、最新磁盘读取、`fsync` 和原子替换。相关
  Python 回归 53/53、Bridge 回归 86/86、真实 TypeScript→Python 回归
  5/5 通过。
- 2026-07-28：桌面端私人环境文件改为覆盖交互式父进程中的陈旧变量；
  Core/桌面类型检查通过，真实 Electron 达到 `server ready`，原生 CDP
  鼠标与键盘验证主菜单、模型菜单、输入编辑和 IPC 均可交互。
- 2026-07-28：Workflow Graph 默认存储改为随部署模式选择 PostgreSQL 或
  显式本地 SQLite，不做故障降级；跨进程租约、控制转发、过期恢复和 Bridge
  回归与导入器回归合计 `18 passed / 0 failed`。SQLite 导入器默认 dry-run、
  源只读、事务写入、run-id 冲突拒绝、同内容幂等并在提交前复核 SHA-256。
- 2026-07-28：所有者选择独立 `arforge_ma`。主库 Workflow Graph 迁移
  `20260728090000_workflow_graph_unified_store` 已应用；主库 48 表、
  `arforge_ma` 3 表，应用角色均无 Schema CREATE 权限。两库隔离恢复分别为
  48/3 表、逐表行数差异 0，临时恢复库均已清理。
- 2026-07-28：Tier 2 方案 B 的 14 个精确目标生成逐文件 SHA-256 清单后
  移入 Windows 回收站；当前 Electron、统一 CLI 和 Python 能力服务均保留。
- 2026-07-28：补齐 `deploy/private-https` 的 Internal/Public Caddy 配置、
  只验证不启动的 PowerShell 校验器和统一 CLI 使用说明；3/3 安全契约通过。
- 2026-07-28：用户原始 ICO、品牌母文件、Desktop/Web 10 个产品 ICO 的
  SHA-256 全部为
  `311b8b1dfcb5bb7e5de690c5b0ceda618f1f7f63fe79f327e38e6cd22072a03e`；
  Desktop 三渠道与 Web 代表 PNG 像素来源、Electron 运行时 `setIcon` 和打包
  图标路径由 3/3 自动化契约固定。
- 2026-07-28：所有者批准 Tier 2 后最终 Desktop 重启。从唯一工程启动的
  Electron、5173 渲染器和 9222 CDP 均就绪；原生鼠标打开模型菜单，输入并发送
  新消息，DeepSeek V4 Pro 在约 7.1 秒内返回
  `ARFORGE_DESKTOP_OK_0728`。采集期间 16 个 HTTP 响应全部为 2xx，运行时异常
  和日志错误均为 0。
- 2026-07-28：3 份过期发布阶段文档生成逐文件 SHA-256 清单后移入 Windows
  回收站；README、用户指南、开发指南和功能契约全部改指当前数据库、私有
  HTTPS、依赖归属及融合验收文档，文档契约 5/5 通过。

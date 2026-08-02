# Arforge 本地项目能力审计

本文件记录 Arforge 面向本地项目开发的功能就绪情况。安装包签名、应用商店、公开分发、升级矩阵和发布审批不属于本审计范围，也不阻塞本地项目使用。

## 审计范围

- 统一主线：`packages/core`、`packages/arforge`、`packages/app` 和
  `packages/desktop`，分别承载共享契约、CLI/Server、前端和 Electron。
- 特色能力：`arforge/` 中的 Agent、记忆、多智能体、评测、办公与自动化能力，
  通过工程自有 capability bridge 逐域接入统一主线。
- 兼容基线：旧 Python CLI 和 Tauri 客户端仅用于迁移对照，不再是默认入口。
- 数据边界：私有 PostgreSQL 是持久数据主路径；SQLite 仅用于隔离测试、显式
  本地模式和仍未迁移的兼容能力。

## 能力映射

| 能力域 | Arforge 实现 | 本地项目状态 |
| --- | --- | --- |
| 多步编码循环 | TypeScript Session Runner + Python capability bridge、自纠错与交付验证 | 就绪 |
| 上下文与压缩 | 项目规则发现、代码检索、LSP、文件状态、自动压缩、会话级上下文隔离 | 就绪 |
| 文件与命令 | 受信工作区、读写工具、补丁计划、后台命令、超时、取消和进程树清理 | 就绪 |
| Git 与工作树 | 状态、差异、分支、受管工作树、保留或显式丢弃退出 | 就绪 |
| 测试与质量 | 项目类型识别、测试运行、失败解析、自纠错、质量门禁和运行报告 | 就绪 |
| 会话 | 统一 Session API、PostgreSQL 持久化、恢复、分叉、重命名、检查点和导出 | 就绪 |
| 计划与任务 | Plan Mode、持久任务图、依赖、领取、状态、调度提示和触发器 | 就绪 |
| 目标与提示队列 | Goal 全生命周期、持久 FIFO、逐提示模型/代理路由和同一成熟执行锁 | 就绪 |
| 工作流 | 数据型 JSON 图、预览、审批、暂停/恢复、分支重试和重启恢复 | 就绪 |
| 插件与技能 | 单一类型化管理 API、来源可见、启停、重扫、两阶段插件安装和可恢复删除 | 就绪 |
| 多智能体 | 八个内置角色、自定义角色、并发调度、团队邮箱、截止时间和取消传播 | 就绪 |
| 工具发现 | 核心工具常驻、重型工具延迟发现、MCP 动态刷新和调用隔离 | 就绪 |
| MCP | stdio、HTTP、SSE、会话、资源、提示、采样、认证、重连和限流 | 就绪 |
| 权限与沙箱 | 请求批准、自动审批、完全访问、规则记忆、路径边界和网络白名单 | 就绪 |
| 记忆与学习 | 项目/工作区作用域、混合检索、质量基线、反思、撤销和用户删除 | 就绪 |
| 长任务 | 后台命令、协作等待、外部唤醒、周期检查、计划任务和守护进程 | 就绪 |
| 桌面交互 | 流式消息、工具时间线、审批、差异、任务、会话运营、语音输入和附件 | 就绪 |
| 可观测性 | 结构化 trace、重放、运行报告、token/成本指标、脱敏日志 | 就绪 |
| 自动化入口 | 统一 CLI、JSON/SSE API、本地 Server、ACP/MCP 和 capability bridge | 就绪 |

## 有意采用等价实现的能力

CLI、Web 和 Electron Desktop 使用同一套 Session/Provider/Permission
契约；Python 特性不再拥有第二套桌面会话状态。编辑器通过 ACP/MCP 和本地
API 接入。远程工作区由受控 SSH、附加工作区根和会话工作树承担。

## 明确不融合的部分

- 特定厂商的登录、订阅、用量计费、私有托管地址和远程工作区服务。
- 安装包签名、公开发布、商店、自动安装更新和最终发布审批。
- 只服务于参考终端界面的主题动画、终端兼容补丁和品牌资产。
- 需要外部证书、受保护流水线或真实生产账户才能形成的发布证据。

## 运行前提

1. 使用仓库固定的 Bun 1.3.14 和 Electron 依赖；Python 3.10+ 仅用于保留能力。
2. 至少配置一个兼容模型，并在
   `%USERPROFILE%\.config\arforge\arforge.json` 明确选择
   `provider/model`；密钥只写入用户私有配置或操作系统安全存储。
3. 对将要修改的项目执行一次工作区信任确认。
4. Git、语言服务器和外部 MCP 服务均为按需能力；缺失时显式降级。私有持久
   模式要求 PostgreSQL 可用，隔离测试可显式使用 SQLite/内存数据库。

## 验收记录（2026-07-27）

- 真实统一 CLI → Core → DeepSeek 调用成功，响应精确返回
  `Arforge模型链路正常`，会话正常结束。
- TypeScript 根工作区 typecheck：27 个作用域包中的 23 个类型检查任务全部通过。
- Python 全量：`2967 passed, 7 skipped, 0 failed`。
- TypeScript 成熟运行时全量（正式 30 秒预算、四分片）：
  `3182 passed, 65 skipped, 1 todo, 0 failed`。
- 共享桌面/Web 前端单元测试：`678 passed, 0 failed`；浏览器测试：
  `30 passed, 0 failed`。
- TUI 全量：`193 passed, 1 skipped, 0 failed`。
- PostgreSQL 专用 `arforge_app` 角色、迁移、备份、恢复与恢复后表数据比对
  已通过；应用角色读写往返成功，且无超级用户、建库、建角色、复制、绕过
  RLS、建 schema 或临时表权限。
- Vue/Clojure Tree-sitter WASM 与查询文件已作为 TUI 静态资产本地打包，
  SHA-256 清单校验通过；断开原远程地址后真实高亮分别生成 18/70 个片段。
- 所有 Tier 1 生成目录均已按所有者批准删除，释放约 11.3 GiB；当前
  Electron、统一前端、CLI/Server、最终私有 wheel 和 PostgreSQL 备份均保留。
- 严格品牌扫描为 0 命中；共遍历 6,392 个文件并扫描 5,786 个文本文件，
  公共工作流、官网和公共托管入口不属于本工程。
- 40 个一方 `package.json` 中的 homepage、repository、bugs、author、
  funding、publishConfig 外部元数据为 0；`.github/` 不存在；12 个一方 ICO 均与所有者
  提供的 Arforge 源图标 SHA-256 完全一致，旧 Tauri 验收 PNG 也由同一源重建。
- Go/Ruby/PHP 在本机无原生运行时且 Docker 引擎关闭时会明确报告不可用，
  不再把仅存在的 `docker.exe` 误判为可用引擎。
- Goal、Task、Prompt Queue 已由 Desktop 与 CLI 通过同一集成 HTTP 契约管理；
  队列排空使用成熟 Session 执行所有者，不再启动并行 V2 Runner。
- Workflow、Plugin、Skill 管理已进入同一 Desktop 控制面和类型化 CLI。
  Python 写操作只开放 15 个审计后的管理方法，越权方法拒绝测试通过。
- Workflow/Plugin/Skill 类型化 API 联通测试覆盖审批图完成、Skill 启停、
  Plugin 检查/应用/可恢复删除/恢复；相关 Python 回归 `33 passed`，
  Agent Python 客户端 `4 passed`。
- 本轮统一闭环的聚焦回归全部通过：Session 执行/Prompt Queue `27 passed`，
  CLI 同源 API、Prompt Queue HTTP 与帮助快照 `4 passed`，Desktop 提交
  `9 passed`；严格品牌审计为 `0 hits in 0 finding files`（遍历 6,392 个
  文件，扫描 5,786 个文本文件）。
- HTTP 路由练习器已覆盖全部 289 个唯一公开 Effect 路由，并以 309 个场景
  覆盖同一路由的有效、无效和生命周期变体。覆盖、鉴权和真实 Effect 三种模式
  均在 `--fail-on-missing --fail-on-skip` 下达到
  `309 passed, 0 failed, 0 skipped, missing=0, extra=0`；真实全量耗时
  895.4 秒。
- 状态型 HTTP 场景覆盖 Goal、Task Graph、Prompt Queue、Session 标签/检查点/
  回退、Memory、Team、Scheduled Prompt、Trigger、Feedback、Learning、MCP、
  Cooperative Wait 与多模态诊断，均通过真实路由、中间件、位置绑定和持久化
  链路。测试过程中修复了 Session 成熟执行实例路由、Scheduled Prompt
  `run-missed` 非法状态污染、Windows PTY 命令、Worktree 临时路径盘符歧义，
  以及 Workflow 领域错误误报 503。
- Electron 桌面开发态已禁用会重入清理大型 Solid 组件树的组件级 Refresh；
  JavaScript 修改采用确定性的整页重载，CSS 热更新保留。App/Desktop 类型检查
  和包含 2,232 个前端模块的完整桌面生产构建均通过。
- 私人运维 CLI 已统一：`doctor/status` 在真实工作区完成运行时、工作区、
  私人目录、PostgreSQL 和 Agent 引擎 5/5 检查；`agents` 返回 7 个角色，
  `tools` 返回 12 个当前可见工具；日志保留默认只预览，凭据扫描不输出凭据值。
  相关纯函数回归 `4 passed, 0 failed`。
- 所有者批准的方案 C 已落地为两阶段 `clear-data`：workspace/all 都先盘点并
  生成 AES-256-CBC + HMAC-SHA256 加密备份，再凭 15 分钟有效的一次性短语
  执行；all 强制独立管理角色，账号、凭据和迁移账本默认保留。安全回归
  `8 passed, 0 failed, 61 assertions`；真实工作区只生成了盘点和备份，
  未执行删除。
- 本轮 22 个 TypeScript 触达文件的定向 Oxlint 为 `0 errors`；根级 Oxlint
  仍会被存量仓库告警/错误阻断，不能作为已清零门禁记录。本轮未用批量自动
  修复改写无关代码，避免把历史风格治理混入功能融合。

## 当前结论

Arforge 已具备在受信本地工作区中执行真实项目任务所需的功能闭环：理解项目、制定计划、修改文件、运行命令和测试、自纠错、生成报告、恢复会话以及回退改动。公开分发是否就绪应继续由独立发布门禁判断，不能与本地功能就绪混为一谈。

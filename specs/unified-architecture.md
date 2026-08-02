# Arforge-Agent 统一架构

状态：执行中  
目标工程：本仓库  
发布、签名、安装器和公共托管：本阶段不在范围内

## 1. 目标

本仓库成为唯一开发主线，同时保留两类已经存在且经过验证的能力：

1. Python Agent 能力：多智能体、长期记忆、能力评测、工作流、安全执行、
   IDE Bridge、特色工具与现有 PostgreSQL 数据能力。
2. 成熟应用框架：类型化 Schema、共享 Core、HTTP Protocol、Server、
   生成式 Client、CLI/TUI、Web App 和 Electron Desktop。

融合不是让两个运行时永久并排运行。最终只有一个会话真相源、一个权限边界、
一个工具协议和一个桌面/CLI 产品入口。Python 特色能力作为受类型约束的能力
服务接入共享核心，不再自行复制产品会话、UI 状态和认证逻辑。

## 2. 当前事实

- Python 工程已有大规模未提交重构，不能通过镜像复制或重置覆盖。
- `arforge/` 和 `tests/` 是现有特色能力及回归证据的权威来源。
- 成熟框架采用 Bun/TypeScript 工作区，包依赖方向为
  `Schema -> Core/Protocol -> Server -> Client/UI`。
- 旧产品壳已在等价、数据恢复和所有者审批门禁通过后退役；行为证据保存在
  迁移矩阵、自动化测试和 Tier 2 哈希清单中。
- 本阶段不复制成熟框架根目录的 `LICENSE` 文件；各第三方包自身要求保留的
  许可证文件和第三方声明不得删除。

## 3. 目标目录

```text
Arforge-Agent/
├─ arforge/                 # Python 特色能力引擎（过渡期保持导入路径）
├─ tests/                   # Python/Bridge 行为回归
├─ packages/
│  ├─ schema/               # 统一数据与事件契约
│  ├─ core/                 # 会话、权限、工具、目标和任务图真相源
│  ├─ protocol/             # HTTP API 契约
│  ├─ server/               # 服务装配
│  ├─ client/ sdk*/         # 生成客户端
│  ├─ arforge/ tui/ cli/    # CLI/TUI 产品入口
│  ├─ app/ ui/ session-ui/  # Web 与共享 UI
│  ├─ desktop/              # Electron Desktop 产品入口
│  └─ agent-python/         # 最终 Python 能力服务适配包（迁移目标）
├─ ide/                     # VS Code / JetBrains 现有集成
├─ specs/                   # 架构、矩阵、验收与来源记录
├─ scripts/                 # Python/项目运维脚本
└─ script/                  # Bun 工作区生成与审计脚本
```

## 4. 权威边界

| 领域 | 最终权威 | Python 侧定位 |
| --- | --- | --- |
| 会话、消息、事件 | `packages/core` | 特色推理只消费/产生类型化事件 |
| 权限与审批 | `packages/core` | 工具执行必须通过共享授权 |
| HTTP API | `packages/protocol` + `packages/server` | 不另建平行公开 API |
| 桌面状态 | Electron App/Desktop | 旧产品壳已退役 |
| CLI/TUI | TypeScript CLI/TUI | Python 仅作为受限能力服务 |
| Agent 特色能力 | Python 能力服务 | 多智能体、学习、评测、检索等 |
| 数据库 | PostgreSQL + 统一迁移门槛 | 禁止同一生产数据被两个写入者竞争 |

融合后的 TypeScript 适配器必须以 `ARFORGE_BRIDGE_MODE=capability` 启动
Python。受限进程只初始化请求所需的能力服务，不能为了协议兼容而构造旧
Session、Goal、Task、Prompt Queue、Feedback 等产品状态库。独立 Python
CLI/Bridge 在兼容验收期仍可使用完整模式，但不是默认产品入口。

## 5. 分阶段迁移

### 阶段 A：工作区吸收

- 引入成熟框架源包和 Bun 锁文件。
- 排除依赖缓存、构建产物、发布部署配置和根许可证文件。
- 保留 Python 现有文件位置，保证回归仍可运行。
- 建立统一根脚本，不立即删除旧启动器。

### 阶段 B：类型化 Python 能力边界

- 定义 `AgentCapability` 请求、事件、错误和取消契约。
- 建立本地进程/IPC 适配器，明确超时、背压、日志脱敏和生命周期。
- 第一批接入只读能力：能力路由、记忆召回、代码检索和评测查询。
- 写操作必须走共享权限和会话事件。

### 阶段 C：产品入口收敛

- Electron Desktop 和 TypeScript CLI 成为默认入口。
- 已迁移旧产品壳独有功能，并按功能矩阵逐项验收。
- Python Bridge 只保留受限能力协议，不形成第二会话数据库。

### 阶段 D：数据与运行时收敛

- PostgreSQL 迁移、备份和恢复演练成为硬门槛。
- 禁止 SQLite/PostgreSQL 或 Python/TypeScript 双写。
- 完成会话、工具、权限、目标、任务、记忆的逐域迁移。
- 将仍有产品语义的 Workflow Graph profile SQLite 日志迁入统一数据库；
  纯缓存、锁和可重建索引必须在合同中明确标注，不能冒充业务真相源。

Workflow Graph 已具备三张 Core 管理的 PostgreSQL 表、跨进程租约、过期
所有者恢复、冲突拒绝和 SQLite 只读导入器。本机迁移已应用；旧 SQLite
dry-run/apply 均发现 0 条运行记录并得到相同空数据指纹。

### 阶段 E：清理

- 功能矩阵、数据恢复和所有者审批通过后，旧产品壳与兼容入口已移入回收站。
- 发布相关工作继续保持关闭。

## 6. 验收门槛

每个迁移域都必须同时满足：

1. 功能合同有明确输入、输出、错误、权限和持久化语义。
2. 原 Python 专项测试继续通过，或被等强度的新测试明确替代。
3. TypeScript Core、Server、Client 和 UI 至少有一条纵向回归。
4. 桌面与 CLI 对同一会话观察到一致事件。
5. 无双写、无隐式数据迁移、无明文凭据、无跨工作区数据泄漏。
6. 目标工程脱离原目录后仍能安装依赖、类型检查和运行。

## 7. 明确不做

- 不在本阶段发布、签名、推送、创建 PR 或配置公共官网。
- 不把用户当前 481 项工作树修改重置成历史提交。
- 不通过批量字符串替换冒充架构融合。
- 不在功能未迁移时删除旧实现和测试证据。
- 不复制依赖缓存、构建产物、临时工具链或原工程根许可证文件。

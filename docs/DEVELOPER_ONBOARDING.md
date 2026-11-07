# Arforge Agent 开发者上手指南

本指南描述 `1.0.0-test.1` 统一主线的源码结构和验证方式。项目中的恢复目录、
缓存、运行数据和历史异常文件不是产品源码，不应被打包或作为架构依据。

## 1. 环境准备

在已检出的源码根目录使用 Bun 1.3.14 安装工作区依赖：

```powershell
bun install --frozen-lockfile
bun run cli --help
bun run dev:desktop
```

如需开发或检查 Python 兼容层，在 Windows 上建立独立虚拟环境：

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e ".[dev,postgres]"
```

CI 和发布环境使用仓库中的带哈希锁文件。修改 Python 依赖后同步维护
`requirements-release.lock` 和 `requirements-dev.lock`。私有环境文件只需填写
当前使用的配置项，参照 [用户指南](USER_GUIDE.md)。

## 2. 开发检查

按改动范围选择受影响包的测试与类型检查，再扩大验证范围。

```powershell
bun run cli --version
bun run --cwd packages/app typecheck
bun run --cwd packages/app test:unit
.\.venv\Scripts\python.exe -m pytest -q
.\.venv\Scripts\python.exe -m ruff check arforge tests config.py main.py
```

完整产品验收还包括：

```bash
python dogfood.py --turns 100
python scripts/performance_baseline.py
npm audit --omit=dev
python -m build
```

## 3. 代码地图

| 路径                               | 职责                                                | 修改时重点验证                                                                                                    |
| ---------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `packages/core/`                   | 共享运行时、数据库、Session Runner 与能力执行       | SQLite/PostgreSQL 双路径、Effect 边界                                                                             |
| `packages/arforge/`                | CLI、Provider、Server、工具与会话                   | CLI/HTTP/会话行为一致                                                                                             |
| `packages/app/`                    | Desktop/Web 共用 Solid 应用                         | 状态同步、交互和可访问性                                                                                          |
| `packages/server/`                 | HTTP 路由和处理器                                   | 请求校验、身份和权限边界                                                                                          |
| `packages/desktop/`                | Electron 主进程、preload 和打包                     | 启动、sidecar、窗口和私有环境                                                                                     |
| `arforge/core/`                    | 保留的 Python Agent 能力                            | 兼容桥、自纠错、取消、错误传播；dogfood 默认 runner 通过统一 TS `arforge run` 执行                                |
| `arforge/models/`                  | 模型适配、速率限制、令牌统计                        | 所有调用入口均经过适配器策略                                                                                      |
| `arforge/planning/`                | 计划、推理、工作流                                  | 状态转换、失败恢复、边界输入                                                                                      |
| `arforge/tools/`                   | 工具注册和具体工具                                  | schema、权限、路径边界、副作用                                                                                    |
| `arforge/security/`                | 确认、验证、恢复、安全编辑                          | fail-closed、脱敏、回滚                                                                                           |
| `arforge/database/`                | 引擎、备份、Alembic 迁移                            | main/multiagent 分离、离线 SQL                                                                                    |
| `arforge/product/`                 | doctor、日志、数据清单                              | 无密钥泄漏、跨平台行为                                                                                            |
| `packages/arforge/src/cli-main.ts` | 统一 TypeScript CLI                                 | 所有产品命令、Provider、Session 与 Permission 的唯一入口                                                          |
| `arforge/cli_bridge.py`            | Python CLI 兼容转发                                 | `python -m arforge`、`python -m arforge.cli`、Python console script、根 `main.py` 和 Windows `arforge.cmd` 只转发到 TS；`invoke(...)` 为嵌入宿主提供捕获式结构化结果；缺失运行时直接失败 |
| `arforge/cli_compat.py`            | 外部嵌入兼容 facade                                 | 仅重导出 `cli_bridge` 的统一 TS 入口和 `CliInvocationResult`；新 Python IDE/测试/服务集成应使用它，不得添加 parser、handler 或状态 |
| `arforge/cli.py`                   | 旧 Python CLI API                                   | 仅供显式兼容调用和迁移测试，不新增产品命令或状态 owner；新嵌入代码迁移到 `arforge.cli_compat` 后再退役，产品/自纠错运行器不得直接启动它，静态门禁禁止其它产品源直接 import/唤起它 |
| `script/arforge-cli-compat-inventory.ts` | TS CLI 兼容退役清单                            | 唯一的只读源码/digest 治理实现；`--check --json` 发现旧模块未经审查漂移或 facade 导出分叉时失败，不执行旧 parser、不写文件 |
| `scripts/cli_compat_inventory.py`  | Python 兼容治理入口                               | 仅无状态转发到上面的 TS 实现，保留旧自动化命令合同；不得添加第二套解析、策略或状态写入 |
| `tests/`                           | 自动回归和产品契约                                  | 新行为必须有失败路径测试                                                                                          |

Desktop 的渲染层和 Web App 通过 HTTP 使用 TypeScript 后端。CLI 和服务端共享
Core 的会话、权限与持久化契约，Python 层保留兼容和迁移用途。完整目录索引见
[仓库结构](REPOSITORY_STRUCTURE.md)。

## 4. 常见开发任务

### 新增 CLI 命令

在 `packages/arforge/src/cli-main.ts` 及对应 `packages/arforge/src/cli/cmd/`
实现命令，复用 Core/Server/Session/Permission；为成功、错误参数、非交互确认和
帮助文本增加 TypeScript 测试，同时更新 README/用户指南。不要在
`arforge/cli.py` 增加新的产品命令；旧 Python API 只能显式兼容转发。

### 检查旧 CLI 退役边界

```powershell
.venv\Scripts\python.exe scripts/cli_compat_inventory.py --json --check
```

该检查由 `script/arforge-cli-compat-inventory.ts` 唯一实现，读取旧 `arforge/cli.py`
的顶层定义并比较源码 digest；任何新增、删除或未经复核的变更都必须先更新迁移
证据。Python 路径只是兼容转发，不执行旧 parser，也不会创建或修改业务状态。

### 新增工具

定义精确 schema，标注风险和副作用，验证输入与路径，确保取消/无输入时拒绝执行，并测试敏感字段不会进入日志。

### 修改数据库结构

TypeScript 产品数据库的迁移在 `packages/core/src/database/`，分别维护 SQLite
与 PostgreSQL 路径。Python 兼容数据库的迁移在 `arforge/database/migrations/`。
先确认迁移归属，再按照 [数据库迁移手册](DATABASE_MIGRATION_RUNBOOK.md) 验证。

### 新增模型提供商

实现 `ModelAdapter` 契约并通过中央工厂构造，确保同步、流式、规划和多智能体路径共享速率限制与错误规范化。

## 5. 测试策略

- 单元测试覆盖纯逻辑和失败边界。
- 集成测试覆盖 CLI、迁移、权限、日志和适配器组合。
- dogfood 使用确定性离线适配器，证明 100 轮流程不依赖网络。
- staging 验收使用临时 PostgreSQL 和测试模型账户，不能用自动化离线结果替代。
- 性能变更运行 `scripts/performance_baseline.py` 并与 [基线](PERFORMANCE_BASELINE_2026-06-18.md) 比较。

## 6. 提交前检查

1. 确认没有修改 `.env`、用户数据库、缓存、恢复目录或未知历史文件。
2. 运行 pytest、Ruff、compileall 和相关 npm 检查。
3. 更新用户可见文档、CHANGELOG 和迁移/回滚说明。
4. 检查 `git diff`，确保没有凭据、生成物和无关修改。
5. 对数据库或安全变更，执行 `bun run fusion:verify`、双库拓扑预检和对应恢复演练；
   发布、签名与公共部署不在当前工程阶段。

## 7. 已知交接事项

源码提交、Windows 安装包、签名和公网部署各自有验收范围。保留私有备份、
工作区数据和原始验收输出。发布证据的存放和脱敏规则见 [仓库结构](REPOSITORY_STRUCTURE.md)。

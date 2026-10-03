# Arforge Agent

[English](README.md)

Arforge Agent 是面向开发工作区的本地优先 AI 智能体。当前公开源码快照对应
测试版本 `1.0.0-test.1`，界面版本名为 `Arforge 测试 1.00.00 版`。本仓库提供
源码与开发文档，暂未提供官方商店版本或公共更新服务。

许可状态：`UNLICENSED`。源码公开可见不代表授予复制、再分发或制作衍生作品的
许可；如需开放授权，应由仓库所有者另行添加许可证。

## 项目文档

- [使用指南](docs/USER_GUIDE.md)
- [仓库结构](docs/REPOSITORY_STRUCTURE.md)
- [开发者上手指南](docs/DEVELOPER_ONBOARDING.md)

## 当前统一架构

- `packages/core`：共享契约、数据库、Session Runner、记忆、评测与原生 TypeScript 能力层。
- `packages/arforge`：统一 CLI、Provider、Server、工具与会话运行时。
- `packages/app`：Desktop 与 Web 共用的 Solid 前端。
- `packages/desktop`：当前 Electron 桌面外壳。
- `arforge/`：Python 兼容与迁移保留层，也供测试和评测使用；产品 CLI、会话运行时
  与业务状态由 TypeScript packages 拥有。

CLI、Server、App 和 Desktop 使用同一套会话、模型、权限和 PostgreSQL
契约，不再各自维护一套产品状态。

## 已验证状态（2026-07-27）

- 真实 CLI → Core → DeepSeek 调用成功，模型完成状态为 `stop`。
- 切换最小权限 `arforge_app` 后再次真实调用，返回
  `Arforge私有链路正常`。
- Python 全量：`2967 passed, 7 skipped, 0 failed`。
- TypeScript 成熟运行时全量：
  `3182 passed, 65 skipped, 1 todo, 0 failed`。
- 根工作区 TypeScript：`23/23` 包通过。
- 严格品牌审计：`0 hits in 0 finding files`；遍历 6,392 个文件，扫描
  5,786 个文本文件。
- 外部源码依赖、Junction 和运行进程：均为 0。
- PostgreSQL 应用角色读写往返、备份和恢复比对通过。

跳过项是当前 Windows 主机缺少的可选运行时或平台能力；例如本机没有
Go/Ruby/PHP 且 Docker 引擎未启动时会明确跳过/报告不可用，不伪造成功。

## 首次配置

```powershell
cd Arforge-Agent
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -e ".[dev,postgres]"
bun install
```

私有环境文件位于：

```text
%USERPROFILE%\.arforge\.env
```

示例值只能使用占位符，真实密钥不要提交到仓库：

```dotenv
DEEPSEEK_API_KEY=replace-with-your-key
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-flash
ARFORGE_DB_URL=postgresql://arforge_app:replace-with-generated-secret@127.0.0.1:5432/arforge
```

统一 TypeScript 运行时的模型选择位于：

```text
%USERPROFILE%\.config\arforge\arforge.json
```

```json
{
  "model": "deepseek-v4-flash/deepseek-v4-flash"
}
```

管理员数据库连接只用于迁移和应用角色初始化。当前进程临时持有管理员
`ARFORGE_DB_URL` 时，可执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\configure_private_postgres.ps1
```

脚本会生成随机的 `arforge_app` 密码、审计最小权限，并只把应用连接持久化到
用户私有 `.env`；不会把管理员连接当作日常运行连接保存。

## 启动

CLI：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run_cli.ps1 --help
powershell -ExecutionPolicy Bypass -File .\scripts\run_cli.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\run_cli.ps1 doctor --json
powershell -ExecutionPolicy Bypass -File .\scripts\run_cli.ps1 tools --json
powershell -ExecutionPolicy Bypass -File .\scripts\run_cli.ps1 agents --json
powershell -ExecutionPolicy Bypass -File .\scripts\run_cli.ps1 models deepseek
powershell -ExecutionPolicy Bypass -File .\scripts\run_cli.ps1 --model deepseek/deepseek-v4-pro
powershell -ExecutionPolicy Bypass -File .\scripts\run_cli.ps1 chat
powershell -ExecutionPolicy Bypass -File .\scripts\run_cli.ps1 ask "检查当前工作区"
powershell -ExecutionPolicy Bypass -File .\scripts\run_cli.ps1 print --final-message-only "总结当前工作区"
powershell -ExecutionPolicy Bypass -File .\scripts\run_cli.ps1 --print -p "检查当前工作区"
powershell -ExecutionPolicy Bypass -File .\scripts\run_cli.ps1 config
powershell -ExecutionPolicy Bypass -File .\scripts\run_cli.ps1 logs-prune 30
powershell -ExecutionPolicy Bypass -File .\scripts\run_cli.ps1 secrets-scan
```

旧 Python 包入口 `python -m arforge`、迁移期模块入口 `python -m arforge.cli`
和安装后的 `arforge` 命令现在只转发到同一 TypeScript CLI
（`packages/arforge/src/index.ts`）；仓库根 `main.py` 与 Windows `arforge.cmd`
也使用同一 bridge。缺少 Bun/TS 入口会直接报错，不会运行第二套 Python CLI。
`arforge.cli` 的可导入 API 仍仅保留给迁移期显式兼容调用；外部 Python IDE、测试和
服务宿主请使用 `arforge.cli_compat`。该 facade 只转发 `cli_bridge`，其
`invoke(...)` 返回结构化 stdout/stderr/退出码，始终禁用 shell；缺少 Bun/TS 时
明确失败，不会回落到旧 Python parser。

开发者可运行 `bun run script/arforge-cli-compat-inventory.ts --json --check` 查看旧 CLI
的函数级冻结清单；兼容命令 `python scripts/cli_compat_inventory.py --json --check`
只无状态转发到同一 TS 实现。两条入口都只读源码并校验 digest，不执行旧 parser 或写入状态。

`workspace --contract-audit` 与 `settlement-status` 的 JSON 和人类输出均带有统一的
`execution_boundary` 只读声明（不写入、不创建状态、不修复 recovery、禁止 Provider 执行）；
审计证据完整不会改变这一边界。

`chat` 是默认 TUI 的兼容别名，`ask` 和 `print` 是一次性 `run` 的兼容别名；
`print` 同时承接历史 `--print`、`--input-format`、`--output-format`、
`--final-message-only`/`--quiet` 参数。它们都调用同一个 TypeScript `RunCommand`，
不会创建第二个运行时。`arforge --help` 是可执行命令矩阵的唯一事实来源；
`memory status/list/search/get/create/update/facets/recall-quality/metrics/write-stats/digest/conflict` 已由
TS/Core 统一 owner 提供，并与 Desktop 使用同一 HTTP/SDK 合同；`digest` 支持类别过滤、
有界读取（1–500）、JSON 的 `truncated` 标记和显式 Markdown 输出；`conflict` 是只读
基准与已持久化候选报告，不会自动调用写入型 `conflictScan`，也不伪造关系覆盖率；历史
`metrics` 只组合 Core typed 只读指标，旧 golden eval/history 明确标记不可比/未读取；
`write-stats` 只显示 Core 数据库范围/来源/类型投影，旧 `memory_writes.jsonl` 决策日志标为
`not_read`，`--clear` 保持退出码 2；`recovery` 只读聚合 profile-local
`recovery_outcomes.jsonl` 并报告损坏行，`recovery --clear` 与 `memory feedback` 会明确返回迁移提示。其它尚未登记
TS owner 的 Python 历史命令仍在迁移账本中，Python bridge 不会静默回退或伪造这些能力。`memory feedback`
会先校验 retrieval UID、正整数 useful/irrelevant ID 和重复标记，再以退出码 2 fail-closed；因为尚无可跨进程
定位的 durable retrieval event、returned-set 校验、工作区/身份绑定和事务更新，所以不会写入 recall feedback。
追加 `memory feedback --contract-audit --json` 可通过同一 TS/Core 纯函数查看
上述合同缺口；它是只读诊断，不需要 retrieval UID，也不会写入任何状态。
Desktop 的 `agentCapability.deepInsights` 也展示同一 `memory-feedback`
section，普通成员、owner 与 admin 看到的合同边界保持一致。
`learning status/recall/record/undo/sync-dogfood/dream` 已由 TS/Core 统一 owner 提供；`recall`
只组合现有只读的 `Memory.recallQuality` 与 `Learning.status` 合同，不写入状态，并与
Desktop 使用同一 workspace-scoped LearningV2 HTTP/SDK 合同。`dream` 返回基于当前
Learning.status 的确定性洞察/建议，明确标记只读投影；不会自动 consolidation、调用模型
或写入模式，后续如需整理必须另行通过 typed ActionGateway 合同。
`feedback summary/list/submit/delete` 也已由 TS/Core 统一 owner 提供，并与 Desktop
使用同一 workspace-scoped FeedbackV2 HTTP/SDK 合同；提交前脱敏并将非中性评分以
best-effort 方式联动正式学习。旧 Python 的位置参数写法继续由同一个 TS owner
解析；已退役 Python feedback 数据库中的 UUID 记录不会重新打开。
`skill` 与历史 Python 复数入口 `skills` 现在也是同一 TS/Core owner：默认列出技能，
并支持 `list/enable/disable/refresh/route`；`skills route <请求>` 使用同一确定性
技能路由合同，不恢复旧 Python manifest/state writer，也不复制第二套注册表。
`repo-scale` 也已融合 Python 旧入口的 `repo-scale <路径> [--query <词>]` 语法；
路径、查询、预算和 JSON/文本输出都进入同一个 TS/Core 有界扫描 owner。
`quality` 同样融合旧的 `quality <patch-file>` 入口：单个 `.diff`/`.patch` 位置参数
或可识别的 unified diff 内容会进入同一个 TS/Core 质量门禁；普通源码文件位置参数
仍按文件质量检查处理，自动化场景可明确使用 `--patch-file`。
`plugin-manager` 现在也是 Python `plugins` 复数入口的唯一 TS/Core owner：
`plugins`（省略动作时默认为 `list`）、`list/inspect/install/update/remove/restore/enable/disable`
均在同一 typed API 与控制审批管线中执行；旧安装名称位置参数会归一到 `--name`。
旧 `root` 位置参数仅接受 `<workspace>/.arforge/plugins`，任意其它目录会在状态变更前
明确拒绝，避免把路径误当工作区或绕过权限边界。

`agent-metrics` 现在也已并入 TS/Core 唯一 owner。默认报告聚合 profile
内的 dogfood、恢复、验证和回归遥测，并显示正式/纵向门禁状态；`history`
读取有界历史，`record` 追加当前快照，`--clear` 清理历史。缺失或坏行只
显示 `n/a`/`insufficient_evidence`，不会影响主会话；只有显式历史操作会
写入或删除本地 `agent_metrics.jsonl`。

`run-history [run-id]` 读取同一份受界限、脱敏的 Core 运行事务/trace 报告，
仅做只读展示，不会再次调用模型或工具。历史 `arforge replay [run-id]` 是
该 TypeScript/Core 报告 owner 的同一别名，不会建立第二套 replay 状态。

`multimodal-diagnose <文件>` 也已并入 TS/Core 唯一 owner，承接旧 Python
诊断入口。支持工作区内相对路径、`--workspace`、文本覆盖 `--text`、
`--mode error|frontend|javascript`、有界 `--limit 1..50` 和 `--json`。
它调用 Desktop 共用的 typed diagnostics 路由，只做本地有界提取/分析，
固定报告 `localOnly=true`、`modelCalls=0`，不写文件、不联网；Python 模块
入口只转发到该命令，不保留第二套解析器或诊断实现。

`features` 现在也由 TS/Core 统一提供只读功能策略：`features list`（或
`features --json`）读取 Desktop 共用的 typed `agentCapability.deepInsights`
中的 TS-native 功能项，不读取旧 Python `feature_flags.json`。历史
`set`、`clear`、`refresh` 会先校验参数，再以退出码 2 明确
`fail-closed`，直到具备带权限、事务和证据的 TS 写入 owner；因此不会
产生第二个功能状态源。

追加 `features --contract-audit --json` 可查看同一份 TS/Core 只读迁移合同：
它列出 durable 状态、工作区/身份绑定、授权、事务、回滚、跨进程一致性、审计
证据和保留/清理策略等缺口，不读取或写入 `feature_flags.json`。Desktop
深度诊断以 `feature-policy-contract` section 展示同一报告，CLI 与 UI 不再各自
定义策略语义。

深度诊断的 `file-state` section 现在提供同一 TS/Core 的结构化合同审计：
它明确列出跨进程 observation journal、run/session 与工作区/身份绑定、
持久化/重启恢复、授权、取消、事务结算、证据摘要和清理策略等缺口。
历史 `file-state` CLI 仍以退出码 2 fail-closed；不会把一次性
`FileMutation.fingerprint`、`AnalysisRuns` 或旧进程内 tracker 冒充为可恢复观察账本。

系统概览的 `cost-optimization` section 也提供只读合同审计，列出 durable
成本归因、provider 定价版本、token 对账、跨进程聚合、重启恢复、evidence
和保留/清理策略等缺口。历史 `cost-optimization` CLI 继续退出码 2
`fail-closed`；不会把 Session 统计、AgentMetrics 或文件指纹冒充成本账本。

`permissions` 也已并入 TS/Core 唯一 owner：`permissions list`（或
`permissions --json`）通过 typed `permission.saved.list` 读取当前工作区
的已保存规则，与 Desktop 共用同一权限数据。历史 `add`、`revoke` 会
保留严格参数校验，但在事务、授权、审计和回滚合同完成前以退出码 2
`fail-closed`，不会读取或创建旧 Python 权限配置。

追加 `permissions --contract-audit --json` 可查看权限策略的只读合同审计，
包括 typed rule、工作区绑定、授权、事务、乐观版本、审计、回滚和跨进程一致性
缺口；Desktop 深度诊断的 `permission-policy-contract` section 与 CLI 共用该
报告。审计不会读取 `permission_rules.json`。

`workflow` 是工作流的唯一 typed owner。历史 `workflows list`、`runs`、
`status`、`events`、`pause`、`resume`、`cancel`、`retry`、`approve`、
`reject` 会归一到同一 HTTP/SDK 操作（`status` 映射为 `get`），`events`
支持有界 `--after`/`--limit` 事件读取。旧 `workflows validate` 和 `run`
的校验语义已由 typed `workflow validate` 覆盖；只有涉及报告写入/执行的
旧 `workflows run` 在等价合同完成前继续明确退出码 2，绝不静默启动工作流
或创建第二套图运行状态。

数据库当前版本查询也已收敛到同一个 TS/Core owner：
`arforge db current [main]` 只读 TypeScript migration ledger，不会自动应用迁移；
历史 `arforge db-current [main]` 会归一到同一命令并返回相同 JSON/文本。`multiagent`
以及其余会修改数据库的旧 `db-*` 命令在具备完整 typed owner 和证据前继续明确
退出码 2，不会误读主库或回退 Python 迁移循环。

`capabilities test <输入>` 已并入同一个 TS/Core owner，但当前是安全的
`route-preview`：只按确定性关键词给出匹配能力、分数和命中词，不调用模型、
不执行命令、不写文件或数据库。旧 Python handler 的真实执行要等所有能力都
具备 typed Core 执行、权限和证据合同后再开放；`--execute` 目前会明确拒绝。

`capabilities evaluate` 会对全部能力目录执行只读合同审计，逐项检查 typed
输入/输出、ActionGateway 授权、取消、evidence、settlement 和 owner 声明。
它不会加载或调用 handler；缺少任一项的能力继续标记为 `fail-closed`，目录
展示不等于已获得执行权限。

`capabilities overview` 通过同一个 typed `agentCapability.systemOverview`
读取运行时、工具、子代理角色和成本合同 section；`--json` 返回可供脚本消费
的结构化结果，`--all` 展开只读 section 数据。它不会启动 handler、模型、shell
或任何写入路径。

进入 CLI 终端界面后，输入 `/models` 并回车可打开模型选择器；也可先按
`Ctrl+X`、松开后再按 `M`。方向键选择、`Enter` 确认，`F2` 在最近模型间
切换。启动参数 `--model 提供商/模型` 可直接指定本次会话模型。

`logs-prune` 默认只生成删除预览；确认清单后追加 `--apply` 才会删除过期
日志。`secrets-scan` 只输出命中文件和凭据类别计数，不会显示凭据值。

桌面端：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run_desktop.ps1
```

两个启动器都固定使用本工程的 Bun，并加载同一个用户私有 `.env`。它们拒绝
从其他工程目录启动。

## 数据库边界

- 私有持久模式：PostgreSQL `arforge` 数据库，日常角色 `arforge_app`。
- 管理员角色：只运行迁移、授权和恢复管理，不启动产品。
- SQLite/内存数据库：只用于显式本地隔离测试或尚未迁移的兼容能力。
- 备份：`%LOCALAPPDATA%\Arforge\backups\postgresql`。

`arforge clear-data` 采用两阶段协议：首次调用只盘点 `workspace|all` 范围、
生成并验证加密 PostgreSQL 备份，再显示 15 分钟有效的一次性短语；执行阶段
重新校验数据库指纹和备份哈希。`all` 还必须提供独立的
`ARFORGE_DB_ADMIN_URL`，账号、凭据和迁移账本始终保留。

## 重要边界

- 当前工程提供手动触发的未签名 Windows 内部 Alpha，以及受保护的签名 Beta 候选
  流水线。后者在取得经验证的云 HSM 代码签名身份并配置 GitHub 受保护环境前仍是
  阻塞状态。操作见 [内部 Alpha 发布手册](docs/INTERNAL_ALPHA_RELEASE.md) 和
  [签名 Beta 配置指南](docs/SIGNED_BETA_SETUP.md)。商店、官网、自动更新和公共托管
  仍未启用。
- 冻结的 Tauri/Python 产品入口已在数据库收敛并获得所有者批准后，于
  2026-07-28 移入 Windows 回收站。
- GitHub 通用仓库解析和第三方 LSP/ripgrep 下载仍是功能依赖；它们不代表
  Arforge 的官网或公共仓库。删除这些能力前必须先由所有者确认。
- `node_modules` 与 `.bun` 是可重建依赖缓存，可清理但会导致下一次安装/启动
  重新下载和链接依赖；不属于产品源码。

完整能力映射见
[融合矩阵](docs/CAPABILITY_FUSION_MATRIX.md) 与
[本地能力审计](docs/LOCAL_PROJECT_READINESS.md)。

多用户部署前请阅读
[用户认证与租户隔离指南](docs/USER_AUTH_AND_TENANCY.md)，其中包含生产环境变量、邮件 Webhook 协议、
PostgreSQL RLS 要求和上线验收步骤。

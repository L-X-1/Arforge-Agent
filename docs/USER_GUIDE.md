# Arforge Agent 用户指南

本文面向 `Arforge 测试 1.00.00 版` 的私有本地使用。产品入口统一为
TypeScript CLI 与 Electron Desktop。

## 1. 启动前检查

```powershell
cd Arforge-Agent
powershell -ExecutionPolicy Bypass -File .\scripts\run_cli.ps1 -ValidateOnly
powershell -ExecutionPolicy Bypass -File .\scripts\run_desktop.ps1 -ValidateOnly
```

两个命令会检查当前工作区、仓库固定版本的 Bun 和 Electron 运行文件。
启动器从本仓库加载代码，不依赖另一份本机工程目录。

## 2. 模型配置

私有密钥文件：

```text
%USERPROFILE%\.arforge\.env
```

```dotenv
DEEPSEEK_API_KEY=replace-with-your-key
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-flash
```

统一运行时的选中模型必须写成 `provider/model`：

```text
%USERPROFILE%\.config\arforge\arforge.json
```

```json
{
  "model": "deepseek-v4-flash/deepseek-v4-flash"
}
```

如果界面一直显示“思考中”，依次检查：

1. 模型是否是完整的 `provider/model`，而不是旧的显示名称。
2. `DEEPSEEK_API_KEY` 是否在用户私有 `.env` 或 Arforge 凭据存储中。
3. 用 CLI 执行一次最小调用：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run_cli.ps1 run `
  "只回复：Arforge模型链路正常" `
  --model "deepseek-v4-flash/deepseek-v4-flash"
```

## 3. PostgreSQL

私有持久模式使用数据库 `arforge`，日常角色必须是最小权限
`arforge_app`。管理员角色只运行迁移、授权与恢复，不启动产品。

首次配置应用角色：

```powershell
# 当前进程临时设置管理员 URL 后执行；不要把管理员 URL 提交到仓库
$env:ARFORGE_DB_URL = "postgresql://admin:password@127.0.0.1:5432/arforge"
powershell -ExecutionPolicy Bypass -File .\scripts\configure_private_postgres.ps1
Remove-Item Env:ARFORGE_DB_URL
```

配置脚本会生成随机应用密码、验证读写往返和拒绝的管理权限，并把应用 URL
写入 `%USERPROFILE%\.arforge\.env`。

备份目录：

```text
%LOCALAPPDATA%\Arforge\backups\postgresql
```

备份文件存在不等于可恢复；必须定期恢复到隔离数据库并比较表数和关键数据。

## 4. 启动 CLI 与桌面端

```powershell
# CLI
powershell -ExecutionPolicy Bypass -File .\scripts\run_cli.ps1

# Desktop
powershell -ExecutionPolicy Bypass -File .\scripts\run_desktop.ps1
```

常用 CLI：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run_cli.ps1 --help
powershell -ExecutionPolicy Bypass -File .\scripts\run_cli.ps1 models
powershell -ExecutionPolicy Bypass -File .\scripts\run_cli.ps1 session list
powershell -ExecutionPolicy Bypass -File .\scripts\run_cli.ps1 capabilities
powershell -ExecutionPolicy Bypass -File .\scripts\run_cli.ps1 capabilities test "plan architecture for a CLI"
powershell -ExecutionPolicy Bypass -File .\scripts\run_cli.ps1 workflow list --json
powershell -ExecutionPolicy Bypass -File .\scripts\run_cli.ps1 workflows events <run-id> --json
powershell -ExecutionPolicy Bypass -File .\scripts\run_cli.ps1 db current --json
powershell -ExecutionPolicy Bypass -File .\scripts\run_cli.ps1 quality package.json
powershell -ExecutionPolicy Bypass -File .\scripts\run_cli.ps1 repo-scale AgentPython `
  --max-files 5000 --limit 10
```

CLI 与 Desktop 共用 Provider、Session、Permission 和 PostgreSQL 状态。不要
同时用旧入口写入同一生产数据。

### 本地 MCP 的依赖目录

当本地 MCP 服务器的入口或依赖放在项目外时，可显式声明需要读取的目录。
在项目目录内，使用 TS CLI 添加配置，例如（替换为你自己的服务器入口）：

```powershell
arforge mcp add docs --read-only-path "..\mcp-server" -- node --preserve-symlinks --preserve-symlinks-main "..\mcp-server\server.mjs"
```

`--read-only-path` 可重复指定，保存到标准 `mcp.servers.<名称>.read_only_paths`。
相对路径以当前工作区为基准，而不是 MCP 的自定义工作目录。保存配置不会自动批准启动；
实际连接时会显示待批准的进程和只读目录，修改目录后须重新批准。
目录必须存在且能解析；批准后目录被替换时会拒绝启动，需检查配置并重新审批。

此选项只增加读取授权，不增加写权限，也不会撤销目录原本已有的工作区写权限。
不要为解决加载错误添加整个磁盘、用户目录或无关项目。当前后端不能维持文件隔离时，
显式只读目录会被拒绝，不会自动切换到较弱的沙箱。

当前 Windows 限制：Bun 1.3.14 在原生隔离中的模块加载仍有失败；仅升级到候选
Bun 1.4.2 也未解决所有只读目录问题。已验证 Node 搭配上述显式参数运行打包后的
SDK MCP 服务器，但不代表任意第三方 MCP 都已通过。Arforge 不会自动换运行时、
修改你的命令或扩大授权。缺少模块时请检查实际入口、依赖范围和运行时兼容性。

### MCP 的启动和请求超时

启动较慢、但连接后响应较快的服务器可以分别配置两个期限，单位都是正整数毫秒：

```powershell
arforge mcp add docs --startup-timeout 15000 --request-timeout 3000 -- node .\mcp-server\server.mjs
```

远程服务器也接受相同两个选项。保存后使用唯一的标准字段
`mcp.servers.<名称>.timeout.startup` 和 `.request`，不会生成另一套超时配置。
配置文件还可以提供全局默认值，例如：

```json
{
  "mcp": {
    "timeout": { "startup": 15000, "request": 3000 },
    "servers": {
      "docs": {
        "type": "local",
        "command": ["node", "./mcp-server/server.mjs"],
        "timeout": { "request": 1000 }
      }
    }
  }
}
```

上例 `docs` 的启动期限是 15000 毫秒，请求期限是 1000 毫秒。
两个字段分别按“服务器配置 → 全局配置 → 内置 30000 毫秒”取值；只设置一个
不会抹掉另一个字段的继承值。0、负数、小数或字符串会被拒绝，原文件保持不变。
旧的单个服务器数字 `timeout` 兼容转换为启动和请求两个相同值；旧的全局
`experimental.mcp_timeout` 数字只作为请求期限，保存时归入标准 `mcp.timeout`。

启动期限约束传输连接和协议初始化；HTTP→SSE 回退共享剩余启动时间，不重新计时。
请求期限供连接后的目录请求、资源读取、提示词、健康检查和工具调用使用。
修改本地服务器任一超时会产生新启动审批；等待你批准的时间不计入协议启动期限。

每个服务器的每类目录遍历现在共享一段 `request` 期限，各页不会重新获得完整时间。
单次完整遍历最多 1000 页、10000 条、10 MiB 的 UTF-8 已解码 JSON 累计量（包含
分页 cursor 和元数据）。超限不发布该次不完整目录，其他服务器的正常目录仍可用；
请缩小服务器暴露的目录范围，慢但正常的完整遍历可以适当调大 request。
同一工作区的目录读取与健康探测共享最多 4 个在途读取名额，取消读取会向 SDK 传递
取消信号；正常可取消的服务连接可以继续使用，不必为了停止等待重启整个服务器。

当前边界：计时从该遍历获得读取名额后开始，不是跨所有服务器和排队时间的总预算。
已解码 JSON 限制也不是 SDK 解码之前的网络响应大小限制。跨服务器累计保留量、
OAuth 令牌交换及第三方关闭流程的总时限仍有待完善。

工具调用也共用原 `request` 配置作为整次协议操作的硬期限：进度通知不能无限延长它；
MCP 长任务的创建、状态轮询、轮询间隔和最终结果等待共用这段时间，不是每次轮询重新计时。
确实需要更久的工具请事先调大该服务器的 request；不会自动另设一份长任务超时配置。
等待用户授权、插件处理和本地持久化收尾不属于这段协议等待时间，因此不能保证整个
界面操作恰好在 request 毫秒内结束。

调用发出后，若超时、连接异常或取消导致结果无法确认，原动作会要求恢复检查，
不会把它当成“远端肯定失败”而自动再执行一次。已收到的远端任务 ID 会保留供原恢复流程
只读查询；服务端明确返回的失败/取消状态仍按明确结果处理。请先确认远端实际状态，
不要直接新建一次可能重复的付款、发布或写入操作。

取消仍是协议请求，不能保证任意远程服务都已停止计算。项目的固定版本 SDK 补丁现已
让轮询休眠可取消：取消时清除轮询定时器，正常结束也移除取消监听器；Gateway 会等待
原任务迭代器完成清理，而不是把它留在后台。非法轮询间隔会被拒绝，不通过计时器溢出
变成高速轮询。超时记录落盘后再强杀进程、新进程拒绝重放的隔离回归已通过；这不代表
所有中途崩溃窗口、第三方远端终止或完整 R13 已验收。

MCP 子调用适配路径现在先保存真实成功结果，再通知插件。若提示
“The action completed and its success was recorded, but postprocessing failed”，
表示远端动作已完成，只是插件后处理出错；请查看原调用结果，不要另建一次重复操作。
插件拿到的是结果和参数副本，不能改写这条成功记录；恢复相同调用时复用原结果，
不重新发出远端请求或补发插件通知。通知属于至多一次执行，强杀进程可能使其未完成，
不承诺恰好一次；重要业务写入不能仅依赖这类通知。后置通知中强杀并用新进程恢复已验证。
外部工具桥接（插件／MCP／CodeMode）的标题、正文和元数据后处理，现已接入同一个
Core 工具管线：先保存原始成功结果，再单独保存合法展示变换，恢复时返回已确认的展示结果。
如果提示 “postprocessing has no confirmed result”，表示实际动作已经完成，但插件处理
没有确认完成；不要另建调用重跑，应先检查原动作记录。处理中和展示结果保存后两处
强杀进程，再由新进程进入相同 Core 工具调用的测试已通过，未重复执行工具或 hook。

旧会话内置工具与 TS 原生计划任务的 after hook 现已进入同一 Core 后处理阶段。
计划任务只走原生 TaskRuntime 和 Core 工具管线；未被正式产品入口使用的兼容任务执行分支、
额外展示消息与回调已退役，历史记录没有因此删除。插件报错或取消不再把已成功的任务
改写成执行失败；任务结果的展示失败会单独说明，不要据此重复启动任务。
若提示 “postprocessing receipt could not be confirmed”，表示动作已完成，但展示阶段回执
没有确认写入；保留原始成功记录，不重跑工具或 hook。取消期间回执写失败也保持取消，
不让父任务把它当普通工具错误继续执行。相同旧调用的已结算结果可在升级后直接复用，不补跑新增 hook；
输入、授权、资源或任务身份不同不能冒用原结果。升级前尚未结算的旧动作不会自动重跑，
请先检查原动作状态。这仍不代表所有工具入口及所有故障窗口已经验收。
原结果及展示结果现在各自按序列化后的 UTF-8 JSON 大小保存：不超过 1 MiB 的仍使用原内联
记录，超过 1 MiB、至多 50 MiB 的使用现有 Artifact／ToolOutputStore 保存精确内容。这个上限
是完整 JSON 的大小，不是正文字符数；给模型的展示仍受原 tool_output 配置限制。
同一调用、同一内容恢复时复用原展示附件回执，不重新生成附件、不延长其保留期限。
若提示 “durable result is unavailable or invalid”，表示原动作已完成，但保存的结果缺失或
校验失败；请先检查原动作和备份，不要另建调用重做。超过上限或原结果无法保存时不会继续
后处理，也不会伪称最终展示已确认。大结果已有真实新进程恢复验证，但历史退役与持久
Artifact 回收及写入中途崩溃仍待验收；回执／会话展示写入故障已有进程内注入测试，
不代表这些中间点均已通过真实强杀恢复，也不能据此认定完整 R08/R09 完成。
插件副作用不能仅依赖展示 hook，原成功落盘到后处理开始之间等其余崩溃窗口也尚未全部
通过实际强杀验收。

当前已知限制：请求发出但未收到任何回复时取消，在同一会话继续提问前必须先处理未知结果。
系统不会把它当成“远端肯定失败”而自动重发；原会话、运行记录、请求摘要、预算和已知账单均保留。
先执行 `arforge session recovery <sessionID> --json`，确认对应运行的 `request.outcome=unknown`、
事件标识、摘要和 `abandonmentBlocker=null`，再执行 recovery 输出的完整
`arforge session abandon-request ... --acknowledge-unknown-outcome` 命令。该命令只记录
“明确放弃等待且不重发”，不会撤销远端效果或退费；没有这个确认，CLI 会拒绝修改。
放弃后无新输入的继续仍会 fail-closed，不会重发旧任务；可以直接提交一个明确的新问题。
如果请求仍有租约、子任务、持久任务或未结算工作，系统会阻止放弃并要求先处理原拥有者。

`quality` 与 `repo-scale` 都通过统一 Server/Core 调用进入 TypeScript/Core
只读 owner，并受当前工作区边界限制。`quality <patch-file>`（`.diff`/`.patch`）
和 `repo-scale <路径> --query <词>` 的旧 Python CLI 写法仍可用；需要消除位置参数
歧义时使用 `quality --patch-file <文件>`。桌面端“Session operations”中提供相同的
质量门禁、仓库规模和有界搜索界面。

插件管理也只有一个 TypeScript/Core owner。旧的 `plugins` 入口是
`plugin-manager` 的兼容别名，省略动作时列出插件，并支持旧的
`list/inspect/install/update/remove/restore/enable/disable` 语法；写操作仍经过
控制审批和可恢复事务。旧 root 位置参数只有在形如
`<workspace>/.arforge/plugins` 时才会转换，其它路径会在变更前给出退出码 2，
不会静默切换到另一个目录。

Agent 质量指标也只有一个 TypeScript/Core owner。使用
`arforge agent-metrics --json` 查看成功率、工具调用、无效动作、首次计划、
恢复、验证和补丁回归等指标以及正式/纵向门禁；`agent-metrics history`
读取最近快照，`agent-metrics record` 记录一条快照，`agent-metrics --clear`
清理本地历史。遥测源缺失或坏行会明确显示为 `n/a`/证据不足，不会让主会话
失败；命令不打开第二套 Python 数据库或状态机。

多模态诊断也只有一个 TypeScript/Core owner：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run_cli.ps1 multimodal-diagnose .\error.log --json
powershell -ExecutionPolicy Bypass -File .\scripts\run_cli.ps1 multimodal-diagnose .\index.html --mode frontend --limit 10
powershell -ExecutionPolicy Bypass -File .\scripts\run_cli.ps1 multimodal-diagnose .\broken.js --mode javascript --text "const app = ;"
```

`--workspace` 指定诊断根目录；文件必须位于该目录内。`--text` 可在没有可读
文件时提供提取文本，长度上限为 500000 个字符；`--limit` 为 1–50 的代码
匹配上限。默认 `error` 模式提取 traceback/异常/缺失模块信号，`frontend`
和 `javascript` 模式复用同一个确定性前端检查器。JSON 会给出来源、信号、
匹配、建议和 `summary`；所有模式均为本地只读，`localOnly=true`、
`modelCalls=0`，不会运行 JavaScript、访问网络或写入文件。`python -m arforge`
和安装后的 `arforge` 旧入口转发到同一 TS 命令。

功能策略查看也只有一个 TS/Core owner：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run_cli.ps1 features list --json
powershell -ExecutionPolicy Bypass -File .\scripts\run_cli.ps1 features --workspace .
```

该命令读取 Desktop 共用的 typed `agentCapability.deepInsights`，只返回
TS-native 功能项，不读取或创建旧 Python `feature_flags.json`。历史
`features set <flag> <on|off>`、`clear <flag>`、`refresh` 会保留参数校验，
但在缺少事务式、带权限的 TS 写入 owner 时以退出码 2 `fail-closed`；这样
旧入口不会生成第二个功能状态源。

需要查看迁移边界而不触碰任何策略文件时，可运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run_cli.ps1 features --contract-audit --json
```

报告固定为 `read-only-feature-policy-contract-audit`、`not_ready`、零写入，
并列出恢复旧写入 owner 之前必须补齐的 durable 状态、身份授权、事务、回滚、
跨进程、审计和清理要求。Desktop 的 `feature-policy-contract` section 返回同一
TS/Core 报告；旧 `feature_flags.json` 不会被读取。

深度诊断还会显示 `file-state` 合同审计。该只读 section 说明当前为什么
不能把旧进程内文件 tracker 当作跨进程、可重启恢复的观察账本，并列出
observation journal、run/session 绑定、授权、取消、事务结算和 evidence
等尚缺要求；历史 `file-state` 命令在 owner 完整前继续以退出码 2
`fail-closed`，不会创建或读取旧 tracker 状态。

系统概览还会显示 `cost-optimization` 合同审计，说明当前缺少 durable
成本归因、provider 定价版本、token 对账、跨进程聚合、重启恢复、证据和
清理策略。历史 `cost-optimization` 命令在 owner 完整前继续退出码 2
`fail-closed`，不会读取或创建旧成本 tracker，也不会把局部统计当作可结算账本。

权限规则查看也由 TS/Core 统一提供：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run_cli.ps1 permissions list --json
powershell -ExecutionPolicy Bypass -File .\scripts\run_cli.ps1 permissions --workspace .
```

`permissions list` 读取当前工作区 typed `permission.saved.list` 返回的已保存
规则，与 Desktop 共用同一数据源。历史 `permissions add <subject> <category>
<decision> [scope]` 和 `permissions revoke <rule-id>` 只做参数校验；在事务、
授权、审计和回滚合同完成前以退出码 2 `fail-closed`，不会回退到 Python
`permission_rules.json` 或创建第二状态源。

权限写入迁移边界可用以下只读审计查看：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run_cli.ps1 permissions --contract-audit --json
```

该报告固定为 `read-only-permission-policy-contract-audit`、`not_ready`、零写入，
并明确 typed rule、工作区绑定、授权、事务、乐观版本、审计、回滚和跨进程缺口。
Desktop 的 `permission-policy-contract` section 与此命令共享同一 TS/Core owner，
不会读取旧 Python `permission_rules.json`。

工作流的 canonical 命令是 `workflow`。历史 `workflows list/validate/run/runs/status/events`
以及 `pause/resume/cancel/retry/approve/reject` 会归一到相同的 typed graph
owner；`status` 映射为 `get`，`events` 支持有界 `--after`/`--limit`。
`workflows run <file>` 不带 `--execute` 时生成确定性的 dry-run 报告；带上
`--execute` 时启动同一个持久化图运行并等待完成、暂停或人工审批。`--report`
指定的相对路径必须位于当前工作区，省略时写入 profile data；整个过程不会
启动 Python 执行循环或创建第二份 graph journal。

查看本地 SQLite 的 TypeScript migration ledger 可使用
`arforge db current --json`（人类模式则显示 `main: <revision>`）。历史
`arforge db-current` 入口会归一到同一个只读 owner，不会自动执行迁移；
`multiagent` 与其余旧 `db-*` 迁移/回滚命令在 typed owner、权限和恢复证据完成前
保持退出码 2 的 fail-closed 边界。

运行历史可使用 `arforge run-history [run-id] --json` 查看有界、脱敏的事务/trace
报告；历史 `arforge replay [run-id]` 只是同一 TS/Core 只读 owner 的别名，不会
重跑模型、工具或副作用。

如果把一个不存在的裸词当作命令输入，统一 CLI 会返回退出码 2、指出未知命令并
给出 `arforge --help`；不会把拼写错误误判为 TUI 项目路径而只显示“不是 TTY”。
已有的工作区路径和显式命令仍保持原有路由，`main.py`、Windows `arforge.cmd`、
`python -m arforge` 与 Bun/TS 入口共享这一边界。

学习召回质量也可以直接查看：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run_cli.ps1 learning recall --json
```

该命令只把 Core 的 `Memory.recallQuality` 与 `Learning.status` 做确定性只读组合，
返回 Top-1、MRR、样本数、模式数和学习回合；不会运行 `dream/consolidation`，不会
调用模型、写入数据库或修改工作区。`learning dream` 现在也进入同一 TS/Core
workspace-scoped owner，返回已观察学习状态的确定性洞察/建议；它明确标记
`executionMode=read-only-core-projection`，不会自动 consolidation、调用模型或写入模式。

`capabilities test <输入>` 是迁移期的安全路由预览：它只显示确定性关键词
匹配、分数和命中词，并明确标记 `executed: 0`；不会调用模型、执行 shell 或
写入文件/数据库。`--execute` 在所有能力具备 typed Core 执行合同前会 fail-closed。

如需查看迁移准备度，可运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run_cli.ps1 capabilities evaluate --json
```

该审计只读取 TypeScript/Core 能力目录，逐项检查 typed 输入/输出、
ActionGateway 授权、取消、evidence、settlement 和 owner 声明；不会调用
handler、模型、shell、文件或数据库。报告中的 `fail-closed` 表示合同尚未
证明，不是运行失败，也不会因目录中出现能力就自动授予权限。

查看控制中心共用的只读系统概览：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run_cli.ps1 capabilities overview --json
```

该命令通过同一个 typed `agentCapability.systemOverview` 返回运行时、工具、
子代理角色和成本合同 section；追加 `--all` 可展开 section 数据，不会调用
handler、模型、shell 或写入路径。

长期记忆档案使用统一的 TypeScript/Core 入口：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run_cli.ps1 memory digest --json
powershell -ExecutionPolicy Bypass -File .\scripts\run_cli.ps1 memory digest --category workflow --path .\memory-digest.md
powershell -ExecutionPolicy Bypass -File .\scripts\run_cli.ps1 memory conflict --json
powershell -ExecutionPolicy Bypass -File .\scripts\run_cli.ps1 memory metrics --json
powershell -ExecutionPolicy Bypass -File .\scripts\run_cli.ps1 memory write-stats --json
powershell -ExecutionPolicy Bypass -File .\scripts\run_cli.ps1 memory recovery --json
```

`memory digest` 只读取当前工作区可见记忆，按类别和重要性稳定排序；
`--digest-limit` 可将读取量限制在 1–500 条，JSON 的 `truncated` 为 `true`
时表示已达到上限。`--path` 是显式 Markdown 文件写入；不带 `--path` 的人类
输出会同步到 profile 的 `memory-digest.md`，旧 Python 命令仍由同一 TS owner
处理。

`memory conflict` 是只读冲突诊断入口：它运行 Core 共享的确定性基准，并读取
当前工作区通过 `conflictList` 已持久化的候选（`--conflict-limit` 为 1–500）。
它不会在查询时调用会写入冲突历史的 `conflictScan`，因此空的 `persisted.items`
表示当前没有已持久化候选，而不代表系统替用户完成了全量扫描；JSON 中的
`relation_coverage.status` 固定为 `not_comparable`，避免把候选数冒充人工关系
覆盖率。旧 Python `memory conflict` 入口也只转发到这一 TS/Core 报告。

`memory metrics` 是只读 Core 指标组合：包括记忆状态、召回质量、已持久化冲突
和有界来源计数。旧 Python golden eval 需要隔离 fixture 写入，历史
`memory_metrics.jsonl` 也尚未由 TS producer 接管，因此 JSON 会明确返回
`golden_eval.status=not_comparable` 与 `history.status=not_read`，不会隐式写入。

`memory write-stats` 同样只做只读数据库投影，显示工作区/全局/隔离/重要记忆、
来源、类型和作用域计数；旧 Python `memory_writes.jsonl` 的 eligible/reason/saved
决策事件尚无等价 typed producer，所以报告中的 `decision_log.status` 为
`not_read`。`memory write-stats --clear` 在该合同完成前保持退出码 2，不会删除历史文件。

`memory recovery` 只读聚合 profile-local `recovery_outcomes.jsonl`，显示已验证恢复、
待重建状态、近 7 天趋势和 `corrupt_rows`；文件缺失会返回 0 计数，不会创建文件。
旧 producer 尚未由 TS/Core 接管，`memory recovery --clear` 保持退出码 2，不删除迁移期证据。

`memory feedback <retrieval_uid> --useful 1,2 --irrelevant 3` 目前只接受并校验历史
语法，然后明确以退出码 2 fail-closed：TS/Core 尚无可跨进程定位的 durable retrieval
event、returned-set 校验、工作区/身份绑定和事务更新，因此不会写入 recall feedback，
也不会回退旧 Python 数据库。缺少 retrieval UID、ID 非正整数或同一 ID 同时出现在两类
反馈中，会在任何状态变化前返回可操作错误。

如需查看该迁移边界的结构化说明，可运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run_cli.ps1 memory feedback --contract-audit --json
```

这是与 Desktop 深度诊断相同的只读合同审计，不需要 retrieval UID，不读取旧
Python 数据库，也不会写入 recall feedback。
Desktop 深度诊断的 `memory-feedback` section 与该 CLI 返回同一份 TS/Core
合同，角色切换不会放宽边界。

## 5. 安全使用

- 只对可信工作区授予写入或命令执行权限。
- 阅读审批卡中的命令、目标路径和风险；取消/无输入应视为拒绝。
- 不把 `.env`、数据库 URL、完整日志或用户数据发送给他人。
- 日志与导出前仍需检查脱敏结果。
- Go/Ruby/PHP 等外部运行时缺失时，Arforge 会报告不可用；不会把未启动的
  Docker Desktop 误判为可用。

完整状态见 [本地能力审计](LOCAL_PROJECT_READINESS.md) 和
[融合矩阵](CAPABILITY_FUSION_MATRIX.md)。

运维与恢复入口：

- [数据库迁移手册](DATABASE_MIGRATION_RUNBOOK.md)
- [数据库备份与恢复](DATABASE_DEPLOYMENT.md)
- [私有 HTTPS 部署](PRIVATE_HTTPS_DEPLOYMENT.md)
- [依赖归属与许可文件处理策略](DEPENDENCY_ATTRIBUTION_POLICY.md)

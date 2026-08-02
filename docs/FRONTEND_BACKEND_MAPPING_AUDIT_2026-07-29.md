# Arforge 前后端能力闭环审计（方案 B 实施结果）

状态：方案 B 已实施；生产 PostgreSQL 凭据仍需管理员侧同步  
审计日期：2026-07-29  
权威机器报告：`artifacts/ui-capability-audit.json`

## 1. 结论

当前工程在“后端能力有唯一归属”和“需要 UI 的公开能力可从前端完成行为闭环”
两个层面均已闭环。

- 生成的公开 Server API：170 个（新增 `privateOperations.overview`）；
- 唯一归属登记：170/170，重复 0，遗漏 0；
- 明确属于 SSE、事务、分页或内部读取的传输方法：10 个；
- 需要 UI 闭环的方法：157 个；
- 已通过直接调用或成熟 SDK 语义界面闭环：157 个（100%）；
- 已确认仍缺 UI/前端生命周期接线：0 个；
- 旧 Python Bridge：191/191 个方法都有唯一运行时所有者，其中 61 个保留为受限
  Python 能力，130 个由 TypeScript 原生能力拥有；
- CLI 当前有 36 个顶层命令。CLI 生命周期、服务启动、调试和高风险私人运维命令
  不应机械转换成 36 个桌面按钮。

100% 是按 API 方法计数的工程指标，不是按用户价值加权的完成度。

## 2. 为什么原来的“169/169 已映射”不足以证明完成

`control-center-map.ts` 能证明每个生成客户端方法被分配到了全局控制中心、会话控制
中心、工作区界面或内部传输中的一个位置。它不能证明：

1. 对应组件真的调用了该方法；
2. 写操作具有预览、确认、恢复和错误反馈；
3. 成熟 SDK 的旧命名与新 Server API 实际表达同一行为；
4. 一个 API 名称出现在“能力映射”页面就等于用户能使用它。

本次新增 `script/ui-capability-audit.ts` 和
`packages/app/src/capabilities/ui-capability-review.ts`，将直接调用证据与人工语义复核
分开。任何新增公开方法没有登记，或任何没有直接调用的方法没有人工归因，审计都会
失败。

## 3. 已完成闭环

| 产品闭环 | 已接线方法 | 实施状态 | 展示位置 | 已实现交互和安全边界 |
| --- | --- | --- | --- | --- |
| Diagnostics Workbench | `diagnostics.diagnose`、`agentCapabilities.repoScale`、`agentCapabilities.qualityAssess` | 已完成 | 全局控制中心 → 诊断 / 运行报告 | 三个独立子页；只读；明确输入范围、扫描上限和“不会调用模型” |
| Memory 治理 | `memories.create`、`memories.status`、`memories.governancePreview`、`memories.governanceApply` | 已完成 | 全局控制中心 → Memory / Learning | 新建表单；状态卡；治理 Preview → 候选 → 二次确认 → Apply；按保留来源恢复 |
| Learning 治理 | `learning.status`、`learning.undo` | 已完成 | 全局控制中心 → Memory / Learning → Learning | 展示 recent、patterns、impact；Undo 前说明关联 Pattern 的递减/删除影响 |
| 私有 Feedback 闭环 | `feedback.submit`、`feedback.list`、`feedback.summary`、`feedback.delete` | 已完成 | 提交：当前 Session 控制中心；治理：全局 Memory / Learning → Feedback | 1–5 分、类别、正文；仅本机存储；删除时说明撤销关联 Learning outcome |
| OAuth 生命周期 | `integrations.attemptCancel` | 已完成 | Provider 连接对话框内部 | Back、关闭、切换方式时取消服务端 attempt；幂等；不影响已完成连接 |

合计 14 个原缺口方法已全部接线；另新增 1 个只读私有运维总览方法。

## 4. 明确不应制造按钮的方法

以下不是 UI 缺失：

- `memories.get`：`memories.list` 已返回完整 `Memory.Info`，详情卡无需为了单条 GET
  再制造一个按钮；
- `learning.record`：由运行时和 Feedback 自动记录；
- `learning.syncDogfood`：有界数据导入/维护操作，不属于普通用户按钮；
- SSE、`sessions.wait/stage/commit`、分页和请求事务等 10 个传输方法；
- CLI 的 `serve`、`web`、`attach`、`acp`、`completion`：进程和协议入口；
- CLI 的 `debug`、`db`：开发/诊断入口；
- `upgrade`、`uninstall`：产品生命周期命令；
- `clear-data --apply`、真实数据库恢复、日志实际删除：高风险管理操作。

这些能力可以显示状态或操作指引，但不能用普通按钮直接执行。

## 5. CLI 私有运维是否进入 Desktop

当前 Desktop 的“私有运维”只是命令说明，不读取实际运行状态。可选范围如下：

### 方案 A：最小闭环

只实现第 3 节的 14 个公开 API 缺口。私人运维继续保留 CLI。

- 优点：范围最小、风险最低、交付最快；
- 缺点：备份时间、恢复演练结果、日志预览和凭据扫描仍要去 CLI 查看。

### 方案 B：只读运维总览（已实施）

在方案 A 基础上，新增受限的只读 Server API，Desktop 展示：

- Doctor 5 项健康状态；
- 全局 token / 成本统计；
- 最近备份时间、文件校验状态；
- 最近恢复演练时间、逐表差异；
- 凭据扫描摘要；
- 日志保留预览。

实际备份、恢复、清理、删除仍只允许通过 CLI/专用管理流程执行。

- 优点：普通界面可看全局状态，同时不扩大破坏性权限；
- 缺点：需定义新的只读运维 Schema 和数据来源，工作量高于方案 A。

### 方案 C：完整管理模式

在方案 B 基础上加入备份、恢复演练、日志应用和 `clear-data` 的图形化向导。

- 优点：Desktop 能覆盖绝大多数私人运维；
- 缺点：必须增加再次认证、一次性计划、超时、不可重放、备份校验、恢复隔离和审计
  日志。普通控制中心与管理模式必须隔离，风险和验证成本最高。

## 6. 实施结果

1. OAuth attempt 在 Back、关闭和切换方式时自动取消，完成/失败/过期后不误取消；
2. Diagnostics Workbench 分离 Multimodal、Repo Scale、Quality；
3. Memory 支持创建、Status、治理 Preview → Confirm → Apply，并按保留来源恢复；
4. Learning 展示 recent、patterns、impact，Undo 明示关联 Pattern 影响；
5. Session 支持 Feedback 提交，全局支持 list、summary、delete；
6. 私有运维总览读取 Doctor、token/成本、备份、恢复演练、凭据摘要和日志预览；
7. 破坏性备份、恢复、清除和日志删除仍留在 CLI/专用管理流程。

## 7. 尚未计入“完成”的质量问题

新增闭环在简体中文和繁体中文下提供完整文案，其余受支持语言使用安全英文回退，
专业术语保持英文。既有 Session 控制中心仍有历史英文文案；它不属于 API 映射缺失，
但仍是后续完整母语翻译的质量债务。

生产验收另有一个独立阻塞：当前 Windows 私有 `ARFORGE_DB_URL` 仍指向旧数据库
`arforge`，且其中 `arforge_app` 的随机密码与 PostgreSQL 角色不一致，实际连接返回
`28P01`。只读 API 已在隔离 SQLite 运行时完成端到端验证；生产 PostgreSQL 必须由
管理员凭据重新执行 `script/configure-postgres-app-role.ps1`，并把目标数据库统一为
`arforge_ma` 后再完成 Desktop 点击验收。

# Step 7.12：Experience / Skill Durable Lifecycle 实施证据

日期：2026-08-13
计划来源：`Arforge-最终详细实施计划-V2-2026-08-11.md` 7.12 阶段 7 退出门禁

## 实施结果

本步骤已把 Memory、Experience、Skill 三个域的状态和生命周期分离到可持久化数据库服务：

- `ExperienceStoreV1` 持久化 Evidence、Support、Candidate、Offline Evaluation、Experience Record 和审计链。
- `SkillStoreV1` 持久化 Skill Version、独立测试 Evaluation、Canary Observation、Deployment Pointer 和审计链。
- 所有服务读写都带 `tenant_id + owner_user_id`；HTTP 层从 `IdentityContext.Current` 派生身份，不接收客户端 tenant、user 或 actor 字段。
- Evidence 只有内部 verifier sink 可以写入；公共 Learning telemetry 会剥离 durable Run、Action、Evaluation、Evidence 引用，不能铸造 verified authority。
- Evolution candidate 不再接受直接 Experience/Evidence/Evaluation 快照，只能通过 `sourceExperienceIDs` 加载 canonical provenance。
- Skill 编译器增加纯函数 artifact 编译入口；候选 Skill 必须有 verified Experience、确定性测试、独立评估、人工 Canary/Promotion，且保留 CAS、幂等重放和 Rollback。

## 数据库与跨进程持久化

- SQLite 迁移：`20260813025236_stage7_durable_experience_skill`。
- PostgreSQL 迁移：`20260813031000_stage7_durable_experience_skill`。
- 新增 11 张 durable 表：6 张 Experience 表、5 张 Skill 表；PostgreSQL 迁移增加 owner-level FORCE RLS 和最小权限授权。
- Learning 的三张表同步收紧为 tenant + owner 隔离策略。
- 未使用单进程内存同步或单进程文件写入作为生命周期事实来源。

## 合同/API

新增私有 Agent Capability API：

- Experience candidate list/get/review。
- Skill lifecycle candidate list/get/create、Canary、Promotion、Rollback、Deployment lookup。
- API 响应只返回 canonical projection、digest、revision、审计可重放所需的 receipt；没有 Evidence 快照写入口。
- OpenAPI 与 `packages/sdk/js/src/v2/gen` 已重新生成并通过 SDK 类型检查。

## 验证记录

以下命令均在项目根目录按 `ARFORGE.md` 入口规则执行：

| 检查 | 结果 |
| --- | --- |
| `tsgo --noEmit`：schema / protocol / core / server | 通过 |
| Stage 7 durable E2E | 1 pass，50 assertions |
| Learning / Evolution / Verifier 回归组合 | 25 pass，228 assertions |
| OpenAPI/JS SDK 生成 | 成功；新 lifecycle operation 已出现在合同与 SDK |
| JS SDK 类型检查 | 通过（使用临时 tsbuildinfo，不写入用户文件） |
| JS SDK 现有测试 | 2 pass，3 assertions |

Stage 7 E2E 覆盖真实 Durable Run → Action/Observation → Verifier Evidence → Evaluation → Experience → Skill candidate → deterministic tests → Canary → Promotion → Rollback；同时覆盖 Evidence drift、permission expansion、幂等重放、CAS drift、审计链和跨 tenant 隔离。

## Git/范围说明

- 本步骤已创建本地 checkpoint 提交：`9648c32f complete durable experience and skill lifecycle`。
- 未执行任何远程 push。
- 既有 `packages/sdk/js/tsconfig.tsbuildinfo` 保持未暂存、未提交；`.codex-analysis/` 与 `tmp/` 也未纳入本步骤。

## 退出状态

Step 7.12 的实现与专门回归已完成；按照计划，在进入阶段 8 前仍必须完成阶段 0–7 的独立总审查、质量修复和复验。本证据不授权跳过该总审查。

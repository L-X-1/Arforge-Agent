# Step 7.7 / Step 7.12 — Skill 独立评测与 canary 观察闭环

日期：2026-08-23

分支：`codex/phase-0-checkpoint`

## 当前结论

本轮关闭了 Skill candidate 创建后的真实用户断点：候选详情现在返回持久化评测报告和摘要自校验的
canary 观察汇总；桌面端不再要求用户手写评测 JSON，而是按确定性测试逐项记录基线、候选、资源消耗、
安全计数和已验证证据。评测通过后可显式启动本地 canary，但在达到最小真实观察数、成功率和零安全事故
之前，后端与界面都保持 fail-closed，用户看不到“晋级”操作。

本轮属于本地功能完善，不包含发布、部署、签名、staging、发布 canary、Git 推送或真实模型调用。

## 计划映射

| 计划要求                              | 本轮闭环                                                                                              |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Step 7.7.1–3 隔离、独立测试与基线对照 | 引导式表单逐项绑定 candidate 的确定性 `test_id`，分别记录 baseline/candidate 结果与 steps/tokens/cost |
| Step 7.7.4–5 效用、安全和成本门禁     | 必须记录新增失败、敏感信息发现、联网尝试并显式确认；核心层生成 canonical evaluation report 和 digest  |
| Step 7.7.6 人工审批前保持候选关闭     | 表单只记录独立运行结果，不执行模型、不虚构证据；提交成功也不会启用 Skill                              |
| Step 7.12 canary 观察与晋级门禁       | 候选详情投影 observation count、success rate、安全事故和策略阈值；未达阈值时不渲染晋级按钮            |
| Step 8.8 Skill Center 用户入口        | 在统一 Skill lifecycle 工作台展示评测结果、canary 进度、来源说明和受控状态变更                        |

## 用户路径

1. 在“工作流、插件与技能”中选择一个待评测 Skill candidate。
2. 按每个确定性测试选择基线和候选的通过/失败结果，并填写步骤、Token 与成本。
3. 填写候选新增失败、敏感信息发现和联网尝试，选择属于该候选的已验证证据。
4. 明确确认安全计数来自本次独立测试运行，再记录结果。
5. 评测通过后填写决策理由与 canary 流量，并显式开始本地 canary。
6. 查看“真实观察数 / 最低要求、成功率 / 最低要求、安全事故”；只有 canonical 观察全部满足策略时才出现晋级入口。

表单为空时不能误提交，错误会定位到首个字段。输入只更新嵌套 store 字段，不替换整行 DOM，连续输入、
复选和键盘焦点保持稳定。界面明确说明“记录独立测试结果”与“自动执行测试”是两件不同的事。

## 后端与安全边界

- candidate 详情仍按可信 identity 的 tenant + owner 查询，客户端不能提交主体字段。
- 持久化 evaluation 必须与 candidate digest、report digest、passed 指针一致，否则读取 fail-closed。
- 每条 canary observation 重新解码并校验 candidate/status 列、canonical record digest；任一损坏记录都会阻断详情和晋级。
- 晋级与界面共用同一 canary 汇总语义：最少 3 条观察、成功率至少 0.95、零安全事故。
- canary observation 不是用户手工创建的数据；核心 Stage 7 测试通过完整 Durable Run、Runtime Evaluation 与
  verified Evidence 管线产生 3 条 canonical 观察后，才得到 `promotion_ready=true`。
- 桌面 E2E 则专门证明 0 条观察时 candidate 保持 `canary`、`promotion_ready=false`，且界面不显示晋级按钮。

## 合同与实现

- `packages/core/src/skill-store.ts`：owner-scoped candidate detail、评测完整性校验、canonical canary 汇总及晋级复用。
- `packages/schema/src/agent-capability.ts`：`SkillLifecycleCandidateDetail` 与 `SkillCanarySummary`。
- `packages/protocol/src/groups/agent-capability.ts`、`packages/server/src/handlers/agent-capability.ts`：详情 HTTP 合同与 handler。
- `packages/client/src/generated*`、`packages/sdk/js/src/v2/gen/*`、`packages/sdk/openapi.json`：同步生成客户端和 OpenAPI。
- `packages/app/src/components/control-center/skill-evaluation-form.ts`：受约束输入模型、字段错误和 payload 构造。
- `packages/app/src/components/control-center/governance-workbench.tsx`：引导式评测、持久报告、canary 进度和 fail-closed 操作入口。
- `packages/app/e2e/desktop-evolution-visibility.acceptance.ts`：打包 Electron 用户路径、正式 API 回读和门禁断言。

## 可复现验证

```text
(packages/core) bun test test/stage7-experience-skill-e2e.test.ts --rerun-every
  1 pass, 0 fail, 70 assertions

(packages/app) bun test src/components/control-center/skill-evaluation-form.test.ts
  3 pass, 0 fail, 16 assertions

(packages/server) bun test src/experience-skill-openapi.test.ts
  1 pass, 0 fail, 6 assertions

(packages/sdk/js) bun test
  2 pass, 0 fail, 3 assertions

(packages/client) bun test
  17 pass, 0 fail, 80 assertions

(packages/app) bun test --preload ./happydom.ts ./src
  1032 pass, 0 fail, 3575 assertions

(各受影响 package) typecheck
  schema、protocol、core、server、client、sdk/js、app、app E2E：全部通过

(packages/app) bun run test:e2e:desktop:workflow
  passed

(packages/app) bun run test:e2e:desktop:repeat
  3/3 passed；52446 ms、51927 ms、52333 ms；每轮隔离 profile；未忽略 flaky failure
```

OpenAPI 结构断言确认 candidate create 仍返回 `SkillLifecycleCandidate`，candidate GET 返回
`SkillLifecycleCandidateDetail`，并存在 evaluate、canary observations、evaluation report 和 canary summary 合同。

## 桌面证据

- `artifacts/desktop-repeatability-audit.json`：
  `6B9403EAC92076B475B98860527FCE893A144FA81BF9B4C99D21E9495C410E92`。
- `artifacts/desktop-typescript-runtime-visibility-audit-run-3.json`：
  `6F6B25025240F253CC0320109C6DDFF561DE3FFED14EC955653F6C1E10F5F8D3`。
- 第三轮证据：`skillEvaluationGuidedFormVisible=true`、`skillEvaluationRecorded=true`、
  `skillCanaryStayedFailClosed=true`、renderer errors = 0、failed requests = 0。
- `packages/sdk/openapi.json`：
  `A75D7C77E072E5532DFE6729AADA49D3FFB5067FD841BFE2BB3B3DD1A014EC49`。

## 开发期边界

1. 表单记录由独立测试产生的结果，不声称 Arforge 已自动运行这些测试。
2. 本轮未调用 DeepSeek 或任何真实 provider，未产生模型费用。
3. 本地 Skill canary 是功能生命周期门禁，不等同于发布部署或生产流量 canary。
4. 工作树仍有其他阶段的未提交变化；checkpoint 只暂存本工作包明确文件或代码块。

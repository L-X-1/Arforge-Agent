# Step 8.8 / Step 7.6 — 已验证 Experience 到 Skill candidate 的用户闭环

日期：2026-08-23

分支：`codex/phase-0-checkpoint`

## 当前结论

本轮关闭了计划 Step 7.6“选择已验证 Experience，再生成 Skill candidate”在桌面端的真实用户入口，
并把它接入 Step 8.8 Plugin/Skill Center。用户不再需要手工猜测或复制内部 Experience ID：服务端只列出
当前可信主体拥有的、可复用且摘要校验通过的 Experience；桌面端提供基础字段、来源选择和折叠的高级
合同/测试设置；提交后只产生不可变 `candidate`，不会安装、启用、灰度或部署。

本轮属于本地功能完善，不包含 Step 8.10/8.11 的发布、部署、签名、staging、canary 运维或 Git 推送。

## 计划映射

| 计划要求 | 本轮闭环 |
| --- | --- |
| Step 7.6.1 选择已验证 Experience | 新增 owner-scoped `GET /api/agent-capabilities/experience/sources`，桌面端以可读摘要、证据数量和时间供用户勾选 |
| Step 7.6.2–6 生成 bounded candidate、校验、扫描、确定性测试、digest/store | 复用既有 `SkillStoreV1.createCandidate` / compiler 门禁；界面只收集有界合同并调用正式 Server API |
| Step 7.6.7 请求评测和人工审批 | 创建后明确显示“未启用或部署”；评测数据仍为空，后续变更继续由已有显式门禁控制 |
| Step 8.8 Plugin/Skill Center | 在现有 Skill lifecycle 工作台加入渐进式候选创建入口，并完成能力分级、OpenAPI、Client、SDK 与桌面 E2E |

## 用户路径

1. 打开控制中心的“工作流、插件与技能”。
2. 在“技能生命周期”展开“创建技能候选”。
3. 填写 Skill ID、版本、用途、触发条件和受限说明。
4. 从界面列出的“已验证经验来源”中选择 1–20 条；没有来源时，界面指向经验候选审核入口。
5. 普通用户可保留默认 JSON 合同和确定性测试；工具、能力、策略及测试细节折叠在“高级设置”。
6. 点击“创建候选（不会启用）”；成功后列表切换到 candidate，并显示未启用/未部署回执。

表单提供可见标签、字段级错误、首个错误自动聚焦、加载反馈、44px 级交互目标和键盘焦点样式。

## 后端与安全边界

- 身份由 `IdentityContext.Current` 提供，客户端不能提交 tenant/user/actor。
- 查询按 tenant + owner 过滤，跨租户/跨用户结果为空。
- 每条来源重新解码 `AgentRuntime.ExperienceRecord`，校验 `reusable`、record/run/evidence 绑定和 canonical digest；
  任一来源损坏时 fail-closed，不把不可信记录投影到界面。
- API 只返回候选创建所需的安全投影，不返回原始 Action、Run、Evidence 内容或秘密。
- candidate 输入仍由核心层验证 Experience provenance、文件/路径、脚本、命令、网络、secret 和确定性测试合同。
- 桌面 E2E 直接读取正式 API，确认新对象为 `candidate`、`evaluation_passed=null`，且只绑定用户选择的
  已验证 Experience；没有自动 install/enable/canary/deploy。

## 交付文件

- `packages/core/src/experience-store.ts`：确定性、owner-scoped、摘要自校验的 Experience 来源列表。
- `packages/schema/src/agent-capability.ts`、`packages/protocol/src/groups/agent-capability.ts`、
  `packages/server/src/handlers/agent-capability.ts`：安全响应 schema、HTTP 合同和可信身份 handler。
- `packages/client/src/generated*`、`packages/sdk/js/src/v2/gen/*`、`packages/sdk/openapi.json`：生成客户端合同。
- `packages/app/src/components/control-center/skill-candidate-form.ts`：有界输入解析和字段错误模型。
- `packages/app/src/components/control-center/governance-workbench.tsx`：渐进式候选创建用户界面。
- `packages/app/e2e/desktop-verified-experience-fixture.ts`：从真实 Durable Run、ActionGateway、独立 Verifier、
  Evaluation 到人工批准的测试来源管线。
- `packages/app/e2e/desktop-evolution-visibility.acceptance.ts`：打包 Electron 用户路径和 fail-closed 断言。

## 可复现验证

```text
(packages/core) bun test test/experience-candidate.test.ts ... test/stage7-experience-skill-e2e.test.ts
  18 pass, 0 fail, 126 assertions

(packages/server) bun test src/experience-skill-openapi.test.ts src/tenant-platform-openapi.test.ts
  2 pass, 0 fail, 3 assertions

(packages/app) bun test --preload ./happydom.ts ./src
  1029 pass, 0 fail, 3559 assertions

(各受影响 package) bun run typecheck
  packages/app, app E2E, core, schema, protocol, server, client, sdk/js：全部通过

(packages/app) bun e2e/desktop-evolution-visibility.acceptance.ts
  passed

(packages/app) bun run test:e2e:desktop:repeat
  3/3 passed；53536 ms、53157 ms、52510 ms；每轮隔离 profile；未忽略 flaky failure
```

独立 `{}` oxlint 配置下，本轮 11 个新增/独立文件为 `0 warnings, 0 errors`。三个共享旧文件仍报告 7 个
既有 unused 警告；逐项与 `HEAD` 对照后确认这些警告在本轮前已存在。本仓库根 `.oxlintrc.json` 的
`options.typeAware` 与当前 oxlint 配置 schema 不兼容，因此未把根配置失败伪报为本轮代码通过。

## 生成链与桌面证据

- 隔离 Client 生成目录与工作树的 `generated/client.ts`、`generated/types.ts`、`generated-effect/client.ts`
  SHA-256 完全一致。
- SDK 的 ExperienceSource schema、endpoint types 和 SDK method 在去除生成器分号/格式差异后 token 完全一致；
  OpenAPI path 与两个 schema JSON 完全一致。
- `artifacts/desktop-repeatability-audit.json`：
  `EF800E7693F689E56D52CABE88335DD66A12F372188D920EAFC037BAFAA21FEF`。
- `artifacts/desktop-typescript-runtime-visibility-audit-run-3.json`：
  `FACB73A83677EA5289E9109351A99B89069D280E57554D584513D9288C140E6E`。
- 第三轮证据：`skillCandidateCreationVisible=true`、
  `skillCandidateCreatedFromVerifiedExperience=true`、`skillCandidateStayedClosed=true`、
  renderer errors = 0、failed requests = 0。

## 开发期边界

1. 本轮没有获取或伪造生产 Experience；桌面 E2E 的三条来源由隔离临时数据库中的真实验证管线创建。
2. 本轮没有自动生成评测观测，也没有替用户批准、灰度、推广或回滚。
3. 工作树仍有此前阶段的大量未提交变化；checkpoint 必须只暂存本工作包的明确文件/代码块。
4. 发布部署阶段继续排除；本地功能交付不依赖 DigiCert、staging 或 signed release。

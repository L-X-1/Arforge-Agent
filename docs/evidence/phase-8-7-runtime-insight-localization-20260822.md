# Step 8.7 Runtime Insight / 会话流程用户可读性证据

日期：2026-08-22
范围：开发阶段本地验证；不包含发布、部署、staging、canary、rollback 或 Git 推送。

## 目标

继续完成 Step 8.7 的安全投影：运行状态、授权、风险等级、恢复、工作流深层字段和会话执行过程不能把内部枚举、内部错误类名或未翻译字段直接交给普通用户。

## 本轮改动

- 新增共享的纯展示层 `packages/app/src/components/control-center/runtime-insight-presentation.ts`，统一处理中英文/繁体中文、未知值、时间、模型标识、错误原因和状态标签。
- Runtime Insight 与 Session Process Panel 复用同一套展示函数，不再直接显示 `riskTier`、内部 authority/status 枚举或 `unselected/unselected`。
- 将常见后端错误投影为可执行提示：未配置模型、服务无响应、提供商未授权、内部异常；保留面向用户的正常原因文本。
- 桌面验收增加原始模型错误字段泄漏门禁，并兼容 Windows Electron 在 profile 根目录或 `profile/session` 下生成的 `DevToolsActivePort`。
- 修正性能 mock-server 测试桩，使其符合 Playwright `Route.request()` 的真实接口（method/headers）。

## 验证结果

| 验证项 | 结果 |
|---|---|
| Runtime Insight 定向测试 | 3/3 通过，14 assertions |
| App 全量单测 | 1023/1023 通过，3545 assertions，149 files |
| App TypeScript typecheck | 通过 |
| App E2E TypeScript typecheck | 通过 |
| 性能单元套件 | 59/59 通过，106 assertions，13 files |
| Desktop build | 退出码 0；保留既有 Vite 动态导入、eval、module script 和 wasm map 警告 |
| Desktop 端到端验收 | 通过；`rendererErrors=[]`、`failedRequests=[]` |
| Desktop 重复性验收 | 3/3 通过；`flaky_failures_ignored=false`；每轮独立 profile |

## 端到端证据

- `artifacts/desktop-typescript-runtime-visibility-audit-runtime-user-facing-v3.json`
  - `runtimeTopology=typescript-core`
  - `workflowDeepFieldsLocalized=true`
  - `personalWorkspaceMetadataLocalized=true`
  - `runtimeInsightVisible=true`
  - `durableRuntimeEvidenceVisible=true`
  - `rendererErrors=[]`
  - `failedRequests=[]`
- `artifacts/desktop-typescript-runtime-insight-runtime-user-facing-v3.png`：失败运行卡片显示“尚未配置可用模型。请在设置中选择提供商和模型后重试”，不再显示 `ProviderModelNotFoundError` 或 `unselected/unselected`。
- `artifacts/desktop-repeatability-audit.json`
  - 3 轮退出码均为 0
  - 轮次耗时：53360ms、51658ms、49046ms
  - 生成时间：2026-08-22T11:14:20.796Z

## 结论

本轮 Step 8.7 的 Runtime Insight / 会话流程深层字段用户可读性和桌面重复性验证通过。当前仍是本地开发 checkpoint，未形成任何发布或部署证据；后续继续按计划审查 Step 8.8/8.9 的功能边界和真实用户流程。

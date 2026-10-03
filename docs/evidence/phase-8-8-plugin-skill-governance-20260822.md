# Step 8.8 / 8.9 开发阶段审查证据（2026-08-22）

## 范围

本批次只处理开发阶段的用户体验、错误投影和桌面验收，不执行发布、部署、staging、签名、canary/rollback 发布流程，也不推送 Git。

- Step 8.8：Plugin/Skill Center 的生命周期入口、技能评测结果和部署回执可读性。
- Step 8.9：租户治理入口、数据请求、备份回执和审计回执的用户可理解性。
- 会话工作流：步骤、运行和节点错误不得把内部模型错误或异常类直接展示给用户。

## 本批次修复

1. 技能评测的 `no_new_*`、`utility_non_regression` 等合约键改为中/英/繁体可读标签；未知键使用安全的空格化回退。
2. 技能部署状态不再渲染原始 JSON，改为带标签的部署回执，只显示技能、当前/上一候选、代次和截短证据摘要。
3. 控制中心治理操作遇到结构化异常时不再把原始对象 `JSON.stringify` 到页面；内部 `Error`/`Exception`/stack trace 只显示当前操作的可读回退。
4. 会话工作流的 workflow、step、run、node 错误统一经过公开错误投影；模型未配置时给出“到设置中选择提供商和模型”的下一步提示。
5. 桌面验收增加技能生命周期入口可理解性和内部合约字段泄露检查。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| App 全量单测 | 1026 pass / 0 fail / 3551 assertions / 150 files |
| 目标错误与技能展示单测 | 10 pass / 0 fail / 13 assertions |
| App typecheck | 通过 |
| App E2E typecheck | 通过 |
| 性能单测 | 59 pass / 0 fail / 106 assertions / 13 files |
| Desktop build | 通过；保留项目既有未使用导入、eval、动态分包和 wasm map 警告 |
| Desktop evolution visibility acceptance | 通过，exit code 0 |
| Desktop repeatability | 3/3 通过，3 个隔离 profile，未忽略 flaky failure |

桌面验收证据：

`artifacts/desktop-typescript-runtime-visibility-audit-step88-governance.json`

关键断言均为 `true`：

- `skillLifecycleGovernanceVisible`
- `skillLifecyclePresentationLocalized`
- `managedSkillDisableApprovedAndExecuted`
- `managedSkillEnableApprovedAndExecuted`
- `pluginInspectionVisibleBeforeMutation`
- `pluginInstallApprovedAndStartsDisabled`
- `pluginUpdateApprovedAndStartsDisabled`
- `blockedPluginRejectedBeforeMutation`
- `pluginRemovalRecoverable`
- `tamperedPluginRestoreRejectedWithoutMutation`
- `tenantDataRequestVisible`
- `tenantBackupReceiptVisible`
- `tenantAuditReceiptVisible`

验收运行在隔离 profile 的 `build` 模式，`packagedDesktop=false`；这证明当前开发构建的桌面路径可重复通过，不代表已完成发布环境证据。

重复性证据：`artifacts/desktop-repeatability-audit.json`（`completed_rounds=3`、`passed=true`、`flaky_failures_ignored=false`、`isolated_profile_per_round=true`）。

## 结论与后续

Step 8.8/8.9 的本批次前端可用性缺口已修复并验证。插件/技能后端合同、租户后端合同和现有审批/回收边界未被绕过；本批次没有把发布阶段 Step 8.10 的 signed release、staging 或运维证据伪装成已完成。下一步继续按计划做剩余开发阶段审查与功能验证。

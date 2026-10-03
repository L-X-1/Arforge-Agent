# Step 8.9 租户治理用户界面 checkpoint（2026-08-22）

## 本轮结论

本轮只处理开发阶段的前端可理解性与本地验收，不涉及发布、部署、staging、签名、canary、rollback 或推送。

发现并修复了一个权限文案不一致：后端治理操作允许 `owner/admin`，界面此前只提示 Owner。现在统一说明为“具备租户管理员权限（Owner 或 Admin）”，数据请求审批也明确为独立的管理员操作。

同时补充了两个不会误导用户的边界说明：

- 备份区域当前创建和校验的是摘要绑定的 manifest，不会在桌面端复制或恢复数据；
- 审计导出当前生成安全回执和摘要，不会在界面下载密钥内容。

审批确认弹窗也按当前语言显示“批准/拒绝”和请求类型，避免中英混排。

## 验证证据

| 检查 | 结果 |
| --- | --- |
| `packages/app` 单元测试 | 1026 pass，0 fail，3551 assertions |
| App typecheck | passed |
| Desktop E2E typecheck | passed |
| Desktop build | passed；仅保留既有构建器 warning |
| 本地桌面用户验收 | passed；新增管理员边界、审计记录数非空断言 |
| 桌面重复性验收 | 3/3 轮通过；未忽略 flaky failure；每轮使用独立 profile |
| 新验收报告 | `artifacts/desktop-typescript-runtime-visibility-audit-admin-copy.json` |

重复性报告：`artifacts/desktop-repeatability-audit.json`。

新报告中 `tenantGovernanceVisible`、`tenantDataRequestVisible`、`tenantBackupReceiptVisible`、`tenantAuditReceiptVisible` 和 `skillLifecyclePresentationLocalized` 均为 `true`；`rendererErrors` 与 `failedRequests` 均为空。

## 交付边界

这证明的是本地 TypeScript Core + Desktop build-mode 的用户路径，不是签名发布包或 staging 证据。Step 8.10/8.11 的发布与运维门禁仍按用户要求不执行。

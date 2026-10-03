# Step 8.9 租户平台治理用户体验证据（2026-08-15）

## 范围

本轮只处理开发阶段的本地产品功能和桌面用户体验，不执行发布、部署、staging、canary、rollback、签名发行或 Git push。

审查结论：8.9 的本地 Server API、数据库/RLS、策略、数据权利、备份清单、审计导出和密钥撤销能力已经存在；此前租户治理页仍把三类回执直接显示为原始 JSON，普通用户必须理解后端字段名。本轮补齐了安全的可读投影。

## 已完成的用户层修复

- 概览现在同时显示租户、区域、待处理数据请求、以最小货币单位计的已结算用量、已结算记录数和活跃限流窗口数。
- 平台策略增加单位说明；配额、保留天数、请求速率、突发量和密钥版本仍由服务端校验。
- 数据权利请求改为“请求回执”卡：显示请求类型、状态、请求时间、ID 和短证据摘要；完整摘要只保留在可追溯的 `title` 属性中，主视图不渲染原始后端字段名。
- 备份校验改为“备份清单”卡：显示区域、Schema 版本、创建/校验时间、状态和短产物摘要；保留显式 Verify 操作。
- 审计导出改为“审计导出回执”卡：显示包含记录数、创建时间、ID 和短导出摘要。
- 状态、数据权利类型、日期和数字按 English / 简体中文 / 繁體中文显示；其他已支持语言不再错误回退为简体中文。
- 所有上述入口仍由 typed Server API 执行；Owner 边界和服务端权威说明保留在首屏。

## 验证结果

| 检查 | 结果 |
|---|---|
| 租户展示纯函数测试 | `3 pass / 0 fail / 10 assertions` |
| App 类型检查 | `bun run typecheck` PASS |
| 桌面 E2E 类型检查 | `bun run typecheck:e2e` PASS |
| App 单元全量 | `1020 pass / 0 fail / 3526 assertions / 149 files` |
| 隔离桌面验收 | PASS；数据权利回执、备份创建/校验、审计回执、Workflow 深层字段均可见 |
| 桌面网络/渲染错误 | `failedRequests=0`，`rendererErrors=0` |
| 桌面可重复性 | `3/3` 轮通过；`flaky_failures_ignored=false`；每轮使用隔离 profile |

验收产物：[desktop-typescript-runtime-visibility-audit-tenant-receipts2.json](../../artifacts/desktop-typescript-runtime-visibility-audit-tenant-receipts2.json)。

## 后端边界与剩余范围

- 本轮真实点击的是本地 Server API 的安全操作：导出租户数据请求、创建并校验备份清单、导出审计回执；没有点击租户数据删除，也没有进行物理删除。
- 回执卡是安全投影，不替代后端授权、数据库 RLS、密钥环或审计链；服务端仍是最终权限边界。
- 本地端到端闭环已验证；真实多租户部署、跨机器密钥管理、staging 和正式发布证据仍属于计划中的发布/运维范围，本开发阶段不纳入交付判断。
- 构建成功但仍有仓库既有的 Vite 动态导入、未使用导入、`eval` 和 wasm map 覆盖警告；这不是本轮功能失败，后续可作为独立工具链清理项处理。

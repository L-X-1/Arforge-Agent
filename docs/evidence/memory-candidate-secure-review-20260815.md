# Memory Candidate 安全审查闭环证据（2026-08-15）

## 范围

本轮是开发完善，不包含发布、部署、签名或远程推送。对应实施计划：

- Step 5.3：Memory Candidate 与 active memory 分离；
- Step 5.4：model/auto 只能进入 candidate，secret/credential 默认拒绝；
- Step 5.5：决策包含 CAS、actor、reason、policy version 与不可变审计；
- Step 5.12：scope 隔离、secret leak 为 0；
- Step 8.7：Personal Workspace 为 memory candidate 提供明确、安全的用户入口。

## 已验证合同

1. model/auto 写入先创建 workspace-scoped candidate，不直接创建 active memory。
2. 人工批准只把 candidate 变为 approved；激活是第二个独立动作。
3. policy=review 可由用户批准并转为 allow；policy=deny、duplicate、conflict、working、secret 均 fail-closed。
4. 凭据样式内容在持久化前脱敏并标记为 secret；审查 API 不返回正文，桌面 DOM 不出现原值。
5. proposed、approved、rejected、activated 均在同一数据库事务中追加不可变审计。
6. 决策使用 expectedUpdatedAt CAS；陈旧决策失败并提示刷新。
7. candidate 读取和 Personal Workspace 投影同时按 tenant、owner、project、workspace 隔离；global scope 单独处理。
8. SQLite 与 PostgreSQL 均具有候选审计表、工作区绑定字段、索引；PostgreSQL 强制 RLS，应用角色仅获审计表 SELECT/INSERT。
9. Personal Workspace 显示内容、来源、策略、重复检查、保留策略、阻断原因和审计；拒绝使用二次确认。
10. 深层状态和已知后端原因已本地化；展开卡跨两栏，操作中有 aria-busy 与状态反馈。

## 新鲜验证结果

- Core typecheck：通过。
- Protocol typecheck：通过。
- Server typecheck：通过。
- App 与 App E2E typecheck：通过。
- Core Memory 全测试族：54 tests、233 assertions，通过。
- App 候选 API、本地化与 Personal Workspace：7 tests、23 assertions，通过。
- Server OpenAPI：4 个候选端点均存在，通过。
- SDK embedded lifecycle：批准、激活、凭据隐藏、拒绝、跨真实工作区隔离，17 assertions，通过。
- SQLite migration check：无未生成 schema 变化，通过。
- PostgreSQL migration：本地开发库已到 `20260815103339_memory_candidate_workspace_scope`。
- PostgreSQL smoke：通过。
- PostgreSQL RLS：38 张业务表强制 tenant policy，28 checks，通过。
- Desktop build：通过。
- Desktop isolated acceptance：通过。
- Desktop repeatability：3/3 通过，未忽略 flaky failure；报告见 `artifacts/desktop-repeatability-audit.json`。
- 安全审查界面截图：`artifacts/desktop-memory-candidate-secure-review.png`。

## 结论与边界

Memory Candidate 已具备可由普通用户完成的审查、批准、激活和拒绝闭环，后端具备事务、审计、CAS、凭据 fail-closed、租户与工作区隔离。该结论只覆盖本地开发与隔离桌面验收，不构成发布环境、签名发布或生产运维证据。

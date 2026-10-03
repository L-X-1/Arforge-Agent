# Workflow 深层字段与治理工作台 UX 回归证据

- 日期：2026-08-15
- 范围：本地开发环境、隔离 Electron profile；未执行发布、部署、staging、signed release、canary、rollback 或 Git push。
- 对照计划：Step 6.12 / 6.13、Step 8.7 / 8.8 / 8.9 的桌面用户可见性与回归部分。

## 本次收敛

1. Workflow presentation 将运行状态、节点类型、访问范围、权限模式、调度动作、执行模式、条件、依赖、尝试次数和时间单位改为显式三语映射；繁体中文不再回退到简体中文。
2. Governance workbench 的 Experience、Skill、Tenant 入口使用用户可理解的中文标题；状态徽章将 `candidate`、`canary`、`active`、`retired` 等内部值转换为可读标签，保留必要的 Owner/ID/JSON 技术边界。
3. 私有运维面板增加 `aria-busy`、可见 `role=status` 加载反馈；离开该页造成的 `private-operations/overview` 请求取消只在验收器中按精确 URL 白名单处理，不放宽其他网络错误。
4. Control Center capability map 补齐 Memory Candidate 的 review/approve/reject/activate 方法，避免前端功能存在但映射审计缺项。

## 验证结果

| 检查 | 结果 |
|---|---:|
| Workflow presentation 专项测试 | 4 pass / 0 fail，28 assertions |
| App unit | 1016 pass / 0 fail，3511 assertions |
| App browser tests | 32 pass / 0 fail，75 assertions |
| Root TypeScript typecheck | 22/22 tasks successful |
| Desktop repeatability | 3/3 rounds pass，未忽略 flaky failure |

重复性报告：`artifacts/desktop-repeatability-audit.json`。三轮均使用隔离 profile，耗时分别为 66.617s、66.500s、66.838s；对应 runtime audit 的三轮均满足：

- `workflowDeepFieldsLocalized=true`；
- `experienceGovernanceVisible=true`、`tenantGovernanceVisible=true`、`skillLifecycleGovernanceVisible=true`；
- `failedRequests=[]`、`rendererErrors=[]`；
- 每轮记录 45 个能力面响应。

本轮用户路径包含 Workflow 定义发现、深层字段预览、审批后完成验证、Experience/Skill/Tenant 治理入口、Skill/Plugin 生命周期、Memory、Runtime insight、Personal Workspace、Personal Jobs、Team、通知深链接和 Session 回退/恢复路径。

## 计划边界

本证据证明的是开发阶段的真实桌面路径和用户可见性，不把入口可见性冒充成发布环境证据。计划 Step 8.10 / 8.11 所需的 staging、签名制品、canary/rollback、SLO 和 release owner 证据按用户要求保持未执行。

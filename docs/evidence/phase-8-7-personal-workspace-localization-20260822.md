# 阶段 8.7 Personal Workspace 本地化与安全投影证据

- 日期：2026-08-22
- 范围：开发质量完善与本地验证；未执行发布、部署、staging、canary、rollback 或 Git 推送。
- 对照计划：`Arforge-最终详细实施计划-V2-2026-08-11.md` 的 Step 8.7。

## 本轮修复

Personal Workspace 之前把后端枚举直接渲染到用户界面，可能出现 `not_required`、`system_automatic`、`scoped_grant`、`riskTier`、`initiator` 等内部字段；选择非中文语言时，人工处理提示还可能回退成简体中文。

本轮完成：

1. 新增纯展示层 `packages/app/src/components/control-center/personal-workspace-presentation.ts`，集中处理状态、可见性、批准状态、发起者、授权类型、风险等级、时间和工作区文案。
2. Personal Workspace 改为展示用户可理解的 safe projection；未知枚举只做安全的下划线转空格，不展示字段名本身。
3. 人工处理提示对英文、简体中文、繁体中文保持一致；其他已支持语言使用英文安全回退，避免错误混入中文。
4. 时间格式跟随当前界面语言，而不是固定使用系统区域设置。
5. 将纯展示逻辑从 Solid 路由组件中分离，单元测试可在 Bun server 环境稳定运行，不再触发客户端路由 API 的测试隔离问题。
6. 桌面验收增加 raw enum/internal field 审查，防止回归。

## 验证结果

| 检查 | 结果 |
|---|---|
| Personal Workspace presentation 单元测试 | 5 pass / 0 fail / 17 assertions |
| 与 tenant presentation 联合目标测试 | 8 pass / 0 fail / 27 assertions |
| App 全量单元测试 | 1022 pass / 0 fail / 3535 assertions / 149 files |
| App TypeScript typecheck | 通过 |
| Desktop E2E typecheck | 通过 |
| Desktop build | 成功；保留既有构建 warnings，未将 warnings 虚报为零 |
| Desktop direct acceptance | 通过；`personalWorkspaceMetadataLocalized=true`、`workflowDeepFieldsLocalized=true`、`failedRequests=0`、`rendererErrors=0` |
| Desktop repeatability | 3/3 通过；未忽略 flaky failure，三轮均为 exit code 0 |

## 证据文件

- 直接验收：`artifacts/desktop-typescript-runtime-visibility-audit-workspace-labels.json`
- 可重复性：`artifacts/desktop-repeatability-audit.json`

直接验收中的 HTTP 400 仅来自计划要求保留的 retired customization boundary 和篡改插件恢复拒绝路径，均已被验收脚本列为预期安全响应；没有失败请求、renderer error 或 bootstrap diagnostic。

## 结论与剩余边界

Step 8.7 的用户可见本地化和 safe projection 回归门禁已补齐。该证据不替代 Step 8.8 Plugin/Skill Center 或 Step 8.9 多租户平台的完整工程退出门禁；本轮也没有触碰 Step 8.10 平台发布与运维范围。

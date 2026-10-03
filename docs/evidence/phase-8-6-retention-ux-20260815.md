# Step 8.6 Personal AI OS — retention UX follow-up

- 日期：2026-08-15
- 范围：本地开发功能与桌面用户体验；未执行发布、部署、staging、签名、canary、rollback 或 push
- 分支：`codex/phase-0-checkpoint`

## 本轮修复

后端和 schema 已支持 `PersonalJob.retainUntil` 与 `RetentionActiveError`，但前端此前没有提供保留期入口，也没有解释终态任务为何暂时不能删除。本轮补齐：

- 高级设置新增删除保护预设：无保护、7 天、30 天、90 天、1 年；只提交截止时间，不接触 secret 明文。
- 终态任务卡片显示保护截止时间；保护期内删除按钮禁用并提供可理解的原因，服务端仍保留最终 fail-closed 校验。
- helper 对固定预设和时间计算提供确定性单元测试；桌面 E2E 选择 7 天后刷新任务，必须看到真实持久化后的截止时间。
- 中文、繁体中文和英文均提供用户可读文案；保留策略明确说明“只延迟可见记录删除，审计历史仍持久保留”。

## 新鲜验证

```text
App Personal Job + Workflow unit       PASS 8/8, 47 assertions
App full unit                          PASS 1017/1017, 3516 assertions
App browser                            PASS 32/32, 75 assertions
App typecheck                          PASS
E2E typecheck                          PASS
Desktop acceptance (retention2)        PASS; personalJobsRetentionVisible=true
Desktop acceptance network/render      failedRequests=0, rendererErrors=0
Desktop capability responses           45
Desktop repeatability                  3/3; flaky_failures_ignored=false
Desktop profiles                       isolated_profile_per_round=true
```

证据文件：`artifacts/desktop-typescript-runtime-visibility-audit-retention2.json`、`artifacts/desktop-repeatability-audit.json`。

## 边界

本轮仍不宣称跨进程平台 worker、真实第三方 provider、staging、多租户生产验证或 Step 8.10/8.11 发布门禁完成。桌面构建退出码为 0，但保留仓库已有的 Vite 分包、source map 覆盖和 Electron 开发 CSP 提示，未将这些提示伪装成零警告。

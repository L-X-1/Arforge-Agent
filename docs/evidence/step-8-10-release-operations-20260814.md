# Step 8.10 — 平台发布与运维证据（2026-08-14）

## 本轮范围

本轮把发布证据、依赖溯源、签名 fail-closed、Core PostgreSQL 发布回滚、SLO/告警和事件/泄露
响应固化为可执行脚本与 runbook。真实代码签名 provider 和受保护 workflow reviewer 不在本机
授权范围内，因此本轮只生成 candidate evidence，不宣称 signed release。

## 已交付

- `script/release-evidence.ts`：从 Bun lockfile 生成 CycloneDX 1.6 SBOM、license、provenance、
  source/tree/lockfile digest、artifact checksum 和 signature binding；`--require-signed` 缺少
  真实证据时失败。
- `packages/core/test/release-evidence.test.ts`：确定性输出、checksum/篡改检测和 candidate 不可升级为 signed。
- `docs/CORE_POSTGRES_RELEASE_RUNBOOK.md`：当前 TypeScript Core 的备份、迁移、RLS、canary 和
  恢复回滚顺序。
- `docs/RELEASE_OPERATIONS_RUNBOOK.md`：candidate→canary→signed→review 生命周期与 release owner 清单。
- `specs/ops-slo-v1.json`：SLO、error budget 和 tenant/migration/backup critical alerts 规范。
- `packages/core/src/runtime/slo.ts` 与 `script/evaluate-slo.ts`：将 SLO 规范落成可执行的聚合证据
  evaluator；缺失/非法窗口、tenant isolation、RLS、restore mismatch 或 cleanup 证据均不会通过。
- `packages/core/test/runtime/slo.test.ts`：通过窗口、缺失证据、隔离/恢复/RLS 失败和非法窗口回归。
- `script/release-gate.ts`、`specs/release-gate-v1.json` 与 `packages/core/test/release-gate.test.ts`：
  将 signed release、SLO report、canary receipt、rollback digest 和 release owner checklist 做
  交叉 digest 校验；默认 `DO_NOT_SHIP` 非零退出。
- `script/run-canary.ts`、`specs/canary-receipt-v1.json` 与 `packages/core/test/run-canary.test.ts`：
  只读 `/global/health` canary harness；限制请求/超时/观察窗口，拒绝 URL 凭据和业务 payload，
  记录失败原因、p95、错误预算和 rollback digest。
- `script/release-environment-preflight.ts`、`specs/release-environment-preflight-v1.json` 与
  `packages/core/test/release-environment-preflight.test.ts`：仅检查签名、staging、OTLP 和数据库
  环境配置是否存在且格式安全；缺失或非法配置默认 `blocked`，不输出 secret 值。
- `script/audit-stage8-exit.ts`、`specs/stage-8-exit-v1.json`、`docs/STAGE_8_EXIT_GATE.md`：为
  Step 8.11 建立五项 digest-bound 退出审计；缺失、篡改或越界 evidence 默认 `DO_NOT_EXIT`。
- `docs/INCIDENT_RESPONSE_RUNBOOK.md`：incident、数据/secret 泄露、密钥轮换和发布事故流程。

## 本地可复现 rehearsal

工作树包含其他阶段未提交改动，因此明确使用 `--allow-dirty`，结果只能作为 candidate：

```text
bun run script/release-evidence.ts -- --allow-dirty --output artifacts/release-evidence-step8-10 --source-date-epoch 0
=> status=candidate, files=4, signed=false
bun run script/release-evidence.ts -- --verify --output artifacts/release-evidence-step8-10
=> status=candidate, verifiedFiles=4
bun run ops:slo:evaluate -- --input packages/core/test/fixtures/slo-window-passing.json --output artifacts/slo-report-step8-10.json --require-pass
=> decision=SHIP, activeAlerts=0 (synthetic contract fixture only)
bun run ops:release:gate -- --release-evidence artifacts/release-evidence-step8-10-final --slo-report artifacts/slo-report-step8-10.json --canary-receipt artifacts/missing-canary.json --owner-evidence artifacts/missing-owner.json --report-only
=> decision=DO_NOT_SHIP, failedChecks=signedReleaseEvidence,canary,releaseOwner
```

`run-canary.ts` 的 3 个测试覆盖 healthy response、HTTP/JSON/network failure、凭据/query/path、
请求上限和 rollback digest 边界；当前没有 staging origin，因此本轮没有生成或宣称真实 canary
receipt。

当前进程的只读 release preflight：

```text
bun run ops:release:preflight -- --report-only --output artifacts/release-environment-preflight.json
=> status=blocked, missing=signing.provider/signing credentials/client certificate/staging.origin/telemetry.otlp_endpoint, secretsPrinted=false
```

因此 Step 8.11 退出审计尚未获得可提交的五项真实 evidence，不执行 EXIT。

新增的真实租户演练入口为 `db:tenant:rls-delete-drill`。它只在显式配置的本机 PostgreSQL 上运行，使用事务回滚
清理测试租户；运行结果必须与 recovery drill 报告一起作为 `tenant_rls_backup_delete_drill` 的 evidence，不能用
SQLite 单元测试替代。

新增 `audit:stage8:local-evidence` 固定套件执行器，已覆盖 A2A revoke/不可升级和 PersonalJob 后台可见/可停/可审计
路径；产物只作为 local-integration 候选证据，仍不能替代真实 staging 或 release-owner 证据。

`audit:stage8:manifest` 会将当前 checkpoint、三类本地报告和缺失的外部 evidence 组装成可审计输入；缺失项保持
`missing`，不会因本地测试通过而自动关闭 Step 8.11。

已按授权执行一次 DeepSeek 实网候选实验：

```text
bun run audit:stage8:deepseek -- --authorize-live --output artifacts/stage8-deepseek-experiment.json
=> requestsUsed=3, model=deepseek-v4-flash, status=fail, decision=DO_NOT_PROMOTE
=> baseline=0/1, multi=0/1; all three attempts reported finishReason=length and produced no valid JSON
```

报告记录了 input/output/total token 与耗时，`secretsPrinted=false`、`productionDataChanged=false`、
`stagingDataChanged=false`。三次授权请求已用尽，本轮不再重试；该失败报告不能填充
`baseline_and_multi_agent_gain`，也不改变退出门禁结论。

后续 runner 已改为强制结构化结果工具调用，并将单次输出上限设为 512 tokens，以针对本轮
`finishReason=length` 做受控修复；这只是代码改进，不构成新的实网证据，必须取得新的实网授权后才能运行。

输出包含 2,438,252 bytes 的 CycloneDX SBOM（2,186 个 lockfile components，其中 1,357 个有
安装包 license 声明，829 个诚实标为 `NOASSERTION`）、`provenance.json`、`signature-status.json`、
manifest 和 SHA-256 checksum。manifest 明确记录 `source.dirty=true`、固定
`source_date_epoch=0`，且签名状态为：`No real signing evidence was supplied; candidate is not a
signed release.` `NOASSERTION` 组件必须在真实发布审查中逐项补充或接受明确的 license 风险决定，
不能被自动转换成 pass。

## 仍然阻断的人工项

1. Windows Authenticode/RFC 3161 真实签名、证书主体和 KeyLocker/HSM 证据必须由受保护 workflow
   和外部 release reviewer 提供。
2. SLO 规范与 fail-closed evaluator 已固化，但生产 OTLP/告警后端仍需把真实聚合窗口输入
   evaluator；dashboard、notification route 和值班 owner 仍需在部署环境中配置并留存截图/导出证据。
3. canary 的真实 production-like 流量与跨区域恢复需要独立环境授权；本地 PostgreSQL 恢复演练
   已在 Step 8.9 记录，但不替代生产演练。

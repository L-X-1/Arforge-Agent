# Arforge Release Operations Runbook

## 状态模型

发布状态必须按以下顺序推进：

`source candidate → reproducible candidate → staging canary → signed candidate → release review`

candidate 不等于 signed。没有真实 Authenticode/RFC 3161 证据、受保护环境 reviewer、签名材料
清理和 artifact digest 绑定时，状态必须保持 `candidate` 或 `blocked`，不能改写 JSON 冒充通过。

进入签名/canary 前先运行环境 preflight；它只输出变量名、状态和缺失项，不输出任何值：

```powershell
bun run ops:release:preflight -- `
  --output artifacts/release-environment-preflight.json
```

默认 `blocked` 会以非零退出；`--report-only` 只能用于诊断。preflight 通过不等于 release 通过，
后续仍必须提供真实签名、SLO、canary、rollback 和 release owner evidence。

## 生成与验证证据

受控、干净工作树中：

```powershell
bun install --frozen-lockfile
bun run release:evidence -- `
  --output artifacts/release-evidence `
  --channel beta `
  --artifact packages/desktop/dist/arforge-desktop-win-x64.exe `
  --require-clean

bun run script/release-evidence.ts -- `
  --verify `
  --output artifacts/release-evidence
```

该命令生成 CycloneDX 1.6 SBOM、`provenance.json`、`signature-status.json`、manifest 和
SHA-256 checksum。依赖 provenance 来自 `bun.lock` 的 resolution/integrity 记录；时间戳来自
`SOURCE_DATE_EPOCH` 或提交时间，不使用运行时当前时间，因此输入不变时证据内容可重现。

本地 rehearsal 若工作树包含未提交开发改动，必须显式使用 `--allow-dirty`，并在报告中标为
candidate；这种输出禁止分发。

## 签名 gate

真实 Windows 签名由受保护的 `.github/workflows/desktop-signed-candidate.yml` 完成。签名证据
必须包含每个 artifact 的 SHA-256、Valid Authenticode、RFC 3161 timestamp、签名主体、
`private_key_export_blocked=true`、required reviewer approval 和 signing material cleanup。

```powershell
bun run script/release-evidence.ts -- `
  --output desktop/release-evidence `
  --channel beta `
  --artifact packages/desktop/dist/arforge-desktop-win-x64.exe `
  --signature-evidence desktop/release-evidence/signed-candidate.json `
  --require-clean `
  --require-signed

bun run script/release-evidence.ts -- `
  --verify `
  --output desktop/release-evidence `
  --require-signed
```

没有 DigiCert/其他受信 provider 的真实证据时，只能运行不带 `--require-signed` 的 candidate
流程；不要创建 `signed-candidate.json` 假数据。

发布最终 gate 必须同时绑定签名 release、SLO report、canary receipt 和 release owner evidence：

```powershell
bun run ops:release:gate -- `
  --release-evidence desktop/release-evidence `
  --slo-report artifacts/slo-report.json `
  --canary-receipt artifacts/canary-receipt.json `
  --owner-evidence artifacts/release-owner-evidence.json `
  --output artifacts/release-gate.json
```

该命令默认 fail-closed；任一文件缺失、digest 不匹配、SLO 未通过、canary 未通过或 owner checklist
不完整都会退出非零。`--report-only` 仅用于诊断，不能用于发布。

Canary 只允许显式指定无凭据的 staging origin，并只请求只读 `/global/health`：

```powershell
bun run ops:canary:run -- `
  --base-url https://staging.example.invalid `
  --artifact packages/desktop/dist/arforge-desktop-win-x64.exe `
  --rollback-artifact-digest <previous-release-sha256> `
  --cohort beta-20260814-a `
  --traffic-percent 5 `
  --requests 20 `
  --output artifacts/canary-receipt.json
```

脚本拒绝 URL 中的凭据、query、fragment 和任意业务路径；receipt 必须证明所有请求成功、p95 不超过
750ms、无 critical alert，并绑定不同的 rollback artifact digest。没有真实 staging origin 时不得
用 fixture receipt 代替 canary 证据。

## Canary、停止和回滚

- canary 前必须完成 Core PostgreSQL runbook、备份 digest、schema revision 和 SLO baseline。
- SLO baseline 必须由聚合且已脱敏的窗口证据生成：

  ```powershell
  bun run ops:slo:evaluate -- `
    --input <slo-window.json> `
    --output <slo-report.json> `
    --require-pass
  ```

  缺字段、窗口无效、租户隔离异常、迁移/RLS 失败、恢复 mismatch 或临时库未清理都会输出
  `DO_NOT_SHIP`；这份 report 不能由手工改 JSON 绕过。

- canary 只允许固定 cohort，记录 candidate digest、traffic percent、观察窗口、错误预算和
  rollback artifact；异常时先停止扩大流量。
- 触发 critical tenant isolation、secret exposure、migration mismatch、backup failure 或
  预算/限流失控告警时，自动停止 promotion，人工确认后回到上一份已签名 release。
- 应用回滚和数据库恢复分开记录；不得用数据库 down migration 代替恢复演练。

## Release owner checklist

发布 owner 必须在证据包中确认：source commit/tree、lockfile digest、SBOM/license review、
artifact hashes、签名与 timestamp、reviewer、canary 结果、SLO/告警 baseline、backup restore
drill、rollback owner、incident contact 和未关闭风险。任一项缺失，release gate 为 `DO_NOT_SHIP`。

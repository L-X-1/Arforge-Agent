# Release Environment Onboarding

本文件说明如何取得 Step 8.10 所需的真实 signed release、staging canary 和 rollback 证据。
这些资源必须由组织的 release owner/DevOps/安全管理员提供；它们不能由本地 fixture、临时 JSON
或自签名证书替代。

## 责任边界

| 资源 | 提供者 | 用途 |
| --- | --- | --- |
| DigiCert KeyLocker 或组织批准的受信代码签名服务 | 安全/发布管理员 | 生成 Authenticode 与 RFC 3161 timestamp |
| GitHub `desktop-release-candidate` Environment | 仓库管理员 | 保护签名 workflow 的变量、secret 和 reviewer |
| 隔离 staging origin、PostgreSQL、备份和遥测 | DevOps/平台管理员 | 迁移、SLO、canary、恢复演练 |
| 上一个已签名 release 及 SHA-256 | release owner | 绑定 rollback artifact |
| reviewer、incident contact、owner checklist | 发布负责人 | release gate 人工证据 |

## GitHub 签名环境

在仓库 Settings → Environments → `desktop-release-candidate` 配置，不要把 secret 写入仓库或聊天：

变量：

- `ARFORGE_WINDOWS_KEYPAIR_ALIAS`
- `ARFORGE_WINDOWS_EXPECTED_SIGNER_SUBJECT`
- `SM_HOST`

Secrets：

- `SM_API_KEY`
- `SM_CLIENT_CERT_PASSWORD`
- `SM_CLIENT_CERT_FILE_B64`（客户端 `.p12` 文件的 Base64 内容）

workflow 会固定使用 `digicert-keylocker`，在受保护的 Windows runner 上：安装 signing client、构建
Windows artifact、通过云 HSM 签名、验证 Authenticode/RFC 3161、删除临时客户端证书，并上传私有
证据包。成功后应得到：

- `signed-candidate.json`
- `*.timestamp-proof.json`
- `signature-status.json`
- `release-manifest.json`
- `SHA256SUMS`
- SBOM 与 `provenance.json`

没有真实 provider 和受保护 reviewer 时，只能生成 candidate，不能使用 `--require-signed`。

## Staging 环境

至少需要：

- 无凭据、无 query/fragment 的 staging origin；
- 只读 `GET /global/health`，返回 `{"healthy":true}`；
- 隔离 PostgreSQL 应用连接和 admin 连接；
- OpenTelemetry/告警 endpoint；
- staging credential scope、environment ID、workspace profile；
- backup/restore 临时库和清理权限；
- 不含生产 credential、生产数据的明确证明。

本地 preflight 对应变量：

```text
ARFORGE_WINDOWS_SIGNING_PROVIDER=digicert-keylocker
SM_HOST
SM_API_KEY
SM_CLIENT_CERT_FILE
SM_CLIENT_CERT_PASSWORD
ARFORGE_WINDOWS_KEYPAIR_ALIAS
ARFORGE_WINDOWS_EXPECTED_SIGNER_SUBJECT
ARFORGE_STAGING_URL
OTEL_EXPORTER_OTLP_ENDPOINT
ARFORGE_DB_URL
ARFORGE_DB_ADMIN_URL
```

签名 workflow 的 reusable staging validation 另外使用 GitHub Environment `staging` 的变量
`ARFORGE_STAGING_CREDENTIAL_SCOPE`、`ARFORGE_STAGING_ENVIRONMENT_ID`、
`ARFORGE_STAGING_WORKSPACE_PROFILE`、`ARFORGE_STAGING_TEST_CREDENTIALS`、
`ARFORGE_STAGING_PRODUCTION_CREDENTIALS_ABSENT`、`ARFORGE_STAGING_PRODUCTION_DATA_ABSENT`；
provider load 还需要由管理员配置 `DEEPSEEK_API_KEY` secret。

## 证据顺序

1. 运行环境 preflight，确认没有 missing/invalid。
2. 构建并验证 reproducible signed candidate。
3. 在隔离 staging 执行 backup、migration、RLS、smoke、restore drill 和 SLO baseline。
4. 用 signed artifact digest 和上一个 signed artifact digest 执行固定 cohort canary，只请求
   `/global/health`。
5. 记录 canary receipt、SLO report、rollback 结果和 release-owner checklist。
6. 运行 release gate，再组合 `signed_release_rollback` evidence。
7. 重新构建 Stage 8 manifest；五类证据全部 `pass` 后才运行 Step 8.11。

## 明确不能接受的替代品

- 自签名或本地临时证书；
- 手写 `status=pass` JSON；
- fixture canary receipt；
- 没有 staging origin 的 localhost rehearsal；
- 没有不同旧 artifact digest 的 rollback 声明；
- 把 candidate 当作 signed release。

这些替代品可以用于本地测试代码，但不能进入 Stage 8 退出 manifest。

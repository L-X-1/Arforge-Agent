# 阶段 0–7 独立总审查记录

- 复核日期：2026-08-14
- 计划基线：`%USERPROFILE%\Desktop\Arforge-最终详细实施计划-V2-2026-08-11.md`
- 当前分支：`codex/phase-0-checkpoint`
- 远程状态：未执行 push
- 目的：在进入 Step 8.11 前，按 V2 顺序重新核对阶段 0–7 的当前代码、数据库、打包和回归证据。

## 当前结论

阶段 1–7 的本地实现和主要回归门禁均已存在；本轮修复并重新验证了 packaged Windows 的 L3 shell 出口授权恢复问题。用户授权的 Tier-2 目标已可恢复地移入 Windows 回收站，`bun run tier2:audit` 已通过。阶段 0 的正式退出门禁仍未封板，原因是工作树仍包含用户既有未提交修改和未归属的临时目录。发布/部署相关的阶段 8.10/8.11 暂缓，不纳入当前开发完善批次。

## 当前已执行并复验

| 计划位置 | 当前结果 | 当前证据 |
| --- | --- | --- |
| Step 0.5 | 本地 checkpoint 可恢复 | 分支 `codex/phase-0-checkpoint`；既有 checkpoint commits；未 push |
| Step 1.11 | 通过 | R2 组合回归：12 文件、68 tests、612 expects、0 fail（本轮新鲜复验） |
| Step 1.12 | 语义保持为“旧入口安全关闭” | 旧 share/revert 仍不宣称恢复可用；share/revert worker/provider 留给阶段 6 |
| Step 2.5 | 通过 | control principal binding checkpoint 与 trust/durable targeted gates |
| Step 2.10 | 通过 | PostgreSQL 17.10；migration ledger 已记录 tenant/mailbox/stage7 等迁移；topology preflight 无 schema/data 变化 |
| Step 2.10 | 通过 | app role least privilege、write round-trip、38 张业务表 FORCE RLS、28/28 RLS checks、fixture cleanup verified |
| Step 2.11–2.12 | 通过本地 packaged 门禁 | final bundle 的 crash recovery 通过；SQLite 四场景 4/4；PostgreSQL 四场景 4/4 |
| Step 3.12 | 本地退出条件通过 | 当前增补记录：Python 3123 collected，3117 pass、6 skip、0 fail；provider offline/live fault-recovery、Golden、Evaluation、OTLP scrubber 已有分栏证据 |
| Step 4.12 | 本地退出条件通过 | Context Firewall、replay/omission、model switch/recovery、Golden 与外部 query baseline |
| Step 5.12 | 本地退出条件通过 | candidate/active、provenance、CAS forget/delete、untrusted recall 与 memory regression |
| Step 6.16 | 本地退出条件通过 | manifest/observer/verifier/recovery、durable workflow、completion verifier；当前 execution group 86 pass、390 expects |
| Step 7.12 | 本地实现和专门回归通过 | Durable Run → Evidence → Experience → Skill → Canary/Promotion/Rollback；当前 experience/evolution group 59 pass、510 expects |

## 本轮质量与构建复验

- `bun run typecheck`：22/22 tasks successful。
- `bun --cwd packages/desktop test`：88 pass、0 fail、258 expects。
- `bun run fusion:verify`：0 fusion findings；能力映射 232/232，duplicate/missing/extra 均为 0；workspace typecheck 22/22。
- `bun run db:topology:preflight`：read-only，`schemaOrDataChanged=false`，`secretsPrinted=false`。
- `bun run --cwd packages/core db:audit:postgres-role`：least privilege、write round-trip 均通过。
- `bun run --cwd packages/core db:smoke:postgres`：PostgreSQL smoke 通过。
- `bun run --cwd packages/core db:test:postgres-rls`：28/28 checks 通过，`cleanupVerified=true`。
- Windows candidate 已重新执行 build → package；本地 package 只证明 candidate 可构建，不能证明真实 Authenticode/RFC3161 signed release。

## 2026-08-14 本地完善批次复验

本节只记录当前开发阶段的本地质量结果，不构成发布、部署或 staging 证据：

- 强制非缓存 `bun turbo typecheck --concurrency=2 --force`：22/22 tasks successful，0 cached。
- R2 安全/HTTP 组合：68 pass、612 expects、0 fail。
- `packages/core` 四分片：1743 pass、9 skip、0 fail、7999 expects。
- `packages/arforge` shard 1/4，串行约束 `--max-concurrency=1`：817 pass、7 skip、1 todo、0 fail、40 snapshots、2244 expects；共 825 tests / 70 files。
- `packages/arforge` shard 2/4，串行约束 `--max-concurrency=1`：1164 pass、24 skip、0 fail、16 snapshots、3402 expects；共 1188 tests / 70 files。
- `packages/arforge` shard 3/4，串行约束 `--max-concurrency=1`：619 pass、10 skip、0 fail、1771 expects；共 629 tests / 69 files。
- `packages/arforge` shard 4/4，串行约束 `--max-concurrency=1`：807 pass、23 skip、0 fail、3029 expects；共 830 tests / 69 files。
- Arforge 四分片合计：3407 pass、64 skip、1 todo、0 fail；共 3472 tests / 278 files、10446 expects。
- 本轮本地缺少可执行 ripgrep 时，glob/grep 通过受限 filesystem fallback 完成；正常可执行 ripgrep 路径仍优先使用。该 fallback 的 glob/grep 回归为 8 pass、0 fail。
- 本轮修复并回归：稳定 replay assistant ID 的消息时间排序、直 Shell L3 授权队列测试、Windows 长文件名 atomic write；对应 targeted gates 均为 0 fail。
- 本轮针对性回归：operations API 2/2、frontend ownership 1/1、snapshot race 1/1、ToolRegistry 16/16、runtime insight 2/2、ShareNext 10/10；均为 0 fail。
- 测试过程中出现的 mock failure、ACP abort warning 和 mDNS loopback warning 均为既有测试/平台条件日志；本轮没有未处理的测试失败。

上述结果覆盖当前完成的 R2、Core 全分片和 Arforge 全 4 个本地分片；它不等于整仓工作树清洁，也不关闭 Step 0.6 的变更归属门禁。发布/部署相关阶段仍保持暂缓。

## 阻塞或尚未正式关闭的项目

### 1. 阶段 0 正式退出门禁未关闭

Step 0.6 要求每个变更有归属、无活跃并行写入、可恢复、generated roots 分离、数据库账本已记录且 P0 顺序获确认。当前工作树仍有大量用户既有未提交文件以及 `.codex-analysis/`、`tmp/` 未跟踪目录，不能把整个工作树宣称为本轮变更；因此本审查不擅自清理、覆盖、stash 或提交这些文件。

`bun run tier2:audit` 已于 2026-08-14 通过：批准选项 B 的 14 个目标均已进入回收站，明确保留的 16 个路径仍存在，且未发生永久删除。`scripts/write_desktop_signed_candidate_evidence.ps1` 按用户授权以可恢复方式处理完成。

### 2. 阶段 8.2 尚无有效的多代理收益证据

多代理调度的 fail-closed 实现已完成，但当前稳定 DeepSeek 实验报告为 `status=fail / DO_NOT_PROMOTE`：baseline 与 multi 均为 0/3 成功。观测到的耗时不能在 0 成功样本上被解释成收益；不能把该报告升级为 `baseline_and_multi_agent_gain=pass`。本轮已用完既定实验请求额度，不追加请求。

### 3. 阶段 8.5 仍是本地受信合同，不是远程生产执行

A2A schema、delegation、revoke/cancel 和 local-verifier transport 已有本地合同；默认公网入口、生产 peer key/mTLS、跨机器 remote executor、usage settlement 尚未启用。它不能作为真实远程部署证据。

### 4. 阶段 8.9 的本地平台演练不能替代外部 staging 演练

本地 PostgreSQL 的 RLS、backup/restore、tenant deletion request 和清理证据已通过；但物理租户删除、对象存储备份、正式 staging 数据/凭据隔离和 release-owner 见证仍需真实环境证据才能满足 Step 8.11 的“真实演练”措辞。

### 5. Step 8.10/8.11 的外部发布证据全部未闭合

当前只有 candidate/reproducible 产物，`signature-status.json` 明确为 `candidate`、`verified=false`，Stage 8 manifest 的 `signed_release_rollback` 为 `missing`。尚缺：

- DigiCert KeyLocker 或组织批准的真实签名 provider、keypair alias、客户端证书和受保护 runner；
- GitHub Environment 的真实签名 secrets、variables 与 required reviewers 配置；
- 隔离 staging origin、PostgreSQL/admin、OTLP/告警、无生产凭据/数据证明；
- 上一份真实 signed release 的 SHA-256 digest；
- signed candidate 的 Authenticode/RFC3161 证据、staging canary receipt、SLO、rollback receipt 和 release-owner checklist。

当前 `bun run ops:release:preflight` 结果为 `status=blocked`，缺少项为：
`signing.provider`、`signing.sm_host`、`signing.sm_api_key`、
`signing.sm_client_cert_file`、`signing.sm_client_cert_password`、
`signing.arforge_windows_keypair_alias`、`signing.arforge_windows_expected_signer_subject`、
`signing.client_certificate_file`、`staging.origin`、`telemetry.otlp_endpoint`；
脚本确认 `secretsPrinted=false`。

GitHub 只读核对结果：仓库 `L-X-1/Arforge-Agent` 的
`desktop-release-candidate` Environment 已存在，并配置 required reviewer `L-X-1`；
该 Environment 当前变量列表为空。`staging` Environment 当前不存在（GitHub API 404）。
本核对没有读取或输出任何 secret 值。

## 阶段 8.11 当前判定

`artifacts/stage-8-exit-evidence.json` 当前仍为 `DO_NOT_EXIT`：

- `baseline_and_multi_agent_gain`：fail；
- `child_remote_capability_revocation`：local pass；
- `background_task_visibility_stop_audit`：local pass；
- `tenant_rls_backup_delete_drill`：local pass；
- `signed_release_rollback`：missing。

因此当前严格位置是：阶段 0–7 正在完成独立总审查收尾，下一步集中处理阶段 0 的变更归属、工作树治理和本地质量门禁。发布/部署相关的阶段 8.10/8.11 保持暂缓，当前不要求真实签名、staging 或外部发布资源。

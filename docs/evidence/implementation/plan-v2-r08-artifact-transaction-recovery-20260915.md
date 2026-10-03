# R08 Artifact 写入事务恢复切片（2026-09-15）

## 结论

本批把 `ToolOutputStore.bindBytes` 的 payload → index → catalog 写入边界收敛为同一 write-ahead marker 事务。marker 在 payload 可见前落盘，catalog entry 是唯一提交记录；进程在任一中间点退出后，下一个受 catalog lock 保护的 `usage`、新 artifact 写入或 cleanup 会立即重放判定：已有匹配 catalog 的 receipt 只删除残留 marker，未提交的 payload/index 一并删除。这样新鲜 orphan 不再必须等待 7 天 retention 扫描，也不会继续占用 profile-wide quota。

marker 只用于恢复元数据，不是第二 catalog、执行器或状态表。marker 损坏或与已提交 receipt 的 handle/digest 不一致时 fail-closed，并保留 payload 供诊断；不会猜测 owner、覆盖 catalog 或重发工具。

## 实现与唯一 owner

- `packages/core/src/tool-output-store.ts`
  - 新增 `pending/` 目录和版本化 `pending_<handle>.json` marker；内容复用现有 `OpaqueArtifactRef`，不记录路径或秘密。
  - `bindBytes` 在同一跨进程 catalog lock 下先写 marker，再写 payload/index，最后追加现有 hash-chained catalog audit；提交后 marker 清理失败仍可由下一进程幂等回收。
  - `recoverPendingLocked` 在 quota/usage、新写入和 cleanup 前执行。catalog 中有等价 handle+receipt 才视为已提交；否则删除未提交 payload/index。handle、managed retrieval hint、reference 等均严格校验，删除不跟随 symlink。
  - 既有 retention cleanup、catalog tombstone、quota、opaque receipt/read 和 audit owner 语义未另建路径。
- `packages/core/test/tool-output-store.test.ts`
  - 覆盖 payload/index 已存在但 catalog 未提交的恢复与 quota 释放。
  - 覆盖 catalog 已提交但 marker 残留时保留 receipt、删除 marker。
  - 覆盖损坏 marker fail-closed 并保留现场。
  - 在真实 Windows/Bun 独立子进程中于 marker、payload、index、catalog 四个边界 SIGKILL；新进程读取同一 store，未提交三种场景均无 catalog/bytes，catalog 已提交场景保留且可读。
  - 原有并发 catalog、quota、摘要绑定、owner/retention/digest、孤儿和 tombstone 回归继续执行。

## 验收证据

| 范围 | 命令/结果 | 原始输出 |
| --- | --- | --- |
| ToolOutputStore 专项 | 36 pass / 0 fail / 194 assertions，exit 0 | [原始测试输出](./plan-v2-r08-artifact-transaction-recovery-20260915.txt) |
| Core 类型 | `bun run typecheck` exit 0 | [原始测试输出](./plan-v2-r08-artifact-transaction-recovery-20260915.txt) |
| Prettier | 两个修改文件 check 通过 | [原始测试输出](./plan-v2-r08-artifact-transaction-recovery-20260915.txt) |
| 差异空白检查 | `git diff --check` exit 0 | [原始测试输出](./plan-v2-r08-artifact-transaction-recovery-20260915.txt) |
| 迁移新鲜度 | `audit:migration-freshness` `valid=true`；Python consumer audit `valid=true`、remaining consumers=0 | [迁移审计快照](./source-snapshot.v1.json) |

测试只使用临时 profile 和本地文件，不发送网络请求、不访问真实用户数据，也不执行用户要求后置的三平台 full sandbox。

## 未关闭边界

该切片只闭合托管 artifact 写入中间点的本地恢复与 quota 占用。R08/R09 仍需补真实终止进程→新进程的 index/catalog/Observation 故障矩阵、外层 Action/Task 最终回执、压缩事务各阶段、跨租户/正式产品入口和历史多版本兼容；真实外部 Provider、Python 物理退役、R28/R30 及 R31 full sandbox 均保持开放。

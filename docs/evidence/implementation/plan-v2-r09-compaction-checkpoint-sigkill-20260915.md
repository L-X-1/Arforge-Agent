# R09 压缩语义检查点跨进程 SIGKILL 切片（2026-09-15）

## 结论

本批把压缩语义检查点的阶段性恢复从同进程夹具提升为真实 Windows/Bun 子进程验证。`SessionCompactionCheckpoint.append` 仍是唯一持久化 owner；在事务提交后、下一阶段开始前，隔离验收 worker 可分别在 `prepared`、`summarizing`、`summarized`、`revalidated`、`committed`、`closed` 六个边界被 SIGKILL。新进程打开同一 SQLite profile 后只读取并严格校验 append-only 前缀，再由 `classifyAsyncCompaction` 给出可解释状态：未到提交阶段为 `in_flight`，已提交但尚未关闭为 `completed_unsettled`，已关闭为 `committed`。

该 hook 只有在 `ARFORGE_DESKTOP_ISOLATED_ACCEPTANCE=1` 且显式设置 `ARFORGE_TEST_COMPACTION_CRASH_PHASE` 时生效，正常产品进程不会进入故障模式。worker 仅写临时测试 session/project 和 checkpoint 元数据，不调用 Provider、不访问用户数据、不自动重试摘要。

## 实现与唯一 owner

- `packages/core/src/session/compaction-checkpoint.ts`
  - 保留现有事务、序列、前缀校验、候选摘要 digest 和 invariant；新增隔离验收专用的提交后 SIGKILL 探针。
  - 进程终止发生在 SQLite checkpoint 事务完成之后，因此新进程验证的是实际持久前缀，不是内存数组或模拟状态。
- `packages/core/test/fixture/compaction-checkpoint-crash-worker.ts`
  - 以固定 provider revision、surface digest 和 candidate digest 写入从 `prepared` 到目标阶段的真实 checkpoint 链。
  - 每个 worker 使用独立临时 SQLite 文件；阶段完成后由 Core hook 终止。
- `packages/core/test/session/compaction-checkpoint.test.ts`
  - 对六个阶段逐一启动独立 Bun 子进程、确认 worker 非正常退出，再用全新 Database layer 扫描同一文件。
  - 另对 `Compaction.Ended` 已先提交的 `after-event`、`committed`、`closed` 三个边界执行新进程 `recoverPublished`；已发布摘要只补齐 checkpoint，不重新调用 Provider。
  - 断言最后 phase 与 recovery status 精确对应，证明重启不倒退、不把未完成摘要伪造成成功。

## 验收证据

| 范围 | 命令/结果 | 原始输出 |
| --- | --- | --- |
| 跨进程 checkpoint 矩阵 + 既有 recovery | `bun test test/session/compaction-checkpoint.test.ts test/session-compaction.test.ts --rerun-every`：**10 pass / 0 fail / 68 assertions，exit 0** | 本批测试输出 |
| checkpoint 单文件复验 | `bun test test/session/compaction-checkpoint.test.ts --rerun-every`：**7 pass / 0 fail / 60 assertions，exit 0** | 本批测试输出 |
| Core 类型 | `bun run typecheck`：exit 0 | 本批命令输出 |
| Prettier | 三个修改/新增 TypeScript 文件 `--check`：通过 | 本批命令输出 |
| 差异空白检查 | `git diff --check`（限定本批文件）：exit 0 | 本批命令输出 |
| Oxlint | 未执行成功：仓库现有 `.oxlintrc.json` 将 `options.typeAware` 放在非 root 位置，当前 Oxlint 在解析配置阶段退出；不是本批源码诊断结果 | 本批命令输出 |

本批最初审计曾发现既有 `packages/app/e2e/test-results` Playwright trace 在扫描期间被清理/改写；随后按 R00 修复依赖账本的真实排除边界并补测试。当前重新生成后的 `audit:migration-freshness` 为 `valid=true`，Python consumer audit 为 `valid=true`、remaining consumers=0；详见[R00 freshness 修复证据](./plan-v2-r00-migration-freshness-20260915.md)。

测试只使用本地临时目录和 SQLite，不发送网络请求、不使用真实凭据、不重启用户正在运行的服务。真实 Linux/macOS/Windows full sandbox 仍按 R30 后执行。

## 已覆盖与未关闭边界

已覆盖：真实子进程在六个 checkpoint 提交阶段的终止、SQLite 持久前缀读取、严格 phase/status 分类；`Compaction.Ended` 已先发布时在 after-event/committed/closed 三个新进程边界促成 `committed/closed` 的恢复；provider-only 前缀阻断回归继续通过。

仍未关闭 R09：prepare/summarize/revalidate/commit/close 内部更细的 provider、Surface CAS、Artifact、settlement 和用户入口故障点；摘要结果未知时的 CLI/Desktop 用户处置；压缩后的完整 Action/Observation 结算与跨租户/历史兼容。该切片不代表 R09 或整体计划完成，也不提前执行 R31 full sandbox。

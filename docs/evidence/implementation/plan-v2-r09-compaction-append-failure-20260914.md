# R09 事务式压缩提交故障追补（2026-09-14）

## 结论

对 R09 最危险的提交窗口做了真实故障注入：摘要 provider 已完成、可见 Surface 已完成 CAS commit，`Compaction.Ended` 已先持久化，但 committed checkpoint append 被模拟为进程/数据库故障。现有 Core owner 能从 durable `revalidated` 前缀与唯一 `Compaction.Ended(operationID,candidateDigest)` 证据恢复 `committed → closed`，不再次调用 provider；没有匹配事件的 provider-only 前缀仍保持阻断。

本批不新增第二个压缩引擎或恢复状态源，验证的是既有 `SessionCompaction.runTransactional` 与 `SessionCompactionCheckpoint.recoverPublished` 的故障语义，避免把“代码看起来有 event-first”当成真实验收。

## 实现与测试

- `packages/core/test/session/compaction-checkpoint.test.ts`
  - 加入一个可控 checkpoint store，在 committed 阶段只失败一次。
  - 断言失败后 provider 调用恰好 1 次、durable 前缀停在 `revalidated`、恢复只追加 `committed/closed`。
  - 第二次恢复报告为空，证明不会重复结算或重发摘要。
- `packages/core/src/session/compaction.ts`、`packages/core/src/session/compaction-checkpoint.ts`
  - 本批保留既有唯一 owner；未为测试另造生产路径。

| 范围 | 结果 |
| --- | --- |
| 压缩检查点/恢复专项 | **6 pass / 0 fail / 30 assertions / exit 0** |
| Core typecheck | `tsgo --noEmit` exit 0 |
| 本切片 Oxlint | **0 warnings / 0 errors** |
| 覆盖的故障事实 | Ended 事件先于 committed checkpoint；append 失败后恢复不重调 provider |

## 未完成边界

- 这只关闭 R09 的一个 event-first 提交故障窗口，不关闭 R09：各阶段中途强杀矩阵、摘要未知结果用户处置、Artifact 失效/回收、压缩后结算与全部产品入口仍开放。
- 该测试使用隔离 SQLite 与受控故障注入；不等同于真实生产 DB 崩溃、跨主机恢复或最终全平台 sandbox。

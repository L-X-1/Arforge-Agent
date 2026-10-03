# Step 6.6 — Revert 可执行 ControlRun 验证记录

日期：2026-08-12
计划：`Arforge-最终详细实施计划-V2-2026-08-11.md`，Step 6.6
分支：`codex/phase-0-checkpoint`
状态：本地实现与 targeted gates 通过；未执行 Git push。

## 已落地的控制链

- readonly Session/Git/filesystem snapshot 是唯一 claim material。
- `session.revert` 与 `session.unrevert` 均创建 L3 fresh-human ControlRun。
- approval 后由同一 worker 重新执行轻量 live fence，不重新解释请求。
- executor 只接受 sealed snapshot、DurableRun control lease 和 ActionGateway human grant。
- 首次 revert 在任何恢复写入前原子写入 immutable preimage receipt，并 checkpoint receipt。
- unrevert 只读取首次 revert 在 Session 中引用的 receipt；缺失、篡改、scope/path/file 集合或内容不匹配均 fail-closed。
- 文件恢复后独立 reread ordinary-file hash、bytes、mode、real path，并记录 durable verified observation。
- Session 与 EventSequence 独立重读；状态混合、未知或写后核验失败进入 `RecoveryRequired`，由 worker 转为 paused/manual recovery。
- crash recovery 不重新 capture 新 snapshot；恢复边界仍由 durable run 与 sealed input 决定。
- 旧 `SessionRevert.revert()` / `unrevert()` 仍为 typed hard-block；没有旧 delete/write 入口绕过 ControlRun。

## Fresh verification

通过：

```powershell
bun run --cwd packages/arforge typecheck
bun test --cwd packages/arforge test/session/revert-snapshot.test.ts test/session/revert-readonly-inspector.test.ts --max-concurrency=1 --parallel=1
bun test --cwd packages/arforge test/control-operation/worktree-worker.test.ts test/control-operation/worktree-scheduler.test.ts test/control-operation/service.test.ts --max-concurrency=1 --parallel=1
bun test --cwd packages/arforge test/server/httpapi-experimental.test.ts --timeout=30000 --max-concurrency=1 --parallel=1
```

结果：`typecheck` 通过；Session snapshot/inspector 17/17；ControlRun worker/scheduler/service 25/25；experimental HTTP 11/11。

附加检查：`git diff --check` 通过。

## 未宣称的门禁

`bun run --cwd packages/arforge test` 在本次 120 秒执行窗口内未完成，因此不将其记为全包通过。该结果不覆盖上述 targeted gate；全包测试与 Stage 6 的统一退出门禁仍需在后续整机回归阶段重新执行。

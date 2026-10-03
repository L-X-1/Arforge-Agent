# Arforge 本地测试分片证据（2026-08-14）

## 范围

- 当前分支：`codex/phase-0-checkpoint`
- 本证据覆盖 `packages/arforge` 的 shard 2/4、3/4、4/4。
- 运行约束：`--max-concurrency=1 --timeout 30000 --dots`。
- 本地质量证据不涉及发布、部署、staging、签名、canary 或 rollback。

## 结果

| 分片 | 测试文件 | pass | skip | todo | fail | expects |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 2/4 | 70 | 1164 | 24 | 0 | 0 | 3402 |
| 3/4 | 69 | 619 | 10 | 0 | 0 | 1771 |
| 4/4 | 69 | 807 | 23 | 0 | 0 | 3029 |

合计（2–4/4）：2590 pass、57 skip、0 todo、0 fail；共 2647 tests、8202 expects。

## 关联修复

- `MessageV2.latest()` 以创建时间为主、MessageID 为同时间兜底，避免稳定 replay 的直 Shell assistant ID 遮蔽后续模型响应。
- 直 Shell 队列回归测试显式完成 L3 授权，验证 Shell 完成后多个 loop caller 只触发一次模型请求。
- Windows atomic write 使用同目录短临时 basename，覆盖长文件名场景。
- ripgrep 不可执行且下载不可用时，glob/grep 使用本地受限 fallback；可执行 ripgrep 仍优先。

## 结论与边界

三个分片均为 0 fail。它们证明本地代码质量门禁通过，不证明远程 staging、真实签名、生产部署或发布回滚条件已满足；Step 0.6 的工作树归属审查仍单独保持开放。

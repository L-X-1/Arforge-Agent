# Core 当前工作树四分片回归证据

- 日期：2026-08-15
- Bun：1.3.14
- 命令：`bun test --shard=N/4 --timeout=30000 --max-concurrency=1 --dots`
- 范围：`packages/core` 当前工作树；未启用 DeepSeek 实网 probe
- 目的：补充旧 checkpoint 证据，确认本轮开发审查后的 Core 后端仍可完整回归

| 分片 | 测试数 | 通过 | 跳过 | 失败 | assertions | 运行时间 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1/4 | 364 | 356 | 8 | 0 | 1057 | 66.29s |
| 2/4 | 434 | 434 | 0 | 0 | 2292 | 68.47s |
| 3/4 | 387 | 387 | 0 | 0 | 2758 | 114.96s |
| 4/4 | 590 | 589 | 1 | 0 | 1997 | 160.69s |
| 合计 | 1775 | 1766 | 9 | 0 | 8104 | — |

跳过项是测试条件性 skip，包含 DeepSeek live probe 以及 Windows PTY/Watcher 平台条件；没有通过忽略失败来换取绿色结果。负向 Skill discovery 测试输出了预期的假下载失败日志，但测试本身通过。

本证据只覆盖本地 Core 代码质量，不代表真实第三方 provider、staging、多租户生产环境、签名发布、canary 或 rollback 已完成。按当前用户授权，未执行 push、发布或部署。

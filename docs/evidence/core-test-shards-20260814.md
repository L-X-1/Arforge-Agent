# Core 分片回归证据（2026-08-14）

## 范围

- 本轮复验起点 checkpoint：`c52a1ac1dd631e077a8fcb6f3260e700d0ab1082`
- 工作树：运行时仍包含用户未提交变化；本证据只声明 `packages/core` 的当前源码与测试分片结果，不声明整仓清洁或整仓通过。
- Bun：`1.3.14`
- 每测试超时：`30000ms`
- 为绕过 `packages/core/package.json` 中的 `--only-failures` 包装，直接在 `packages/core` 目录执行原始 Bun Test。

## 命令与结果

```powershell
Push-Location .\packages\core
bun test --shard=1/4 --timeout=30000
bun test --shard=2/4 --timeout=30000
bun test --shard=3/4 --timeout=30000
bun test --shard=4/4 --timeout=30000
Pop-Location
```

| 分片 | 测试文件 | 通过 | 跳过 | 失败 | 断言 |
|---:|---:|---:|---:|---:|---:|
| 1/4 | — | 466 | 0 | 0 | 2946 |
| 2/4 | — | 493 | 0 | 0 | 1952 |
| 3/4 | — | 351 | 7 | 0 | 1103 |
| 4/4 | — | 433 | 2 | 0 | 1998 |
| 合计 | — | 1743 | 9 | 0 | 7999 |

## 跳过项说明

- DeepSeek live probe：未重新发起实网请求，遵守此前最多 3 次请求和费用授权边界。
- PTY/Watcher 的跳过项是测试自身条件性 skip，不计为失败；它们不能替代对应平台专项验收。

## 结论

`packages/core` 当前分片回归通过。该证据只服务于本地开发完善，不替代 PostgreSQL 实库、真实 staging canary、签名发布、回滚或 live/multi-agent 收益证据；这些发布/部署事项当前按用户要求暂缓。

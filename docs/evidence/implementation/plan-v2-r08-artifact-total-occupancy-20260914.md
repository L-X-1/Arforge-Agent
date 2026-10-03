# R08 托管产物总占用控制（2026-09-14）

## 结论

本批完成 R08 的一个可复验切片：托管产物的总物理占用现在由既有 `ToolOutputStore` 统一统计和限制。配额检查、物理写入、索引落盘和 `registered` 审计在同一个跨进程 catalog lease 内执行；超限在写入前 fail-closed，索引或审计失败会清理本次文件，不产生半完成收据。并发导入不能共同观察同一剩余额度而超额；统计包含目录中的孤儿托管文件，默认上限为 256 MiB，可由现有 `ConfigV2.ToolOutput.max_total_bytes` 配置。

这不是 R08/R09 整项完成。Observation/settlement 中途故障、完整压缩/回收策略、不同进程强杀矩阵、产品入口和全用户旅程仍开放；MCP 生命周期的两个 Windows Bun/BaseContainer 边界失败也未被隐藏或降级。

## 实现与唯一 owner

- `packages/core/src/config/tool-output.ts`
  - 在现有 ToolOutput 配置中增加可选 `max_total_bytes`，不改变 `max_lines`/`max_bytes` 的模型预览限制。
- `packages/core/src/tool-output-store.ts`
  - 增加 `usage()`，统计 `tool-output` 目录下 `artifact_*`/`tool_*` 的非符号文件实际字节数，并返回有效 profile 上限。
  - `bindBytes` 在既有 catalog Flock 内先读取占用、比较配额，再写入 bytes/index/audit；失败路径清理物理文件和索引。
  - `recordAudit` 与绑定路径共享同一 append helper，避免锁内再次取得同一锁。
- `packages/core/test/tool-output-store.test.ts`
  - 覆盖顺序超限、物理占用回报、跨并发导入，以及 catalog 条目数量不因拒绝而增加。

## 验收证据

| 范围 | 命令/结果 | 原始输出 |
| --- | --- | --- |
| ToolOutputStore quota/usage/回滚 | 31 pass / 0 fail / 162 assertions，exit 0 | [tool-output-store test](./plan-v2-r08-artifact-total-occupancy-20260914.txt) |
| Core 类型 | `bun run typecheck` exit 0 | [tool-output-store test](./plan-v2-r08-artifact-total-occupancy-20260914.txt) |
| scoped lint | 0 errors；8 warnings 均为既有 unsafe assertion/legacy lint（新增一致性告警已清零） | [tool-output-store test](./plan-v2-r08-artifact-total-occupancy-20260914.txt) |
| 迁移新鲜度门禁 | `valid=true`；source inputs 7568、Python capabilities 5080、Python tests 3394、dependency leaves 7500、TS source files 1757、capability links 4 | [tool-output-store test](./plan-v2-r08-artifact-total-occupancy-20260914.txt) |

## 边界

1. `usage()` 是物理占用观测，不会自动删除孤儿或修复索引；清理仍由既有 `cleanup` owner 负责。
2. 配额是每个 ToolOutputStore profile 目录的总上限，不是跨 profile/租户的全局磁盘配额，也不替代 OS sandbox enforcement。
3. 既有单件 `MAX_ARTIFACT_BYTES`、读取上限、owner/retention/digest 校验均保留；这次没有放宽未授权读取或把路径重新暴露给模型。
4. 本机 Windows Bun 1.3.14 的 BaseContainer stdio 失败仍按 R13 证据保留；真实 Linux/macOS/Windows full sandbox 依用户顺序留到 R31。

## 计划归属

对应 R08“总占用控制、孤儿及历史回收”中的总占用切片，并为 R09 压缩/结果落盘复用同一资源预算。R08、R09、R13、R17 仍开放，下一批继续中途故障窗口、回收和正式入口旅程。

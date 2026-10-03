# 阶段 2–7 质量复核记录

- 复核日期：2026-08-14
- 计划基线：`Arforge-最终详细实施计划-V2-2026-08-11.md`
- 复核目的：在进入 Step 8.11 退出门前，重新检查阶段 2–7 的类型安全、能力归属、旧接口边界和现有工程审计结果。
- 结论：本轮本地代码质量门通过；Step 8.11 仍不能通过。

## 已验证通过

1. `bun run fusion:verify`
   - Fusion 边界审计：0 findings。
   - 能力归属：生成方法 232、映射方法 232；duplicate/missing/extra 均为 0。
   - 手工审查候选 76 项均已登记，无未审查候选、无过期审查记录。
   - 工作区类型检查：27 个包纳入范围，22 个 typecheck 任务成功（其余为不含该任务的范围包）。
2. 受影响核心回归：38 tests passed、0 failed、150 expect calls。
3. `bun run fusion:audit`：28 manifests、12,968 files visited、0 findings。
4. `bun test --cwd packages/script src/fusion-audit.test.ts`：4 passed、0 failed。
5. `bun --cwd packages/arforge typecheck`：通过。

## 本轮发现并修复

- 新生成的 client endpoints 已全部纳入 capability map 和 UI review；删除旧的未授权 `memories.delete/deleteMany` 映射。
- memory 删除迁移到维护授权接口：携带期望版本、ActionID、EvidenceID 和显式原因；`Memory.Info` 暴露版本并补齐更新版本回归断言。
- Fusion 首方边界审计排除了构建临时目录、嵌入运行时和验收产物目录；未修改生产代码来规避扫描。
- 修复 `fusion:verify` 使用的根级 capability 脚本别名和 Desktop 私有元数据命中。
- 补齐 CLI 与 arforge HTTP API 实例服务图中的租户平台、会话、凭据、持久化任务、Durable Run/Action、Personal Job 和 Tool Output cleanup 节点；完整工作区类型检查恢复通过。

## 保留的阻塞项

- `bun run tier2:audit` 仍有 2 个历史证据问题：缺少对应 execution manifest，以及 signed-candidate 脚本执行后仍保留 approved target。它们未被伪造为通过，需按原审计流程补充/修复。
- brand audit 仍报告 8 个历史/入口文本命中；当前 `brand:check` 命令通过，但这些命中仍保留可追溯记录。
- Step 8.10/8.11 所需的外部签名发布、可回滚 canary、正式 baseline 与量化 multi-agent gain 尚无当前有效证据。
- 本轮未进行新的外部网络或 DeepSeek 请求；既有三次 bounded experiment 仍是 `DO_NOT_PROMOTE` 历史证据。

因此，本记录只证明阶段 2–7 的当前本地工程质量已复核，不改变 Step 8 退出清单中的 `DO_NOT_EXIT` 状态。

# R08 Artifact catalog tombstone 回收切片（2026-09-14）

## 结论

本批修复了 R08/R09 共用的托管产物 catalog 长期运行缺口：retention cleanup 删除 bytes/index 后，`removed` 审计仍保留，但旧实现也永久保留 catalog entry；持续创建和清理最终会把 10,000 条 entry 配额耗尽，即使物理存储已经空闲。现在 catalog 在保留审计链和未达上限时的可查询投影的前提下，于新 receipt 注册遇到 entry cap 时按 `lastSequence` 从旧到新回收最老的 removed tombstone，再写入新 entry。每个新移除投影保留最小的 durable `removed` 标记，因此审计环滚动后仍可识别；活跃 entry、未删除 receipt 和审计哈希链不被回收。

这不是 R08/R09 整项完成。压缩检查点完整故障矩阵、跨进程强杀恢复、正式产品入口和全平台 sandbox 仍开放。

## 实现与唯一 owner

- `packages/core/src/tool-output-store.ts`
  - `appendCatalogAudit` 使用 entry 上的 durable `removed` 标记识别 tombstone，并保留 artifact/owner identity 校验。
  - `CatalogStoredEntry.removed` 作为最小 tombstone 标记持久化；旧无标记状态继续可读，重新注册会清除标记，其他审计动作不会把已移除 receipt 伪装成活跃 entry。
  - 仅 `registered` 新 receipt 在目录已满时触发回收；按最老 `lastSequence` 确定性选择 tombstone。
  - 回收只改变当前 read-model entries；历史 `removed` 记录继续留在 hash-chained audit，超过审计窗口时由既有 `droppedAuditEntries/chainAnchor` 语义承接。
  - 无足够 tombstone 时仍 fail-closed，不覆盖活跃 entry 或放宽上限。
- `packages/core/test/tool-output-store.test.ts`
  - 以合法的 10,000-entry/10,000-audit fixture 直接构造 cap-pressure 状态，验证最老 removed entry（其首条 removed audit 会在新写入时滚出窗口）仍被回收、新 receipt 成功注册、entry 数仍为 10,000、审计窗口正确推进。
  - 保留并回归现有 cleanup、重复 removed、owner、digest、quota、并发和中断语义。

## 验收证据

| 范围 | 命令/结果 | 原始输出 |
| --- | --- | --- |
| ToolOutputStore 全专项 | 32 pass / 0 fail / 166 assertions，exit 0 | [原始测试输出](./plan-v2-r08-artifact-retirement-20260914.txt) |
| Core 类型 | `bun run typecheck` exit 0 | [原始测试输出](./plan-v2-r08-artifact-retirement-20260914.txt) |
| 修改文件 scoped Oxlint | 0 warnings / 0 errors | [原始测试输出](./plan-v2-r08-artifact-retirement-20260914.txt) |
| 差异空白检查 | `git diff --check` exit 0 | [原始测试输出](./plan-v2-r08-artifact-retirement-20260914.txt) |

专项测试没有发送网络请求，也没有访问真实用户数据；只使用临时 profile 和内存生成的合法 catalog fixture。

## 计划归属与边界

对应 R08“总占用控制、孤儿及历史回收”中的历史 tombstone 回收切片，并为 R09 Artifact/压缩结果长期运行提供有界 catalog。它不证明全量工具来源已统一、不证明压缩事务的所有故障窗口，也不替代 R28 invariant 汇总、R30 后置审计或按用户顺序最后执行的真实 Linux/macOS/Windows full sandbox。

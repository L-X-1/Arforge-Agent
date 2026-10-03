# Step 6.2 — File 工具收敛证据

日期：2026-08-12
状态：通过（代码与定向回归已完成；未推送远端）

## 计划门禁与实现

| 计划要求 | 实现证据 |
| --- | --- |
| canonical/root containment | `LocationMutation.resolve` 继续执行 lexical containment、canonical root containment 与外部目录授权边界。 |
| no-follow | `FileGuard`、`LocationMutation`、`ReadToolFileSystem` 与 V2 `FileSystem` 逐级检查路径组件；符号链接以 typed error 或 fail-closed defect 拒绝。 |
| byte/line limit | `ReadToolFileSystem` 保留 50 KiB / 2,000 行文本页上限、媒体 20 MiB 上限和单行截断。 |
| fingerprint / external drift | `FileGuard.snapshot` 计算 SHA-256、size、mode、identity、mtime；文件读取前后比较 identity/size/mode/mtime，漂移返回 `ReadTool.ExternalDriftError`。 |
| preimage/postimage | `FileMutation.writeTextWithReceipt` 与 `writeIfUnchangedWithReceipt` 返回 preimage/postimage 指纹和 rollback receipt。 |
| atomic replace | 写入使用同目录随机临时文件，`wx` 创建、保留 mode、`sync`、关闭后 rename；尝试目录 fsync，兼容 Windows 不支持目录 fsync 的平台。 |
| expected version/CAS | `writeIfUnchanged` 与 `removeIfUnchanged` 在同一 canonical-target mutex 下比较 expected bytes 后提交；不匹配返回 `StaleContentError`。 |
| bounded batch patch | `apply_patch` 在所有目标预解析/授权/读取后执行；后续失败时按逆序补偿，update/delete 使用 CAS，add 使用 expected-byte CAS 删除；失败不会返回 completed output。 |
| risk / compensation | `apply_patch` 从不可逆 L2 改为 guarded、compensatable，并声明恢复 pre-action snapshots 的 compensation。 |

## 验证

```text
bun run --cwd packages/core typecheck
  passed

bun test --cwd packages/core ./test/file-mutation.test.ts ./test/tool-read-filesystem.test.ts ./test/tool-read.test.ts ./test/tool-write.test.ts ./test/tool-edit.test.ts ./test/tool-apply-patch.test.ts
  69 pass, 0 fail, 218 expect() calls
```

补充验证：

- `FileMutation` receipt、conditional remove、并发 CAS 测试通过；
- `ReadToolFileSystem` external drift 测试通过；
- `apply_patch` 后续提交失败时前序删除恢复，补偿失败会保留失败状态并报告目标；
- 中断不会被转换成成功结果，符合工具层 interruption/defect 不吞掉的约束。

## 已知边界

Node/Windows 路径检查存在 native handle 级 TOCTOU 窄窗口；本步骤采用多次 lstat、final identity 检查、最小原子写 executor 和 CAS，未宣称消除操作系统级窗口。跨进程/崩溃恢复的持久 rollback artifact 属于后续 DurableRun/Recovery 工作包。

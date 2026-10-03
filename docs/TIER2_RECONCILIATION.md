# Tier 2 单目标修正接口

## 目的

Tier 2 方案 B 已记录过 14 个批准目标的可恢复退役，但后续 sanitized snapshot 重新引入了一个批准脚本。`scripts/reconcile_tier2_retirement.ps1` 只处理这种“计划已执行、恰好只剩一个批准目标”的状态，不重写历史计划，也不永久删除文件。

## 默认只读核验

```powershell
.\scripts\reconcile_tier2_retirement.ps1 `
  -TargetPath 'scripts/write_desktop_signed_candidate_evidence.ps1'
```

该命令只输出目标、大小、类型和 `execute_required=true`，不会创建凭证或改变目标。

## 需要明确授权后的执行

```powershell
.\scripts\reconcile_tier2_retirement.ps1 `
  -TargetPath 'scripts/write_desktop_signed_candidate_evidence.ps1' `
  -Execute
bun run tier2:audit
```

执行前接口会验证：

- 计划仍是已批准的 Option B、`executed-recoverable`；
- 目标属于批准清单；
- 所有批准目标中恰好只有该目标仍存在；
- 路径在工作区内且不是 reparse point；
- 回收站移动前写入带 SHA-256 的单目标 reconciliation manifest。

`-Execute` 使用 Windows Recycle Bin；任何审计失败都必须停止，不得改写计划状态或改为永久删除。

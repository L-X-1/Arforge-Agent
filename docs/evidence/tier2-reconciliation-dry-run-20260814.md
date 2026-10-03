# Tier 2 reconciliation dry-run 证据（2026-08-14）

- 实现 checkpoint：`b014869e`
- 目标：`scripts/write_desktop_signed_candidate_evidence.ps1`
- 当前状态：目标仍存在；未执行回收站移动。

## 验证命令

```powershell
.\scripts\reconcile_tier2_retirement.ps1 `
  -TargetPath 'scripts/write_desktop_signed_candidate_evidence.ps1'
```

结果：

```json
{
  "status": "dry-run",
  "approved_option": "B",
  "target": "scripts/write_desktop_signed_candidate_evidence.ps1",
  "recovery": "Windows Recycle Bin",
  "target_type": "file",
  "bytes": 5251,
  "file_count": 1,
  "permanently_deleted": false,
  "execute_required": true
}
```

越界/未批准路径被拒绝；`bun run tier2:audit` 仍只报告该唯一残留目标。`-Execute` 未调用，因此没有文件移动、凭证写入或计划状态修改。

## 其他门禁

- PowerShell parser：通过。
- `git diff --check`：退出码 0（只有既有换行转换提示）。
- `bun run fusion:verify`：通过；0 findings，232/232 capability mapping，22/22 workspace typecheck。

# R00 迁移账本 freshness 易失产物边界修复（2026-09-15）

## 结论

按 R00 的要求修复了真实审计规则，而不是刷新 JSON 掩盖漂移：Python 依赖账本扫描器现在明确排除 Playwright 产生的 `test-results` 目录。该目录属于运行时临时报告，测试结束后会被自动清理或重写，不应作为旧 Python 依赖/迁移源的稳定输入。排除只影响盘点范围，不会隐藏产品源码、启动器或用户配置。

## 实现与验证

- `script/arforge-python-dependencies-ledger.ts`
  - `EXCLUDED_SEGMENTS` 新增 `test-results` 与 `playwright-report`，递归扫描和校验使用同一规则。
  - 既有 `docs/evidence/implementation`、`.venv`、缓存及构建产物边界保持不变。
- `script/arforge-python-dependencies-ledger.test.ts`
  - 易失 Playwright `test-results` 与 `playwright-report` 目录夹具均不会进入 `scanned_files`，生成后校验仍为 valid。

## 验收证据

| 范围 | 命令/结果 |
| --- | --- |
| 账本专项 | `bun test --config E:/Arforge-Agent/script/bunfig.toml E:/Arforge-Agent/script/arforge-python-dependencies-ledger.test.ts --rerun-every`：**5 pass / 0 fail / 14 assertions，exit 0** |
| 依赖账本重生成 | `scanned_file_count=5085`、`dependency_leaf_count=6708`、`asset_count=6`，exit 0 |
| 全局 freshness | `bun run audit:migration-freshness`：**valid=true**；Python capability/test/dependency、TS composition、TS boot、source snapshot、capability links 均 valid |
| Python consumer | `bun run audit:python-consumers`：**valid=true**、`remaining_consumer_count=0` |
| 格式/差异 | 修改脚本与测试 Prettier 通过；限定文件 `git diff --check` exit 0 |

该修复不把台账数量当完成率，也不关闭 R01/R02/R03 或 Python 行为迁移；它只恢复了输入新鲜度审计的可重复性。未改用户数据，不涉及 full sandbox。

# R03：PowerShell 当前会话入口诊断

日期：2026-09-06。承接 npm shim 核验，属于 R03 可验证切片，不关闭 R03 或全阶段计划。

## 实现与验收场景

子进程无法读取父 PowerShell 的交互 alias/function。因此新增只读采集脚本 `scripts/arforge-cli-path.ps1`，在待检查会话中使用 Get-Command -All 获取名称、类型、文件路径，经 stdin 交给现有 TS `cli-path --powershell-stdin`。诊断、文件核验、报告仍共用同一个 TS owner；脚本不是另一套产品 CLI，不持有业务状态。

```powershell
# 在需要检查的 PowerShell 会话执行；省略 -Json 可查看中文说明。
& '%ARFORGE_REPO%\scripts\arforge-cli-path.ps1' -Json
```

- 保留 Get-Command 返回顺序，能显示文件入口前的 alias/function 遮蔽。未知函数/别名导致 blocked、逻辑 CLI 数量为 null，不猜测它们等价于 TS 入口。
- 不调用发现的 arforge、不读取函数正文、不读取 alias 定义；文件候选复用现有固定模板、目标 realpath、package 与 launcher/source 摘要检查。
- stdin 上限 32,768 字节、命令上限 64 个；字段校验拒绝函数正文、非法命令名及非绝对文件路径。文件 basename 必须匹配声明的 arforge 名称；直接 UNC/device 路径在读取前拒绝，避免这类远端路径触发访问。
- JSON 解析失败返回固定错误，不回显输入。无效输入退出码 2；正常报告沿用 0/1。设置了 10 秒 stdin 超时，但未把超时分支计作本批已测场景。
- 采集脚本使用 Node Application，避免名为 node 的函数/别名遮蔽；仅临时设置脚本作用域 UTF-8 输出编码并恢复，没有修改 PATH/profile/执行策略。
- 快照是调用者提供的元数据，不是来源认证，也不是执行授权。报告 schema 仍为 2，新增 resolver 值 PowerShell:Get-Command。

## 新鲜验证

在 packages/arforge 执行：

```powershell
bun test test/cli/cli-path.test.ts --rerun-every
bun run typecheck
```

结果：**26 passed / 0 failed / 89 expect() calls**，类型检查通过。两个受影响 TS 文件 oxlint --deny-warnings 为 0 warnings / 0 errors，Prettier 未产生差异。

实际进程测试包括：PowerShell 函数遮蔽、别名遮蔽、正常文件入口；函数体中的抛错哨兵没有执行。另经正式 Node launcher 传入非法 JSON 和超大 stdin，均返回 blocked/退出码 2，输出不含输入哨兵。保留原 Windows npm CMD 中文空格路径与直接 launcher 的结果一致性回归。

测试使用临时 home、内存 DB，关闭项目配置及模型目录抓取，不使用真实远端 Provider。PowerShell 子进程使用 NoProfile；本机选中 pwsh，Windows PowerShell 5 和真实用户 profile 没有据此宣称通过。Windows 专属测试在其他系统明确 skip，不等于全平台验证。

开发中曾出现 yargs 连字符选项与参数类型不一致导致的类型错误，及断言 await 的 lint 警告；修复后重新执行上述检查通过。未掩盖此前 R08 全文件 57 条 lint 警告。

| 受测文件 | SHA-256 |
|---|---|
| packages/arforge/src/cli/cmd/cli-path.ts | 1f130b04345412156a93575b900a6191b33a535d096af7b76e33f23eee3b5ed5 |
| packages/arforge/test/cli/cli-path.test.ts | a338769a96f59376d01a7db70e99cfa2d1134db428857f9f78dc7cd055800847 |
| scripts/arforge-cli-path.ps1 | 3de7f2681c1c29101c5d3f9faf8f084921dd24c9e1d1e2684d2f515c92291510 |

## 剩余范围

R03 仍需覆盖 profile/执行策略/新 shell 差异、历史 venv/IDE、Node/Bun 环境身份和安装脚本完整用户旅程。函数/别名仅识别遮蔽，不解析其任意行为；未证明全部 npm 版本及独立安装副本等价。直接 UNC 拒绝不代表完整文件系统网络隔离或并发替换防护。全阶段完成后才进入用户后置的三平台 full sandbox。

现有生成器刷新了 composition（1,751 个源码文件）与 dependency（7,260 个扫描文件、7,446 个依赖叶项）库存；源码快照为 7,459 项。统一 freshness 集成测试 **2 passed / 7 expect() calls**，七个校验项通过。本批与入口测试合计 **28 passed / 96 expect() calls**，另外包含 Node assert.rejects 的异常断言，未将其混入 Bun expect 计数。

库存与源码指纹是可重跑的新鲜度检查，不是功能完成比例；不把本批测试通过计为 R03 全包关闭。

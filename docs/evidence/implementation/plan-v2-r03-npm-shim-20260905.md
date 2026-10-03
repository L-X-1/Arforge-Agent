# R03：npm shim 实目标核验

日期：2026-09-05。承接仓库 CMD 误判修复；继续完整 v2.0 计划，不关闭 R03。

## 实际实现

本机 where.exe 返回仓库 arforge.cmd 与 npm 的 arforge/arforge.cmd；npm/node_modules/arforge-agent 为指向当前 E:/Arforge-Agent 的 junction。读取了本机 CMD、POSIX shell、PowerShell 三份模板后，将这些已审阅模板作为固定摘要白名单，并加入可移植测试夹具；产品不读取测试夹具。

现有 cli-path owner 现在支持：

- 对已审阅 npm 模板计算完整内容摘要（仅统一 CRLF/LF），不根据注释、文件位置或片段推断启动目的地；其他模板仍 unknown，模板合法更新需要复核。
- 解析 shim 同目录下 node_modules/arforge-agent 的 realpath，必须确实等于当前产品 checkout；再核对 bin/arforge.js 与 TS index.ts 实路径，沿用已审阅 launcher 指纹检查。
- 仓库 CMD 与 npm shim 共用 package.json 身份/版本/摘要检查，要求 name=arforge-agent、有效版本字段；报告包含 package_root/package_version/package_digest。
- 四个合法 wrapper（仓库 CMD + 三种 npm 模板）归为一个逻辑 CLI；断链、旧 checkout、错误包名、launcher 修改及额外脚本命令不能获得 canonical-shim 结论。
- 没有修改全局 npm 安装、PATH、用户 launcher 或 shell profile；没有从旧 Python 重新启动产品。

## 验证结果

1. 新 npm 合并用例最初 RED（blocked），实现后 GREEN。
2. 最终 **19 passed / 53 assertions**，其中包含先前 CMD 误判回归、新增 npm 五类反例、CRLF 与版本绑定、四 wrapper 合并。
3. 真实 Windows CMD：在临时中文/空格目录放入已审阅 npm CMD 模板并建立指向当前仓库的 junction；执行 cli-path --json，与直接 node bin/arforge.js 的 JSON 和退出码相同。配置/home 隔离、DB 为内存，夹具自动清理。其他平台显式 skip 此 Windows 专属用例，不能当作跨平台通过。
4. packages/arforge 全包 typecheck 通过；两受影响 TS 文件 oxlint --deny-warnings 0 warnings / 0 errors、Prettier check 通过。shell 模板保留原始字节，不对其执行格式化。
5. 原生成器刷新 composition/dependency 后，统一 freshness 集成 **2 passed / 7 assertions**，七项检查通过。本批合计 **21 passed / 60 assertions**；源码快照 7,457 项，仍非功能验收分母。

```powershell
# packages/arforge
bun test test/cli/cli-path.test.ts --rerun-every
bun run typecheck
```

| 受测文件 | SHA-256 |
|---|---|
| packages/arforge/src/cli/cmd/cli-path.ts | 33d737d462d9815ca1d250a9355982c53b8f7a7c55931c94eeb4a4253d30b91c |
| packages/arforge/test/cli/cli-path.test.ts | 9ca804742736ba379d81d90a1787035b3d0f035a049f08a17056aac4af3b1fee |

模板摘要（LF 规范化）：CMD d295eac6ad82bac1bd2e3ec5dfb7865bd466c57c4cd14f09ae76fcf2ac2440a1；shell 7f5484e01a2796fb82cfa901e4d7594dc3005b0b5c93d07ed2cc37c3510fcd27；PowerShell 43b068f827f09ce6349a98cdf192d75285319dc6054ecffc39a1c98139c5812f。

## 剩余要求

- 当前 PowerShell 会话 alias/function/.ps1 优先级、profile、历史 venv、IDE 及全新 shell 解析仍未闭合。对 ps1 模板的只读核验不等于真实 PowerShell 用户旅程。
- 非白名单 npm 版本、独立安装副本、其他 bin wrapper 尚未支持；不同 checkout 即使版本相同也不会合并。没有声称 npm 各版本通用解析。
- Node/Bun 可执行文件版本/身份、局部 node.exe、PATH/ARFORGE_BUN 等环境覆盖项和完整 import graph 仍待核验；当前证明的是脚本固定目标关系，不是对所有执行环境的安全认证。
- 稳定文件读取假设仍有效，未提供对抗并发替换的原子证明。install.bat/安装说明及其他计划阶段继续保留，不执行后置的 full sandbox。
- 上批 Runner 全文件 57 条 lint 警告未因本批专项检查通过而关闭。

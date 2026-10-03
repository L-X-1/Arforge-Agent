# R03：CLI 入口路径误判修复（仓库 CMD 切片）

日期：2026-09-05。继续完整 v2.0 计划，不关闭 R03，不修改用户 PATH、shell profile 或已有 launcher。

## 实码问题与修复

旧诊断将仓库内同名 arforge.cmd 无条件判为 canonical，并将含 node_modules/arforge-agent 与 bin/arforge.js 字符串的脚本判为同一 npm shim。两个新增反例先失败，证明 Python wrapper 和无效脚本确实能获得错误肯定结论。

现已修复：

- 仓库位置不再构成认证；Python 可执行内容先识别为 legacy-python，rem/# 注释不作为实际 Python 调用证据。
- 已审阅的仓库 arforge.cmd 只接受明确的有效命令序列，允许空行/rem 注释，额外执行语句拒绝。
- 只读检查 bin/arforge.js 与 packages/arforge/src/index.ts 的实路径；不存在、非普通文件、过大文件和指向其他 checkout 的 junction 不取得验证记录。
- bin/arforge.js 必须匹配代码中已审阅的 SHA-256（LF/CRLF 统一）。该 launcher 内容若有合法变更，也必须复核并更新指纹；不能自动信任任意新内容。
- 输出 wrapper、launcher、TS source 的摘要与最终目标。不执行被发现的 wrapper；指纹仅证明当前审阅范围内的文件关系，不是签名或全链路安全认证。
- 未核验 npm shim、其他安装版入口仍 unknown/external；不能因为包含路径片段就折叠成同一 CLI。
- schema 升级为 **2**：`logical_cli_count` 在外部/未知/旧 Python 入口存在时为 null，文本显示“未确定”。报告列出解析范围与限制，防止 where.exe 的结果冒充当前 PowerShell 会话全部命令解析。

这是真实诊断修复，不是删除 wrapper、恢复旧 Python 入口或另建产品 CLI。

## 实际验证

- 新反例 RED：2 failed / 3 passed；实现后更新旧的不正确肯定断言。
- 最终定向测试：**11 passed / 30 assertions**，包括真实 `node bin/arforge.js cli-path --json` 子进程、隔离配置与内存 DB，输出 schema v2 与退出码一致；Windows 工作区 canonical 文件条目确有目标摘要。
- 夹具覆盖中文/空格路径、Python wrapper、伪造 npm 片段、重复解析项、launcher 修改、TS 目标缺失、额外命令、不同 checkout、目标目录 junction、无法读取/无解析结果。全部夹具临时目录自动清理，不改用户 PATH。
- packages/arforge 全包 typecheck 通过；两个受影响文件 oxlint --deny-warnings **0 warnings / 0 errors**，Prettier check 通过。
- 一次误在仓库根执行 bun test，被仓库 do-not-run-tests-from-root 防护拒绝，未产生测试通过；随后在 packages/arforge 正确目录复跑，上述统计只取正确执行结果。
- 使用原生成器更新 composition/dependency，刷新输入快照后，统一 freshness 集成 **2 passed / 7 assertions**、七项检查通过。本批合计 **13 passed / 37 assertions**；源码输入 7,453 项，不是功能完成分母。

```powershell
# packages/arforge 目录
bun test test/cli/cli-path.test.ts --rerun-every
bun run typecheck
# 正式用户入口，只读（遇未知候选退出 1 是保守诊断，不是运行时失败）
node bin/arforge.js cli-path --json
```

| 受测文件 | SHA-256 |
|---|---|
| packages/arforge/src/cli/cmd/cli-path.ts | 9c92908fa5190efb9600566ae64125144814cccde5eb1c104b67eb022f21289e |
| packages/arforge/test/cli/cli-path.test.ts | 680c5b06c34791998176db1432d79a3bd396e9fc32d5cb9808b2036c10e4aa35 |

## 尚未完成

1. 真实 npm shim 的递归目标、npm link、版本/源码关系核验；当前合法 npm shim 也可能得到 unknown，不能宣称多种正确 wrapper 全已验收。
2. PowerShell 当前 alias/function/.ps1/profile、激活历史 venv、IDE 和全新 shell 的完整解析及优先级说明。
3. ARFORGE_BUN/PATH 中 Node/Bun 的最终实际版本、环境覆盖和整个 TS import graph；当前仅绑定已审阅仓库启动脚本及入口文件。
4. install.bat 与安装说明的完整修复及多平台运行。读取使用稳定文件假设，未提供对抗并发文件替换的原子保证。
5. 上批 Runner 大文件的 57 条 lint 警告不因本批两文件 lint 通过而关闭；其余 R00—R31 按计划继续，真实 full sandbox 仍后置。

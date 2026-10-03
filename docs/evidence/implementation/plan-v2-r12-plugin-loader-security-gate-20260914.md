# Plan v2.0 R12 — Plugin loader manifest security gate（2026-09-14）

## 本批完成

- 在既有 `PluginLoader.load` 的 import 前阶段接入 Core `plugin-contract`：带 `plugin.json` 的模块先解析 manifest metadata，拒绝禁用版本或缺 name/version 的 manifest，再运行既有 tree digest、签名验证和静态安全扫描。
- `security.status=blocked` 或 blocking finding（forbidden EventV2/database-admin 边界、未声明 egress/secret、扫描限制、无效签名等）在 dynamic import 之前返回错误；unsigned/untrusted 仍按既有 warning 语义，不把静态 warning 伪装成硬隔离。
- 预检通过后在 import 前重新计算 tree digest，检测预检与加载之间的本地文件漂移；不新增 loader、权限数据库、执行器或 OS sandbox。没有 `plugin.json` 的既有开发模块保持原兼容路径。

## 实际验收

- Arforge `test/plugin/loader-shared.test.ts`：**29 pass / 0 fail / 43 expect calls**。新增“Core manifest security gate 在 import 前阻断”并验证插件副作用文件没有创建；既有 file/npm、v1、入口选择、重试和顺序测试继续通过。
- 新增安全 fixture：`unsafe.js` 含 forbidden EventV2 访问，模块本身若被 import 会写 `called.txt`；实际 `called.txt` 不存在，证明阻断发生在 import 前。
- 修改文件 scoped Oxlint：**0 warnings / 0 errors**；Prettier、`git diff --check` 通过。Arforge 包级 typecheck 仍只被既有 `packages/tui` JSX/BaseRenderable 诊断阻断，本批 loader 无新增类型诊断。

## 用户影响与边界

带 manifest 的插件在加载前会得到可诊断的安全阻断；不带 manifest 的本地开发插件行为不变。未修改插件或用户数据。

R12 仍未关闭：PluginControl 的真实多入口授权/撤销、受限宿主 capability RPC、运行中 hook 终止、完整 revision provenance/签名信任存储及真实 OS hard isolation 仍待后续；签名/静态扫描不等于 Bun 进程隔离，full sandbox 继续按 R30 后执行。

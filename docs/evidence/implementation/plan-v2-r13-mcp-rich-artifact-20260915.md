# R13 MCP rich result Artifact/trust projection（2026-09-15）

## 结论

MCP 富结果现在复用 Core 既有 `ToolOutputStore`，不再只有不可恢复的内联 `data:` 投影：带有既有 `source=mcp-capability-registry` 标记的 prompt/resource/tool 结果，其二进制内容会在结算边界写入同一托管 Artifact catalog，并随 settlement 返回 `OpaqueArtifactRef`。模型仍得到原来的内联媒体以保持 provider 兼容；Artifact 回执是恢复、审计和跨入口读取的规范身份，普通工具媒体路径不变。

绑定是确定性的：owner、session、tool call、MCP server/kind/URI、附件序号和 SHA-256 内容共同决定 managed handle。重复结算先验证已有 index、owner、digest、大小、MIME 和 handle，再复用原回执，不追加第二条 `registered` 审计。非法或非内联 MCP 富附件在进入存储前 fail-closed，不会写入 catalog。

## 实现

- `packages/core/src/tool-output-store.ts`
  - 增加 MCP 富附件 10 MiB 上限和严格 base64/data URL 解码。
  - 在现有 write-ahead marker、index、hash-chained catalog、owner/retention/digest 校验之上增加稳定 MCP receipt 绑定；未标记的普通工具媒体保持原有 inline 行为。
  - 小文本结果也会保留 MCP `artifactRefs`；大文本结果与既有文本 Artifact 回执合并，旧 `outputPaths` 仍仅作兼容投影。
- `packages/core/test/tool-output-store.test.ts`
  - 覆盖 MCP resource 形态的图片结果、回执 MIME/大小/label/owner、真实 bytes 读取、重复结算幂等和单条注册审计。
  - 覆盖非法非内联 URL 的 fail-closed 与 catalog 零写入。
  - 明确普通工具 native media 仍不产生 Artifact 回执。

## 验收证据

| 范围 | 命令/结果 |
| --- | --- |
| Artifact store 全量 | `D:\\bun\\bin\\bun.exe test --timeout 90000 test/tool-output-store.test.ts --rerun-every`：**38 pass / 0 fail / 205 assertions，exit 0** |
| MCP projection 回归 | `D:\\bun\\bin\\bun.exe test --timeout 60000 test/mcp/resource-projection.test.ts --rerun-every`：**11 pass / 0 fail / 48 assertions，exit 0** |
| 新增 MCP rich 绑定筛选 | MCP rich、非法 URL、普通 media 与 text+media：**4 pass / 0 fail / 18 assertions，exit 0**（包含全量中的对应 4 项） |
| Core 类型 | `D:\\bun\\bin\\bun.exe run typecheck`（`packages/core`）：**exit 0** |
| 格式/差异 | Prettier 对修改的 TypeScript 文件通过；限定 `git diff --check` 通过 |
| Oxlint | 修改文件 **0 errors**；报告的 warning 来自该文件/既有测试中的原有类型断言与 consistent-return 规则，不是新增错误 |

## 边界与未关闭项

1. 内联媒体仍保留给模型 provider；Artifact receipt 是持久化/恢复身份，不宣称已经把所有 provider 的媒体输入改为远程 receipt URL。
2. HTTP/CLI catalog 的 control Action/Gateway 身份、授权、期限、持久回执与恢复仍待 R13 后续切片；本切片只统一富结果存储 owner。
3. MCP 四类本地 stdio/HTTP 生命周期、断连/代际冷恢复、默认全量失败矩阵和真实外部服务仍开放；已知两个 Windows/Bun 本地 stdio 边界失败不归因于本切片。
4. full Linux/macOS/Windows sandbox 继续按 R30 完成后执行。

测试仅使用临时目录、内存数据和 SQLite，不访问用户数据、不发送网络请求、不使用真实凭据。

# Plan v2.0 R10 — Skill Discovery Core 融合与边界证据（2026-09-14）

## 本批完成

- `packages/arforge/src/skill/discovery.ts` 不再维护第二套 HTTP 下载器、缓存路径算法或刷新逻辑；产品 `cfg.skills.urls` 入口现在仅通过 `@arforge-ai/core/skill/discovery` 的 `SkillDiscovery` 服务做字符串路径适配。
- Core Discovery 将索引与文件读取统一纳入有界响应收集：索引 1 MiB、单文件 4 MiB、单次 pull 总文件 32 MiB、索引最多 128 个 skill、每个 skill 最多 256 个文件、单文件路径最多 1024 字节、pull 总时限 30 秒。超限或取消不会发布 staging 目录。
- unversioned、same-version、version-change 都先判断已发布 revision 是否完整；需要更新时下载到随机 staging 目录，完成必需文件校验后再用原子 rename 替换。刷新失败继续暴露旧的已发布 revision，不返回半写目录；旧版本只在新版本完整后被清理。
- 原有 Core 的来源隔离缓存、相对路径/跨 origin 检查、FSUtil/FileGuard 写入边界继续保留，没有新增权限数据库、HTTP owner 或恢复器。

## 实际验收

- Core `test/skill-discovery.test.ts`：**10 pass / 0 fail / 31 expect calls**。新增索引条目上限、超大文件零发布、无版本刷新失败保留旧 revision；既有 traversal、跨 origin、嵌套文件、版本更新、旧文件清理继续通过。
- Arforge `test/skill/discovery.test.ts`：**7 pass / 0 fail / 25 expect calls**。产品 Discovery 适配器的 Cloudflare fixture、缓存、版本刷新和无尾斜杠行为通过。
- Arforge `test/skill/skill.test.ts`：**17 pass / 0 fail / 48 expect calls**。正式 `Skill` 服务的 `.arforge`、`.claude`、`.agents`、全局/禁用外部目录、目录投影和缺失技能错误继续通过，证明适配器没有破坏用户可见目录。
- Core `bun run typecheck`：exit 0。
- 修改文件 scoped Oxlint：**0 errors**（Core discovery 测试文件合计 1 个既有 warning）。Prettier、`git diff --check` 通过。

## 用户影响与边界

Skill 配置的远程目录仍按原 `cfg.skills.urls` 使用；目录条目不合法、远程文件超限或刷新不完整时，用户继续看到上一个完整版本，首次安装则返回空目录并记录可诊断错误。该批未修改用户数据或已发布缓存；临时 staging/backup 在成功或失败后清理。

R10 仍未关闭：签名/manifest trust 与 revision provenance、Egress/SecretProvider 的实际下载授权、redirect 逐跳策略、CLI/Desktop/子代理统一可见性、撤销/删除后的新 turn 行为仍待后续切片。真实三平台 full sandbox 仍按 R30 后执行。

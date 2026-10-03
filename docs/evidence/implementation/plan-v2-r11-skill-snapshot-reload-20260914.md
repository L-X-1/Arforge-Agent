# Plan v2.0 R11 — Skill snapshot、可见性与 reload 证据（2026-09-14）

## 本批完成

- Core SkillV2 现在是来源可见性解析的唯一 owner：来源按注册顺序合并，同名 Skill 由后注册来源覆盖，但保留首次出现位置，保证 prompt 顺序确定。
- SkillV2.reload()、来源 transform 和 transform scope 释放都会失效按来源缓存；来源签名变化也会在读取前触发失效。因此目录文件编辑、URL refresh 和来源删除不会继续使用旧缓存。
- 新增不可变 SkillV2.snapshot()，返回单次 materialized revision、脱敏来源 locator、冻结的 Skill 列表和基于来源身份/Skill 内容的 SHA-256 digest。URL provenance 只保留 origin/path，不带用户名、密码、query 或 hash；digest 可供后续 R06 请求绑定使用。
- 正式 Arforge Skill 服务也新增同语义的 reload()/snapshot()：InstanceState 的 discovery/state 缓存按一次 reload 一起失效，返回 revision、Skill/目录快照和 digest；既有 CLI、Session、Agent、HTTP consumers 继续使用同一服务。
- 既有 State、SkillDiscovery、PermissionV2 与插件 transform/reload owner 保持不变，没有新增缓存、权限或持久化事实源。
- 正式 Core SessionRunner 在创建主 Provider `RequestEnvelope` 前读取可用的 SkillV2 snapshot，并将其 SHA-256 digest 写入 `execution.skill_snapshot_digest`。该字段只接受小写 64 位十六进制摘要，随 envelope 的 canonical digest、EventV2 `RequestEnvelopePrepared` 和 recovery rebuild 一起校验；Skill 服务缺失的轻量兼容夹具不会伪造摘要，生产图由 `SkillGuidance -> SkillV2` 提供同一 owner。
- Arforge mature AI-SDK/native 适配器也接受并自动补齐同一 Skill snapshot digest；`RequestBindingPrepared`、RuntimeInvariant projection 与 parity `RequestProjection` 均保留该可选字段。显式传入的 digest 与当前 Core snapshot 不一致时在 provider preparation 前 fail-closed，避免成熟适配器悄悄使用另一版 Skill。

## 实际验收

- Core test/skill.test.ts：5 pass / 0 fail / 25 expect calls。覆盖后来源覆盖、冻结 projection、目录编辑后旧 snapshot 保持不变、reload 后新内容可见、URL refresh 次数和凭据脱敏。
- 受影响 Core 回归（test/skill.test.ts、test/tool-skill.test.ts、test/skill/guidance.test.ts、test/plugin/skill.test.ts）：12 pass / 0 fail / 41 expect calls。
- Arforge test/skill/skill.test.ts + test/session/system.test.ts：23 pass / 0 fail / 76 expect calls。覆盖正式目录发现、reload 后新内容、旧 snapshot 稳定、目录投影和系统提示回归。
- Core bun run typecheck：exit 0。
- Core `test/session/request-envelope.test.ts`：22 pass / 0 fail / 69 expect calls。覆盖 Skill digest 的 canonical 校验、持久 JSON 往返、摘要变化导致 request digest 变化及非法摘要 fail-closed。
- Core `test/session-runner.test.ts`：25 pass / 0 fail（既有正式 Runner 回归；请求 envelope 仍沿原 prepare→commit→rebuild 路径）。
- Arforge `test/session/mature-request-binding.test.ts`：5 pass / 0 fail / 19 expect calls；覆盖 mature native/prepared binding 的 Skill digest 绑定、差异摘要和非法输入。
- Core `test/session-runner-evidence.test.ts` + `test/session-runner-parity.test.ts`：20 pass / 0 fail（包含 formal/mature 可选 Skill digest 的共同投影与比较）。
- 修改文件 scoped Oxlint：0 warnings / 0 errors；Prettier 与 git diff --check 通过。

## 用户影响与边界

同一 turn 已拿到的 snapshot 不会被后续 reload 改写；新 turn 通过 reload() 获得新 revision。正式 Core Provider 请求现在携带该 snapshot digest，重启恢复时若当前 Skill 版本不同会使 request digest 不一致并停在 recovery gate，而不是把新 Skill 当成旧请求重放。旧的 SkillV2.list() 和 Arforge Skill.all() 调用仍保持兼容，插件/工具未增加第二套可见性解析。

R11 仍未关闭：watcher 自动触发、跨进程持久 snapshot、配置覆盖层 provenance、权限撤销阻断持有旧 grant 的待执行动作，以及 CLI/Desktop/子代理统一消费仍待后续切片。R06 也仍未关闭：需要继续完成 prepare 后 defaults/endpoint/cache/schema/credential 变更及真实新进程矩阵，并在真实 formal/mature/provider 旅程中证明摘要一致；本批只完成合同和接线。真实三平台 full sandbox 仍按 R30 后执行。

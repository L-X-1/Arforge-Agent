# Step 7.6 — Skill Compiler 验证证据

日期：2026-08-12

## 实现范围

- 新增 `packages/core/src/skill-compiler.ts`，只生成 candidate store，不安装或激活 Skill。
- 编译入口要求至少一个 `reusable=true`、带 run/evidence 的 Experience；来源 Experience IDs 写入 V1 manifest。
- 生成 bounded `SKILL.md`/assets/scripts refs、确定性 test IDs/digests、Skill artifact digest 和 pending evaluation/approval requests。
- 严格限制文件数量、单文件大小和总大小；拒绝绝对路径、盘符路径、空/`.`/`..` 路径。
- 对 secrets、unsafe command execution、network URL/client 做扫描；发现命中立即 fail-closed，不写 candidate。
- 同一 skill/version 已有相同 digest 时幂等复用；digest 不一致时拒绝覆盖。

## 验证结果

```text
bun run --cwd packages/core typecheck
passed

bun test --cwd packages/core test/skill-compiler.test.ts
2 pass, 0 fail

bunx prettier --check packages/core/src/skill-compiler.ts packages/core/test/skill-compiler.test.ts
passed

bunx oxlint packages/core/src/skill-compiler.ts packages/core/test/skill-compiler.test.ts
0 warnings, 0 errors
```

测试覆盖：candidate store 写入与幂等、manifest/test/evaluation/approval pending 状态、已验证 Experience 前置条件、unsafe path、secret/network script 拒绝，以及没有 active 安装副作用。

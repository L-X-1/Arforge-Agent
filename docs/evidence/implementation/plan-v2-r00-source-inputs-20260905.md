# Plan v2：R00 源码输入指纹与新鲜度

日期：2026-09-05。承接首批 R02 的 CLI/CI 修复。本批只完善工程证据校验，不改变产品运行时，不关闭全部 R00/R01。

## 本批实现

- 新增 script/arforge-source-snapshot.ts，作为现有 migration freshness 的输入校验模块；只复用已有 canonical JSON/hash 工具，不调用已弃用的 Luna protocol/card/claim 状态机。
- Git -z 枚举当前已跟踪和未忽略的未跟踪文件；记录 HEAD、逐文件 Git 状态、字节长度和 SHA-256。删除的已跟踪文件显式记录 deleted。NUL 解析避免空格、中文和 rename 双记录被拆错。
- 分批、流式计算文件摘要，不复制文件正文，不读取 Git 忽略的 .env。遇到 symlink/junction/非普通文件拒绝处理，不越界跟随链接。
- 写入前后检查路径，使用独占临时文件、fsync、rename 发布；验证命令只读，不会替用户刷新过期证据。生成必须明确 --write。
- 新鲜度总门禁增加 source-inputs；快照内容篡改、输入变化、新增/删除文件、未知 schema 字段均不能通过。输出仅表示 input freshness，不能用作功能完成、授权或可信签名。
- 原位修复 numericMetrics 的 TypeScript tuple 类型收窄，使专项类型检查真实通过；没有放宽门禁。
- 使用原生成器更新 capability/file、test、dependency、composition 投影及对应 attestation；没有手工把 OPEN 改为完成。

## 使用

在 E:/Arforge-Agent 根目录执行：

```powershell
# 只读验证当前输入
bun run script/arforge-migration-freshness.ts validate-source-snapshot --root .

# 明确确认当前输入应成为新基线后生成；不代表测试重跑或需求验收
bun run script/arforge-migration-freshness.ts generate-source-snapshot --root . --write

# 所有台账与输入一起验证
bun run audit:migration-freshness
```

生成物：docs/evidence/implementation/source-snapshot.v1.json。只排除这个生成物自身，其他 Git 可见证据与配置文件仍纳入摘要。

先完成源码/证据修改和台账更新，最后生成输入快照，然后执行验证。后续任何受跟踪输入修改都应使它过期，不能拿旧结果给新代码盖章。

## 明确限制

- 这是输入指纹清单，不是包含源文件正文的可恢复备份，不能靠摘要重建已经丢失的未提交代码。
- 范围是 Git-visible working tree；不涵盖被忽略的依赖目录、私有凭据、工具二进制、外部账号及其状态。完整环境/测试输入关联仍属于 R00/R01 后续工作。
- 捕获期间应保持源码静止。已检查读取期间文件元数据与前后 Git 清单变化，但不宣称提供文件系统级原子快照或对抗恶意并发替换的 OS 安全边界。
- 摘要可检测输入变化，不是签名或测试运行证明；不会据它自动设置功能 accepted。
- 包含 symlink/junction/submodule 目录等非普通文件的工作树会 fail-closed，不能静默排除后宣称全覆盖。当前项目的实码采集已完成试跑，未触发该限制。
- 生成器原有 OPEN 语义保持原样。5080 个能力叶和其他数量只反映盘点规模，不计迁移完成率。

## 测试与验证

| 检查 | 结果/范围 |
|---|---|
| 新模块初次测试 | 因模块未实现而失败；随后实现并修复测试夹具的 Windows junction 清理问题 |
| 快照与四类生成器测试 | 26 pass / 0 fail，75 assertions，5 files |
| 专项类型检查 | exit 0；使用项目已有 packages/core/node_modules/@types 中的 Bun 类型 |
| oxlint --deny-warnings | 0 warnings / 0 errors，4 files |
| Prettier check | 4 files 全部通过 |
| 统一 freshness 与真实工作树集成测试 | 2 pass / 0 fail，7 assertions，19.14s；六项检查全部通过，缺失根目录的负例仍拒绝 |

本批两组共 28 个不同测试、82 个断言通过。初次真实工作树指纹包含 7,445 项；此数量是 Git 可见输入数，不是已完成能力数。后续正文更新后需再次生成指纹，使当前清单与当前文件一致。

本批脚本验证输入 SHA-256：

| 文件 | 摘要 |
|---|---|
| script/arforge-source-snapshot.ts | c65a30d0c6bc9a6d1c4e4129d12f446a9f33c77189e3811e90cc757d691c3019 |
| script/arforge-source-snapshot.test.ts | 51a4bc4ae4095c7567339012b718bf2461e46d1396ad2039622d791fd026dad4 |
| script/arforge-migration-freshness.ts | 5f1029719ae7aeb1626370b0f863e392bfec39968c9da34d0a54dcb7ab3847df |
| script/arforge-migration-freshness.test.ts | dab39e226df6f79ec50d9992263aba126679124efd6ad6b10f85a2c3fcb937d2 |


定向测试命令（script 目录）：

```powershell
bun test arforge-source-snapshot.test.ts arforge-python-ledger.test.ts arforge-python-tests-ledger.test.ts arforge-python-dependencies-ledger.test.ts arforge-ts-composition-ledger.test.ts --rerun-every
```

专项类型检查（根目录）：

```powershell
bun run tsc --noEmit --skipLibCheck --moduleResolution bundler --module esnext --target esnext --types bun --typeRoots packages/core/node_modules/@types script/arforge-source-snapshot.ts script/arforge-source-snapshot.test.ts script/arforge-migration-freshness.ts script/arforge-migration-freshness.test.ts
```

## 后续

R01 还需实现“原行为→TS owner→测试/成功旅程→输入版本”的逐能力验收关联，并使无关输入变更不误伤其他项、相关变更能令对应证据过期；不能把全仓快照直接当逐能力完成清单。之后继续 R05/R06/R14 的真实功能缺口，全部非后置工作完成后才执行三平台 full sandbox。

边界自检：本批未删除用户源码，未清空工作树，未改 Git 配置，未提交/推送，未修改全局 PATH，未操作用户服务，未使用真实 Provider 凭据；测试只在独立临时目录创建文件。

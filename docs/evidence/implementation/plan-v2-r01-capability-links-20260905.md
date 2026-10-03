# Plan v2：R01 行为关联与声明输入的新鲜度（首个切片）

日期：2026-09-05。此批完善迁移证据工具，不改变产品运行时，不关闭 R01，不恢复旧 Luna 协议。

## 实现范围

- 在现有 migration freshness 中增加 `capability-links` 检查及 `validate-capability-links` 只读子命令；独立的 capability-links.v1.json 不由 Python OPEN 库存生成器写入。
- 稳定行为 ID 不包含源行号；记录旧文件/符号、既有 TS owner、别名、分类、测试选择器、预期结果与限制。重复 ID 或完全相同的声明别名会报错；这不是自然语言语义去重。
- 可选 receipt 绑定行为合同摘要、声明的逐文件输入摘要、场景列表、单独的结果文件摘要、命令、环境和执行范围。修改行为预期、漏绑源码/测试、重复输入、结果文件篡改或失效路径均报错。
- 复用 R00 链接/junction 拒绝和流式文件摘要，不另外实现文件安全管线。新鲜度只比较声明的文件，相关文件变化失效，无关文件不会使该条关联的 receipt 失效；全仓 source-inputs 仍按全仓变化独立失效。
- `valid` 仅表示结构与声明输入匹配。`current-reported-pass`、`current-reported-failure` 都是结果声明，不是功能验收；所有记录明确输出 `accepted: false`。未知的 accepted/status 等字段拒绝，不能手填完成状态混入检查。
- 当前两条实码定位记录都是无 receipt 的待复验/待融合项，`missing_evidence_count=2`。历史 R02 结果不冒充本批声明输入的验收收据。

## 本次纠正的语义前提

`arforge/cli.py::_run_capability_eval` 明确描述为“不调用模型的确定性基础设施合同”，再调用 `arforge.core.capability_eval.run_capability_eval`。因此，不能把旧命令笼统称为真实模型任务评测，也不能把新 `capabilities evaluate` 的静态 typed 合同审计视为完整等价替代。下一批必须逐项比较旧报告、错误、退出码及内部行为，然后融入已有 CapabilityAnalysis / Evaluation / Golden。

## 使用与结果解释

仓库根目录执行：

```powershell
bun run script/arforge-migration-freshness.ts validate-capability-links --root .
bun run audit:migration-freshness
```

只读，不执行 receipt 中的 command，不访问 Provider，不修复/重写记录。路径或摘要错误返回 JSON findings 并退出 1；合法但缺少证据的关联返回 valid=true 和 missing，不能将退出 0 当作验收成功。失败测试的有效 receipt 同样会显示 current-reported-failure，不能用此命令替代测试门禁。

正式 receipt 的输入至少包含关联的所有旧文件、owner 文件和测试文件；实际调用链依赖、锁文件、工具链、平台/环境等仍需由对应验证批次完整声明。合同摘要按既有 canonicalJson 计算，包含除 receipt 外的全部记录字段。receipt 是可检查的自述元数据，非签名、非自动执行证明，不能证明遗漏依赖没有影响。

## 已实际执行的验证

- 先运行新测试确认缺少模块失败，再实现：RED → GREEN。
- 新关联工具 10 测试；连同 source snapshot 和四类库存生成器：**36 passed / 101 assertions / 6 files**，最终代码复跑通过。
- 覆盖相关等长修改、无关修改、预期变化、重复 ID/别名、缺失输入、场景错绑、证据篡改、非法 JSON/路径、junction 越界、未知验收标志、失败报告、只读不改文件。
- 实际启动 TS 校验 CLI，验证 stdout 可解析 JSON、合法输入退出 0、缺失 owner 退出 1。仅是本工具用户旅程，不宣称产品 CLI 全面验收。
- 专项 TypeScript typecheck 通过；oxlint --deny-warnings 为 0 warnings / 0 errors；Prettier check 通过。首次 lint 的不安全类型断言已改为类型守卫后重跑。
- 使用现有生成器更新 Python dependencies 库存：7,256 扫描文件、7,412 依赖叶、6 资产；均为盘点数量，不是完成率。
- 刷新 source snapshot 后，统一 freshness 集成测试 **2 passed / 7 assertions**；本批合计 **38 passed / 108 assertions**。实际 `bun run audit:migration-freshness` 的七项检查均 valid=true，含 7,449 项源码输入和两条 missing 的能力关联。此项仍是工程一致性校验，不是功能通过率。

测试命令：

```powershell
# script 目录
bun test arforge-capability-links.test.ts arforge-source-snapshot.test.ts arforge-python-ledger.test.ts arforge-python-tests-ledger.test.ts arforge-python-dependencies-ledger.test.ts arforge-ts-composition-ledger.test.ts --rerun-every

# 根目录；仅受影响脚本类型检查
bun run tsc --noEmit --skipLibCheck --moduleResolution bundler --module esnext --target esnext --types bun --typeRoots packages/core/node_modules/@types script/arforge-capability-links.ts script/arforge-capability-links.test.ts script/arforge-source-snapshot.ts script/arforge-migration-freshness.ts script/arforge-migration-freshness.test.ts
```

## 受测文件 SHA-256

| 文件 | SHA-256 |
|---|---|
| script/arforge-capability-links.ts | dae57586986a0c0d4e3ad5381ab44d679d920d667b61677446f854d1cf15d828 |
| script/arforge-capability-links.test.ts | d73f6de6d137693e81234b17972d0b3aede912583e6145eded26600c0a906020 |
| script/arforge-source-snapshot.ts | f84f61f53d6f750ae208d8e906600041d937c7bcdb1f27328d0b87a7f89d8491 |
| script/arforge-migration-freshness.ts | 1227d7e3b0caea8d6446d596d3dc2550217112437221171425eced4dc8658783 |
| script/arforge-migration-freshness.test.ts | 20c7e66387fa523482c806261b2bb40e7da2dae42b36d1665898f0dc704c0862 |
| docs/evidence/implementation/capability-links.v1.json | 9a816bd6496e7a50294aa222254c781e50467d21d634a19467ca21cad9196ef2 |

## 尚未完成与下一步

1. 当前是两条样例范围的人工行为定位，不是全部 5,080 库存叶的验收分母。symbol/selector 是定位说明，尚不自动验证 AST 唯一性或测试选择器确实存在；文件存在不等于语义 owner 正确。
2. 继续将旧基础设施合同逐项与 TS 既有 owner 做真实行为比较，建立覆盖正常、错误、恢复等适用场景的版本绑定结果；不能只改文档或报告字段判等价。
3. 补齐按文件/限定符号与自动库存的稳定多对一关联、未覆盖域报告、全仓消费者图、环境和传递依赖范围。生成库存不会写本关联文件，但其语义关系的完整性尚未自动闭合。
4. 全阶段产品功能、实际 Linux CI、旧数据迁移、Python 退出及其他 R04—R30 不因本工具通过而完成。没有运行真实三平台 full sandbox；按用户要求最后执行。
5. 快照与逐文件校验需要稳定工作目录，并非 OS 原子快照/抵御并发恶意文件系统切换的保证；没有新增运行时状态源、评估器、插件或对外服务。

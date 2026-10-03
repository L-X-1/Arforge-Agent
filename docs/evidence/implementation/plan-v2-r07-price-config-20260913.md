# R07：实际价目配置进入同一 TS 执行与计费管线

日期：2026-09-13。接续 [费用恢复与请求绑定](./plan-v2-r07-personal-job-billing-20260913.md)。本批验证原生产服务组合、隔离真实配置文件、SQLite 与本地 HTTP，不使用 Catalog.transform 替代本批配置正例。R07 和整个计划仍未完成。

## 本批验收条件

1. `arforge.json` 中的标准 `providers.*.models.*.priceCatalog` 必须能通过产品配置读取，进入原 Core Config、ConfigProviderPlugin、Catalog 和 PersonalJobExecutor，而不要求用户维护第二份价目。
2. 旧 TS `provider` 拼写只作迁移输入。与标准 `providers` 同文件共存时，标准值后应用；不得选择旧地址或旧价格。
3. 价目版本整份替换，不能把旧 revision 的缓存费率拼进新 revision。无效显式价目拒绝加载，不能无声回退到其他文件或旧拼写。
4. 读取及执行不得改写原配置文件；HTTP 仍使用原合同的数字时间编码。缺价时不启动、不新增输入、不消耗尝试次数，并说明用户应改哪里。

## 真实问题与修复

- **产品配置门禁拒绝标准 providers**：Core 已有该合同，但产品入口仍只解码 V1-shaped TS DTO。现有 loader 读取标准 Provider schema，并为尚未迁出的消费者作无状态只读投影；不产生新配置文件、服务或 Catalog。原文件仍由 Core 直接读取，投影不是正式请求/计费的配置来源。
- **旧拼写的价目被丢弃**：原 V1 Model schema 不保留 priceCatalog。现在复用原 `Billing.PriceCatalog` 可选字段；V1→Core 迁移边界显式 encode，避免已解码 DateTime 被再次当作 wire number 解码。
- **插件 JSON 边界编码错误**：原 ConfigProviderPlugin 把 typed DateTime 直接送入 JSON 插件边界，实际报 `Expected number, got DateTime.Utc`。现沿既有 profile 的处理方式 encode 原价目合同，没有新增计费实现。
- **混合文件悄悄采用旧价目**：实际正式入口回归观察到 rate=9、revision=legacy-price，而不是标准 rate=1。Core 现在将同一文件的旧迁移部分与标准 providers 部分依次送入原有 ordered-document/plugin pipeline，后者紧随前者，保留同一来源路径。仅为原文件的顺序投影，不是两份用户配置或两个状态 owner，也没有另写一套 Core 合并器。标准 model 的 native API、部分 limit、variant headers 等数据仍在原 canonical document 中，不经有损反向转换进入 Core。
- **价目不能字段级混合**：产品既有配置合并在同文件及跨文件场景中整份替换 priceCatalog；标准 disabled=false 也能覆盖旧 deprecated 状态。正式 mixed 回归在旧配置故意放入错误 endpoint、9 倍单价、额外 cacheRead 费率和 deprecated 状态，仍只向标准本地 endpoint 请求一次，并按新完整价目记 5 micro。
- **错误不能隐藏成回退**：Core 对显式 provider/providers schema 无效返回既有 ConfigInvalidError，消息不包含字段值；产品 loader 同样拒绝。测试覆盖标准、混合、旧拼写及较低优先级文件，不改写文件。原来对语法坏 JSON 的一般忽略行为未在本批重构，不能把此项称为所有配置损坏都已 fail-closed。
- **用户提示具体化**：execute/launch 缺价或价目尚未生效时，原 NotRunnableError 说明具体 `providers["providerID"].models["modelID"].priceCatalog`、`arforge.json/arforge.jsonc`、重新打开工作区或重启加载、重试同一任务。明确任务未启动、尝试额度未变。免费模型也必须来自真实的显式零费率，不能以缺价当免费。

## 实际验证记录

Windows / Bun 1.3.14。下表均为已结束的命令；批次重叠不相加，不按数量计算完成率。

| 检查 | 结果及范围 |
|---|---|
| Core 配置/插件/旧 options 首批 | 三文件 `45 pass / 0 fail / 167 断言 / 1.89 秒` |
| 最后 Core 六文件 | `bun test --rerun-every test/config/config.test.ts test/config/provider.test.ts test/config/provider-options.test.ts test/personal-job.test.ts test/personal-job-executor.test.ts test/billing.test.ts`：`94 pass / 0 fail / 393 断言 / 2.32 秒` |
| 产品完整配置文件 | `bun test --timeout 60000 test/config/config.test.ts`：`99 pass / 0 fail / 173 断言 / 27.63 秒`；随后仅把新投影中的类型断言改为运行时类型收窄，最终配置专项和 HTTP 又覆盖该路径 |
| Formal 扩大回归 | `bun test --timeout 60000 test/session/prompt.test.ts -t 'Formal PersonalJob\|Formal scoped execution\|Formal compaction HTTP\|Formal credential billing boundary'`：`39 pass / 0 fail / 160 filtered / 659 断言 / 227.41 秒`；包括实际配置、原账单补记、摘要费用、队列隔离、正文/摘要凭据发送边界。在最后的提示文案调整之前 |
| 最后 Formal 配置与提示专项 | `bun test --timeout 60000 test/session/prompt.test.ts -t 'Formal PersonalJob loads verified pricing\|Formal PersonalJob refuses unverified pricing'`：`7 pass / 0 fail / 192 filtered / 98 断言 / 58.05 秒`；覆盖最后文案及类型收窄 |
| HTTP 与 OpenAPI | `bun test --timeout 60000 test/server/httpapi-config.test.ts test/server/httpapi-public-openapi.test.ts`：`21 pass / 0 fail / 607 断言 / 13.57 秒`；原 GET /config 返回 numeric effectiveFrom 和完整价目，原文件不变 |
| 原 SDK 生成与测试 | 仓库原 `bun run script/generate.ts` exit 0，原生成器包含 TS 编译；SDK 三测试 `3 pass / 5 断言`。由源合同生成 OpenAPI 与原 JS SDK v2 字段，未手写生成类型；不把这三项静态合同检查当配置交互验收 |
| 类型检查 | 强制 workspace `22/22，0 cached，50.836 秒`；最后提示与断言调整后 Core、Arforge typecheck 又分别 exit 0 |
| 格式与静态 | 十一个源/测试文件、原 SDK v2 生成目录、OpenAPI 与 schema changelog 格式通过；scoped lint `75 warnings / 0 errors`。新增不安全类型断言已清理；剩余为既有 ConfigProviderPlugin 2、Core config test 1、产品 config 2、prompt test 59、产品 config test 11，未称整仓 lint 清零 |

失败证据与夹具边界：

- 本批初始 canonical/legacy 正式配置测试 0 pass/2 fail：前者产品 ConfigInvalidError，后者源价目字段丢失。补齐后又暴露插件 DateTime 编码错误，最终真实文件路径通过。
- mixed 独立复现 `0 pass / 1 fail / 2 断言 / 6.35 秒`，明确读到旧 revision 与旧单价；未通过换测试价格掩盖。
- 扩大 Core 首次 `44 pass / 1 fail` 是新增 native fixture 缺少原 schema 必需的 settings；按原合同补 `{}` 后 `45 pass`。没有放宽运行时 Schema 来通过夹具。
- 文件路径测试不使用真实远程 Provider/真实计费账号；单次正文 input=2/output=3、每 token 1 micro 的 fixture 总额是 5 micro，不是任何供应商的报价。

## 尚未完成，按这些接续

1. **配置保存与重新加载尚未统一。** 实码仍有旧产品 `Config.update` 写 `config.json`，Core 不读取此旧文件名；`updateGlobal` 仍按 V1 schema 读写；Core Config 在 location 打开时读一次，没有配置热重载完成证据。已有配置测试验证这些旧方法自身成功，不等于它们改变正式执行配置。下一步须让既有配置写入/失效路径归到 TS 标准，并验证保存→新 Catalog→原任务的真实旅程，不能继续扩建另一套配置 owner。
2. **只读 DTO 投影不是迁移终态。** 新增投影仅服务尚存旧消费者。部分 limit、native 模型、profile、variant headers/default 等 canonical 元数据不能由旧 DTO 完整表达；Core 原文保留已验证，但旧 UI/Provider 消费者的完整一致性未验收。其他标准配置组（agents、skills、mcp、compaction 等）的混合文件行为也未在本批全面融合。应逐步迁出这些旧读取者，而不是把反向投影保留成第二框架。
3. **运行中预算与当前授权恢复未完成。** 本批是新任务的实际配置路径及已完成结果的既有回归；原 run 仍有部分用量/未结算 receipt、价目或凭据变化时，不重置原预算、不绕过当前撤权，仍需生产链证明。
4. **PersonalJob 自身强杀冷恢复未完成。** 继续 occurrence→run/result/receipt、租约/取消/耗尽竞争、历史缺身份任务及用户可处置错误；以前 Session worker 的强杀记录不替代此任务入口。
5. 完整多步工具/重试/fallback/标题及小模型费用、币种精度、PostgreSQL/多租户、大历史性能和桌面/不同用户旅程仍未验收。R06/R07/R09/R17/R23/R30 不关闭，真实三平台 full sandbox 只在 R30 后执行，不涉及发布。

## 来源与操作边界

- composition：`f8a7971f0a056a694e63cbf76bb38598e49fe0280aa3f68c6be8e472a3c73f5e`，1757 源文件、3 roots、5 bindings、3 Runner uses。
- runner-negative：`2faacd5a2dfd6161f36d8a43d70328bc86a2ffc037f666ba50f9e3b36411c93e`。
- dependencies：`fdc13e60c2337f36efeaab86bd5550732c8cbadda07565adf97d884ee2750ecc`，7280 文件、7478 叶、6 assets。
- 依赖及源码快照在文档同步后按原生成器刷新并只读核验；静态新鲜度不是功能完成证据。

本批未修改真实账户、凭据、数据库、PATH 或全局 CLI，未新增 Python 产品功能、账本、调度器或状态服务，未提交/推送。原 SDK 生成器仅清理并重建了其已核验位于仓库内的生成目录和 dist 编译产物，可由同一生成器重建；用户源码与无关工作区改动保留。

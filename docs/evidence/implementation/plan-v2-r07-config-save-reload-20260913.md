# R07：配置保存与 Core 重新加载融合

日期：2026-09-13。接续[实际价目配置](./plan-v2-r07-price-config-20260913.md)。本批关闭明确的保存断点和写入一致性缺陷，不关闭 R07 或整个配置迁移工作包。没有新增配置服务、Catalog、账本或调度器。

## 验收范围与实现

1. **原产品保存进入原 TS Core 文件管线。** `packages/arforge/src/config/config.ts` 的 update/updateGlobal 调用原 Core Config 中的 updateDocument；reader/writer 复用 decodeDocument。旧 provider 写入经既有 ConfigMigrateV1 转成 providers，JSON 编码去掉迁移占位的 undefined，避免删除无关标准字段。价目 revision 整份替换；显式 active 可覆盖 deprecated，未指定 status 则不修改开关。
2. **保存位置与原读取位置一致。** 保存已有 arforge.json/jsonc，局部保存优先已有 .arforge/arforge.jsonc/json；不存在则创建 arforge.jsonc。旧 config.json 仅在首次保存时作为保留输入，原文件不改写。全局保存和旧读取者均尊重 ARFORGE_CONFIG_DIR。此处不是完整旧 profile 导入，也没有声称所有历史 CLI/TOML writer 已迁完。
3. **保留与并发。** JSONC 注释、无关字段保留。复用原 EffectFlock 串行化部分修改；已有文件复用 FSUtil.writeIfUnchanged 比较原字节。新文件在原 FileGuard.atomicWrite 内先写临时文件并 fsync，再以不可覆盖的 hard-link 发布，另一写者抢先创建目标时失败；不退回覆盖写。无效文件、无效价目、链接目录和已观察到的外部修改均拒绝。
4. **同一运行时重新加载。** 保存操作必须显式传入调用方实际 LocationServiceMap；HTTP handler 在原 layer 边界捕获该服务，不从裁剪过的 request context 可选读取，也不额外构建一个 map。局部保存使原产品配置缓存失效，并失效 map 中受影响的已存在目录/workspace key；全局保存失效全部现有 key。Core 仍按 location 快照工作，后续获取通过原 LayerMap 构建新快照，没有另一份可变配置缓存。
5. **失败不能在提交后才发现。** 全局接口原来先写文件，再将完整结果解码为旧 DTO。标准 skills 数组已能复现接口失败但 username 实际写入。现在提交前先校验兼容响应，失败时原字节不变。此项是写入安全修复，**不是标准 skills/其他字段已在旧接口可用**；迁移中的 DTO 限制仍须从原消费者消除。

## 正式用户路径证据

- 实际 arforge.json 先保存单价 1，打开原 Catalog，再通过原产品 Config.update 保存单价 2；同一 LocationServiceMap 的后续 Catalog 返回新价。之后使用原 PersonalJobExecutor→Formal/Core Runner、本地 HTTP、SQLite 完成任务：input=2、output=3，账单为 10 micro，仅一次模型请求；不创建 config.json。这是配置保存到实际执行/计费，不是仅判断 PATCH 返回成功。
- 默认服务器：GET /api/model 先读价目 http-price-1，经原 PATCH /config 保存后再 GET 返回 http-price-2 及新完整费率；原位置断言保留。
- 默认服务器全局路径：PATCH /global/config 写入首版价目，两个目录各自实际打开并读取 Catalog；再次保存后两者均返回新费率。等待原 global.disposed 事件同步，没有固定 sleep。测试仅使用 preload 创建的隔离 profile，保留并还原所选配置文件。
- 并发部分保存保留双方字段；非协作修改和抢先创建目标被拒绝，外部写入保留；链接/junction 目标原文不变。

失败与修复过程：

- Formal saved 最初失败：保存后 arforge.json 仍是旧价。之后暴露 EffectFlock 服务未从 layer 捕获；修复后 saved 专项 1 pass / 10 断言 / 8.86 秒，最终扩大批见下表。
- 全局响应缺陷先红：1 fail / 2 断言 / 3.10 秒，失败响应后实际多了 username；提交前校验后 1 pass / 2 断言 / 3.08 秒。
- HTTP 初版夹具用了 env:[]，ConfigProviderPlugin 因此创建未连接的 integration，Catalog.available 正常过滤模型。移除该错误认证声明后通过，未放宽运行时可用性过滤。全局测试初版用了不存在的事件名，改为引用原 ServerEvent.Disposed.type 后通过；不把这些夹具错误称为产品缺陷。

## 已结束的测试与静态检查

Windows / Bun 1.3.14。重叠批次不累计，也不换算功能完成率。

| 检查                                                      | 最终或明确时间边界的结果                                                                                                                             |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core 配置、writer、Provider、options、FileMutation 五文件 | 75 pass / 0 fail / 259 断言 / 10.69 秒；在最后 active 专项与 lint 清理前                                                                             |
| 加 active 专项后的 Core 四个配置文件                      | 53 pass / 0 fail / 195 断言 / 2.22 秒                                                                                                                |
| 最后 Core writer/config/FileMutation 三文件               | 52 pass / 0 fail / 200 断言 / 10.88 秒，覆盖最终错误类型收窄；包括原跨进程 FileMutation 竞争测试                                                     |
| 产品完整配置文件                                          | 103 pass / 0 fail / 186 断言 / 27.62 秒；后续仅清理无用 import                                                                                       |
| Formal 扩大回归                                           | 40 pass / 0 fail / 160 filtered / 681 断言 / 244.58 秒；覆盖 saved、价目缺失、已完成结果恢复、正文/摘要凭据边界、压缩 HTTP                           |
| HTTP / 全局 / 控制面 / OpenAPI 四文件                     | 26 pass / 0 fail / 633 断言 / 28.32 秒                                                                                                               |
| 强制全工作区 typecheck                                    | 22/22 successful，0 cached，57.87 秒；最后清理后 Core 与 Arforge 又分别 typecheck exit 0                                                             |
| 格式 / diff-check                                         | 13 个源/测试文件全部通过；新 writer 测试是新增文件，也单独格式检查                                                                                   |
| scoped oxlint                                             | 76 warnings / 0 errors；原 prompt.test.ts 59、原 FileGuard 6、原产品 config.test.ts 11。清理本批新增的 2 个告警及两个无用 import，不冒充整仓告警清零 |

复验命令（测试在对应包目录运行）：

```text
# packages/core
bun test --rerun-every test/config/config.test.ts test/config/config-write.test.ts test/config/provider.test.ts test/config/provider-options.test.ts test/file-mutation.test.ts
bun run typecheck

# packages/arforge
bun test --timeout 60000 test/config/config.test.ts
bun test --timeout 60000 test/server/httpapi-config.test.ts test/server/httpapi-global.test.ts test/server/httpapi-control-plane.test.ts test/server/httpapi-public-openapi.test.ts
bun test --timeout 60000 test/session/prompt.test.ts -t 'Formal PersonalJob|Formal scoped execution|Formal compaction HTTP|Formal credential billing boundary'
bun run typecheck

# root
bun turbo typecheck --concurrency=2 --force
bun run audit:migration-freshness
```

本批没有修改 HTTP payload schema；不需要以重新生成 SDK 充当行为验证。此前价目字段的 SDK/OpenAPI 生成证据仍在上一批。

## 未完成与下一步

1. **继续配置消费者融合，不保留双框架作为终态。** 旧 Config DTO 仍不能完整表达标准 agents/skills/mcp/compaction 等字段；混合文件 decoder 目前只对 providers 补齐标准覆盖。应在原 Core 管线统一其余字段及原消费者，保留来源、优先级与不丢字段证据。提交前安全拒绝不算该能力完成。
2. **其余配置入口/来源。** 手工修改文件的自动监听、ARFORGE_CONFIG 显式文件、模板替换、托管/远端配置、旧 CLI/TOML 写入和全部 UI/Provider 一致性未在本批全面验证。需盘点后融入原 owner，不能只检查两个保存方法。
3. **活跃任务和恢复边界。** 原 LayerMap/RcMap 在仍有借用引用时保留旧资源、后续获取用新资源；只读核对库实现不等于生产任务保存中途的安全验收。仍须验证保存/撤权、并发输入、租约、预算与未结算用量的实际交错，不宣称热重载在所有运行阶段都已完成。
4. **PersonalJob 本身 SIGKILL→新进程恢复仍未验收。** 保留原 occurrence/run/result/receipt、当前授权与原预算，覆盖暂停/取消/耗尽竞争和历史任务可处置错误。先前 Session 强杀证据不替代此项。
5. 文件 CAS 的最后内核调用仍无法对任意恶意并发写者给出 OS 级事务保证；首次保留旧 config.json 的跨文件变更、候选文件优先级竞争也未完整证明。hard-link 不支持的文件系统会报错，不降级覆盖；真实跨平台行为归到相应后续验收，不以 Windows 测试称全平台通过。
6. R06/R07/R09/R17/R23/R30 均未关闭。PostgreSQL、多租户、大历史、桌面及不同用户完整旅程继续；R31 真实三平台 full sandbox 仅在 R30 后执行，不涉及发布。

## 来源与操作边界

- composition：c6430b289cf04fc460a018dff867c5aaaef5586800d2ad30c33a12053c4ba2d7；1757 源文件、3 roots、5 bindings、3 Runner uses。
- runner-negative：dbbc12d385181cee53bdd433fdd80024a03e2a246d5375f652e832b9b10e4536。
- dependencies：970e5c27e175b5f923c938dd68b4e53d91cdac256ffe22eb171c61ffcbbcd84d；7281 文件、7478 叶、6 assets。
- 桌面计划与本证据写入后，使用原 source-snapshot 生成器与 freshness 检查记录源码新鲜度；静态有效不代表功能验收完成。

本批未操作真实账号、凭据、数据库、PATH、全局 CLI 或 OS 沙箱；未新增 Python 产品能力，未提交/推送。测试写入仅在隔离目录，旧用户文件和无关工作区改动保留。规则自检：未扩大授权边界、未暴露敏感信息，未将局部通过冒充整体交付。

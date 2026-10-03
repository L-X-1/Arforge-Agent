# Arforge Agent — Agent 入口

> 项目行为准则与执行规则定义在 [[ARFORGE.md]]；请在继续之前阅读 ARFORGE.md，
> 其中包含完整的 Prompt Engineering 标准、优先级金字塔、技能路由与项目上下文。
> 本文档承载项目开发规范（构建、测试、静态检查与提交约定）。

## 开发规范

### Python（仓库根目录执行）

```powershell
.venv\Scripts\python.exe -m pytest tests/          # 全量（约 3100+ 用例）
.venv\Scripts\python.exe -m pytest tests/<文件> -q  # 单文件快速验证
.venv\Scripts\python.exe -m ruff check arforge/ tests/
```

### TypeScript（在各包目录内执行 `bun run <script>` 或 `bun test`）

| 包 | 测试 | 静态检查 |
|---|---|---|
| `core` | `bun test` | `bun run typecheck` |
| `server` | `bun test` | `bun run typecheck` |
| `desktop` | `bun test` | `bun run typecheck` |
| `app` | `bun run test:unit`（另含 `test:browser`，需浏览器环境） | `bun run typecheck` |
| `schema` | 无独立测试（typecheck 为准） | `bun run typecheck` |
| `protocol` | 无独立测试（typecheck 为准） | `bun run typecheck` |
| `llm` | `bun test` | `bun run typecheck` |

注：`core`/`llm` 的 `bun test` 默认只跑失败用例（`--only-failures`），需要全量时用 `bun test --rerun-every` 或显式清空失败缓存；首次运行前先 `bun install`。

### 提交约定

- 遵循仓库现有风格（`feat(scope): 描述` / `fix(scope): 描述` / `docs:`）
- 提交前运行受影响包的相关测试与静态检查
- 不修改 git 配置、不跳过 hooks、不强制推送
- **验证优先级**: 任何改动先跑最小范围的测试与 typecheck，再扩大到全量

## 规范分层

| 文档 | 定位 |
|---|---|
| `ARFORGE.md` | 行为准则（Agent 执行规则，权威） |
| `AGENTS.md`（本文件） | 开发规范入口（构建/测试/检查/提交约定） |
| `packages/*/AGENTS.md` | 包级规范（desktop、app、schema、llm 等，见各包目录） |
| `docs/product-interaction.md` | 产品交互设计规范（面向开发者） |

## Skills

任务匹配技能描述时，开发技能按 `grill-me → OpenSpec → Trellis → Superpowers`
关系路由（详见 ARFORGE.md 第六节）。在 Arforge 运行时由 `SkillGuidance` 自动注入，
无需手动加载；在 opencode 等外部工具语境下，用其 skill 工具加载匹配的技能。

# Arforge Agent（灵枢智能体�?代码归类与报错审计报�?

更新时间�?026-06-14  
审计范围：`E:\Arforge-Agent`，排�?`.venv`、缓存目录��`.arforge/backups/checkpoints` 等生成物后的 Python 代码�?

## 1. 总体判断

项目目录确实已经偏杂乱，但不是��代码完全失控��的状����当前核心问题是�?

- 根目录承载了过多测试脚本、运行脚本��导出物、缓存产物和状��文件，降低了可读����?
- `arforge/` 包内模块数量很多且较扁平，尤其是 Context/Perception/Code Intelligence 相关文件已经形成子系统，但还没有被拆成明确子包��?
- 测试体系不是标准 pytest 形��，很多 `test_*.py` 是脚本式自测，带有顶层执行和 `sys.exit()`，导�?`pytest --collect-only` 直接失败�?
- 语法和导入层面健康：AST 解析通过、compileall 通过�?49 �?`arforge.*` 模块全部可导入��?
- 真实功能回归集中�?DataTools 可视化链路��CapabilityRouter 两个断言、测试收集方式��lint 债务�?

建议先不要立刻大规模移动文件。正确顺序是：先修测试入口和功能回归，再按下面的核心框架分批迁移，并用兼容导入层保护已有调用�?

## 2. 核心框架归类

### 00 启动、配置��打包入�?

- `config.py`
- `main.py`
- `verify_modules.py`

评价：入口文件数量不多，�?`verify_modules.py` 更像弢�发脚本，后续建议移入 `scripts/` �?`tools/dev/`�?

### 01 CLI、UI、本地交互层

- `arforge/capability/capability_cli.py`
- `arforge/cli.py`
- `arforge/cli_ui.py`
- `arforge/export_cli.py`
- `arforge/learning_cli.py`
- `arforge/locale.py`
- `arforge/privacy_cli.py`
- `arforge/slash_code_analysis.py`
- `arforge/slash_code_quality.py`
- `arforge/slash_commands.py`
- `arforge/slash_engineering.py`
- `arforge/slash_memory_learning.py`
- `arforge/slash_productivity.py`
- `arforge/slash_system_config.py`
- `arforge/status.py`

建议目标：`arforge/cli/`。Slash 命令已经是一个独立交互协议层，建议拆�?`arforge/cli/slash/`�?

### 02 Agent Core、事件��响应��主循环

- `arforge/agent_core.py`
- `arforge/agent_event.py`
- `arforge/agent_loop.py`
- `arforge/agent_loop_v2.py`
- `arforge/agent_response.py`
- `arforge/agent_trace.py`

评价：这�?Arforge 的主干��`agent_loop.py` �?`agent_loop_v2.py` 并存说明演进路线尚未收束，后续需要明�?v2 是否成为唯一主循环��?

### 03 Model Adapter、DeepSeek、Token

- `arforge/deepseek_adapter.py`
- `arforge/model_adapter.py`
- `arforge/model_factory.py`
- `arforge/prompt.py`
- `arforge/token_tracker.py`

建议目标：`arforge/models/`。如果未来要多模型竞争��路由��降级，这一层应保持窄接口，不要让业务��辑渗进去��?

### 04 Planning、Reasoning、Orchestration、Workflow

- `arforge/effort_mode.py`
- `arforge/evaluator.py`
- `arforge/feedback.py`
- `arforge/learning_workflow.py`
- `arforge/model_reasoning.py`
- `arforge/orchestrator.py`
- `arforge/perception_orchestrator.py`
- `arforge/planner.py`
- `arforge/reasoning.py`
- `arforge/response_mode.py`
- `arforge/workflow.py`

评价：这里是“像�?Agent 丢�样����和组织行动”的核心。问题是 planner、reasoning、workflow、orchestrator 的边界需要再硬一点：Planner 只产计划，Orchestrator 只编排，Workflow 只表达流程状态，Evaluator 只判断质量��?

### 05 Context、Knowledge、Perception、Code Intelligence

- `arforge/api_route_indexer.py`
- `arforge/better_call_graph.py`
- `arforge/better_call_graph_v2.py`
- `arforge/call_graph.py`
- `arforge/chinese_dev_intent.py`
- `arforge/class_relationship_indexer.py`
- `arforge/code_chunk_indexer.py`
- `arforge/code_indexer.py`
- `arforge/code_navigation_agent.py`
- `arforge/code_retrieval.py`
- `arforge/code_retriever.py`
- `arforge/code_summarizer.py`
- `arforge/coding_context.py`
- `arforge/coding_task_analyzer.py`
- `arforge/config_environment_indexer.py`
- `arforge/context_builder.py`
- `arforge/context_builder_v2.py`
- `arforge/context_enhancer.py`
- `arforge/context_ranker.py`
- `arforge/context_v2.py`
- `arforge/database_schema_indexer.py`
- `arforge/dependency_graph.py`
- `arforge/directory_metadata.py`
- `arforge/dirty_file_registry.py`
- `arforge/error_pattern_indexer.py`
- `arforge/impact_analyzer.py`
- `arforge/impact_analyzer_v2.py`
- `arforge/import_resolver.py`
- `arforge/incremental_perception.py`
- `arforge/incremental_perception_pipeline.py`
- `arforge/knowledge_graph.py`
- `arforge/knowledge_v2.py`
- `arforge/module_summary_v2.py`
- `arforge/project_architecture_analyzer.py`
- `arforge/project_scanner.py`
- `arforge/python_ast_indexer.py`
- `arforge/reference_indexer.py`
- `arforge/semantic_code_search.py`
- `arforge/semantic_index_metadata.py`
- `arforge/symbol_navigator.py`
- `arforge/symbol_resolver.py`
- `arforge/test_mapping_indexer.py`
- `arforge/tools/context_tools.py`
- `arforge/tools/perception_tools.py`
- `arforge/type_instance_resolver.py`
- `arforge/universal_dev_environment_analyzer.py`

评价：这是当前最强��也朢�霢�要整理的子系统��它已经覆盖扫描、索引��检紃6�9��语义搜紃6�9��调用图、影响分析��错误模式��项目架构分析，但文件太平��建议目标结构：

```text
arforge/context/
  builders/
  indexers/
  retrieval/
  graph/
  impact/
  perception/
  dev_environment/
```

### 06 Memory、Learning、Task、Personalization

- `arforge/auto_memory.py`
- `arforge/learning.py`
- `arforge/learning_consolidation.py`
- `arforge/learning_db.py`
- `arforge/learning_dreaming.py`
- `arforge/learning_engine.py`
- `arforge/learning_experience.py`
- `arforge/learning_injection_v2.py`
- `arforge/learning_injector.py`
- `arforge/learning_meta.py`
- `arforge/learning_patterns.py`
- `arforge/learning_reflection.py`
- `arforge/learning_schema.py`
- `arforge/learning_v2.py`
- `arforge/memory.py`
- `arforge/semantic_memory.py`
- `arforge/task_manager.py`
- `memory-vault/arforge_training_seed_20260614.py`

评价：记忆和学习已经从��存东西”演进到“经验注入��反思��模式沉淢�”��`memory-vault/arforge_training_seed_20260614.py` 属于本次训练/记忆工程脚本，不应长期混在生产归类里�?

### 07 Tool、Execution、MCP、Web、Data、Infra

- `arforge/executor.py`
- `arforge/mcp_client.py`
- `arforge/mcp_test_server.py`
- `arforge/tool_executor.py`
- `arforge/tool_registry.py`
- `arforge/tools/__init__.py`
- `arforge/tools/basic_tools.py`
- `arforge/tools/code_tools.py`
- `arforge/tools/data_tools.py`
- `arforge/tools/file_tools.py`
- `arforge/tools/infra_tools.py`
- `arforge/tools/mcp_tools.py`
- `arforge/tools/task_tools.py`
- `arforge/tools/web_tools.py`

评价：工具层已经具备注册、执行��MCP、文件��Web、数据��基硢�操作能力。当�?DataTools 可视化测试有真实失败，说明工具层霢�要补依赖棢�测��输入格式兼容和错误消息�?

### 08 Security、Permission、Sandbox、Verification、Recovery、Safe Modify

- `arforge/backup_manager.py`
- `arforge/diff_applicator.py`
- `arforge/diff_generator.py`
- `arforge/file_ops.py`
- `arforge/git_intelligence.py`
- `arforge/permission.py`
- `arforge/recovery.py`
- `arforge/safe_modifier.py`
- `arforge/sandbox.py`
- `arforge/verifier.py`
- `arforge/verifier_v2.py`

评价：这�?Arforge 做真实改代码时的安全底盘。代表��测�?`test_verifier_v2.py`、`test_recovery.py` 已��过，说明这部分相对可靠。后续应让所有写文件路径都收敛到 Safe Modify + Diff + Backup + Verifier 流程�?

### 09 Capability Enhancement、Multimodal

- `arforge/capability/__init__.py`
- `arforge/capability/base_enhancer.py`
- `arforge/capability/benchmark.py`
- `arforge/capability/capability_db.py`
- `arforge/capability/capability_fusion.py`
- `arforge/capability/capability_registry.py`
- `arforge/capability/capability_router.py`
- `arforge/capability/capability_schema.py`
- `arforge/capability/enhanced_pipeline.py`
- `arforge/capability/enhancement_engine.py`
- `arforge/capability/enhancement_flow.py`
- `arforge/capability/evidence_builder.py`
- `arforge/capability/evidence_fusion.py`
- `arforge/capability/multimodal/__init__.py`
- `arforge/capability/multimodal/document_adapter.py`
- `arforge/capability/multimodal/image_adapter.py`
- `arforge/capability/multimodal/ocr_adapter.py`
- `arforge/capability/security_audit.py`

评价：增强能力架构完整，�?`test_capability_router.py` 目前�?2 个失败，说明路由策略和测试预期不丢�致��这里需要优先修，因为它决定仢�么时候应该启用增强能力��?

### 10 Product Hardening、Doctor、Privacy、Export、Logging

- `arforge/db_registry.py`
- `arforge/doctor.py`
- `arforge/logger.py`

评价：数量少但重要��`doctor` 测试通过，后续建议把 export、privacy、status 等产品化能力也归到这丢�层或建立 `arforge/product/`�?

### 11 Dogfood、开发实验脚�?

- `dogfood.py`

评价：这是非常有价��的吃自己狗粮脚本，但不该长期停在根目录。建议迁�?`scripts/dogfood.py` �?`tools/dev/dogfood.py`。当前存在一�?`SyntaxWarning: invalid escape sequence '\('`，需要修正字符串或使�?raw string�?

### 12 Tests、脚本式测试与回�?

- `test_agent_loop_v2.py`
- `test_auto_memory.py`
- `test_backup_manager.py`
- `test_battle_scenarios.py`
- `test_capability_engine.py`
- `test_capability_registry.py`
- `test_capability_router.py`
- `test_capability_schema.py`
- `test_cli_ui.py`
- `test_context_enhancer.py`
- `test_context_v2.py`
- `test_data_tools.py`
- `test_diff_applicator.py`
- `test_diff_generator.py`
- `test_doctor.py`
- `test_document_adapter.py`
- `test_e2e_integration.py`
- `test_e2e_step111.py`
- `test_enhanced_pipeline.py`
- `test_evaluator.py`
- `test_feedback.py`
- `test_knowledge_graph.py`
- `test_knowledge_v2.py`
- `test_mcp.py`
- `test_memory_v2.py`
- `test_model_reasoning.py`
- `test_multimodal_adapters.py`
- `test_orchestrator.py`
- `test_p2.py`
- `test_planner.py`
- `test_reasoning.py`
- `test_recovery.py`
- `test_registry.py`
- `test_safe_modifier.py`
- `test_sandbox.py`
- `test_self_learning_v2.py`
- `test_semantic_memory.py`
- `test_slash_commands.py`
- `test_trace.py`
- `test_verifier.py`
- `test_verifier_v2.py`
- `test_web_tools.py`
- `test_workflow.py`

评价：测试数量不算少，但形��偏脚本。建议目标：

```text
tests/
  unit/
  integration/
  e2e/
  legacy_script/
```

迁移前先去掉顶层执行�?`sys.exit()`，把脚本�?`def test():` 改成 pytest 可收集的多个断言函数，或者把旧脚本放�?`tests/legacy_script/` 并单独运行��?

### 99 未归类或霢�要人工判�?

- `arforge/__init__.py`
- `arforge/auto_index_manager.py`
- `arforge/code_reader.py`
- `arforge/intent_analyzer.py`

建议�?

- `auto_index_manager.py` 归入 `arforge/context/indexers/` �?`arforge/context/perception/`�?
- `code_reader.py` 归入 `arforge/context/retrieval/` �?`arforge/tools/code_tools.py` 附近�?
- `intent_analyzer.py` 归入 `arforge/planning/` �?`arforge/context/dev_intent/`�?

## 3. 报错与健康检查结�?

### 3.1 语法棢��?

结果：��过�?

- AST 解析�?98 �?Python 文件�? �?AST 错误�?
- `python -m compileall -q arforge main.py config.py dogfood.py verify_modules.py`：���出码 0�?
- 唯一警告：`dogfood.py:113 SyntaxWarning: invalid escape sequence '\('`�?

### 3.2 导入棢��?

结果：��过�?

- 通过 `pkgutil.walk_packages` 导入 `arforge.*` 模块�?
- 模块总数�?49�?
- 导入失败�?�?

这说明当前项目没有明显的语法级或 import-time 级崩溃��?

### 3.3 pytest 收集棢��?

结果：失败��?

命令�?

```powershell
python -m pytest --collect-only -q
```

失败原因�?

- `test_battle_scenarios.py` 在模块顶层运行脚本��辑�?
- 它打印战斗场景结果后调用 `sys.exit(1)`�?
- pytest 还没完成收集就被中断�?

附带结果�?

- `test_battle_scenarios.py` 自报 10 个场景��?5 个检查��?4 个��过�? 个失败��?
- pytest 被中断前只收集到 4 个测试项�?

判断：这是测试架构问题，不是单纯某个功能 bug。需要把脚本式测试和 pytest 测试分层�?

### 3.4 代表性脚本测�?

通过�?

- `python test_memory_v2.py`�?1/41 通过�?
- `python test_context_v2.py`�?6/66 通过�?
- `python test_verifier_v2.py`�?9/79 通过�?
- `python test_recovery.py`�?8/58 通过�?
- `python test_doctor.py`�?3/33 通过�?
- `python test_multimodal_adapters.py`�?3/43 通过�?

失败�?

- `python test_capability_router.py`�?7/59 通过�? 个失败��?
- `python test_data_tools.py`�?2/69 通过�? 个失败��?

CapabilityRouter 失败点：

- `should_enhance memory_write` 期望�?False�?
- `engine.should_enhance` 相关断言失败�?

DataTools 失败点：

- `matplotlib 可用` 失败�?
- `chart_bar` 数据格式或输出路径失败��?
- `chart_line` 失败�?
- `chart_pie` 失败�?
- `chart_hist` 失败�?
- `chart_scatter` 失败�?

判断：DataTools 失败大概率由依赖缺失和图表输入格式兼容共同��成；CapabilityRouter 是策略��辑或测试预期需要对齐��?

### 3.5 Ruff 静��检�?

结果：失败，但多数属于代码卫生��务�?

命令�?

```powershell
python -m ruff check arforge main.py config.py dogfood.py verify_modules.py
```

结果�?

- 发现 448 �?lint 问题�?
- 其中 290 个可自动修复�?
- 主要类型：未使用 import、未使用变量、无占位�?f-string、导入位置不规范、多 import 写在丢�行��?

代表性文件：

- `arforge/agent_core.py`：未使用导入和变量较多��?
- `arforge/agent_loop.py`、`arforge/agent_loop_v2.py`：未使用导入/变量�?
- `arforge/tools/infra_tools.py`、`arforge/tools/perception_tools.py`：大�?E402 导入不在文件顶部�?
- `dogfood.py`：多 import、未使用 import、导入位置和 invalid escape warning�?
- `verify_modules.py`：多 import、未使用 import、f-string 无占位符等��?

判断：Ruff 结果不等于运行失败，但会持续影响维护速度。建议先�?F401、F841、F541、E401，再决定是否�?E402 做结构调整��?

## 4. 推荐目标目录结构

建议逐步收敛为：

```text
E:\Arforge-Agent
  arforge/
    cli/
    core/
    models/
    planning/
    context/
      builders/
      indexers/
      retrieval/
      graph/
      impact/
      perception/
    memory/
    tools/
    security/
    capability/
    product/
  tests/
    unit/
    integration/
    e2e/
    legacy_script/
  docs/
  scripts/
  memory-vault/
  data/
```

根目录建议只保留�?

- `README.md`
- `CHANGELOG.md`
- `pyproject.toml`
- `requirements.txt`
- `MANIFEST.in`
- `main.py`
- `arforge.cmd`
- 必要的配置文�?

生成物建议处理：

- `__pycache__/`、`.pytest_cache/`、`.ruff_cache/`：加入清理流程和 `.gitignore`�?
- `arforge_agent.egg-info/`：构建产物，不应作为核心源文件管理��?
- `.venv/`：可以保留本地使用，但应排除在项目认知和提交之外�?
- `arforge_export_*.json`：移�?`data/exports/` �?`.arforge/exports/`�?

## 5. 后续弢�发顺�?

### 第一优先级：修测试体�?

- �?`test_battle_scenarios.py` 的顶层运行��辑改成 `if __name__ == "__main__":`�?
- 去掉测试导入时的 `sys.exit()`�?
- 将脚本式 `def test():` 拆为 pytest 可识别测试，或统丢�放入 legacy 脚本测试目录�?
- 目标：`python -m pytest --collect-only -q` 必须稳定通过�?

### 第二优先级：修真实功能失�?

- �?`test_capability_router.py` �?2 个失败，明确 `memory_write` 是否应该触发增强能力�?
- �?`test_data_tools.py` �?7 个失败，增加 matplotlib 依赖棢�测��图表输入格式��配、输出路径验证��?

### 第三优先级：清理 lint 高价值问�?

- 先运行安全的自动修复或手工修 F401/F841/F541/E401�?
- �?E402 不要机械移动，要先确认这些导入是否有懒加载��可选依赖或启动性能考虑�?

### 第四优先级：分批迁移目录

迁移顺序建议�?

1. `tests/` 迁移：风险最低，收益朢�高��?
2. `scripts/` 迁移：移�?`dogfood.py`、`verify_modules.py`、训练脚本��?
3. `arforge/cli/` 迁移：Slash 命令边界清晰�?
4. `arforge/context/` 迁移：规模最大，霢�要兼容导入层和回归测试��?
5. `arforge/core/`、`arforge/planning/`、`arforge/models/`：最后收束主干��?

## 6. 当前结论

Arforge Agent（灵枢智能体�?的核心框架不是空架子，很多模块已经能跑，尤其�?Memory V2、Context V2、Verifier V2、Recovery、Doctor、Multimodal 代表性测试都通过。当前最大问题不是��不能实现��，而是工程组织、测试标准化和若干功能回归没有被收束�?

下一步最值得做的是：先把 pytest 收集修好，再�?CapabilityRouter �?DataTools，然后开始按核心框架迁移目录�?

## 7. 第一批目录迁移记�?

执行时间�?026-06-14

已完成的低风险迁移：

- 根目�?`test_*.py` 已迁�?`tests/legacy_script/`�?
- 根目�?`dogfood.py`、`verify_modules.py` 已迁�?`scripts/dev/`�?
- 根目�?`arforge_export_*.json` 已迁�?`data/exports/`�?
- 已新建核心架构预备目录：
  - `arforge/core/`
  - `arforge/models/`
  - `arforge/planning/`
  - `arforge/context/`
  - `arforge/context/builders/`
  - `arforge/context/indexers/`
  - `arforge/context/retrieval/`
  - `arforge/context/graph/`
  - `arforge/context/impact/`
  - `arforge/context/perception/`
  - `arforge/context/dev_environment/`
  - `arforge/security/`
  - `arforge/product/`
  - `tests/legacy_script/`
  - `scripts/dev/`
  - `data/exports/`

兼容性处理：

- `tests/legacy_script/sitecustomize.py` 会在直接运行旧脚本测试时把项目根目录加入 `sys.path`�?
- `pyproject.toml` 已配�?pytest 忽略 `tests/legacy_script/`，避免脚本式测试在导入阶段调�?`sys.exit()` 打断 pytest 收集�?
- 曾短暂创�?`arforge/memory/`，但它会遮住现有核心模块 `arforge/memory.py`，已撤销。Memory 子系统需要等正式迁移 `memory.py` 时再创建同名包��?

迁移后验证：

- `python -m compileall -q arforge main.py config.py scripts\dev`：��过，仅保留 `scripts\dev\dogfood.py` �?invalid escape warning�?
- `arforge.*` 模块导入棢�查：162 个模块，0 个导入失败��?
- `python -m pytest --collect-only -q`：��过，当前收集到 `arforge/test_mapping_indexer.py::test_file_to_source_guess`�?
- `python tests\legacy_script\test_memory_v2.py`�?1/41 通过�?
- `python tests\legacy_script\test_context_v2.py`�?6/66 通过�?

第二批建议：

- 迁移 Product Hardening：`db_registry.py`、`doctor.py`、`logger.py` �?`arforge/product/`�?
- 迁移 Security/Safe Modify：`backup_manager.py`、`diff_*`、`file_ops.py`、`permission.py`、`recovery.py`、`safe_modifier.py`、`sandbox.py`、`verifier*.py` �?`arforge/security/`�?
- 第二批开始必须同步改 import，或者保留短期兼�?shim�?

## 8. 第二批目录迁移记�?

执行时间�?026-06-14

已完成的生产模块迁移�?

- Product Hardening 本体已迁�?`arforge/product/`�?
  - `db_registry.py`
  - `doctor.py`
  - `logger.py`
- Security / Safe Modify 本体已迁�?`arforge/security/`�?
  - `backup_manager.py`
  - `diff_applicator.py`
  - `diff_generator.py`
  - `file_ops.py`
  - `git_intelligence.py`
  - `permission.py`
  - `recovery.py`
  - `safe_modifier.py`
  - `sandbox.py`
  - `verifier.py`
  - `verifier_v2.py`

兼容性处理：

- �?`arforge/*.py` 路径保留轻量 compatibility wrapper，例�?`arforge/verifier.py` 会转发到 `arforge.security.verifier`�?
- 兼容 wrapper 显式补齐旧测试依赖的内部符号�?
  - `arforge.file_ops._ensure_backup_dir`
  - `arforge.diff_generator._parse_hunks`
  - `arforge.diff_generator._parse_hunk_header`
  - `arforge.backup_manager._load_index`
  - `arforge.backup_manager._save_index`
  - `arforge.backup_manager._classify_backup_age`
  - `arforge.diff_applicator._apply_single_hunk`
  - `arforge.diff_applicator._verify_hunk_context`
  - `arforge.diff_applicator._ensure_newline`

第二批迁移后验证�?

- `arforge.*` 模块导入棢�查：176 个模块，0 个导入失败��?
- `python -m pytest --collect-only -q`：��过�?
- `python tests\legacy_script\test_verifier_v2.py`�?9/79 通过�?
- `python tests\legacy_script\test_recovery.py`�?8/58 通过�?
- `python tests\legacy_script\test_doctor.py`�?3/33 通过�?
- `python tests\legacy_script\test_backup_manager.py`�?8/38 通过�?
- `python tests\legacy_script\test_diff_generator.py`�?5/55 通过�?
- `python tests\legacy_script\test_diff_applicator.py`�?8/48 通过�?

第三批建议：

- 迁移 Model Adapter：`deepseek_adapter.py`、`model_adapter.py`、`model_factory.py`、`prompt.py`、`token_tracker.py` �?`arforge/models/`�?
- 迁移 Planning：`planner.py`、`reasoning.py`、`orchestrator.py`、`workflow.py`、`evaluator.py`、`feedback.py`、`model_reasoning.py` 等到 `arforge/planning/`�?
- 第三批仍建议保留 compatibility wrapper，等扢�有内�?import 被改到新路径后再统一删除 wrapper�?

## 9. 第三批目录迁移记�?

执行时间�?026-06-14

已完成的生产模块迁移�?

- Model Adapter 本体已迁�?`arforge/models/`�?
  - `deepseek_adapter.py`
  - `model_adapter.py`
  - `model_factory.py`
  - `prompt.py`
  - `token_tracker.py`
- Planning / Reasoning / Orchestration 本体已迁�?`arforge/planning/`�?
  - `effort_mode.py`
  - `evaluator.py`
  - `feedback.py`
  - `learning_workflow.py`
  - `model_reasoning.py`
  - `orchestrator.py`
  - `perception_orchestrator.py`
  - `planner.py`
  - `reasoning.py`
  - `response_mode.py`
  - `workflow.py`

兼容性处理：

- 原路径继续保�?compatibility wrapper，例�?`arforge.planner` 转发�?`arforge.planning.planner`�?
- 补齐旧脚本测试依赖的内部符号�?
  - `arforge.planner._guess_affected_files`
  - `arforge.planner._guess_constraints`
  - `arforge.reasoning._detect_biases`
  - `arforge.model_reasoning._extract_json`
  - `arforge.model_reasoning._extract_list`
  - `arforge.model_reasoning._heuristic_reason`
  - `arforge.model_reasoning._heuristic_plan`

第三批迁移后验证�?

- `arforge.*` 模块导入棢�查：192 个模块，0 个导入失败��?
- `python -m pytest --collect-only -q`：��过�?
- `python tests\legacy_script\test_planner.py`�?42/142 通过�?
- `python tests\legacy_script\test_reasoning.py`�?09/109 通过�?
- `python tests\legacy_script\test_orchestrator.py`�?38/138 通过�?
- `python tests\legacy_script\test_model_reasoning.py`�?9/39 通过�?

第四批建议：

- 迁移 Agent Core：`agent_core.py`、`agent_loop*.py`、`agent_event.py`、`agent_response.py`、`agent_trace.py` �?`arforge/core/`�?
- Context/Perception 子系统文件最多，建议作为第五批单独迁移，并在迁移前先固定丢�组更完整的回归测试��?

## 10. 第四批目录迁移记�?

执行时间�?026-06-14

已完成的生产模块迁移�?

- Agent Core 本体已迁�?`arforge/core/`�?
  - `agent_core.py`
  - `agent_event.py`
  - `agent_loop.py`
  - `agent_loop_v2.py`
  - `agent_response.py`
  - `agent_trace.py`

兼容性处理：

- 原路径继续保�?compatibility wrapper，例�?`arforge.agent_loop_v2` 转发�?`arforge.core.agent_loop_v2`�?
- 补齐旧脚本测试依赖的内部符号�?
  - `arforge.agent_loop_v2._verify_with_v2`
  - `arforge.agent_loop_v2._enrich_with_knowledge`
  - `arforge.agent_loop_v2._enhance_reasoning`
  - `arforge.agent_loop_v2._auto_read_mentioned_files`
  - `arforge.agent_loop_v2._assess_capability`
  - `arforge.agent_loop_v2._inject_learnings`
  - `arforge.agent_loop_v2._optimize_context`

第四批迁移后验证�?

- `arforge.*` 模块导入棢�查：198 个模块，0 个导入失败��?
- `python -m pytest --collect-only -q`：��过�?
- `python -m compileall -q arforge main.py config.py scripts\dev`：��过�?
- `python tests\legacy_script\test_agent_loop_v2.py`�?2/42 通过�?

第五批建议：

- 迁移 Memory/Learning，但注意 `arforge/memory.py` 与目标目�?`arforge/memory/` 同名冲突，需要一次��完成本体迁移��wrapper 设计和导入验证��?
- 迁移 Context/Perception/Code Intelligence，这是最大批次，应拆�?`indexers`、`retrieval`、`graph`、`impact`、`perception` 子批次��?
- 迁移 CLI 之前要处�?`arforge/cli.py` 与目标目�?`arforge/cli/` 的同名冲突，建议朢�后做�?

# Arforge Agent（灵枢智能体�?Semantic Code Search V2 设计

## 1. 目标

Semantic Code Search V2 的目标是�?Arforge Agent（灵枢智能体�?支持更接近真�?Code Agent 的中文语义代码检索能力��?

当前 Arforge 已经具备�?

* 代码文件索引
* Python AST 符号索引
* Import Resolver
* Symbol Resolver
* Better Call Graph V2
* Class Relationship Index
* Module Summary V2
* Code Chunk Index
* Semantic Code Search V1
* Chinese Dev Intent Analyzer
* Context Builder V2
* Perception Orchestrator
* Impact Analyzer V2

但是当前 Semantic Code Search V1 主要还是规则关键词扩展搜紃6�9��?

V2 的目标是升级�?Hybrid Code Search，也就是�?

```text
结构化索�?
+
关键词检�?
+
中文语义扩展
+
向量棢��?
+
结果排序
+
上下文构�?
```

朢�终希�?Arforge 能更准确回答�?

```text
哪里处理工具调用�?
哪里处理流式输出�?
哪里写入数据库？
更新代码索引为什么会卡住�?
修改 chat_stream 会影响哪里？
哪个模块�?Agent 主流程？
哪个文件是工具执行入口？
```

## 2. 总体架构

Semantic Code Search V2 的整体流程如下：

```text
用户中文问题
    �?
Chinese Dev Intent Analyzer
    �?
Query Expander / Query Rewriter
    �?
Hybrid Search
    ├─┢� SQLite 关键词检�?
    ├─┢� SQLite 结构化检�?
    └─┢� Qdrant 向量语义棢��?
    �?
Result Merger
    �?
Result Ranker
    �?
Context Builder V2 / V3
    �?
返回相关文件、代码块、符号��调用链、风险和建议
```

## 3. 设计原则

### 3.1 不做纯向量搜�?

Arforge 不应该只依赖向量数据库��?

原因�?

* 代码搜索霢�要精确符号定�?
* 函数名��类名��文件路径必须精确匹�?
* 调用关系和依赖关系必须依赖结构化索引
* 纯向量搜索容易召回语义相似但工程上不相关的代�?

扢��?V2 应该采用 Hybrid Search�?

### 3.2 不直接向量化完整文件

V2 第一阶段不直接把完整文件放进向量库��?

原因�?

* 完整文件太长
* 噪声太多
* 容易重复
* 修改后重建成本高
* 对代码定位不够精�?

第一阶段优先向量化：

* code_chunks
* module_summaries_v2
* code_symbols
* impact_analysis_v2 摘要

### 3.3 SQLite 仍然是主索引�?

Qdrant 负责语义召回，但 SQLite 仍然负责�?

* 结构化元数据
* 文件路径
* 符号信息
* 调用�?
* 影响分析
* 向量索引状��记�?
* content_hash 变化棢��?

也就是说�?

```text
SQLite = 结构化真相源
Qdrant = 语义召回加��器
```

### 3.4 面向中文弢�发场景优�?

Semantic Code Search V2 必须优先支持中文弢�发表达，例如�?

```text
哪里处理工具调用�?
哪里生成模块摘要�?
这个卡住可能在哪里？
帮我找数据库写入逻辑
哪个地方负责路由匹配�?
修改这个函数会影响哪里？
```

扢�以查询阶段必须先经过中文弢�发需求理解和关键词扩展��?


## 4. 核心数据来源

Semantic Code Search V2 不从原始文件直接弢�始，而是优先复用 Arforge 已经建立好的 Perception Layer 数据�?

核心数据来源包括�?

* code_chunks
* module_summaries_v2
* code_symbols
* resolved_function_calls_v2
* impact_analysis_v2
* class_relationships
* import_bindings
* variable_types
* instance_calls

这些数据已经包含�?Arforge 对代码库的结构化理解�?

## 5. code_chunks

### 5.1 作用

code_chunks 用于定位具体代码块��?

它��合回答�?

```text
哪里处理工具调用�?
哪里处理流式输出�?
哪里写入数据库？
哪里构建索引�?
哪里处理异常�?
```

### 5.2 主要字段

来自 code_chunks 表：

* file_path
* chunk_type
* chunk_role
* parent_name
* class_name
* function_name
* start_line
* end_line
* code_preview
* keywords

### 5.3 向量化文本格�?

code_chunk �?text_for_embedding 建议格式�?

```text
类型：代码块
文件：arforge/agent_core.py
职责：工具调�?工具执行
扢�属：ArforgeAgent.chat_stream
类：ArforgeAgent
函数：chat_stream
行号�?80-490
关键词：run_tool_if_match, tool_result, user_input
代码预览�?
tool_result = run_tool_if_match(user_input)
```

### 5.4 适合的查�?

```text
哪里处理工具调用�?
哪里处理流式输出�?
哪里执行数据库写入？
哪里可能导致索引卡住�?
哪里有异常处理？
```

## 6. module_summaries_v2

### 6.1 作用

module_summaries_v2 用于理解文件级职责��?

它��合回答�?

```text
Agent 主流程在哪里�?
工具系统入口在哪里？
任务管理模块在哪里？
哪个模块修改风险高？
```

### 6.2 主要字段

来自 module_summaries_v2 表：

* file_path
* module_role
* core_classes
* core_functions
* dependencies
* reverse_dependencies
* call_overview
* class_overview
* risk_level
* risk_reason
* summary_text

### 6.3 向量化文本格�?

module_summary �?text_for_embedding 建议格式�?

```text
类型：模块摘�?
文件：arforge/agent_core.py
模块职责：Agent 核心调度模块，负责用户输入处理��工具调用��模型调用��上下文流转和主执行流程�?
核心类：
- ArforgeAgent
核心函数�?
- chat
- chat_stream
- call_model
依赖模块�?
- arforge.tools
- arforge.memory
风险等级：高风险
风险原因：该文件属于 Agent 主流程，修改可能影响工具调用、流式输出和模型调用�?
摘要�?
模块：arforge/agent_core.py
职责：Agent 核心调度模块...
```

### 6.4 适合的查�?

```text
哪个文件负责 Agent 主流程？
工具执行模块在哪里？
任务管理模块在哪里？
修改哪个文件风险朢�高？
```

## 7. code_symbols

### 7.1 作用

code_symbols 用于定位类��函数��方法等符号定义�?

它��合回答�?

```text
run_tool_if_match 在哪里？
ArforgeAgent 有哪些方法？
chat_stream 定义在哪里？
某个类的入口在哪里？
```

### 7.2 主要字段

来自 code_symbols 表：

* symbol_name
* symbol_type
* file_path
* class_name
* start_line
* end_line
* signature
* docstring

### 7.3 向量化文本格�?

code_symbol �?text_for_embedding 建议格式�?

```text
类型：代码符�?
符号：run_tool_if_match
符号类型：function
文件：arforge/tools.py
扢�属类�?
行号�?20-180
签名：run_tool_if_match(user_input)
说明�?
根据用户输入匹配并执行工具��?
```

### 7.4 适合的查�?

```text
工具执行函数在哪里？
哪个函数负责模型调用�?
哪个类负�?Agent 主流程？
chat_stream 是什么？
```

## 8. resolved_function_calls_v2

### 8.1 作用

resolved_function_calls_v2 用于理解真实调用链��?

它��合回答�?

```text
谁调用了 run_tool_if_match�?
chat_stream 调用了哪些函数？
self.call_model 指向哪里�?
agent.chat_stream 指向哪里�?
```

### 8.2 主要字段

来自 resolved_function_calls_v2 表：

* caller_name
* caller_file
* caller_class
* caller_function
* raw_callee_name
* raw_call
* callee_file
* resolved_symbol
* resolved_method
* resolved_type
* resolution_source
* call_category
* confidence
* line_number
* context

### 8.3 向量化策�?

第一阶段不建议把每一条调用关系全部向量化，因为调用关系数量可能很多，容易产生噪声�?

建议只在以下情况生成向量文本�?

* 高置信度调用关系
* 核心文件中的调用关系
* 与高风险模块相关的调用关�?
* �?Impact Analyzer V2 引用过的调用关系

### 8.4 向量化文本格�?

```text
类型：解析级调用关系
调用者：ArforgeAgent.chat_stream
调用位置：arforge/agent_core.py:486
调用表达式：run_tool_if_match
真实目标：arforge/tools.py::run_tool_if_match
解析来源：import_binding
调用分类：function_call
置信度：95
代码�?
tool_result = run_tool_if_match(user_input)
```

## 9. impact_analysis_v2

### 9.1 作用

impact_analysis_v2 用于理解修改风险和影响范围��?

它��合回答�?

```text
修改 chat_stream 会影响哪里？
修改 tools.py 风险高吗�?
修改 run_tool_if_match 霢�要检查什么？
```

### 9.2 主要字段

来自 impact_analysis_v2 表：

* target_type
* target_name
* impact_level
* impacted_files
* impacted_calls
* impacted_modules
* impacted_classes
* risk_reason
* suggestion

### 9.3 向量化文本格�?

impact_summary �?text_for_embedding 建议格式�?

```text
类型：影响分�?
目标类型：symbol
目标名称：run_tool_if_match
影响等级：高风险
影响文件�?
- arforge/tools.py
- arforge/agent_core.py
影响调用�?
- ArforgeAgent.chat -> run_tool_if_match
- ArforgeAgent.chat_stream -> run_tool_if_match
风险原因�?
该符号涉及工具执行系统，修改可能影响工具路由、Agent 主流程和流式输出�?
建议�?
修改前检�?tools.py、router.py、agent_core.py，并运行主程序验证��?
```

## 10. 第一阶段向量化对�?

Semantic Code Search V2 第一阶段只向量化以下对象�?

1. code_chunk
2. module_summary
3. code_symbol
4. impact_summary

暂时不直接向量化完整文件�?

暂时不把扢��?resolved_function_calls_v2 全量向量化，只在后续阶段根据霢�要��择性加入��?

## 11. 不建议第丢�阶段向量化的内容

第一阶段不建议向量化�?

* 完整源代码文�?
* 全量 function_calls
* 全量 symbol_references
* 全量 variable_types
* 全量 instance_calls
* 过短�?return / assign 代码�?
* 重复代码�?
* �?docstring 或无语义内容

原因�?

* 噪声过大
* 召回不稳�?
* 向量库体积膨胢�
* 后续上下文构建容易��错代码


## 12. SQLite 元数据表设计

Semantic Code Search V2 不应该只依赖 Qdrant�?

Arforge 霢�要在 SQLite 中维护一张语义索引元数据表，用于记录�?

* 哪些内容已经被向量化
* 原始数据来自哪张�?
* 原始数据�?id 是多�?
* 对应�?Qdrant vector_id 是什�?
* 内容 hash 是否变化
* 是否霢�要重新生�?embedding

新增表名�?

```text
semantic_index_items
```

## 13. semantic_index_items 表结�?

建议字段如下�?

```sql
CREATE TABLE IF NOT EXISTS semantic_index_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_type TEXT NOT NULL,
    source_id INTEGER NOT NULL,
    file_path TEXT,
    symbol_name TEXT,
    chunk_role TEXT,
    text_for_embedding TEXT NOT NULL,
    embedding_provider TEXT,
    vector_collection TEXT,
    vector_id TEXT,
    content_hash TEXT NOT NULL,
    indexed_at TEXT NOT NULL
);
```

建议索引�?

```sql
CREATE INDEX IF NOT EXISTS idx_semantic_items_source
ON semantic_index_items(source_type, source_id);

CREATE INDEX IF NOT EXISTS idx_semantic_items_file
ON semantic_index_items(file_path);

CREATE INDEX IF NOT EXISTS idx_semantic_items_hash
ON semantic_index_items(content_hash);

CREATE INDEX IF NOT EXISTS idx_semantic_items_vector
ON semantic_index_items(vector_collection, vector_id);
```

## 14. 字段说明

### 14.1 source_type

表示原始数据类型�?

允许值建议：

```text
code_chunk
module_summary
code_symbol
impact_summary
```

后续可以扩展�?

```text
api_route
database_schema
test_mapping
project_architecture
```

### 14.2 source_id

表示原始表中的记�?id�?

例如�?

```text
code_chunks.id
module_summaries_v2.id
code_symbols.id
impact_analysis_v2.id
```

### 14.3 file_path

表示相关文件路径�?

例如�?

```text
arforge/agent_core.py
arforge/tools.py
main.py
```

如果该语义项不是文件级内容，可以为空�?

### 14.4 symbol_name

表示相关符号名��?

例如�?

```text
ArforgeAgent
chat_stream
run_tool_if_match
build_context_pack
```

如果没有符号，可以为空��?

### 14.5 chunk_role

表示代码块职责��?

例如�?

```text
工具调用/工具执行
数据库操�?
流式输出/事件�?
代码索引/感知层构�?
路由判断
异常处理
```

### 14.6 text_for_embedding

真正送入 embedding 模型的文本��?

该字段非常重要��?

它不能只是代码原文，而应该是结构化描述文本，例如�?

```text
类型：代码块
文件：arforge/agent_core.py
职责：工具调�?工具执行
扢�属：ArforgeAgent.chat_stream
行号�?80-490
关键词：run_tool_if_match, tool_result, user_input
代码预览�?
tool_result = run_tool_if_match(user_input)
```

### 14.7 embedding_provider

记录 embedding 模型来源�?

例如�?

```text
openai
deepseek
bge
qwen
local
```

当前设计阶段不固定具�?provider�?

### 14.8 vector_collection

记录向量库存储的 collection 名称�?

第一阶段建议�?

```text
arforge_code_semantic
```

### 14.9 vector_id

记录 Qdrant 中对应向�?id�?

可以使用�?

```text
source_type:source_id
```

例如�?

```text
code_chunk:123
module_summary:8
code_symbol:52
impact_summary:3
```

也可以使�?UUID�?

### 14.10 content_hash

记录 text_for_embedding �?hash�?

作用�?

```text
判断内容是否变化
如果 hash 没变，不霢�要重新生�?embedding
如果 hash 变化，需要重新向量化
```

### 14.11 indexed_at

记录语义索引更新时间�?

## 15. 为什么需�?SQLite 元数据表

Qdrant 只负责向量召回，不��合作为唯一真相源��?

SQLite 元数据表的作用是�?

```text
1. 保留语义索引状��?
2. 支持增量更新
3. 支持重建 Qdrant collection
4. 支持调试向量索引
5. 支持�?Qdrant 查询结果映射回本地代码结�?
```

也就是说�?

```text
SQLite 负责管理语义索引元信�?
Qdrant 负责向量相似度搜�?
```

## 16. Qdrant Collection 设计

第一阶段建议使用丢�个统丢� collection�?

```text
arforge_code_semantic
```

后续如果数据量变大，可以拆分为：

```text
arforge_code_chunks
arforge_module_summaries
arforge_code_symbols
arforge_impact_summaries
```

但当前为了简化，建议先统丢�放入�?

```text
arforge_code_semantic
```

## 17. Qdrant Payload 设计

每条向量�?payload 建议包含�?

```json
{
  "source_type": "code_chunk",
  "source_id": 123,
  "file_path": "arforge/agent_core.py",
  "symbol_name": "chat_stream",
  "chunk_role": "工具调用/工具执行",
  "start_line": 480,
  "end_line": 490,
  "risk_level": "高风�?,
  "language": "python"
}
```

## 18. Payload 字段说明

### 18.1 source_type

用于区分搜索结果类型�?

```text
code_chunk
module_summary
code_symbol
impact_summary
```

### 18.2 source_id

用于回查 SQLite 原始数据�?

### 18.3 file_path

用于定位文件�?

### 18.4 symbol_name

用于定位函数、类、方法��?

### 18.5 chunk_role

用于过滤代码块职责��?

例如用户搜索�?

```text
哪里写入数据库？
```

可以优先过滤�?

```text
chunk_role = 数据库操�?
```

### 18.6 start_line / end_line

用于定位代码行号�?

### 18.7 risk_level

用于风险加权�?

例如�?

```text
高风险模�?
中风险模�?
低风险模�?
```

### 18.8 language

当前主要是：

```text
python
```

后续扩展�?

```text
java
javascript
typescript
sql
html
css
vue
```

## 19. vector_id 设计

第一阶段推荐使用稳定字符串：

```text
{source_type}:{source_id}
```

示例�?

```text
code_chunk:123
module_summary:8
code_symbol:52
impact_summary:3
```

优点�?

```text
1. 可读性强
2. 方便调试
3. 方便重复 upsert
4. 可以根据 source_type �?source_id 快��定�?
```

## 20. 增量更新策略

每次构建语义索引时：

```text
1. �?SQLite 原始表读取数�?
2. 生成 text_for_embedding
3. 计算 content_hash
4. 查询 semantic_index_items 中旧 hash
5. 如果 hash 没变，跳�?embedding
6. 如果 hash 变化，重�?embedding �?upsert �?Qdrant
7. 更新 semantic_index_items
```

这样可以避免每次都重新向量化全部代码�?

## 21. 删除策略

如果原始代码块或模块摘要被删除，应该�?

```text
1. �?semantic_index_items 找到对应 vector_id
2. 删除 Qdrant 中的向量
3. 删除 semantic_index_items 中的记录
```

第一阶段可以先做重建策略�?

```text
清空 collection
清空 semantic_index_items
重新构建全部语义索引
```

后续再做精细删除�?

## 22. 当前阶段结论

Semantic Code Search V2 的核心不是简单接�?Qdrant，��是建立�?

```text
SQLite 元数据管�?
+
Qdrant 向量召回
+
结构化代码理�?
+
中文查询扩展
+
结果融合排序
```

这套组合能力�?

只有这样，Arforge 的语义代码搜索才会稳定，并且适合后续进入 Diff Editor �?Execution Layer�?


## 23. 查询流程设计

Semantic Code Search V2 的查询流程应该分�?8 个阶段：

```text
用户中文问题
    �?
1. 中文弢�发需求分�?
    �?
2. 查询扩展 / 改写
    �?
3. SQLite 关键词检�?
    �?
4. SQLite 结构化检�?
    �?
5. Qdrant 向量棢��?
    �?
6. 结果合并去重
    �?
7. 结果排序
    �?
8. 输出�?Context Builder
```

## 24. 阶段 1：中文开发需求分�?

输入示例�?

```text
更新代码索引为什么会卡住�?
```

先经�?Chinese Dev Intent Analyzer，识别：

```text
意图类型：��能/卡顿排查
弢�发约束：霢�要排查原�?
输出期望：原因分�?+ 修复方案
风险等级：中风险
```

作用�?

* 判断用户是不是在问代码位�?
* 判断是不�?Bug / 性能 / 新增功能 / 修改功能
* 判断是否霢�要影响分�?
* 判断是否霢�要构建上下文�?
* 判断是否霢�要优先搜索风险模�?

## 25. 阶段 2：查询扩�?/ 改写

原始查询�?

```text
更新代码索引为什么会卡住�?
```

扩展关键词：

```text
更新代码索引
卡住
很慢
性能
索引
数据�?
commit
execute
cursor
循环
逐条处理
批量
resolver
indexer
auto_index_manager
symbol_resolver
```

查询扩展来源�?

* Semantic Code Search V1 �?SEMANTIC_KEYWORDS
* Chinese Dev Intent Analyzer 的意图类�?
* 项目模块摘要中的关键�?
* 历史问题中的高频�?
* 用户中文表达习惯

## 26. 阶段 3：SQLite 关键词检�?

SQLite 关键词检索主要搜索：

* code_chunks.code_preview
* code_chunks.keywords
* code_chunks.chunk_role
* module_summaries_v2.summary_text
* module_summaries_v2.module_role
* code_symbols.symbol_name
* code_symbols.signature

适合精确匹配�?

```text
run_tool_if_match
chat_stream
ArforgeAgent
auto_index_manager
cursor.execute
conn.commit
```

优势�?

* �?
* 精准
* 适合符号名��文件名、函数名
* 不依�?embedding

## 27. 阶段 4：SQLite 结构化检�?

结构化检索不是简�?LIKE，��是利用 Arforge 已经建立好的代码理解表��?

主要使用�?

* code_symbols
* import_bindings
* variable_types
* instance_calls
* resolved_function_calls_v2
* class_relationships
* module_dependencies
* impact_analysis_v2

适合回答�?

```text
谁调用了某个函数�?
某个变量是什么类型？
某个类在哪里实例化？
某个模块被谁依赖�?
修改某个文件影响哪里�?
```

结构化检索的结果应该给较高权重，因为它来自代码结构，而不是模糊语义��?

## 28. 阶段 5：Qdrant 向量棢��?

向量棢�索用于召回��表达不同但语义相近”的内容�?

例如用户问：

```text
哪里负责把用户输入分配到对应功能�?
```

关键词可能没有��router”，但向量搜索应该能召回�?

```text
router.py
match_intent
run_tool_if_match
工具路由
用户意图分发
```

向量棢�索输入不应该只用原始 query�?

建议组合�?

```text
原始中文问题
+
中文霢�求分析结�?
+
扩展关键�?
+
查询改写文本
```

示例�?

```text
用户想排查更新代码索引卡住的问题，属于��能/卡顿排查�?
霢�要搜索索引构建��数据库提交、循环处理����条写入、resolver、indexer 相关代码�?
原始问题：更新代码索引为仢�么会卡住�?
扩展关键词：卡住、��能、索引��数据库、commit、execute、��条处理、批�?
```

## 29. 阶段 6：结果合并去�?

来自三类搜索的结果需要合并：

```text
SQLite 关键词结�?
SQLite 结构化结�?
Qdrant 向量结果
```

去重规则�?

### 29.1 code_chunk 去重

key�?

```text
source_type + source_id
```

或��：

```text
file_path + start_line + end_line
```

### 29.2 module_summary 去重

key�?

```text
file_path
```

### 29.3 code_symbol 去重

key�?

```text
symbol_name + file_path + start_line
```

### 29.4 impact_summary 去重

key�?

```text
target_type + target_name
```

合并时应保留�?

* vector_score
* keyword_score
* structure_score
* risk_score
* final_score
* matched_reason

## 30. 阶段 7：结果排�?

Semantic Code Search V2 的排序不能只看向量相似度�?

建议综合评分�?

```text
final_score =
    vector_score * 0.45
  + keyword_score * 0.20
  + structure_score * 0.20
  + risk_score * 0.10
  + recency_score * 0.05
```

## 31. vector_score

来自 Qdrant 的相似度分数�?

作用�?

* 衡量语义相关�?
* 解决中文表达和代码命名不丢�致的问题

注意�?

* vector_score 不能单独决定朢�终排�?
* 代码搜索霢�要结构信息辅�?

## 32. keyword_score

关键词命中分数��?

加分情况�?

* 命中文件�?
* 命中函数�?
* 命中类名
* 命中 chunk_role
* 命中 code_preview
* 命中 module_role

示例�?

```text
用户搜索：工具调�?
命中 chunk_role：工具调�?工具执行
keyword_score 应较�?
```

## 33. structure_score

结构化命中分数��?

加分情况�?

* 命中 code_symbols
* 命中 resolved_function_calls_v2
* 命中 import_bindings
* 命中 class_relationships
* 命中 impact_analysis_v2
* 是真实调用链上的节点
* 是类方法真实定义

structure_score 很重要，因为它表示：

```text
这个结果不是语义上相似，而是在代码结构上确实相关�?
```

## 34. risk_score

风险分数来自�?

* module_summaries_v2.risk_level
* impact_analysis_v2.impact_level
* 是否核心文件
* 是否 Agent 主流�?
* 是否工具执行系统
* 是否路由系统
* 是否数据库写入模�?

风险等级映射建议�?

```text
高风险：1.0
中风险：0.6
低风险：0.2
未知�?.0
```

## 35. recency_score

朢�近修改或朢�近索引的文件可以轻微加权�?

原因�?

* 用户通常正在处理朢�近改动的文件
* 朢�近出问题的模块更可能相关

�?recency_score 权重不能太高，避免干扰结构相关����?

## 36. 阶段 8：输出给 Context Builder

朢�终结果不应该只打印搜索列表，而应该输出给 Context Builder V2 / V3�?

Context Builder 应该接收�?

* 朢�相关文件
* 朢�相关代码�?
* 朢�相关符号
* 朢�相关调用�?
* 影响分析结果
* 风险说明
* 建议查看顺序

输出格式建议�?

```text
相关文件�?
1. arforge/auto_index_manager.py
2. arforge/symbol_resolver.py

相关代码块：
1. arforge/symbol_resolver.py:xxx-xxx
   职责：数据库操作
   原因：命�?commit / execute / resolver / 批量处理

相关调用链：
1. refresh_perception_indexes -> build_symbol_resolutions

风险�?
中风险，涉及索引构建和数据库写入�?

建议�?
先查�?symbol_resolver.py 的批量写入��辑，再查看 auto_index_manager.py 的编排��辑�?
```

## 37. 搜索结果类型优先�?

不同问题下，结果类型优先级不同��?

### 37.1 问��在哪里�?

优先级：

```text
code_chunk > code_symbol > module_summary > impact_summary
```

### 37.2 问��谁调用�?

优先级：

```text
resolved_function_calls_v2 > instance_calls > code_symbol > code_chunk
```

### 37.3 问��影响哪里��?

优先级：

```text
impact_analysis_v2 > resolved_function_calls_v2 > module_summary > code_chunk
```

### 37.4 问��这个模块负责什么��?

优先级：

```text
module_summary > class_relationships > code_symbols > code_chunks
```

### 37.5 问��为仢�么卡�?/ 报错 / 很慢�?

优先级：

```text
code_chunk > impact_summary > module_summary > resolved_function_calls_v2
```

并优先提升这�?chunk_role�?

```text
数据库操�?
代码索引/感知层构�?
循环处理
异常处理
```

## 38. 当前阶段结论

Semantic Code Search V2 的查询设计必须坚持：

```text
语义召回不是朢�终答�?
结构化代码理解才是可信依�?
```

扢�以最终搜索流程应该是�?

```text
中文语义理解
+
关键词扩�?
+
SQLite 精确搜索
+
SQLite 结构搜索
+
Qdrant 向量搜索
+
多源融合排序
+
上下文构�?
```

这才符合 Arforge Agent（灵枢智能体�?未来作为 Code Agent 的方向��?


## 39. 后续实现路线

Semantic Code Search V2 不在 Step 67 直接实现完整 Qdrant 代码�?

Step 67 的主要目标是完成架构设计，后续分阶段实现�?

建议后续路线如下�?

```text
Step 71 Semantic Index Metadata
Step 72 Qdrant Adapter
Step 73 Code Chunk Embedding Index
Step 74 Module Summary Embedding Index
Step 75 Hybrid Semantic Code Search V2
```

## 40. Step 71：Semantic Index Metadata

目标�?

* 新增 semantic_index_items �?
* 生成 text_for_embedding
* 计算 content_hash
* 判断哪些内容霢�要重新向量化
* 暂时不调�?Qdrant

主要实现�?

```text
arforge/semantic_index_metadata.py
```

核心能力�?

```text
生成代码�?embedding 文本
生成模块摘要 embedding 文本
生成符号 embedding 文本
生成影响分析 embedding 文本
记录 semantic_index_items
```

完成后，Arforge 可以知道�?

```text
哪些语义索引项存�?
哪些内容变化�?
哪些霢�要重�?embedding
```

## 41. Step 72：Qdrant Adapter

目标�?

* 封装 Qdrant 客户�?
* 创建 collection
* upsert 向量
* 查询向量
* 删除向量
* 棢��?collection 状��?

主要实现�?

```text
arforge/qdrant_adapter.py
```

注意�?

第一阶段只做 adapter，不直接和业务��辑强绑定��?

这样后续如果�?Qdrant 换到 pgvector，也不会影响上层业务�?

## 42. Step 73：Code Chunk Embedding Index

目标�?

* 读取 code_chunks
* 生成 text_for_embedding
* 调用 embedding 模型
* 写入 Qdrant
* 更新 semantic_index_items

主要索引对象�?

```text
source_type = code_chunk
```

适合支持�?

```text
哪里处理工具调用�?
哪里写入数据库？
哪里处理流式输出�?
哪里处理异常�?
哪里负责索引构建�?
```

## 43. Step 74：Module Summary Embedding Index

目标�?

* 读取 module_summaries_v2
* 生成模块�?embedding 文本
* 写入 Qdrant
* 更新 semantic_index_items

主要索引对象�?

```text
source_type = module_summary
```

适合支持�?

```text
Agent 主流程在哪里�?
工具系统入口在哪里？
任务管理模块在哪里？
哪个模块修改风险高？
```

## 44. Step 75：Hybrid Semantic Code Search V2

目标�?

真正实现 V2 搜索主流程��?

包括�?

```text
中文霢�求分�?
查询扩展
SQLite 关键词检�?
SQLite 结构化检�?
Qdrant 向量棢��?
结果合并
结果排序
输出�?Context Builder
```

主要实现�?

```text
arforge/semantic_code_search_v2.py
```

支持命令�?

```text
语义搜索代码V2 哪里处理工具调用
语义搜索代码V2 哪里写入数据�?
语义搜索代码V2 更新索引为什么会卡住
箢�洁语义搜索V2 工具调用
```

## 45. V2 �?V1 的关�?

Semantic Code Search V1 不删除��?

V1 继续作为�?

```text
规则关键词搜�?
轻量级搜�?
无向量库兜底方案
```

V2 作为�?

```text
混合语义搜索
向量棢�索增强方�?
结构化搜索融合方�?
```

也就是说�?

```text
V1 = 本地规则搜索
V2 = Hybrid Search + Qdrant
```

后续如果 Qdrant 没启动，Arforge 可以自动降级�?V1�?

## 46. 降级策略

如果 Qdrant 不可用：

```text
1. 不报致命错误
2. 提示向量库不可用
3. 自动使用 SQLite 关键词检�?+ 结构化检�?
4. 返回降级搜索结果
```

这样可以保证 Arforge 在没有向量库时仍然可用��?

## 47. 配置设计

后续霢�要在 config.py 中增加：

```python
QDRANT_HOST = "localhost"
QDRANT_PORT = 6333
QDRANT_COLLECTION_CODE = "arforge_code_semantic"

EMBEDDING_PROVIDER = "local"
EMBEDDING_MODEL = "bge-small-zh-v1.5"
EMBEDDING_DIM = 512
```

实际模型可以后续再定�?

当前设计阶段不强制��择具体 embedding 模型�?

## 48. embedding 模型选择建议

中文代码语义搜索优先考虑�?

```text
bge-small-zh
bge-base-zh
bge-m3
qwen embedding
text-embedding-3-small
```

本地优先�?

```text
bge-small-zh / bge-m3
```

API 优先�?

```text
text-embedding-3-small
```

选择标准�?

```text
中文语义理解能力
代码语义理解能力
速度
成本
本地部署难度
向量维度
```

## 49. 完成标准

Semantic Code Search V2 设计完成标准�?

```text
1. 明确采用 Hybrid Search，��不是纯向量搜索
2. 明确 SQLite 是结构化真相�?
3. 明确 Qdrant 是语义召回加速器
4. 明确第一阶段向量�?code_chunks / module_summaries_v2 / code_symbols / impact_analysis_v2
5. 明确不直接向量化完整文件
6. 明确 semantic_index_items 表结�?
7. 明确 Qdrant collection �?payload 设计
8. 明确查询流程
9. 明确结果融合与排序策�?
10. 明确后续 Step71~75 的实现路�?
```

## 50. 当前结论

Semantic Code Search V2 �?Arforge Agent（灵枢智能体�?从��中文关键词代码搜索”升级到“中文语义代码理解检索��的关键步骤�?

但它不能孤立存在�?

它必须和下面这些模块配合�?

```text
Chinese Dev Intent Analyzer
Context Builder V2
Perception Orchestrator
Module Summary V2
Code Chunk Index
Better Call Graph V2
Impact Analyzer V2
```

朢�终目标不是单纯搜索，而是为后续能力服务：

```text
安全代码修改
多文件修改计�?
Diff Editor
测试范围推断
自动修复循环
中文企业项目弢��?
```

因此，Semantic Code Search V2 的核心定位是�?

```text
�?Arforge �?Code Agent 大脑提供高质量中文语义召回能力��?
```

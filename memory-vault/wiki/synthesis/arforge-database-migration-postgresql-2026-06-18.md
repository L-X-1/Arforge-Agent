---
title: 数据库架构迁移 — 从 SQLite 到 SQLAlchemy + PostgreSQL 部署
category: synthesis
summary: 将 Arforge 数据库从 raw sqlite3 全面迁移到 SQLAlchemy ORM + PostgreSQL，作为默认数据库，零 SQLite 回退。
tags: [arforge, database, sqlalchemy, postgresql, migration, devops]
updated: 2026-06-18
---

# 数据库架构迁移 — SQLAlchemy + PostgreSQL 部署

## 背景

Arforge 原使用 Python 原生 `sqlite3`（标准库）在 7 个模块中各自管理连接。所有表通过 `CREATE TABLE IF NOT EXISTS` 手动建表，列迁移靠 `PRAGMA table_info` + `ALTER TABLE ADD COLUMN`。适用于个人本地使用。

用户要求：
1. 开始积累用户数据，需要专业数据库
2. 云部署为默认，不再使用 SQLite
3. 保留测试环境的 SQLite 内存库支持

## 迁移成果

### 数据层
- **ORM**: SQLAlchemy 2.0 DeclarativeBase 风格
- **默认数据库**: PostgreSQL 17.10（云部署优先）
- **7 张表模型**: Memory, LearningExperience, LearningOutcome, LearningPattern, TokenUsage, MultiagentTask, MultiagentConversation
- **双引擎**: `get_engine()` (主库) + `get_ma_engine()` (多智能体库)
- **跨后端 JSON**: `JSONText` TypeDecorator (SQLite TEXT / PostgreSQL JSONB)

### 新建文件 (10 个)
```
arforge/database/
├── __init__.py          # 统一入口
├── base.py              # DeclarativeBase + JSONText
├── config.py            # ARFORGE_DB_URL 配置
├── engine.py            # 双引擎 + session 管理
├── migration.py         # 自动建表 + 诊断
└── models/
    ├── __init__.py
    ├── memory.py
    ├── learning_experience.py
    ├── learning_outcome.py
    ├── learning_pattern.py
    ├── token_usage.py
    └── multiagent.py
```

### 重写模块 (7 个)
| 模块 | 改动 |
|------|------|
| `arforge/memory.py` | sqlite3.connect → get_session() + Memory ORM |
| `arforge/models/token_tracker.py` | 同上 → TokenUsage ORM |
| `arforge/learning_db.py` | 同上 → LearningExperience ORM |
| `arforge/learning_system.py` | 同上 → LearningOutcome + LearningPattern ORM，保留 _init_db/get_db_path 兼容壳 |
| `arforge/database_schema_indexer.py` | sqlite3 → sqlalchemy.inspect() |
| `arforge/multiagent/protocol.py` | sqlite3._ensure_db → get_ma_session() + ORM merge/upsert |
| `arforge/__init__.py` | 添加 auto_init_db() 调用，保留 get_db_path() 兼容导出 |

### 新增依赖
```toml
# pyproject.toml
dependencies = ["sqlalchemy>=2.0.0"]
[project.optional-dependencies]
postgres = ["psycopg2-binary>=2.9.0"]
```

### 环境变量
| 变量 | 格式 | 说明 |
|------|------|------|
| `ARFORGE_DB_URL` | `postgresql://user:pass@host:5432/arforge` | 主库（必需） |
| `ARFORGE_MULTIAGENT_DB_URL` | 自动推导为 `.../arforge_ma` | 多智能体库（可选） |

## PostgreSQL 部署

### 环境
- **PostgreSQL 17.10** (Winget 安装)
- **数据库**: `arforge` (主库) + `arforge_ma` (多智能体)
- **驱动**: psycopg2-binary 2.9.12
- **密码重置**: 通过 `postgres --single` 单用户模式
- **配置文件**: `.env` 中 ARFORGE_DB_URL

### 部署步骤
1. `winget install PostgreSQL.PostgreSQL.17`
2. 停服务 → 单用户模式 → 重设密码
3. 启服务 → `CREATE DATABASE arforge; CREATE DATABASE arforge_ma;`
4. 写入 `.env`: `ARFORGE_DB_URL=postgresql://postgres:***@localhost:5432/arforge`
5. 安装驱动: `pip install psycopg2-binary`

## 信任屏幕键盘修复

### 问题
`trust_screen.py` 的 `_read_key()` 存在两个竞态条件：
1. Windows 扩展键 `\xe0` 穿透到 UTF-8 解码，返回垃圾字符 `'à'`
2. ANSI 转义 `\x1b` 嵌套 `kbhit()` 失败时穿透到 `return "esc"`

### 修复
- 用**阻塞式 `getch()`** 替代不可靠的 `kbhit()` 轮询
- 添加 10ms 宽限期处理慢速终端
- 正确返回空字符串忽略未识别的转义序列

## 验证

```
测试:        591 passed, 3 failed (全部既有), 0 regressions
Ruff:        CLEAN (所有新文件和修改文件)
compileall:  OK (arforge/database/ 包)
PostgreSQL:  写入 OK, 查询 OK, 7 张表自动创建
```

## 入口架构说明

`arforge` 命令存在多个入口点：
- ❌ `D:\PYTHON\Scripts\arforge.exe` — pip console_scripts，stdin 断裂
- ✅ `E:\Arforge-Agent\arforge.cmd` — 直接调用 `.venv\Scripts\python.exe main.py`
- ✅ `C:\Users\...\npm\arforge` — Node.js 包装器 `spawn` + `stdio:inherit`

正确用法：`cd E:\Arforge-Agent && arforge.cmd`

# aimemory 记忆库使用引导

你（agent）可以访问 **aimemory 记忆库**——一个持久化、语义可检索的 AI 记忆服务（mem0 兼容）。以下规则让你在对话中**主动使用记忆**，而不是被动等待。

## 记忆库是什么

- 跨会话持久：上一个会话存的内容，本会话能检索到
- 语义检索：搜"怎么连数据库"能命中"用 psql 连接 PostgreSQL"这类同义表达
- 多租户隔离：只能访问当前用户自己的记忆
- 自动提炼：写入时会经 LLM 提炼成结构化事实（facts），增强召回

## 何时应该查记忆（recall）

- **开始新任务/新会话时**：先检索相关记忆，避免重复踩坑、重复决策
- 用户提到"之前/上次/以前/我记得/我们讨论过"
- 涉及历史决策、偏好、配置、账号、项目背景
- 复杂任务开始前，主动预取相关上下文

→ 触发 `aimemory-recall` skill（只读检索，静默于空）

## 何时应该存记忆（remember）

- 用户明确说"记住/别忘了/记一下"
- 用户表达持久偏好、事实、配置、账号、项目决策
- 对话产生重要结论、踩坑教训、解决方案
- 完成一个有长期价值的任务后

→ 触发 `aimemory-remember` skill（messages 批量提炼）

## 记忆管理

用户要求"查我的记忆/列出/修改/删除/清空记忆"时，触发 `aimemory` skill（增删改查，删除需用户确认）。

## 关键工具

- `mcp__aimemory__search_memories` — 语义检索（核心）
- `mcp__aimemory__add_memory` — 写入（支持 messages 批量提炼）
- `mcp__aimemory__get_memories` / `get_memory` — 列出/查看
- `mcp__aimemory__update_memory` / `delete_memory` — 修改/删除
- `mcp__aimemory__delete_all_memories` / `list_entities` / `delete_entities` — 批量管理

## 注意

- 记忆可能是历史快照，涉及密码/端口等**使用前判断时效性**，必要时提醒用户核实
- 不存敏感明文（完整密码），除非用户明确要求
- 保持轻量：recall 最多加载 10 条，避免污染上下文

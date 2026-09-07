---
name: aimemory
description: aimemory 记忆库管理入口——检索、列出、查看、更新、删除记忆，管理记忆库数据。适用时机：用户想"查我的记忆/看记忆库/搜索记忆/列出记忆/修改某条记忆/删除记忆/清空记忆/导入导出记忆"，或询问"我记得什么/我的记忆里有没有 X"。涉及记忆库的增删改查都走本 skill。纯对话式加载历史记忆用 aimemory-recall，主动保存用 aimemory-remember。
metadata:
  cli_version: ">=0.2.14"
  category: memory
user-invocable: true
---

# aimemory（记忆库管理）

aimemory 是自托管的 AI 记忆库（mem0 兼容 MCP），多租户隔离、语义+关键词混合检索。核心逻辑由 MCP 服务提供（MCP 工具），本 skill 描述各管理操作的编排。

> ⚠️ 依赖已连接的 MCP 服务 `aimemory`（`http://<内网IP>:18543/mcp`）。
> ⚠️ 数据按用户隔离：只能操作当前登录用户自己的记忆，跨用户访问会被拒绝。

> 🧩 **工具名匹配**：实际注册的 MCP 工具名为 `mcp__<server名>__<工具名>`。插件安装时 server 名带前缀
> （如 `mcp__plugin_aimemory_aimemory__search_memories`），用户级直连时无前缀（`mcp__aimemory__search_memories`）。
> 下表统一用**裸工具名**（`search_memories` 等）表示，调用时按 `__` 后的工具名匹配实际注册名即可，无需关心 server 前缀。
## 意图 → 工具映射

| 用户说 | 调用 | 说明 |
|---|---|---|
| "搜/查记忆" + 关键词 | `search_memories` | 语义+关键词混合检索，`threshold` 可过滤低置信 |
| "刚存的记忆在不在/提炼完没" | `get_event_status` | `add_memory(messages)` 是异步的，用返回的 `event_id` 查提炼状态 |
| "列出/我的记忆" | `get_memories` | 分页，可按 `metadata`/时间过滤 |
| "看某条记忆" | `get_memory` | 按 id 取单条 |
| "改某条记忆" | `get_memory` 确认 id → `update_memory` | 更新前先读原文确认 |
| "删某条记忆" | `delete_memory` | 按 id 删除 |
| "清空我的全部记忆" | 引导用户到 Web 平台「我的记忆」手动删 | MCP 刻意不提供整库删除（防误操作） |
| 记忆键管理 | 引导用户到 Web 平台（REST `/api/keys`）或设备流接入 | API Key 管理（MCP 不暴露） |

## 核心规则

- **删除必须确认**：`delete_memory` 执行前先展示目标内容让用户确认，禁止擅自删除
- **更新先读**：`update_memory` 前先 `get_memory` 拿到原文，向用户展示修改点
- **隔离边界**：记忆是**当前登录员工**的账本；涉及 `user_id` 参数时只能传当前身份，跨用户查询/删除会被服务端拒绝，向用户解释这是多租户隔离
- **结果汇报**：检索结果用紧凑列表呈现（内容 + 相似度/时间），不吐原始 JSON

## 相关 skill

- `aimemory-recall`：任务开始时自动加载相关记忆（只读）
- `aimemory-remember`：主动保存记忆（写入）

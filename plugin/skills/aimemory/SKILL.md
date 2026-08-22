---
name: aimemory
description: aimemory 记忆库管理入口——检索、列出、查看、更新、删除记忆，管理记忆库数据。适用时机：用户想"查我的记忆/看记忆库/搜索记忆/列出记忆/修改某条记忆/删除记忆/清空记忆/导入导出记忆"，或询问"我记得什么/我的记忆里有没有 X"。涉及记忆库的增删改查都走本 skill。纯对话式加载历史记忆用 aimemory-recall，主动保存用 aimemory-remember。
metadata:
  cli_version: ">=0.2.14"
  category: memory
user-invocable: true
---

# aimemory（记忆库管理）

aimemory 是自托管的 AI 记忆库（mem0 兼容 MCP），多租户隔离、语义+关键词混合检索。核心逻辑由 MCP 服务提供（`mcp__aimemory__*` 工具），本 skill 描述各管理操作的编排。

> ⚠️ 依赖已连接的 MCP 服务 `aimemory`（`http://<内网IP>:18543/mcp`）。
> ⚠️ 数据按用户隔离：只能操作当前登录用户自己的记忆，跨用户访问会被拒绝。

## 意图 → 工具映射

| 用户说 | 调用 | 说明 |
|---|---|---|
| "搜/查记忆" + 关键词 | `mcp__aimemory__search_memories` | 语义+关键词混合检索，`threshold` 可过滤低置信 |
| "列出/我的记忆" | `mcp__aimemory__get_memories` | 分页，可按 `agent_id`/`run_id` 过滤 |
| "看某条记忆" | `mcp__aimemory__get_memory` | 按 id 取单条（含修改历史） |
| "改某条记忆" | `mcp__aimemory__get_memory` 确认 id → `mcp__aimemory__update_memory` | 更新前先读原文确认 |
| "删某条记忆" | `mcp__aimemory__delete_memory` | 按 id 删除 |
| "清空记忆" | `mcp__aimemory__delete_all_memories` | 清空当前用户全部记忆（需用户明确确认） |
| "有哪些用户/实体" | `mcp__aimemory__list_entities` | 列出有记忆的实体 |
| "删用户/实体" | `mcp__aimemory__delete_entities` | 删用户及其记忆（需用户明确确认，不可恢复） |
| 记忆键管理 | `mcp__aimemory__create_api_key` / `list_api_keys` / `revoke_api_key` | API Key 管理 |

## 核心规则

- **删除/清空必须确认**：`delete_memory`/`delete_all_memories`/`delete_entities` 执行前先展示目标内容让用户确认，禁止擅自删除
- **更新先读**：`update_memory` 前先 `get_memory` 拿到原文，向用户展示修改点
- **隔离边界**：涉及 `user_id` 参数时只能传当前身份；跨用户查询/删除会被服务端拒绝，向用户解释这是多租户隔离
- **结果汇报**：检索结果用紧凑列表呈现（内容 + 相似度/时间），不吐原始 JSON
- **agent/run 过滤**：用户提到"某 agent 的记忆"时，用 `agent_id`/`run_id` 参数过滤

## 相关 skill

- `aimemory-recall`：任务开始时自动加载相关记忆（只读）
- `aimemory-remember`：主动保存记忆（写入）

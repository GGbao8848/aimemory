---
name: aimemory
description: aimemory 记忆库管理入口——检索、列出、查看、更新、删除记忆，管理记忆库数据。适用时机：用户想"查我的记忆/看记忆库/搜索记忆/列出记忆/修改某条记忆/删除记忆/清空记忆/导入导出记忆"，或询问"我记得什么/我的记忆里有没有 X"。涉及记忆库的增删改查都走本 skill。纯对话式加载历史记忆用 aimemory-recall，主动保存用 aimemory-remember。
metadata:
  cli_version: ">=0.2.14"
  category: memory
user-invocable: true
---

# aimemory（记忆库管理）

aimemory 是自托管的 AI 记忆库（mem0 兼容 MCP），语义+关键词混合检索。核心逻辑由 MCP 服务提供（MCP 工具），本 skill 描述各管理操作的编排。

> ⚠️ 依赖已连接的 MCP 服务 `aimemory`（`http://<内网IP>:18543/mcp`）。
> ⚠️ 单用户部署：记忆归属当前部署的账号（个人账本），无需指定用户。

> 🧩 **工具名匹配**：实际注册的 MCP 工具名为 `mcp__<server名>__<工具名>`，如 server 名为 `aimemory` 时
> 检索工具注册为 `mcp__aimemory__search_memories`（若你的客户端安装时给 server 名加了前缀，则以实际注册名为准）。
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
| "清空我的记忆" | 引导用户到 Web 管理台操作，或 REST `DELETE /v1/memories/?user_id=…` | MCP 刻意不提供整库删除（防误操作） |
| 记忆键管理 | 引导用户到 Web 管理台（REST `/api/keys`） | API Key 管理（MCP 不暴露） |

## 核心规则

- **删除必须确认**：`delete_memory` 执行前先展示目标内容让用户确认，禁止擅自删除
- **更新先读**：`update_memory` 前先 `get_memory` 拿到原文，向用户展示修改点
- **更新后自动去重**：改文本后服务端会异步做一次「同一事实」检测，重复的旧记忆自动合并删除（审计可查），无需手动清理
- **写入语义**：`add_memory` 提交的都是素材（text/messages），异步受理由内部 LLM 提炼入库（不存原文）；日常对话结束时主动存一次关键结论即可
- **账本边界**：记忆是当前部署账号的个人账本（单用户，无需传 `user_id`）
- **结果汇报**：检索结果用紧凑列表呈现（内容 + 相似度/时间），不吐原始 JSON

## 相关 skill

- `aimemory-recall`：任务开始时自动加载相关记忆（只读）
- `aimemory-remember`：主动保存记忆（写入）

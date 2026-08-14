---
description: aimemory 记忆插件总览：检查 MCP 连接与配置状态，展示记忆工具用法，可按参数执行 add/search/list 操作。
argument-hint: "[add <内容>] [search <关键词>] [list] [status]"
skills: aimemory
---

# aimemory 记忆插件

检查并操作企业 AI 记忆库。

## 状态检查（默认）

1. 检查 aimemory 的 MCP 服务器是否已连接：查看可用工具中是否包含 `add_memory` / `search_memories` / `get_memories` 等。
2. 若工具缺失，提示用户：Settings → MCP 里检查 aimemory 服务器状态，并确认已配置 API Key（运行 `/aimemory-key` 引导）。
3. 用 `get_memories(page_size: 5)` 拉几条记忆验证连通。

## 按参数执行

- `/aimemory status` → 仅做上述状态检查
- `/aimemory list` → `get_memories(page_size: 20)` 列出最近记忆
- `/aimemory search <关键词>` → `search_memories(query: <关键词>)` 检索（$1）
- `/aimemory add <内容>` → `add_memory(text: <内容>)` 写入（$1，可继续追问 metadata）

其余情况或参数为空：展示上面的工具速查表与写入/检索时机建议（详见 aimemory skill）。

$ARGUMENTS

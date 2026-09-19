---
name: aimemory
description: aimemory 个人记忆库的统一入口——检索/注入历史记忆、沉淀新记忆、管理记忆库数据。适用时机：开始新任务或切换上下文时预取相关记忆；用户说"记住/别忘了/记一下"或给出持久偏好/决策/配置；用户问"我记得什么/我的记忆里有没有 X/之前/上次"；以及查、改、删、导出记忆或管理接入 Token。涉及 aimemory 记忆库的一切操作都走本 skill。
metadata:
  cli_version: ">=0.2.14"
  category: memory
user-invocable: true
---

# aimemory（个人记忆库）

自托管的 mem0 形态记忆库：素材写入 → 后台 LLM 提炼 + 冲突消解 → 语义/关键词混合检索。
单用户部署，记忆归属当前部署的身份，无需传 `user_id`。

> ⚠️ 依赖已连接的 MCP 服务 `aimemory`（`http://<内网IP>:18543/mcp`）。
> 实际注册的工具名是 `mcp__<server名>__<工具名>`，下文统一用**裸工具名**（`search_memories` 等）表示，
> 调用时按 `__` 后的名字匹配即可。

## 三种用法，按需读对应参考（不要一次全读）

| 场景 | 读哪篇 | 主要工具 |
|---|---|---|
| **召回**：任务开始/切换上下文时预取相关记忆，或用户问"我之前的偏好/决策" | [references/recall.md](references/recall.md) | `search_memories` |
| **沉淀**：用户说"记住"，或出现值得长期留存的决策/配置/偏好/教训 | [references/remember.md](references/remember.md) | `add_memory` → `get_event_status` |
| **管理**：查/看/改/删单条记忆，导出，或管理接入 Token | [references/manage.md](references/manage.md) | `get_memories` / `get_memory` / `update_memory` / `delete_memory` |

一次会话里召回 + 沉淀可以都做（先召回、回答后再沉淀）；管理类操作按需查。

## 工具面（7 个）

| 工具 | 一句话 |
|---|---|
| `add_memory` | 提交素材（`text` 或 `messages`），**异步**受理返回 `event_id`，后台 LLM 提炼入库（不存原文） |
| `get_event_status` | 用 `event_id` 查提炼进度：pending / processing / done / failed |
| `search_memories` | 语义 + 关键词混合检索（`query` 必填；`limit` / `threshold` / `filters` 可选） |
| `get_memories` | 分页列出记忆（可用 `filters` 过滤 metadata / 时间范围） |
| `get_memory` | 按 id 取单条 |
| `update_memory` | 按 id 更新 `text` / `metadata`（改文本后台自动去重合并） |
| `delete_memory` | 按 id 删除 |

## 四条硬规则

1. **写入必须轮询到底**：`add_memory` 返回 `event_id` ≠ 已入库。用 `get_event_status` 等到 `done`
   （拿提炼产物）或 `failed`（素材未入库，如实告知用户，不谎报成功）。
2. **删除必须确认**：`delete_memory` 前先展示目标内容让用户确认，禁止擅自删除。
3. **更新先读**：`update_memory` 前先 `get_memory` 拿原文，向用户展示修改点。
4. **结果要紧凑**：检索/列表结果用短列表呈现（内容 + 时间），不吐原始 JSON；把记忆融入回答；
   无相关记忆时保持沉默、不打扰。

## 边界

- 记忆是当前部署账号的个人账本：检索到的内容可能已过时（端口/地址/配置），使用前判断时效性，必要时提醒核实。
- 不存敏感明文：密码等凭据默认不存原文，可存"存在哪/用户名"，除非用户明确要求。
- 清空全部记忆、签发/吊销 Token 这类整库与凭据操作**不通过 MCP 做**——引导用户到 Web 管理台
  （`http://<内网IP>:18543/admin`）。

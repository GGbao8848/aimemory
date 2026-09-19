# 管理：查看、修改、删除、导出

单条记忆的日常管理，以及整库/接入类操作该去哪儿做。

## 意图 → 操作

| 用户说 | 做法 |
|---|---|
| "列出/我的记忆" | `get_memories`（分页；`filters` 支持 metadata 键值、`created_at`/`updated_at` 的 `{gte,lte}` 范围） |
| "看某条记忆" | `get_memory { memory_id }` |
| "改某条记忆" | 先 `get_memory` 读原文 → 向用户展示修改点 → `update_memory { memory_id, text? , metadata? }` |
| "删某条记忆" | 先展示目标内容确认 → `delete_memory { memory_id }` |
| "刚存的那个存上了吗" | `get_event_status { event_id }`（异步写入的进度查询） |
| "清空我的记忆" | 引导到 Web 管理台操作，或 REST `DELETE /v1/memories/?user_id=…`（MCP 不提供整库删除，防误操作） |
| Token 签发 / 吊销 | 引导到 Web 管理台「接入 Token」页（`http://<内网IP>:18543/admin`），MCP 不暴露 |
| 导出全部记忆 | Web 管理台「接入 Token」页的导出按钮，或 REST `GET /api/memories/export` |

## 更新与删除的注意点

- **更新后自动去重**：改文本后服务端异步做一次「同一事实」检测，重复的旧记忆自动合并删除
  （可在变更历史里追溯），无需手动清理。
- **删除留痕**：删除会写入变更历史（保留被删文本），误删可从 Web 管理台的「变更历史」查看；
  真要恢复需人工按历史文本重建。
- **作用域维度**：REST 面（`/v1` `/v2`）支持 `agent_id` / `run_id` 标签过滤；MCP 面单用户下不需要这些参数。

## 错误处理

工具返回 `isError: true` 时，文案里已写明下一步（如"memory_id 不存在，先 get_memories 列出有效 id"）。
按文案修正参数重试；`add_memory` 报"LLM 未启用"是部署侧配置问题，告知用户去 `.env` 配 `LLM_ENABLED=1`
并重启，或改用检索类操作。

---
name: aimemory-remember
description: 把当前对话中的关键信息存入 aimemory 记忆库，供未来会话检索。适用时机：用户明确说"记住/别忘了/记一下"、用户表达持久偏好/事实/配置/账号信息、对话中出现重要决策或踩坑教训、完成一个有价值的结论时。记忆自动经 LLM 提炼（messages 批量模式），支持按 agent 归属隔离。
metadata:
  cli_version: ">=0.2.14"
  category: memory
user-invocable: true
---

# aimemory-remember（记忆沉淀）

把对话中的关键信息存入 aimemory，让未来会话能检索到。核心逻辑由 MCP 服务提供（`mcp__aimemory__add_memory`），本 skill 只描述编排。

> ⚠️ 依赖已连接的 MCP 服务 `aimemory`（`http://<内网IP>:18543/mcp`，工具前缀 `mcp__aimemory__`）。

## 何时使用

- 用户说"记住"、"别忘了"、"记一下"、"写进记忆"、"存一下"
- 用户表达持久偏好、事实、配置、账号、项目背景
- 对话中产生重要决策、踩坑教训、解决方案
- 一段多轮对话形成了完整结论（适合 messages 批量提炼）

## 执行步骤

1. **收集内容**：把用户想记住的内容整理成 `messages` 数组（多轮对话）或 `text`（单条事实）。优先用 `messages`——LLM 会自动提炼成多条结构化记忆。

2. **调用 `mcp__aimemory__add_memory`**：

   ```json
   {
     "messages": [{"role": "user", "content": "..."}, {"role": "assistant", "content": "..."}],
     "agent_id": "<当前agent名，如 zcode>"   // 可选，标记记忆归属
   }
   ```
   或单条：`{ "text": "要记住的内容" }`

3. **确认结果**：向用户简短确认记忆已保存（`count` 条 / id），或提炼后的内容预览。

## 约束

- **不存敏感明文**：账号密码等凭据谨慎——默认不存完整密码，可存"存在哪/用户名"，除非用户明确要求
- **不存临时信息**：一次性对话（如"今天天气"）不存
- **提炼优先**：能丢 messages 就丢 messages（LLM 提炼更结构化），避免存口语化原文
- **尊重 infer**：默认开启事实抽取（infer=true），无需手动设置
- 保存失败时如实告知用户，不谎报成功

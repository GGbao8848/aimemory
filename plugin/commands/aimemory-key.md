---
description: 配置 aimemory 的 API Key。推荐先试 /aimemory-connect 一键自动连接；本命令为手动流程（打开 Web 平台生成密钥 → 填入配置），连接码流程不可用或密钥失效时使用。
argument-hint: "[mcp服务地址]"
skills: aimemory
---

# 配置 aimemory API Key（手动兜底）

> **优先用 `/aimemory-connect`**：浏览器授权后密钥自动生成并写入配置，无需手动复制粘贴。以下为手动流程兜底（若 $1 提供了 MCP 服务地址，用它替换下面的服务器地址）。

## 步骤

1. **打开 Web 平台**：告诉用户访问 `http://<服务器>:18543`（默认为插件配置的 server_url，去掉末尾 `/mcp`）。
2. **登录**：点击「通过登录平台登录」，用公司统一账号（Keycloak）登录。
3. **生成密钥**：在「🔑 接入密钥」区块，输入密钥名称（如 `zcode`），点「生成密钥」，**立即复制**显示的 `m0-` 开头的明文（只显示一次）。
4. **回到 ZCode 填入**：Settings → Plugin Management → aimemory 插件的设置里，把 `api_key` 字段填成刚复制的 `m0-xxx`；`server_url` 保持管理员给的地址。
5. **验证**：MCP 工具应自动重连；运行 `/aimemory status` 确认 `get_memories` 可调用。

## 故障排查

- **密钥失效 / 401**：在 Web 平台吊销旧密钥并重新生成，更新插件配置。
- **服务地址不对**：以管理员分发的地址为准，改插件设置的 `server_url`。
- **MCP 服务器显示未连接**：Settings → MCP 里检查 aimemory 的 url 与 Authorization 头，确认 `Token ${api_key}` 已替换成真实密钥。

## 安全提醒

密钥只存在本机 ZCode 配置里，不要分享给他人、不要提交进代码仓库；泄漏时去 Web 平台「吊销」即可立即失效。

$ARGUMENTS

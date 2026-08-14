---
description: 半自动连接 aimemory：浏览器一键授权后，用连接码自动生成 API Key 并写入你的 ZCode 配置，无需手动复制粘贴。也用于重新连接或修复失效的密钥。
argument-hint: "[连接码 XXXX-XXXX]"
skills: aimemory
allowed-tools: Read, Edit, Write, Bash
---

# 连接 aimemory（半自动）

把 aimemory 一键接入你的 ZCode，密钥自动生成并写入配置，不再手动复制/粘贴。

## 方式一：无参数（发起授权）

1. 在浏览器打开 **`http://<服务器>:18543/connect`**（服务器地址见插件设置的 `server_url`，去掉末尾 `/mcp`）。
2. 如未登录，用公司统一账号（Keycloak SSO）登录——已登录则自动确认。
3. 页面会显示 **连接码**（形如 `A3K9-Q2W1`）与自动生成的 API Key。
4. 回到这里，运行 **`/aimemory-connect <连接码>`**（把连接码粘到后面）。

## 方式二：带连接码（自动写入配置）

1. 用 `Read` 读取 `~/.zcode/cli/config.json`。
2. 用 `Bash` 请求兑换接口（连接码即凭据，10 分钟有效、一次性）：
   ```bash
   curl -s -X POST http://<服务器>:18543/api/connect/claim \
     -H "Content-Type: application/json" \
     -d '{"code":"<连接码>"}'
   ```
   返回：`{ "user_id": "...", "api_key": "m0-xxx", "mcp_url": "http://<服务器>:18543/mcp" }`
3. 用 `Edit` 把返回的 `mcp_url` 与 `api_key` 写入 `~/.zcode/cli/config.json` 的 `mcp.servers.aimemory`（若 `mcp` 或 `servers` 不存在则用 `Write` 重建，**务必保留原有其它字段**）：
   ```json
   {
     "mcp": {
       "servers": {
         "aimemory": {
           "type": "http",
           "url": "http://<服务器>:18543/mcp",
           "headers": { "Authorization": "Token m0-xxx" }
         }
       }
     }
   }
   ```
   > 这就是带真实密钥的完整配置（与 mem0 配置同款写法），写入后即永久生效、重启不丢。
4. 提示用户 **重启 ZCode 或让 MCP 重连**，再运行 `/aimemory status` 验证连通。

## 失败处理

- **连接码无效/已过期/已使用**：提示重新打开 `/connect` 获取新码（旧码一次性）。
- **写配置时文件不存在**：用 `Write` 新建（内容就是上面的 JSON）。
- **claim 返回非 200**：把错误消息告诉用户；若是网络不通，检查内网地址。
- **已有失效密钥**：让用户在 Web 平台吊销旧密钥，再走一次本流程即可（新密钥会自动写入，覆盖旧的）。

## 安全

- 连接码一次性、10 分钟有效，只用于兑换；密钥写进配置后，连接码即作废。
- 密钥只存在本机 `~/.zcode/cli/config.json`，不要提交进代码仓库；泄漏时去 Web 平台「吊销」立即失效。

$ARGUMENTS

---
description: 快速连接 aimemory（设备流，零粘贴）：从内部市场安装的插件，浏览器授权页点一次「确认授权」即自动生成密钥并写入 ZCode 配置。无需复制任何 token/连接码。也用于重连或修复失效密钥。
argument-hint: "[request_id 可选]"
skills: aimemory
allowed-tools: Read, Edit, Write, Bash
---

# 快速连接 aimemory（设备流）

aimemory 是**内部市场插件**：标准认证（Keycloak SSO + 授权确认）全部保留，但通过设备流消除「复制粘贴字符串」——员工只需在授权页点一次「确认授权」（可给密钥命名），密钥自动生成并写入配置。

## 方式一：直接运行（推荐）

运行 `/aimemory-connect`（不带参数），按以下步骤：

1. 用 `Bash` 发起设备流请求（内部市场端点，绝对可信）：
   ```bash
   curl -s -X POST http://<服务器>:18543/api/connect/start
   ```
   返回：`{ "request_id": "…", "authorize_url": "http://<服务器>:18543/connect?request_id=…", "expires_in": 600 }`
2. 告诉用户**打开 `authorize_url`**（可帮忙打开）：用公司统一账号登录（SSO，已登录则免密）→ 授权页显示本人身份 → 可选填密钥名称 → 点「确认授权」。
3. 用 `Bash` 轮询授权状态（每 2-3 秒一次，最多 10 分钟）：
   ```bash
   curl -s "http://<服务器>:18543/api/connect/poll?request_id=<request_id>"
   ```
   - 返回 `{"status":"pending"}` → 继续等待
   - 返回 `{"status":"authorized","token":"m0-xxx","key_name":"…"}` → 拿到密钥，进入第 4 步
   - 返回 `{"error":"授权请求已过期或不存在"}` → 重新发起
4. 用 `Read` 读取 `~/.zcode/cli/config.json`，用 `Edit` 把 `mcp.servers.aimemory` 写成字面量（保留原有字段；文件不存在用 `Write` 新建）：
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
5. 提示用户**重启 ZCode 或让 MCP 重连**，再运行 `/aimemory status` 验证连通。

## 方式二：带 request_id（重连/续期）

若已有未完成的 request_id（如上一步中断），运行 `/aimemory-connect <request_id>`，直接引导用户打开对应授权页 → 确认 → 轮询 → 写配置（跳过第 1 步）。

## 失败处理

- **授权页报「授权请求无效」**：请求已过期（10 分钟）或已被处理 → 重新运行命令发起新的设备流请求。
- **密钥名重名**：服务端自动加后缀（`zcode` → `zcode-2`），无需处理。
- **写配置时文件不存在**：用 `Write` 新建（内容就是上面的 JSON）。
- **已有失效密钥**：让用户在 Web 平台吊销旧密钥，再走一次本流程。

## 安全说明

- 设备流**不降级认证**：授权页仍是 Keycloak SSO 校验 + 本人显式「确认授权」；密钥由服务端生成、只经加密连接下发到本机。
- 密钥写进 `~/.zcode/cli/config.json` 后持久生效，不要提交进代码仓库；泄漏时去 Web 平台「吊销」立即失效。
- 内部市场机制仅在本插件使用，服务端对任意来源的请求同样鉴权校验。

$ARGUMENTS

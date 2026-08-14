# aimemory · ZCode 插件

让 agent 跨会话记住部署经验、踩坑记录、项目约定与个人偏好，基于公司内网的 [aimemory](../README.md) 记忆服务。

**安装后：MCP 工具自动注册（`add_memory` / `search_memories` / `get_memories` / `get_memory` / `update_memory` / `delete_memory`），配一次密钥即可使用。**

## 目录结构

```
plugin/
├── .zcode-plugin/plugin.json   # 插件清单（声明 userConfig：server_url / api_key）
├── .mcp.json                   # MCP 服务器声明（http 远程，url/headers 引用 user_config）
├── skills/aimemory/SKILL.md    # 记忆使用准则（教 agent 何时写/查/改/删）
├── commands/
│   ├── aimemory.md             # /aimemory 总览与记忆操作
│   └── aimemory-key.md         # /aimemory-key 首次配置密钥引导
└── README.md                   # 本文档
```

## 员工安装（三步）

1. **获取插件目录**：从公司分发渠道获取本 `plugin/` 目录（见下节"分发方式"）。
2. **添加为本地 marketplace**：ZCode → Settings → Plugin Management → Discover 页 →「+」→ 选择 **Add local folder** → 指向本 `plugin/` 目录 → 确认。
3. **安装并启用**：在插件列表找到 **aimemory** → 安装。

## 首次配置（密钥）

安装后 MCP 工具还不会工作，因为还没有你的个人密钥（每个员工一个，互相隔离）：

1. 运行命令 **`/aimemory-key`**（agent 会一步步引导）。
2. 浏览器打开 `http://<服务器>:18543` → 「通过登录平台登录」→ 用公司统一账号登录。
3. 「🔑 接入密钥」→ 命名（如 `zcode`）→ 生成 → **立即复制 `m0-xxx` 明文**（只显示一次）。
4. 回到 ZCode：Settings → Plugin Management → aimemory → 设置，把 `api_key` 填成刚复制的密钥；`server_url` 保持管理员给的地址。
5. 运行 **`/aimemory status`** 验证连通（能 `get_memories` 即成功）。

> 密钥只存在本机，只用于访问你自己的记忆；泄漏时去 Web 平台「吊销」立即失效。

## 使用

- 装好后**无需手动指挥**：agent 读到 SKILL 会自动在合适时机写/查记忆（部署经验、踩坑、项目约定、你的偏好）。
- 想手动操作：`/aimemory list`（列出）、`/aimemory search <关键词>`（检索）、`/aimemory add <内容>`（写入）。

## 分发方式（管理员）

本插件**没有独立仓库**，随 aimemory 主仓库一起走局域网 Git 分发：

- **局域网 Git 分发（推荐）**：员工 `git clone` / `git pull` 公司内网上的 aimemory 仓库，按上面三步把 `plugin/` 添加为本地 marketplace。后续更新插件 = 拉取主仓库（git pull）+ 重新指向目录。
- **将来做独立插件市场**：把整个 `plugin/` 目录抽成一个独立仓库作为 marketplace（GitHub 或内网 Git），员工改为添加远程 marketplace URL。`plugin.json` / `.mcp.json` / `skills` / `commands` 均为标准格式，**抽出即用，无需改造**。

## 配置项说明

| userConfig | 说明 | 默认 |
|---|---|---|
| `server_url` | 公司 aimemory 服务的 MCP 端点 | `http://192.168.161.73:18543/mcp`（部署时改） |
| `api_key` | 你的个人密钥（Web 平台生成） | 空，必填 |

> 注：api_key 以普通配置字段存储（ZCode 暂不支持持久化 sensitive 字段）。内网个人机器可接受；更严格的环境可用个人配置覆盖或按需吊销密钥。

## 安全

- 记忆按登录用户隔离（Keycloak 身份 + API Key 双重绑定），跨用户访问被服务端拒绝。
- 记忆库不存敏感明文：请遵循 SKILL 中的安全红线，不要把密码/密钥写进记忆内容。
- API Key 泄漏：Web 平台一键吊销，立即失效。

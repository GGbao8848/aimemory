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

## 员工安装（两步）

1. **添加 aimemory 仓库为 marketplace**：ZCode → Settings → Plugin Management → Discover →「+」→ 添加公司内网上的 aimemory 仓库（Git URL 或本地目录，根目录有 `marketplace.json`）→ 确认。若仓库不可用，也可 **Add local folder** 直接指向 `plugin/` 目录（兜底）。
2. **安装 aimemory 插件**：在插件列表找到 **aimemory** → 安装。

## 一键连接（设备流，零粘贴）

安装后运行 **`/aimemory-connect`**，按 agent 引导：

1. agent 发起设备流请求 → 给出**授权页地址**（自动弹出）。
2. 浏览器打开授权页：用公司统一账号登录（SSO，已登录免密）→ 显示本人身份 → 可选填密钥名称 → 点**「确认授权」**。
3. agent 自动轮询 → 拿到密钥 → **自动写入你的 ZCode 配置**，MCP 工具即连上。
4. 运行 **`/aimemory status`** 验证（能 `get_memories` 即成功）。

> **零粘贴**：全程无需复制任何 token / 连接码。标准认证不降级（SSO 校验 + 授权确认 + 密钥服务端生成），密钥写进 `~/.zcode/cli/config.json` 后持久生效。
> 内部市场插件走快速连接；外部/手动接入仍用「MCP 配置 JSON」标准方式（见下节）。

## 手动配置（外部接入 / 兜底）

`/aimemory-connect` 不可用（如平台版本过旧）时，用 `/aimemory-key` 走手动流程：登录 Web 平台 → 生成密钥 → 填入插件设置。详见该命令引导。

## 使用

- 装好后**无需手动指挥**：agent 读到 SKILL 会自动在合适时机写/查记忆（部署经验、踩坑、项目约定、你的偏好）。
- 想手动操作：`/aimemory list`（列出）、`/aimemory search <关键词>`（检索）、`/aimemory add <内容>`（写入）。

## 分发方式（管理员）

本插件随 aimemory 主仓库分发，仓库根目录的 **`marketplace.json`** 即市场入口：

- **一键安装（推荐）**：员工把 aimemory 仓库（公司内网 Git URL 或本地目录）添加为 marketplace → Discover 里点安装，即可安装/更新插件。
- **兼容旧方式**：Add local folder 指向 `plugin/` 目录仍可用（无需 marketplace.json）。
- **将来做独立插件市场**：把整个 `plugin/` 目录抽成独立仓库，复制一份 `marketplace.json` 放仓库根即可，**标准格式，抽出即用**。

## 配置项说明

| userConfig | 说明 | 默认 |
|---|---|---|
| `server_url` | 公司 aimemory 服务的 MCP 端点 | `http://192.168.161.73:18543/mcp`（部署时改） |
| `api_key` | 手动模式填的密钥（一键连接模式自动写入配置，无需填） | 空 |

> 一键连接会把密钥写入 `~/.zcode/cli/config.json` 的 `mcp.servers.aimemory`（与 mem0 配置同款写法），持久生效。手动模式需在插件设置里填 `api_key`。

## 安全

- 记忆按登录用户隔离（Keycloak 身份 + API Key 双重绑定），跨用户访问被服务端拒绝。
- 记忆库不存敏感明文：请遵循 SKILL 中的安全红线，不要把密码/密钥写进记忆内容。
- API Key 泄漏：Web 平台一键吊销，立即失效。

# aimemory —— 企业级 AI 记忆库（MCP 服务）

> 自托管、mem0 兼容的 **AI 记忆服务**：供全公司的 agent（Claude Code、Codex、自研 agent…）通过 **MCP（Streamable HTTP）** 读写记忆。
> 登录走公司统一 **Keycloak**，多租户**完整用户隔离**；Web 平台可自助管理记忆、生成接入密钥。

## 特性

- **mem0 兼容的 MCP 工具集**：`add_memory` / `search_memories` / `get_memories` / `get_memory` / `update_memory` / `delete_memory` + `create_api_key` / `list_api_keys` / `revoke_api_key`
- **内网单端口 18543**：`/mcp`（MCP 端点）+ `/api/*`（REST）+ `/`（Web 管理平台）
- **多租户隔离**：所有数据按用户隔离，跨用户访问直接拒绝（MCP 与 REST 均验证）
- **关键词全文检索**（SQLite FTS5 trigram）：支持中文子串，零外部依赖、完全离线
- **记忆历史**：每次修改/删除保留旧值快照，可追溯时间线
- **密钥管理**：Web 平台生成 `m0-xxx` 密钥（仅存 sha256 哈希），一键复制 MCP 配置 JSON
- **pm2 部署**：单进程即可服务全公司

## 架构

```
┌─ MCP 客户端（Claude Code / Codex / …）─┐
│  POST http://<内网IP>:18543/mcp         │  Authorization: Token m0-xxx
└───────────┬────────────────────────────┘
            ▼
┌──────────── HTTP Server :18543 (Express) ────────────┐
│  /mcp      MCP Streamable HTTP（工具调用）            │
│  /api/*    REST（Bearer Token 或 Web 会话 cookie）     │
│  /         管理 Web 页面（Keycloak 授权码+PKCE 登录）   │
│  /auth/*   Keycloak 登录 / 回调 / 登出                 │
└────────────┬─────────────────────────────────────────┘
             ▼
┌─ auth/ ──────────────────────┐   ┌─ db/ ────────────────────┐
│ keycloak.js  OIDC+JWKS 验签   │   │ SQLite: memories          │
│ tokens.js    API key 签发校验 │   │ memories_fts (FTS5)       │
└──────────────────────────────┘   │ memories_history / keys   │
                                   └───────────────────────────┘
```

## 快速开始（本机部署）

前置：本机已运行 Keycloak（见 [mykeycloak](../mykeycloak) 项目，业务口 `18443`）、Node.js 20+。

```bash
# 1. 安装依赖
npm install

# 2. 配置 .env（参考 .env.example；KEYCLOAK_ADMIN_* 会自动读 mykeycloak/.env）
cp .env.example .env

# 3. 初始化 Keycloak（幂等：创建 realm=aimemory、client=aimemory-web、测试用户 alice/bob/charlie）
npm run setup-keycloak

# 4. 启动
npm start
```

验证：

```bash
curl http://localhost:18543/            # Web 平台
curl http://localhost:18443/health/ready  # Keycloak 健康
```

### pm2 上线

```bash
npm install -g pm2
pm2 start ecosystem.config.js && pm2 save && pm2 startup
pm2 logs aimemory-mcp
pm2 restart aimemory-mcp        # 更新代码后重启
```

## 员工接入指南（给同事的模板）

1. 浏览器打开 `http://<服务器内网IP>:18543` → 「通过登录平台登录」（公司统一账号）
2. 生成一个**接入密钥**（如命名 `claude-code`），复制显示的 `m0-xxx` 明文
3. 在 agent 的 MCP 客户端配置中加入以下 JSON（url 的 IP 换成服务器内网 IP）：

```json
{
  "mcpServers": {
    "aimemory": {
      "type": "http",
      "url": "http://192.168.161.73:18543/mcp",
      "headers": {
        "Authorization": "Token m0-你的密钥"
      }
    }
  }
}
```

> 在 Web 平台生成密钥后，页面会**自动生成带真实 Token 的完整 JSON**，一键复制即可。

4. 之后 agent 就能调用记忆工具：写 `add_memory`、查 `search_memories`、管 `get_memories` 等。
   每个员工的数据**互相隔离**，密钥吊销后立即失效。

## MCP 工具一览

| 工具 | 说明 |
|---|---|
| `add_memory` | 写入一条记忆（text + metadata） |
| `search_memories` | 关键词全文检索（支持中文子串，查询建议 ≥3 字符） |
| `get_memories` | 分页列出自己的记忆 |
| `get_memory` | 按 id 获取单条（含修改历史时间线） |
| `update_memory` | 更新 text / metadata（旧值进历史） |
| `delete_memory` | 删除（旧值进历史） |
| `create_api_key` / `list_api_keys` / `revoke_api_key` | 密钥管理 |

> 参数与 mem0 官方 MCP 同构（`user_id` / `filters` / `page_size` / `limit` 等）。
> `infer` / `rerank` / `threshold` 为兼容保留：本实例为关键词检索，无 LLM 抽取/向量排序。

## 测试用户（隔离验证）

`npm run setup-keycloak` 会创建（可改 `.env` 的 `TEST_USERS`）：

| 用户 | 密码 |
|---|---|
| alice | `aimemory-test-2026` |
| bob | `aimemory-test-2026` |
| charlie | `aimemory-test-2026` |

建议验证：alice 写入记忆 → 用 bob 的密钥查 `get_memories` 应为空；用 alice 的记忆 id 直接读应被拒。

## REST API 摘要

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/memories` | 新增记忆 `{text, metadata?}` |
| GET | `/api/memories?page=&page_size=&q=` | 列表 / 搜索 |
| GET/PATCH/DELETE | `/api/memories/:id` | 单条 / 更新 / 删除 |
| POST/GET | `/api/keys`、`/api/keys/:id/revoke` | 密钥管理 |
| GET | `/api/me` | 当前身份 |

鉴权：`Authorization: Token m0-xxx` 或 Web 会话 cookie。

## 配置项（.env）

| 变量 | 说明 |
|---|---|
| `PORT` | 服务端口（默认 18543，单端口提供 MCP+REST+Web） |
| `PUBLIC_BASE_URL` | 对外地址（用于生成 MCP JSON 的 url；留空则用请求来源） |
| `KEYCLOAK_URL` / `KEYCLOAK_REALM` / `KEYCLOAK_CLIENT_ID` | Keycloak 对接 |
| `KEYCLOAK_ADMIN_USER` / `KEYCLOAK_ADMIN_PASSWORD` | 初始化脚本用（可读 mykeycloak/.env） |
| `TEST_USERS` / `TEST_USERS_PASSWORD` | 测试用户 |
| `SESSION_SECRET` | Web 会话签名密钥（首次启动自动生成） |

## 数据与安全

- 数据目录 `data/aimemory.db`（SQLite WAL）；备份：停服后复制 db 文件即可
- API Key 只存 sha256 哈希，明文仅生成时展示一次
- JWT 离线验签（JWKS 缓存），校验 `iss` / `aud` / `exp`
- 所有查询强制 `WHERE user_id=?`，存储层兜底隔离

## Roadmap（后续扩展）

- [ ] 向量语义检索 + LLM 事实抽取（schema 已预留 `infer` / `rerank` / `threshold`）
- [ ] 管理员视图 / 审计日志
- [ ] HTTPS / 域名接入

## 参考

- 产品构想：本仓库旧版 `README.md` 已归档为本文档前身（多租户设计见 mykeycloak 项目 docs）

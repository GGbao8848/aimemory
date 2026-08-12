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
#    迁移到其他公司/服务器时：只改 KEYCLOAK_URL 即可对接任意 Keycloak，详见下文「对接其他主机的 Keycloak」
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

## 对接其他主机的 Keycloak（迁移部署）

本项目**不绑定特定的 Keycloak 部署**。当前开发机默认读 `../mykeycloak/.env` 的管理员凭据（仅为开发便利）；**迁移到其他公司/服务器时，只需改 `.env` 配置，即可对接任意主机、任意端口的 Keycloak**——甚至对方用 HTTPS/域名也直接支持。

### 关键认知：服务运行期不需要管理员权限

服务运行（MCP / REST / Web 登录）只依赖下面 3 个配置，通过 Keycloak 的 **OIDC 发现端点**自动获取公钥（JWKS）、登录/换 token 端点，全程无需任何管理员凭据：

| 配置 | 说明 | 迁移示例 |
|---|---|---|
| `KEYCLOAK_URL` | 对方 Keycloak 业务地址（含端口/协议） | `http://10.20.30.40:8080` 或 `https://sso.company.com` |
| `KEYCLOAK_REALM` | 业务 realm | 可沿用 `aimemory`，也可用对方已有 realm |
| `KEYCLOAK_CLIENT_ID` | 应用 client | 可沿用 `aimemory-web` |

> JWT 验签**自动适配**：服务从 `{KEYCLOAK_URL}/realms/{REALM}/.well-known/openid-configuration` 实时拉取 JWKS，**无需手动配置任何公钥**。

### 迁移步骤（新机器）

```bash
# 1. 拷贝整个项目（务必包含 data/ 目录——那是全部记忆数据）
#    示例: rsync -av aimemory/ user@new-server:/opt/aimemory/

# 2. 配置 .env：把 KEYCLOAK_URL 改成对方 Keycloak 地址
cp .env.example .env
#    编辑 .env:
#      KEYCLOAK_URL=http://<对方Keycloak>:<端口>
#      PUBLIC_BASE_URL=http://<新机器内网IP>:18543   # 可选：固定管理页生成的 MCP JSON 地址

# 3. 安装依赖并初始化 Keycloak（幂等）
npm install
npm run setup-keycloak
```

`setup-keycloak` 按两种对接方式工作（幂等，可重复执行）：

- **方式 A · 给管理员凭据（自动创建）**：把对方 master realm 的管理员账号密码填入 `.env` 的 `KEYCLOAK_ADMIN_USER` / `KEYCLOAK_ADMIN_PASSWORD`，脚本会在对方 Keycloak 上自动创建 realm、client、测试用户，并**自动把新机器的 `IP:端口` 注册进 client 的回调地址**。
- **方式 B · 对方已备好 realm/client（无管理员权限）**：让对方在管理台手动创建：
  - realm（或复用已有 realm）+ client（`public` 类型、开启 PKCE / S256）
  - client 的 **Valid redirect URIs** 必须包含：
    - `http://<新机器IP>:18543/auth/callback`（授权回调）
    - `http://<新机器IP>:18543/`（登出回跳）
  - 脚本检测到 realm/client 已存在会自动跳过创建，仅补齐回调地址

```bash
# 4. pm2 启动
npm install -g pm2
pm2 start ecosystem.config.js && pm2 save
```

### 常见问题

| 现象 | 原因与解决 |
|---|---|
| 登录跳回后报「Invalid redirect uri」 | client 的 Valid redirect URIs 没有新机器的 host:端口 → 按方式 B 手动补上，或重跑 `setup-keycloak` |
| `setup-keycloak` 提示「正在对接非本机 Keycloak」 | 脚本检测到非 localhost 地址，属正常提示；确认网络连通与凭据来源后继续即可 |
| 员工复制出来的 JSON url 还是旧机器 IP | `.env` 设 `PUBLIC_BASE_URL=http://<新机器IP>:18543`，或在管理页直接用浏览器地址访问后重新复制 |
| 对方 Keycloak 是 HTTPS/域名 | `KEYCLOAK_URL` 直接填 `https://...` 即可，OIDC 流程与验签自动走标准协议 |

## 数据与安全

- 数据目录 `data/aimemory.db`（SQLite WAL）；备份：停服后复制 db 文件即可
- API Key 只存 sha256 哈希，明文仅生成时展示一次
- JWT 离线验签（JWKS 缓存），校验 `iss` / `aud` / `exp`
- 所有查询强制 `WHERE user_id=?`，存储层兜底隔离

## 工具字段与扩展指南（Roadmap）

### 一、为什么保留完整字段

工具 schema 与 **mem0 官方 MCP 完全同构**，其中 `infer` / `rerank` / `threshold` 等参数已为 LLM 能力预留，当前按关键词存储**忽略它们**（见 `src/mcp/tools.js` 中的"兼容保留"注释）。这样做的价值：

- **下游零改动**：agent 端早已按 mem0 的完整参数写调用，将来服务端升级能力时客户端无需任何变更
- **平滑升级**：扩展全部为增量，不破坏现有调用

### 二、当前保留字段一览

| 字段 | 所在工具 | 当前行为 | 保留用途 |
|---|---|---|---|
| `infer` | add_memory | 忽略（原文直接入库） | 接入 LLM 后：从文本自动抽取结构化事实/实体 |
| `threshold` | search_memories | 忽略 | 接入向量后：相似度阈值过滤低置信结果 |
| `rerank` | search_memories | 忽略 | 接入向量后：结果重排序（语义优先） |
| `filters` | search_memories / get_memories | 仅支持 `user_id`（已强制隔离） | 扩展为 metadata 键值 / 时间范围 / 命名空间过滤 |
| `user_id` | 所有工具 | 已完整实现：只能等于当前身份，跨租户拒绝 | 多租户隔离底座，无需再扩展 |

### 三、扩展路线图（按重要程度）

#### P0 —— 核心竞争力（建议优先，做完才是"AI 记忆库"而非"普通 CRUD"）

**1. 向量语义检索（embedding 召回）**
- 扩展内容：接入 embedding（OpenAI 兼容 API 或本地模型），记忆增加向量列，`search_memories` 升级为"向量语义 + 关键词混合召回"
- **扩展前**：搜"怎么连数据库"查不到"用 psql 连接 PostgreSQL"这类**语义相近但无共同词**的记忆
- **扩展后**：语义相近即可命中，中文同义/口语化表达有效
- 依赖：外部 LLM 的 base_url + key（本机无 ollama，需配置），或后续部署本地 embedding
- 影响：纯增量；`threshold` / `rerank` 参数位已就绪

**2. LLM 事实抽取（`infer` 生效）**
- 扩展内容：`add_memory` 时把自由文本交给 LLM，抽取事实/实体/关系结构化入库，支持记忆合并去重
- **扩展前**：存的是原始句子，检索靠关键词命中
- **扩展后**：agent 问"上次部署踩了什么坑"能精准召回被抽取过的事实（如"端口冲突"）；记忆可跨上下文复用
- 影响：`add_memory` 多一次 LLM 调用（建议异步化）；`infer=false` 保持原样

#### P1 —— 体验增强

**3. `rerank` 重排序生效**
- **扩展前**：命中按 bm25 相关性排序，语义接近但关键词弱的排在后面
- **扩展后**：向量召回后用 LLM/交叉编码器重排，"真正相关的"提到最前（跟随 P0 的 embedding 一起做）

**4. `threshold` 相似度阈值生效**
- **扩展前**：参数被忽略，无法控制"多像才算命中"
- **扩展后**：调用方可设阈值过滤低置信结果，减少噪音

**5. `filters` 多维过滤**
- **扩展前**：仅 `user_id`
- **扩展后**：支持 `metadata` 键值过滤（如 `{"source":"claude-code"}`）、时间范围（`created_at` 之后）、命名空间
- 影响：纯增量

**6. 遗忘与记忆衰减（TTL / 主动 forget）**
- 扩展内容：记忆带优先级/衰减曲线，低频旧记忆自动降级归档，检索默认召回"活跃"记忆
- **扩展前**：所有记忆平权，旧记忆可能淹没新记忆
- **扩展后**：近期高频使用的记忆优先（类似人脑遗忘曲线）
- 影响：需新增存储字段，向后兼容

#### P2 —— 企业治理与高级能力

**7. 时序知识图（实体随时间演变）**
- **扩展前**：单条记忆扁平存储，事实更新靠 `update_memory` 手工改
- **扩展后**：能回答"这个配置什么时候改过、演变过程"——事实级时间线成为一等公民
- 工作量最大，建议 P0/P1 跑稳后做

**8. 审计日志 / 管理员视图**
- **扩展前**：无管理员概念（当前为用户自助精简版）
- **扩展后**：管理员跨租户查看/导出/审计，配合"被遗忘权"

**9. 文件附件**
- **扩展前**：`metadata` 只能存任意 JSON 引用，附件本体需独立 blob 存储 + 下载接口

### 四、扩展前后效果对比

| 能力 | 当前（关键词版） | 扩展后（LLM 版） | 重要程度 |
|---|---|---|---|
| 检索 | 仅字面/子串命中 | 语义命中（同义、口语化） | **P0** |
| 写入 | 原样存文本 | 自动抽事实/实体、可合并去重 | **P0** |
| 排序 | bm25 相关性 | 语义重排 | P1 |
| 过滤 | 仅用户 | metadata / 时间 / 命名空间 | P1 |
| 生命周期 | 永不过期 | 遗忘曲线 / TTL | P1 |
| 时间线 | 单条修改历史 | 事实级时序图 | P2 |
| 治理 | 用户自助 | 审计 / 管理员 | P2 |

### 五、扩展的通用原则

1. **schema 已全部预留** → 所有扩展向后兼容，现有 agent 零改动
2. **先做 P0 两项**（embedding 检索 + infer 抽取），它们是"AI 记忆库"区别于"普通 CRUD"的关键，也是 mem0 的核心卖点
3. 实现方式：加一层外部 LLM 适配（OpenAI 兼容），存储层保持不变；本机无 ollama，接 DeepSeek/通义等任意 OpenAI 兼容 API 即可
4. 每一档扩展都建议单独验证（如新增 `search_memories` 语义召回对比用例）后再并入主线

## 参考

- 产品构想：本仓库旧版 `README.md` 已归档为本文档前身（多租户设计见 mykeycloak 项目 docs）

# aimemory —— 企业级 AI 记忆库（MCP 服务）

> 自托管、mem0 兼容的 **AI 记忆服务**：供全公司的 agent（Claude Code、Codex、自研 agent…）通过 **MCP（Streamable HTTP）** 读写记忆。
> 登录走公司统一 **Keycloak**，多租户**完整用户隔离**；Web 平台可自助管理记忆、生成接入密钥。

## 特性

- **mem0 兼容的 MCP 工具集**：`add_memory` / `search_memories` / `get_memories` / `get_memory` / `update_memory` / `delete_memory` + `create_api_key` / `list_api_keys` / `revoke_api_key`
- **内网单端口 18543**：`/mcp`（MCP 端点）+ `/api/*`（REST）+ `/`（Web 管理平台）
- **多租户隔离**：所有数据按用户隔离，跨用户访问直接拒绝（MCP 与 REST 均验证）
- **语义 + 关键词混合检索**：embedding 向量召回（同义/口语化可命中）+ SQLite FTS5 trigram 关键词召回（中文子串）；embedding 不可用时自动回退纯关键词，完全离线可用
- **自动去重（auto-merge）**：写入时与已有记忆做语义相似度检测，高度重复自动跳过（≥0.92），防止记忆库变脏
- **实体抽取与链接**：LLM 自动抽取实体（公司/人名/IP/端口等）存 `entities`，检索时实体命中加权排前（对标 mem0 entity linking）
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
                                   └──────────┬────────────────┘
                                              ▼
                          ┌─ embeddings/client.js ─────────┐
                          │ OpenAI 兼容 /v1/embeddings     │
                          │ （向量化 + 降级回退）           │
                          └───────────────────────────────┘
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

> ⚠ 本机实际部署（复用现有 Keycloak / br-platform realm）：
> 本机 Keycloak 业务端口为 **6543**（BR-Agent 等 agent 项目同用），复用其 `br-platform` realm 的现有用户（admin/br0001~br0004…），**不新建测试用户**（`.env` 里 `TEST_USERS=` 留空即跳过）。`setup-keycloak` 只新建 client `aimemory-web`（含本机 IP:18543 回调）。
> **`KEYCLOAK_URL` 必须与 BR-Agent 用同一 host**（SSO 会话 cookie 按 host 域存储，不同域会单点登录失效）；本机 IP 变更后需同步更新 `.env`（当前为 `http://10.2.28.65:6543`）。详见 `.env` 注释与 [docs/pm2-deploy.md](docs/pm2-deploy.md) 第 10 节。

### pm2 上线

完整部署指南（安装 → 启动 → 验证 → 开机自启 → 日常运维 → 更新 → 扩容 → 排查）见 **[docs/pm2-deploy.md](docs/pm2-deploy.md)**。快速上手：

```bash
npm install -g pm2
pm2 start ecosystem.config.js && pm2 save
pm2 logs aimemory-mcp
pm2 restart aimemory-mcp        # 更新代码后重启
```

> Windows 上 `pm2 startup` 不生效，开机自启用计划任务执行 `pm2 resurrect`，详见部署文档第 6 节。

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
| `add_memory` | 写入记忆：`text` 单条 或 `messages` 多轮对话（LLM 自动提炼成**多条**独立记忆）；支持 `agent_id`/`run_id` 归属；`infer` 默认异步提炼事实存 `facts` |
| `import_memories` | **批量导入**：`groups` 多段对话一次提炼成多条记忆（历史会话/聊天记录批量沉淀，auto-merge 自动去重） |
| `search_memories` | 语义 + 关键词 + 实体混合检索（支持 `rerank=true` LLM 重排；支持按 agent/run 过滤） |
| `get_memories` | 分页列出自己的记忆（支持按 agent/run 过滤） |
| `get_memory` | 按 id 获取单条（含修改历史时间线） |
| `update_memory` | 更新 text / metadata（旧值进历史） |
| `delete_memory` | 删除（旧值进历史） |
| `delete_all_memories` | 清空当前用户的全部记忆（用户与密钥保留） |
| `list_entities` | 列出有记忆的用户实体（记忆数 + 最后活跃时间） |
| `delete_entities` | 删除用户及其全部记忆、密钥、会话（不可恢复） |
| `create_api_key` / `list_api_keys` / `revoke_api_key` | 密钥管理 |

> 参数与 mem0 官方 MCP 同构（`user_id` / `agent_id` / `run_id` / `messages` / `filters` / `page_size` / `limit` 等）。
> `messages` 已生效：多轮对话自动提炼成记忆（mem0 核心模式）。
> `agent_id`/`run_id` 已生效：记忆按 agent/run 隔离，搜索/列出可过滤。
> `threshold` 已生效：过滤低于相似度阈值的向量召回结果（0~1，默认 0 不过滤）。
> `infer` 已生效：`add_memory` 默认异步 LLM 提炼事实存 `facts`（增强语义召回，失败降级原样入库）。
> `rerank` 已生效：`search_memories` 传 `rerank=true` 时用 LLM 按查询相关性重排（更精准，略增延迟；LLM 不可用自动回退）。

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
| `EMBEDDING_ENABLED` | 置 `1` 启用语义检索；`0` 或未配置时纯关键词（可选） |
| `EMBEDDING_BASE_URL` / `EMBEDDING_MODEL` / `EMBEDDING_API_KEY` | OpenAI 兼容 embeddings 服务（vLLM 等） |
| `EMBEDDING_TIMEOUT_MS` | 单次 embedding 调用超时（默认 15000） |
| `LLM_ENABLED` | 置 `1` 启用 infer 事实抽取；`0` 关闭（可选） |
| `LLM_BASE_URL` / `LLM_MODEL` / `LLM_API_KEY` | OpenAI 兼容 chat/completions 服务（infer 用） |
| `LLM_TIMEOUT_MS` | 单次 LLM 调用超时（默认 30000） |

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

4. pm2 启动（详见 [docs/pm2-deploy.md](docs/pm2-deploy.md)）：`npm install -g pm2 && pm2 start ecosystem.config.js && pm2 save`

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

## 为什么暂不换 PostgreSQL

**当前阶段 SQLite 是最优解，不建议为换而换。**

| 维度 | SQLite（现状） | 300~800 人场景实测 |
|---|---|---|
| 并发吞吐 | 读 1400+ QPS / 写 ~1000 QPS | 800 并发混合操作 827 QPS、0 错误 |
| 写瓶颈 | WAL 单写者串行 | 300 人 p99 387ms；800 人 p95 2.5s（可双实例缓解） |
| 数据量 | 单文件，几十 GB 内无压力 | 800 人 × 数百条记忆 = 数十万级，远未到极限 |
| 运维 | 零依赖，拷 `data/` 即迁移 | 迁移指南已利用该特性 |

**换 PG 的真实诱因（出现其一再评估）**：

1. 写并发持续 >1000 TPS 或日志出现 `SQLITE_BUSY`
2. 需要多实例/主从高可用（SQLite 无法跨机器共享库文件）
3. 数据量上数百 GB ~ TB
4. 做向量语义检索想一体化（pgvector）——这是最可能的真实诱因，届时随 P0 扩展一起迁更划算
5. 公司运维强制标准化 PG

**迁移成本提示**：`db/repo.js` 需全部重写（SQL 方言差异）、FTS5 trigram 需换成 `pg_trgm`（中文分词 PG 反而更弱）、数据迁移脚本 + 全量回归。收益在未到极限前为零，**目前分层已预留可换性**（数据访问集中在 repo.js，MCP/REST/auth 接口层不受影响）。

## 容量与压测（实测数据）

> 以下为本机实测（Apple Silicon 类配置，Node 24，pm2 单实例）。真实业务（agent 每分钟几十次调用）远低于此量级。

### 各规模实测结果（0 错误）

| 规模 | 场景 | QPS | p50 | p95 | 结论 |
|---|---|---|---|---|---|
| 300 人 | 300 并发混合操作（读:写=5:1） | 773 | 65ms | 968ms | ✅ 充裕 |
| 300 人 | 300 个 MCP 会话常驻（模拟 agent 连接） | 303 | 753ms | 936ms | ✅ 内存 ~0.27MB/会话 |
| **800 人** | **800 并发混合操作（读:写=5:1）** | **827** | 193ms | **2563ms** | ⚠️ 可用但尾延迟偏高 |
| **800 人** | **800 个 MCP 会话常驻** | **265** | 2241ms | 2800ms | ⚠️ 单实例握手排队 |
| 800 人 ×2 实例 | 800 并发混合操作 | 883 | 483ms | 1849ms | 锁竞争转移，改善有限 |
| 800 人 ×2 实例 | 800 个 MCP 会话常驻 | **431** | 1547ms | 1728ms | ✅ 会话/握手延迟减半 |

内存：基线 ~46MB；800 会话峰值 ~200MB（单实例）/ ~366MB（双实例）。

### 结论与操作建议

1. **≤300 人：单实例 SQLite 完全够用**，无需任何改动
2. **800 人（或大量 agent 常驻连接）**：能满足且 0 错误，但**建议双实例**——实测多实例对"并发会话/握手"这类 CPU 瓶颈改善显著（MCP 会话 QPS +63%、延迟减半）；对"读写争用"改善有限（锁在 SQLite 层，多进程缓解不了单库写瓶颈，属预期）
3. 扩实例命令：`pm2 scale aimemory-mcp 2`（WAL 支持多进程共享同一库文件，无需改任何代码），详见 [docs/pm2-deploy.md](docs/pm2-deploy.md) 第 9 节
4. **真正的写瓶颈信号**：日志出现 `SQLITE_BUSY` 或写 QPS 持续 >1000 → 才需要考虑 PG 或分库（详见上节"为什么暂不换 PostgreSQL"）

## 工具字段与扩展指南（Roadmap）

### 一、为什么保留完整字段

工具 schema 与 **mem0 官方 MCP 完全同构**，其中 `infer` / `rerank` / `threshold` 等参数为 LLM 能力预留。当前 `threshold` / `infer` / `rerank` 均已生效（随 embedding / LLM 上线）。这样做的价值：

- **下游零改动**：agent 端早已按 mem0 的完整参数写调用，将来服务端升级能力时客户端无需任何变更
- **平滑升级**：扩展全部为增量，不破坏现有调用

### 二、当前保留字段一览

| 字段 | 所在工具 | 当前行为 | 保留用途 |
|---|---|---|---|
| `infer` | add_memory | **已生效**：默认异步 LLM 提炼事实存 `facts`（失败降级原样入库） | 随 P0-2 LLM 上线已完成 |
| `messages` | add_memory | **已生效**：多轮对话自动提炼成记忆（mem0 核心模式） | 随 messages 批量上线已完成 |
| `agent_id`/`run_id` | add_memory / search_memories / get_memories | **已生效**：记忆按 agent/run 隔离，可过滤 | 多作用域已完成 |
| `threshold` | search_memories | **已生效**：过滤低于相似度阈值的向量召回 | 随 embedding 上线已完成 |
| `rerank` | search_memories | **已生效**：`rerank=true` 时 LLM 按查询相关性重排 | 随 LLM 上线已完成（缓解短查询排序噪声） |
| `filters` | search_memories / get_memories | 支持 `user_id` / `agent_id` / `run_id` | 扩展为 metadata 键值 / 时间范围过滤 |
| `user_id` | 所有工具 | 已完整实现：只能等于当前身份，跨租户拒绝 | 多租户隔离底座，无需再扩展 |

### 三、扩展路线图（按重要程度）

#### P0 —— 核心竞争力（建议优先，做完才是"AI 记忆库"而非"普通 CRUD"）

**1. 向量语义检索（embedding 召回）✅ 已完成**
- 接入 OpenAI 兼容 embedding 服务（vLLM `/v1/embeddings`），记忆表增加向量列，`search_memories` 升级为「向量语义 + 关键词混合召回」
- 降级：embedding 服务不可用/失败时自动回退纯关键词，不影响现有调用；`EMBEDDING_ENABLED=0` 可关闭
- 相关实现：`src/embeddings/client.js`、`src/db/repo.js`（`getVecCandidates` / `cosineSimilarity`）、`memories.embedding` 列

**升级前后实测对比**（同一批记忆、同一组查询，`limit=3`）：

| 查询 | 之前（纯关键词） | 现在（语义 + 关键词） |
|---|---|---|
| 「怎么连数据库」 | 无结果 | 「用 psql 命令连接 PostgreSQL 数据库进行数据查询」（0.65） |
| 「前端怎么做界面」 | 无结果 | 「前端页面用 React 组件构建交互界面」（0.77） |
| 「几点上班」 | 无结果 | 「每天 9 点打卡，考勤异常要手动补报工时」（0.77） |
| 「公司在哪」 | 无结果 | 「公司地址是南京市鼓楼区中山北路 100 号」（0.61） |
| 「上次部署踩了什么坑」 | 无结果 | 「部署踩过的坑：pm2 环境变量读不到 .env…」（0.65） |

> 原理：查询与记忆都转成向量做余弦相似度，语义相近即可命中，不再要求查询与记忆出现相同字词；关键词路径作为兜底仍保留（如搜「BIP」）。

**2. LLM 事实抽取（`infer` 生效）✅ 已完成**
- `add_memory` 时把自由文本交给 LLM，提炼成结构化事实存 `memories.facts`；向量对「原文 + facts」生成，事实参与语义召回
- **效果**：agent 问"用的是什么服务器系统"能命中原本只说"部署服务器是 Windows Server 2022"的记忆
- **降级**：LLM 不可用/失败时静默，原样入库；`infer=false` 保持原样不抽取
- 相关实现：`src/llm/client.js`、`syncFacts` / `semanticText`（`src/db/repo.js`）、`memories.facts` 列
- 依赖：`LLM_ENABLED=1` + OpenAI 兼容 chat/completions（`10.10.10.146:8001`，`qwen3.8-27b`）

#### P1 —— 体验增强

**3. `rerank` 重排序 ✅ 已生效**
- **扩展前**：命中按 bm25 相关性排序，语义接近但关键词弱的排在后面
- **扩展后**：`search_memories` 传 `rerank=true` 时用 LLM 按查询相关性重排，"真正相关的"提到最前（缓解短查询排序噪声；LLM 不可用自动回退）

**4. `threshold` 相似度阈值 ✅ 已生效**
- **扩展前**：参数被忽略，无法控制"多像才算命中"
- **扩展后**：调用方可设阈值过滤低置信结果，减少噪音（随 P0-1 embedding 一起上线）

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

## 开发提示

- **推 GitHub 需走代理**（本机未配置全局 git 代理时）：`git -c http.proxy=http://127.0.0.1:7890 push origin main`（单次生效，不改全局配置）

## 参考

- 下一阶段计划：见 **[docs/下一阶段计划.md](docs/下一阶段计划.md)**（阶段 0 运营收尾 → P0 AI 化 → P1/P2）
- 产品构想：本仓库旧版 `README.md` 已归档为本文档前身（多租户设计见 mykeycloak 项目 docs）

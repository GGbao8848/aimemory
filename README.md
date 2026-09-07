# aimemory —— 企业级 AI 记忆库（MCP 服务）

> 自托管、mem0 兼容的 **AI 记忆服务**：供全公司的 agent（Claude Code、Codex、自研 agent…）通过 **MCP（Streamable HTTP）** 读写记忆。
> 登录走公司统一 **Keycloak**，按**员工**完整隔离（一个员工一个记忆账本，多 agent 共享）；Web 平台可自助管理记忆、生成接入密钥。

## 特性

- **mem0 核心 MCP 工具集（7 个，少即是多）**：`add_memory` / `get_event_status` / `search_memories` / `get_memories` / `get_memory` / `update_memory` / `delete_memory`——刻意不提供批量导入、整库/实体管理、agent/run 维度
- **素材提炼型写入**：`add_memory` 的输入一律视为"素材"（text/messages），**不直接落库**——后台内部 LLM 提炼成多条结构化记忆后入库；异步受理 + 队列串行，本地 LLM 低并发不阻塞调用；提炼失败不落库（不存原文）
- **内网单端口 18543**：`/mcp`（MCP 端点）+ `/api/*`（REST）+ `/`（Web 管理平台）+ `/healthz`（健康检查）
- **多租户隔离**：数据按员工隔离，跨用户访问直接拒绝（MCP 与 REST 均验证）
- **语义 + 关键词混合检索**：embedding 向量召回（同义/口语化可命中）+ SQLite FTS5 trigram 关键词召回（中文子串）；embedding 不可用时自动回退纯关键词，完全离线可用
- **LLM 提炼与实体抽取**：`messages` 写入后台队列异步提炼成结构化记忆（服务端轮询处理，低并发 LLM 环境下不阻塞 MCP 调用）；facts/entities 异步抽取存库并参与语义召回（对标 mem0 核心）
- **接入密钥**：Web 平台生成 `m0-xxx` 密钥（仅存 sha256 哈希）+ 设备流浏览器免粘贴授权，一键复制 MCP 配置 JSON
- **半熔断容错**：LLM/embedding 服务抖动自动熔断降级、恢复自动探测回补，无需重启
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
│  /healthz  健康检查（DB / embedding / LLM / Keycloak） │
└────────────┬─────────────────────────────────────────┘
             ▼
┌─ auth/ ──────────────────────┐   ┌─ db/ ────────────────────┐
│ keycloak.js  OIDC+JWKS 验签   │   │ SQLite: memories          │
│ tokens.js    API key 签发校验 │   │ memories_fts (FTS5)       │
└──────────────────────────────┘   │ api_keys / sessions       │
                                   │ connect_requests(设备流)   │
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

> 暴露 **7 个工具**（mem0 最小核心面：写入 / 状态查询 / 检索 / 列表 / CRUD）。刻意不提供批量导入、整库/实体管理、agent/run 维度——员工记忆是一个账本，日常沉淀用 `add_memory` 即可。

| 工具 | 说明 |
|---|---|
| `add_memory` | 提交记忆**素材**（`text` 单条 / `messages` 多轮对话）：一律**异步受理**返回 `event_id`，后台由 aimemory 内部 LLM 提炼成多条自包含记忆后入库——**库内只存提炼产物，不存原文** |
| `get_event_status` | 查询异步提炼任务状态（pending/processing/done/failed；done 含提炼结果，failed 含原因） |
| `search_memories` | 语义（向量）+ 关键词（FTS）+ 实体混合检索；支持 `threshold`、`filters`（metadata/时间） |
| `get_memories` | 分页列出当前员工的记忆 |
| `get_memory` | 按 id 获取单条 |
| `update_memory` | 更新 text / metadata（文本变化自动重抽 facts 并补向量） |
| `delete_memory` | 按 id 删除 |

> **API Key 管理不暴露为 MCP 工具**——由 Web 平台 REST 端点（`POST/GET /api/keys`、`POST /api/keys/:id/revoke`）与设备流接入提供。

> 参数保留 mem0 同构子集：`user_id`（只能等于当前身份）/ `text` / `messages` / `metadata` / `filters` / `page_size` / `limit` / `threshold`。
> **写入语义**：`text` / `messages` 都是"素材"——异步受理后由内部 LLM 提炼成结构化记忆入库（不存原文）；提炼失败/无有效产出 → 事件 failed，素材不落库（调用方可见错误后重试）。LLM 未启用时写入直接拒绝。
> facts/entities：写入产物本身即结构化记忆（无需再抽 facts）；仅 `update_memory` 手动编辑文本后异步重抽 facts 供语义召回（失败静默，不影响保存）。

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
| `LLM_BASE_URL` / `LLM_MODEL` / `LLM_API_KEY` | OpenAI 兼容 chat/completions 服务（提炼/infer 用） |
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

## 工具参数与检索能力（当前实现）

### 已生效的参数

| 参数 | 所在工具 | 行为 |
|---|---|---|
| `text` / `messages` | add_memory | **记忆素材**：异步受理返回 `event_id`，后台 LLM 提炼成结构化记忆入库（不存原文）；提炼失败 → 事件 failed，素材不落库 |
| `metadata` | add_memory | 附加元数据（如 `{source:"zcode"}`），透传给每条提炼产物，可参与过滤 |
| `user_id` | 所有工具 | 只能等于当前身份，跨租户拒绝（多租户隔离底座） |
| `event_id` | get_event_status | 查异步提炼任务状态（done 含产物列表；failed 含原因） |
| `limit` / `page` / `page_size` | search_memories / get_memories | 分页与条数控制 |
| `threshold` | search_memories | 过滤低于相似度阈值的向量召回结果（0~1，默认 0 不过滤） |
| `filters` | search_memories / get_memories | `user_id` / `metadata` 键值 / `created_at`、`updated_at` 时间范围 |

> 刻意**不提供**的参数/维度（瘦身决策）：`infer`（写入即自动抽取，无需开关）、`rerank`（成本高、收益边际）、`agent_id`/`run_id`（员工账本单一维度）。

### 检索实现说明

- **语义召回**：查询与记忆都转成向量做余弦相似度（`memories.embedding` 列，float32 BLOB），语义相近即可命中；embedding 服务不可用时半熔断降级纯关键词。
- **关键词召回**：SQLite FTS5 trigram（中文子串），作为字面命中的兜底。
- **实体参与召回**：LLM 抽取的 facts/entities 存 `memories.facts`/`entities`，向量对「原文 + facts + entities」生成，实体名命中即可被语义召回。

## 开发提示

- **测试**：`npm test`（核心回归：CRUD / 多租户隔离 / 关键词检索 / schema 精简），用独立临时库不碰生产数据。
- **健康检查**：`curl http://<内网IP>:18543/healthz`（DB / embedding / LLM / Keycloak 状态）。
- **推 GitHub 需走代理**（本机未配置全局 git 代理时）：`git -c http.proxy=http://127.0.0.1:7890 push origin main`（单次生效，不改全局配置）

## 参考

- 下一阶段计划：见 **[docs/下一阶段计划.md](docs/下一阶段计划.md)**（阶段 0 运营收尾 → P0 AI 化 → P1/P2）
- 产品构想：本仓库旧版 `README.md` 已归档为本文档前身（多租户设计见 mykeycloak 项目 docs）

# aimemory —— 企业级 AI 记忆库（MCP 服务）

> 自托管、mem0 兼容的 **AI 记忆服务**：供全公司 agent（Claude Code / Codex / 自研 agent…）经 **MCP（Streamable HTTP）** 读写记忆。
> 登录走公司统一 **Keycloak**，按**员工**完整隔离（一人一账本，多 agent 共享）；Web 平台自助管理记忆、生成接入密钥。

## 特性

- **素材提炼型写入（核心）**：`add_memory` 的输入一律视为素材（`text` / `messages`），**不直接落库**——后台内部 LLM 提炼成多条自包含结构化记忆后入库；异步受理 + 队列串行，本地低并发 LLM 下不阻塞调用；提炼失败不落库
- **语义 + 关键词混合检索**：embedding 向量召回（同义/口语化可命中）+ SQLite FTS5 trigram 关键词召回（中文子串）；embedding 不可用时自动回退纯关键词
- **7 个核心 MCP 工具**：`add_memory` / `get_event_status` / `search_memories` / `get_memories` / `get_memory` / `update_memory` / `delete_memory`——刻意不提供批量导入、整库/实体管理、agent/run 维度
- **L0 原始会话归档**：各机安装采集器（pm2），把 Codex / Claude Code / ZCode 的原始会话追加归档到 `data/l0/<设备>/<agent>/`；上传带**设备码 + 设备信息 + agent**，Web「会话归档」页按**设备 → agent → 会话 → 详情**逐级下钻，可在任意机器查看其他机器的会话；只采集上传、不做提炼（详见 [docs/L0-原始会话归档.md](docs/L0-原始会话归档.md)）。**当前服务器本机已部署**（设备「服务器本机 / user2」）。
- **多租户隔离**：数据按员工隔离，跨用户访问直接拒绝（MCP 与 REST 均验证）
- **接入**：Web 自助签发多枚 `m0-xxx` Token（按客户端命名分发、单独吊销，明文页面随时可查）+ 设备流浏览器免粘贴授权；Web 页支持导出全量记忆（JSON）
- **半熔断容错**：LLM/embedding 服务抖动自动熔断降级、恢复自动探测回补，无需重启
- **单端口 18543**：`/mcp` + `/api/*` + Web 管理页 + `/healthz`

## 架构

```
MCP 客户端 (Claude Code / ZCode / …) ── POST /mcp, Authorization: Token m0-xxx
        │
        ▼
HTTP Server :18543 (Express)
  /mcp        MCP Streamable HTTP（7 工具）
  /api/*      REST（Token 或 Web 会话 cookie）
  /           管理 Web 页（Keycloak 授权码+PKCE 登录）
  /healthz    健康检查（db/embedding/llm/keycloak）
        │
        ▼
SQLite (data/aimemory.db): memories + memories_fts(FTS5) + api_keys + sessions + events(异步队列)
        │
        ├─ embeddings/client.js → OpenAI 兼容 /v1/embeddings（语义向量）
        └─ llm/client.js       → OpenAI 兼容 /v1/chat/completions（提炼/infer）
```

## 快速开始

前置：Node.js 20+、可用的 Keycloak（生产复用公司统一 Keycloak，仅需 `KEYCLOAK_URL`/`KEYCLOAK_REALM`/`KEYCLOAK_CLIENT_ID`，见下文「对接 Keycloak」）。

```bash
npm install
cp .env.example .env            # 按需改 KEYCLOAK_URL / LLM_* / EMBEDDING_*（见 .env 注释）
npm run setup-keycloak          # 幂等初始化 realm/client/测试用户
pm2 start ecosystem.config.js && pm2 save   # 或 npm start
```

验证：

```bash
curl http://localhost:18543/healthz    # {"status":"ok",...}
curl http://localhost:18543/           # Web 平台（Keycloak 登录）
```

## 使用方式

- **MCP 接入**：`url: http://<内网IP>:18543/mcp`，`headers: { "Authorization": "Token m0-xxx" }`。员工在 Web「接入 Token」页签发 / 或走设备流一键授权。
- **写入（素材）**：`add_memory { text }` 或 `add_memory { messages: [{role,content}...] }` → 返回 `{event_id, status:"pending"}`；轮询 `get_event_status` 至 `done`（含提炼产物）或 `failed`（素材未入库）。**返回≠已入库，务必查状态。**
- **查询**：`search_memories { query, limit?, threshold? }` 语义检索；`get_memories` / `get_memory` 列表/单条；`update_memory` / `delete_memory` 修改/删除。

> 参数保留 mem0 子集：`text` / `messages` / `metadata` / `filters`（metadata 键值、时间范围）/ `page_size` / `limit` / `threshold` / `user_id`（只能等于当前身份）。
> 刻意不提供：`infer`（写入即自动提炼）、`rerank`、`agent_id`/`run_id`（员工单维度账本）。

## REST API 摘要

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/memories` | 提交素材（202 + event_id 异步受理） |
| GET | `/api/memories?page=&page_size=&q=` | 列表 / 语义搜索 |
| GET/PATCH/DELETE | `/api/memories/:id` | 单条 / 更新 / 删除 |
| GET | `/api/memories/export` | 导出当前员工全部记忆（JSON 附件） |
| GET | `/api/events/:id` | 查素材提炼状态 |
| GET | `/api/stats` / `/api/me` | 统计 / 当前身份 |
| POST/GET | `/api/keys`、`/api/keys/:id/revoke` | Token 管理（多 Token 并存，单独吊销） |
| POST | `/api/l0/ingest` | L0 原始会话批次上传（带设备三元组，幂等，仅归档不提炼） |
| GET | `/api/l0/stats` | L0 归档统计 + 设备清单 + 会话清单（`?device=`/`?agent=` 过滤） |
| GET | `/api/l0/session` | 读单会话内容（`agent`/`device`/`session_id`，含归属校验） |
| POST/GET | `/api/connect/start`、`/api/connect/poll`、`/api/connect/confirm` | 设备流接入 |

鉴权：`Authorization: Token m0-xxx` 或 Web 会话 cookie。

## 对接 Keycloak（迁移部署）

服务运行期**不需要管理员凭据**——只依赖 `KEYCLOAK_URL` / `KEYCLOAK_REALM` / `KEYCLOAK_CLIENT_ID` 三个配置，经 OIDC 发现端点自动获取 JWKS 与端点。迁移到任意主机/HTTPS 都只改 `.env`。

```bash
# 拷贝项目（务必含 data/ —— 全部记忆数据）→ 配 .env → 起服务
rsync -av aimemory/ user@new-server:/opt/aimemory/
# .env: KEYCLOAK_URL=http://<对方Keycloak>:<端口>   （HTTPS 直接填 https://…）
#       PUBLIC_BASE_URL=http://<新机器内网IP>:18543 （可选：固定管理页生成的 MCP JSON 地址）
```

`npm run setup-keycloak` 幂等：有管理员凭据自动建 realm/client；无凭据则要求对方预建 client（public + PKCE），脚本仅补回调地址。登录异常多为 client 的 Valid redirect URIs 缺 `http://<IP>:18543/auth/callback`，补上即可。

## 配置项（.env 关键项）

| 变量 | 说明 |
|---|---|
| `PORT` | 服务端口（默认 18543） |
| `PUBLIC_BASE_URL` | 对外地址（管理页生成 MCP JSON 用；留空取请求 Host） |
| `KEYCLOAK_URL` / `KEYCLOAK_REALM` / `KEYCLOAK_CLIENT_ID` | Keycloak 对接（运行期仅需这三项） |
| `SESSION_SECRET` | Web 会话签名（首次启动自动生成写回 .env） |
| `LLM_ENABLED` / `LLM_BASE_URL` / `LLM_MODEL` / `LLM_API_KEY` / `LLM_TIMEOUT_MS` | 提炼用 chat/completions（未启用时写入直接拒绝） |
| `EMBEDDING_ENABLED` / `EMBEDDING_BASE_URL` / `EMBEDDING_MODEL` / `EMBEDDING_API_KEY` | 语义检索用 embeddings（不可用自动退关键词） |
| `AIMEMORY_DB` | 数据库路径覆盖（测试用独立库） |

## 数据与安全

- 库内只存**提炼产物**（结构化记忆），素材原文不入库；`text` 明文存储无加密——**不写入完整密码等敏感明文**（skill 有约束）。
- Token 校验走 sha256 哈希（`token_hash`），明文另存 `token_plain` 以便 Web 页随时回看——**库文件含 Token 明文，data/ 目录访问权限即等同密钥权限**；每员工可持有多枚命名 Token，按客户端签发、单独吊销。
- 记忆按员工隔离，导出仅限本人；删除需 Web 或 MCP `delete_memory` 单条确认。

## 容量与运维

- **≤300 人：单实例 SQLite 完全够用**（实测 300 并发混合 773 QPS / p95 <1s，0 错误）；800 人量级建议 `pm2 scale aimemory-mcp 2`（WAL 支持多进程共享库文件）。
- 换 PostgreSQL 的必要信号：`SQLITE_BUSY` 频发、写 QPS >1000、数据量上百 GB——未到前 SQLite 是零运维最优解。
- 测试：`npm test`（10 项核心回归，独立临时库）；健康：`curl /healthz`。
- 历史压测明细、Windows 开机自启等已归档 `docs/archive/`（当时环境的记录，参数已过时）。

## 测试报告

最新：[docs/测试报告-2026-09-07-v0.2-素材提炼与端到端.md](docs/测试报告-2026-09-07-v0.2-素材提炼与端到端.md)（单测 10/10 + MCP/REST 端到端全通过）。

## 四层记忆架构

本项目按 **L0 原始会话 → L1 会话摘要 → L2 事实记忆 → L3 画像/知识** 四层组织，L0 是唯一事实源，
上层均可从 L0 重放重建。当前 L0、L2 已落地，L1/L3 待建：

- **[docs/四层记忆架构与进展.md](docs/四层记忆架构与进展.md)** —— 总览与进度台账（建议先读）
- [docs/调研报告-2026-07-会话与记忆管理系统.md](docs/调研报告-2026-07-会话与记忆管理系统.md) —— 架构源起（L0-L3 模型出自该文）
- [docs/L0-原始会话归档.md](docs/L0-原始会话归档.md) —— L0 实现细节

## 关联项目

- **配套 Skills**：本仓库 `skills/` 目录（aimemory 管理 / aimemory-recall 召回 / aimemory-remember 沉淀 / aimemory-collector 会话备份部署），Web「接入指南」页可下载 zip，或直接取用仓库源（https://github.com/GGbao8848/aimemory）。已取消插件打包与插件市场分发，接入只走 skill + MCP API 两条路。
- **Keycloak 部署**：mykeycloak（统一登录平台）。

# aimemory —— 个人 AI 记忆库（mem0 形态）

> 自托管的 **mem0 形态个人记忆服务**：REST（`/v1` `/v2`，对齐 mem0 官方用法）+ **MCP（Streamable HTTP）**
> 双接入面，给 agent（Claude Code / Codex / ZCode / 自研 agent…）读写长期记忆。
> 单用户部署——记忆归属 Token 持有者；Web 管理台（shadcn/ui）管理记忆与接入 Token。

## 特性

- **mem0 形态 API**：`POST /v1/memories/`（add）、`POST /v2/memories/search/`、`POST /v2/memories/`（get_all + filters）、
  `GET/PUT/DELETE /v1/memories/{id}/`、`GET /v1/memories/{id}/history/`、`DELETE /v1/memories/`（按作用域批量删）、
  `GET /v1/event/{event_id}/`（事件轮询）——SDK/脚本照 mem0 的用法写即可
- **素材提炼型写入（infer 双路径）**：`infer=true`（默认）输入视为素材（`text` / `messages`），后台 LLM 提炼成
  多条自包含记忆后异步入库（返回 `event_id`）；`infer=false` 原文直存同步返回——与 mem0 语义一致
- **冲突消解（mem0 的 ADD/UPDATE/DELETE/NOOP）**：新事实入库前与已有记忆比对，同一事实不再反复入库、
  新旧取值不再并存；每次变更写入 `memory_ops` 历史（`GET /v1/memories/{id}/history/` 可查，误删可复原）
- **语义 + 关键词混合检索**：embedding 向量召回 + SQLite FTS5 trigram 关键词召回（中文子串）；
  embedding 不可用时自动回退纯关键词
- **mem0 三维度作用域**：`user_id`（账号维度，必须省略或等于鉴权主体）/ `agent_id` / `run_id`
  （自由标签，标记哪个 agent、哪次会话写入），检索与列表可按维度过滤
- **MCP 7 工具**：`add_memory` / `get_event_status` / `search_memories` / `get_memories` / `get_memory` /
  `update_memory` / `delete_memory`
- **Web 管理台（shadcn/ui）**：记忆列表（搜索 / agent·run 过滤 / 编辑 / 删除 / 变更历史）、
  Token 签发（明文一次性展示）、接入指南；Tailwind v4 + Radix，暗/亮双主题
- **半熔断容错**：LLM/embedding 服务抖动自动熔断降级、恢复自动探测回补，无需重启
- **单端口 18543**：`/mcp` + `/v1` `/v2` + `/api/*` + Web 管理台 + `/healthz`

## 架构

```
agent / SDK / 脚本 ── POST /v1/memories · POST /v2/memories/search，Authorization: Token m0-xxx
MCP 客户端        ── POST /mcp
        │
        ▼
HTTP Server :18543 (Express)
  /v1 /v2     mem0 形态 REST（Token 鉴权）
  /mcp        MCP Streamable HTTP（7 工具）
  /api/*      管理台自用面（Token 或 Web 会话 cookie）
  /admin, /   Web 管理台（web/ 构建产物 + 本地口令登录）
  /healthz    健康检查（db / embedding / llm / 提炼队列积压）
        │
        ▼
SQLite (data/aimemory.db): memories + memories_fts(FTS5) + memory_ops(变更历史)
        + l2_meta(向量维度) + api_keys + sessions + events(异步提炼队列)
        │
        ├─ embeddings/client.js → OpenAI 兼容 /v1/embeddings（语义向量）
        └─ llm/client.js       → OpenAI 兼容 /v1/chat/completions（素材提炼/消解判定）
```

> 2026-09-19 转向定论：项目收敛为 mem0 形态——此前的 L0 会话采集 / L1 会话摘要 / L3 画像 / 设备流授权
> 已整体退役（旧库自动迁移：这些表 DROP，memories 数据保留；`data/l0`、`data/l3` 文件留盘可自行归档）。
> 见 [docs/项目规划.md](docs/项目规划.md)。

## 快速开始

前置：Node.js 20+ 以及一个 OpenAI 兼容的 LLM 服务（素材提炼用；embedding 可选）。**无需任何外部登录服务**。

```bash
npm install
npm run web:install && npm run web:build   # 管理台前端（产物 web/dist；只跑后端可跳过，/admin 会给 503 提示）
cp .env.example .env            # 按需改 LLM_* / EMBEDDING_*（见 .env 注释）
npm run doctor                  # 首启自检：依赖/目录/数据库/前端产物/LLM 配置一次查清
pm2 start ecosystem.config.js && pm2 save   # 或 npm start
```

验证：

```bash
curl http://localhost:18543/healthz    # {"status":"ok",...}
curl http://localhost:18543/           # Web 管理台（首次启动会打印自动生成的口令）
```

## 使用方式（照 mem0 的写法）

签发 Token：登录 Web「接入 Token」页 → 签发 → 明文一次性展示。之后：

```bash
# add（异步提炼，返回 event_id）
curl -X POST http://localhost:18543/v1/memories/ \
  -H "Authorization: Token m0-xxx" -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"网关迁到了 10.10.10.146"}],"agent_id":"zcode","run_id":"s-42"}'

# search（混合检索）
curl -X POST http://localhost:18543/v2/memories/search/ \
  -H "Authorization: Token m0-xxx" -H "Content-Type: application/json" \
  -d '{"query":"网关部署在哪","filters":{"user_id":"owner"},"top_k":5}'

# get_all / update / delete / history
curl -X POST http://localhost:18543/v2/memories/ -H "Authorization: Token m0-xxx" \
  -H "Content-Type: application/json" -d '{"filters":{"agent_id":"zcode"},"page":1,"page_size":20}'
curl -X PUT http://localhost:18543/v1/memories/<id>/ -H "Authorization: Token m0-xxx" \
  -H "Content-Type: application/json" -d '{"text":"更新后的文本"}'
curl -X DELETE http://localhost:18543/v1/memories/<id>/ -H "Authorization: Token m0-xxx"
curl http://localhost:18543/v1/memories/<id>/history/ -H "Authorization: Token m0-xxx"
```

- **infer=true 必须轮询**：返回 200 + `event_id` ≠ 已入库，用 `GET /v1/event/{event_id}/` 等到 `done`/`failed`。
- **响应文本字段名是 `memory`**（mem0 形状）；`agent_id`/`run_id` 是自由标签。
- **MCP 接入**：`url: http://<内网IP>:18543/mcp`，`headers: { "Authorization": "Token m0-xxx" }`。

## REST API 摘要

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v1/memories/` | add（infer=true 异步提炼 / infer=false 直存） |
| POST | `/v2/memories/search/` | 混合检索（query + filters + top_k） |
| POST | `/v2/memories/` | get_all（filters + 分页，{count, next, previous, results}） |
| GET/PUT/DELETE | `/v1/memories/{id}/` | 单条 / 更新 / 删除 |
| GET | `/v1/memories/{id}/history/` | 变更历史（ADD/UPDATE/DELETE 留痕） |
| DELETE | `/v1/memories/` | 按作用域批量删除（异步，返回 event_id） |
| GET | `/v1/event/{event_id}/` | 异步事件状态轮询 |
| POST/GET | `/api/keys`、`/api/keys/:id/revoke` | Token 管理（管理台自用面） |
| GET | `/api/stats` / `/api/me` / `/api/memories/export` | 统计 / 身份 / 导出 |

完整契约：[docs/api/openapi.json](docs/api/openapi.json)（路径与方法集由测试守护，TS 类型 `npm run types` 生成）。

## 配置项（.env 关键项）

| 变量 | 说明 |
|---|---|
| `PORT` | 服务端口（默认 18543） |
| `AIMEMORY_PASSWORD` | Web 登录口令（首次启动自动生成写回 .env，并打印在日志） |
| `AIMEMORY_USER_ID` / `AIMEMORY_USER_NAME` | 个人身份标识 / 界面显示名（默认 owner / 我） |
| `LLM_ENABLED` / `LLM_BASE_URL` / `LLM_MODEL` / `LLM_API_KEY` / `LLM_TIMEOUT_MS` | 提炼用 chat/completions（未启用时 infer=true 写入直接拒绝） |
| `EMBEDDING_ENABLED` / `EMBEDDING_BASE_URL` / `EMBEDDING_MODEL` / `EMBEDDING_API_KEY` | 语义检索（不可用自动退关键词；换模型后 `npm run vec:rebuild`） |
| `AIMEMORY_DB` | 数据库路径覆盖（测试用独立库） |
| `L2_*` | 冲突消解开关与 token 预算（全量见 .env.example 注释） |

## 数据与安全

- 库内只存**提炼产物**（`infer=true` 路径）；`infer=false` 按需直存。**不要写入完整密码等敏感明文**。
- Token 校验走 sha256 哈希，**库内不存明文**：明文仅在创建响应里返回一次，丢失请吊销重建。
- 删除走单条确认（Web/MCP）或按作用域批量删（REST，必须带至少一个过滤条件）。

## 运维

- **个人规模 SQLite 余量充足**：10 万条记忆关键词检索 P95≈40ms；检索质量基线 recall@5=1.0 / MRR≈1.0
  （历史基线见 [docs/检索基线-2026-09-19.md](docs/检索基线-2026-09-19.md)，注意其中 L0/L1/L3 相关项已随裁层失效）。
- 运维件：`npm run doctor`（首启自检）、`scripts/backup.sh` / `restore.sh`（在线备份恢复）、
  `scripts/export.js` / `import.js`（memories 全量迁移，幂等）、`npm run vec:rebuild`（换 embedding 模型后重建向量索引）。
- Docker：多阶段镜像 + compose（数据卷 `./data`），见 [docs/部署-生产机.md](docs/部署-生产机.md)；操作手册见 [docs/运维手册.md](docs/运维手册.md)。

## 测试

`npm test` 全量（独立临时库，零真实 LLM）：mem0 API 行为回归 + 契约守护（openapi 双向比对）+
冲突消解 + 检索质量地板 + MCP 错误语义 + 迁移/备份/导出端到端 + 配置对齐 + 密钥防线。

## 关联

- **配套 Skill**：本仓库 `skills/aimemory/`（单一入口，`references/` 下按需读召回/沉淀/管理三篇），
  Web 可访问 `GET /skill/SKILL.md` 预览、`GET /skill/download` 打包下载。
- **历史版本**：四层架构（L0/L1/L2/L3）与多租户实现分别封存在 git 历史与 `multi-tenant` 分支；
  层级设计文档保留在 `docs/` 作为存档（L0/L2/L3 文档描述的机制已不在 main）。

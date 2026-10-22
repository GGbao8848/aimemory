# aimemory —— 个人 AI 记忆库（mem0 形态）

> 自托管的 **mem0 形态个人记忆服务**：REST（`/v1` `/v2`，对齐 mem0 官方用法）+ **MCP（Streamable HTTP）**
> 双接入面，给 agent（Claude Code / Codex / ZCode / 自研 agent…）读写长期记忆。
> 多租户部署——Keycloak（realm `br`）登录，记忆归属登录用户 / Token 持有者；Web 管理台（shadcn/ui）管理记忆与接入 Token。

## 特性

- **mem0 形态 API**：`POST /v1/memories/`（add）、`POST /v2/memories/search/`、`POST /v2/memories/`（get_all + filters）、
  `GET/PUT/DELETE /v1/memories/{id}/`、`GET /v1/memories/{id}/history/`、`DELETE /v1/memories/`（按作用域批量删）、
  `GET /v1/event/{event_id}/`（事件轮询）——SDK/脚本照 mem0 的用法写即可
- **素材提炼型写入（infer 双路径）**：`infer=true`（默认）输入视为素材（`text` / `messages`），后台 LLM 提炼成
  多条自包含记忆后异步入库（返回 `event_id`）；`infer=false` 原文直存同步返回——与 mem0 语义一致
- **写入门槛 + 项目归属**：库定位跨机器/跨项目/长久记忆（skill 引导分流，短期项目细节走项目内 AGENTS.md）；
  项目相关记忆带 `agent_id` 标签，可按项目检索与批量清理
- **敏感内容策略开关**：内网自托管默认凭据可按原文入库（`SENSITIVE_MODE=allow`）；
  公网/共享部署设 `redact` 由提炼层自动脱敏
- **冲突消解（mem0 的 ADD/UPDATE/DELETE/NOOP）**：新事实入库前与已有记忆比对，同一事实不再反复入库、
  新旧取值不再并存；每次变更写入历史，可查可复原
- **语义 + 关键词混合检索**：embedding 向量召回 + SQLite FTS5 关键词召回（中文子串）；embedding 不可用时自动回退
- **mem0 三维度作用域**：`user_id`（必须省略或等于鉴权主体）/ `agent_id` / `run_id`（自由标签），检索可按维度过滤
- **MCP 7 工具**：`add_memory` / `get_event_status` / `search_memories` / `get_memories` / `get_memory` /
  `update_memory` / `delete_memory`
- **Web 管理台（shadcn/ui）**：记忆管理、Token 签发（明文一次性展示）、Keycloak 登录
- **半熔断容错**：LLM/embedding 服务抖动自动熔断降级、恢复自动探测回补，无需重启
- **单端口 18543**：`/mcp` + `/v1` `/v2` + `/api/*` + Web 管理台 + `/healthz`

## 快速开始

前置：Node.js 20+、一个 OpenAI 兼容的 LLM 服务（素材提炼用；embedding 可选）、
一台可用的 Keycloak（Web 管理台登录用；[进阶指南](docs/进阶指南.md)有注册说明）。

```bash
npm install
npm run web:install && npm run web:build   # 管理台前端（只跑后端可跳过）
cp .env.example .env            # 按需改 LLM_* / EMBEDDING_* / KEYCLOAK_*
npm run setup:keycloak          # 在 Keycloak 注册 client（幂等；需 KEYCLOAK_ADMIN_*）
npm run doctor                  # 首启自检：依赖/数据库/前端产物/LLM 配置一次查清
pm2 start ecosystem.config.js && pm2 save   # 或 npm start
```

验证：`curl http://localhost:18543/healthz` 返回 `{"status":"ok",...}`；
浏览器打开 `http://localhost:18543/` → 「使用 Keycloak 登录」。

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
  -d '{"query":"网关部署在哪","top_k":5}'
```

- **infer=true 必须轮询**：返回 200 + `event_id` ≠ 已入库，用 `GET /v1/event/{event_id}/` 等到 `done`/`failed`。
- **响应文本字段名是 `memory`**（mem0 形状）；`agent_id`/`run_id` 是自由标签。
- **MCP 接入**：`url: http://<内网IP>:18543/mcp`，`headers: { "Authorization": "Token m0-xxx" }`。
- 完整 API 契约：[docs/api/openapi.json](docs/api/openapi.json)（TS 类型 `npm run types` 生成）。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/进阶指南.md](docs/进阶指南.md) | 架构 / API 全表 / 配置项 / Keycloak 多租户与数据迁移 / 数据安全 / 运维 / 测试 |
| [docs/部署-生产机.md](docs/部署-生产机.md) | 生产部署、Keycloak 注册细则、Docker 形态、故障排查 |
| [docs/运维手册.md](docs/运维手册.md) | 备份恢复、日常运维操作 |
| [docs/前端对接.md](docs/前端对接.md) | REST / MCP 对接细节（鉴权、filters、错误语义） |
| `skills/aimemory/` | 配套 Skill（`GET /skill/SKILL.md` 预览、`GET /skill/download` 下载） |

# aimemory 部署指南（pm2 托管）

本指南从 **pm2 安装** 开始，覆盖 aimemory 在 Windows 服务器上用 pm2 托管的完整流程：安装 → 启动 → 验证 → 开机自启 → 日常运维 → 更新部署 → 多实例扩容 → 故障排查。

> 相关文档：[单点登录设计](单点登录设计.md)；Keycloak 对接与迁移见 README「对接其他主机的 Keycloak」。

## 1. 前置条件

| 项 | 要求 | 检查命令 |
|---|---|---|
| Node.js | ≥ 20（本机实测 v24，**better-sqlite3 需 ≥13 才有 Node 24 预编译**） | `node -v` |
| npm | 随 Node 安装 | `npm -v` |
| Keycloak | 已部署并运行（本机业务口 `6543`，realm `br-platform`，BR-Agent 等 agent 项目同用） | `curl http://localhost:6543/realms/br-platform/.well-known/openid-configuration` |

一次性准备（项目根目录）：

```bash
cd E:\br\MCP\aimemory
npm install          # 安装 express / MCP SDK / better-sqlite3 等依赖
npm run setup-keycloak   # 幂等初始化 Keycloak（realm/client 已存在则仅补齐回调地址）
```

> **better-sqlite3 原生模块**：`npm install` 若提示 install-scripts 被阻止（npm 安全策略），Node 24 下需用 `better-sqlite3@^13`（v11 无 Node 24 预编译且本机缺 Python 编译链）。已就绪则无需处理，可用 `node -e "require('better-sqlite3')"` 验证。

## 2. 安装 pm2

pm2 是 Node.js 进程管理器，提供开机自启、崩溃自动重启、日志管理。全局安装：

```bash
npm install -g pm2
pm2 -v          # 验证安装，输出版本号（如 7.x.x）即成功
```

> Windows 上全局包安装到 `%APPDATA%\npm`。若 `pm2` 命令找不到，把该目录加入 PATH，或改用完整路径：`C:\Users\<用户名>\AppData\Roaming\npm\pm2.cmd -v`

## 3. 理解 pm2 配置（ecosystem.config.js）

项目根目录的 `ecosystem.config.js` 已内置全部托管配置，直接 `pm2 start ecosystem.config.js` 即可，无需手写启动命令。关键项说明：

| 配置项 | 值 | 作用 |
|---|---|---|
| `name` | `aimemory-mcp` | 进程名，后续 `pm2 logs aimemory-mcp` 等命令用 |
| `script` | `src/index.js` | 启动入口（Node 直接运行，无需编译） |
| `cwd` | 项目根目录 | 相对路径基准 |
| `instances` | `1` | 单实例（扩容见第 9 节） |
| `autorestart` | `true` | 崩溃自动重启 |
| `max_memory_restart` | `512M` | 内存超限自动重启 |
| `time` | `true` | 日志带时间戳 |
| `env.NODE_ENV` | `production` | 生产环境标记 |

> aimemory 是纯 Node 服务（区别于 bip-timesheet-mcp 的 TS 编译 + Python 核心），`pm2 start` 前无需 build，`src/` 即源码即产物。

## 4. 启动服务

```bash
cd E:\br\MCP\aimemory
pm2 start ecosystem.config.js
pm2 save        # 保存进程列表，供开机自启 pm2 resurrect 恢复（必做！见第 6 节）
```

输出会显示进程状态（`online`）。启动日志确认 Keycloak 地址正确：

```bash
pm2 logs aimemory-mcp --lines 5
# 预期出现: [aimemory] MCP + API + Web 已启动: http://0.0.0.0:18543
#           [aimemory] Keycloak: http://<KEYCLOAK_URL>/realms/br-platform
```

> ⚠ **Keycloak 地址必须与 BR-Agent 同 host**（SSO 会话 cookie 按 host 域存储，不同域会互相读不到会话 → 单点登录失效、跳登录页）。本机 IP 变更后需同步更新 `.env` 的 `KEYCLOAK_URL`（见第 10 节故障排查）。

## 5. 验证部署

| 检查项 | 命令 / 地址 | 预期 |
|---|---|---|
| 进程状态 | `pm2 list` | `aimemory-mcp` 状态 `online`，重启次数合理 |
| Web 平台 | `http://localhost:18543/` | 200，登录页 |
| REST 鉴权 | `curl http://localhost:18543/api/me` | 401（未登录态正常） |
| MCP 端点 | `curl -X POST http://localhost:18543/mcp -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'` | 401（未带 key 正常） |
| 登录流程 | 浏览器打开 `http://<内网IP>:18543` → Keycloak 登录 | 回调后显示用户名（br0004 等），非 UUID |
| 局域网连通 | 其他机器访问 `http://<服务器IP>:18543/mcp` + `Token m0-xxx` | 可建立 MCP 连接 |

> `PUBLIC_BASE_URL` 保持留空：登录回调跟随请求来源 Host，「在哪个地址打开就在哪个地址回调」，避免 cookie 域不一致导致 `state 校验失败`（详见第 10 节）。

## 6. Windows 开机自启

Windows 上 pm2 **不支持** `pm2 startup` 命令，需用计划任务在用户登录时执行 `pm2 resurrect`（恢复第 4 节 `pm2 save` 保存的进程列表）。

用管理员身份打开 CMD，执行：

```bat
schtasks /Create /TN pm2-resurrect /TR "cmd /c C:\Users\<用户名>\AppData\Roaming\npm\pm2.cmd resurrect" /SC ONLOGON /RL HIGHEST
```

验证计划任务已创建：

```bat
schtasks /Query /TN pm2-resurrect
```

> 说明：`/SC ONLOGON` 表示用户登录时触发；`/RL HIGHEST` 以最高权限运行。路径按第 2 节实际 pm2 位置替换。**Keycloak 需另行自启**（本机为启动文件夹 `start_keycloak_hidden.vbs`，见 BR-Agent 部署指南）。

## 7. 日常运维命令

| 操作 | 命令 |
|---|---|
| 查看所有进程 | `pm2 list` |
| 查看实时日志 | `pm2 logs aimemory-mcp` |
| 查看进程资源占用 | `pm2 monit` |
| 查看进程详细信息（路径/环境/重启历史） | `pm2 info aimemory-mcp` |
| 重启 | `pm2 restart aimemory-mcp` |
| 停止 | `pm2 stop aimemory-mcp` |
| 从 pm2 移除 | `pm2 delete aimemory-mcp` |
| 清空日志 | `pm2 flush aimemory-mcp` |
| 持久化进程列表 | `pm2 save` |

> 每次 `pm2 stop` / `pm2 delete` 后如需恢复开机自启，重新 `pm2 start ecosystem.config.js` 并 `pm2 save`。

## 8. 更新部署（代码升级）

```bash
cd E:\br\MCP\aimemory
git pull                    # 拉取新代码（本机直连 GitHub 需代理，见 README「开发提示」）
npm install                 # 依赖有变更时
pm2 restart aimemory-mcp
```

> ⚠ **数据库迁移坑**：新版本若在 `db/index.js` 给表加唯一索引（如 `api_keys` 的 `UNIQUE(user_id,name) WHERE revoked_at IS NULL`），而现有库里已有同用户未吊销重名记录，启动会直接报 `UNIQUE constraint failed` 起不来。此时：
> 1. 先备份 `data/` 目录（`cp -r data /tmp/aimemory-backup/data-$(date +%Y%m%d)`）
> 2. 用 sqlite 把多余的未吊销重名 key 吊销（保留最早一条）
> 3. 再 `pm2 restart`
>
> 判断依据：`pm2 logs aimemory-mcp --err` 出现 `UNIQUE constraint failed: api_keys.user_id, api_keys.name`。

## 9. 多实例扩容（pm2 scale）

**实例 = 一份正在运行的服务进程。** 单实例 = 一个进程处理所有请求（排队）；双实例 = 两个一模一样的进程，pm2 自动负载均衡。

**关键认知：数据不复制、不分裂。** 两个进程连的是**同一个 `data/aimemory.db` 文件**（SQLite WAL 支持多进程共享同一库文件），记忆完全共享一份，扩容后用户/agent 的数据、密钥、会话都不受影响。

```bash
pm2 scale aimemory-mcp 2     # 扩到 2 实例（开第二个窗口）
pm2 scale aimemory-mcp 1     # 缩回 1 实例
pm2 scale aimemory-mcp +1    # 在当前基础上 +1
pm2 save                     # 持久化实例数（重启机器后保持）
```

**实测效果（800 人场景）**：

| 指标 | 单实例 | 双实例 |
|---|---|---|
| 800 个 MCP 会话（模拟 800 个 agent 常驻） | 265 QPS，p95 2800ms | 431 QPS（+63%），p95 1728ms（延迟减半） |
| 800 并发混合读写 | 827 QPS，p95 2563ms | 883 QPS，p95 1849ms |

**适用判断——什么瓶颈被解决、什么解决不了**：

- ✅ **能解决"进程排队"**：并发会话握手、初始化、事件循环排队这类 CPU/单进程瓶颈 → 扩容显著提速（上面 MCP 会话那一行）
- ⚠️ **解决不了"单库写"**：SQLite 单写者串行化，多进程抢同一个写入口，写延迟改善有限（上面混合读写那一行）——这是 SQLite 固有上限，不是配置错误

**注意事项**：

1. **不是越多越好**：实例数一般跟 CPU 核数走（8 核机最多 8 个左右有效），超过核数反而因进程内耗、争抢加剧而无效
2. **扩容无需改代码**：接口层（MCP/REST/auth）与存储层（repo.js）都不感知实例数，纯 pm2 操作
3. **别用"扩实例"治"写瓶颈"**：若日志出现 `SQLITE_BUSY`，那是单库写到了极限，扩实例没用——此时才评估换 PostgreSQL（详见 README「为什么暂不换 PostgreSQL」）
4. 当前服务按需调整：≤300 人保持 1 实例即可；800 人或大量 agent 常驻连接时建议 2 实例

## 10. 故障排查

| 现象 | 排查步骤 |
|---|---|
| `pm2 list` 状态 `errored` / 反复重启 | `pm2 logs aimemory-mcp --err` 看错误日志 |
| 启动报 `UNIQUE constraint failed: api_keys...` | 新版本加了唯一索引、历史重名 key 冲突 → 按第 8 节「数据库迁移坑」清理后重启 |
| 启动报 `Could not locate the bindings file` | better-sqlite3 原生模块缺失 → `npm install better-sqlite3@^13` 后重启 |
| 登录页报「登录发起失败: fetch failed」 | `.env` 的 `KEYCLOAK_URL` 连不通 → 本机 IP 可能变更，`curl http://localhost:6543/...` 验证并同步更新（Keycloak 地址必须与 BR-Agent 同 host） |
| 登录回跳后报「state 校验失败（防 CSRF）」 | `PUBLIC_BASE_URL` 设了固定 IP，而用户从 localhost 打开 → 回调 host 与 cookie 域不一致 → 把 `PUBLIC_BASE_URL` 留空（跟随请求来源） |
| 登录回跳后报「Invalid redirect uri」 | client 的 Valid redirect URIs 没有当前 host:端口 → 重跑 `npm run setup-keycloak`（幂等补齐） |
| Web 显示 UUID 前 8 位而非用户名 | 老会话未存 username → 退出重新登录一次 |
| 端口 18543 被占用（响应头不是 Express） | `netstat -ano | grep :18543` 查占用进程，确认不是其他服务抢端口 |
| pm2 列表突然为空（daemon 掉线） | 进程实际可能还活着；重新 `pm2 start ecosystem.config.js` + `pm2 save` 恢复（见第 4、6 节） |
| `pm2 resurrect` 恢复为空 | 确认执行过 `pm2 save`（见第 4 节） |
| pm2 命令找不到 | 见第 2 节 PATH 说明，用完整路径 `...\npm\pm2.cmd` |
| 局域网连不上 | 确认防火墙放行 `18543`；用服务器真实内网 IP（非 localhost）连接 |

## 11. 卸载 pm2（可选）

```bash
pm2 delete aimemory-mcp   # 先从 pm2 移除服务
pm2 kill                  # 停止 pm2 守护进程
npm uninstall -g pm2      # 卸载
```

> 若已创建开机自启计划任务，一并删除：`schtasks /Delete /TN pm2-resurrect /F`。

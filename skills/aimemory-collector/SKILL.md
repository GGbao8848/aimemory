---
name: aimemory-collector
description: 在本机部署/管理 aimemory L0 会话采集器（把 Codex / Claude Code / ZCode 的原始会话自动备份到 aimemory 服务端）。适用时机：用户说"部署会话备份/上传会话/把会话存到记忆库/装采集器/开 L0 采集/停掉会话采集"，或询问"会话有没有在备份/采集器状态/积压/最近上传"。由 agent 执行安装、状态检查与卸载。
metadata:
  cli_version: ">=0.2.14"
  category: memory
user-invocable: true
---

# aimemory-collector（会话自动备份 · 部署与运维）

把本机 agent 的**原始会话**自动采集并上传到 aimemory 服务端归档（L0 层）。只做采集与上传，
**不参与任何 LLM 提炼与 embedding**——归档的是一手原始数据，供审计、回放与后续 L1/L2 重放。

> ⚠️ **这是高影响操作**：会安装一个常驻后台服务（pm2）并注册开机自启，且用户的一句
> "帮我部署" 会让 agent 自动跑完全程。因此下面第 2 步的 dry-run 报告**必须**先给用户看、
> 得到确认后才能执行安装。
>
> ⚠️ **数据范围**：采集的是本机全部 agent 会话原文（含粘贴的代码、可能的口令、内部文档）。
> 安装前向用户明确这一点，并确认本机 Token 有效。

## 何时部署 / 何时不部署

| 情形 | 建议 |
|---|---|
| 用户希望会话历史不丢、可回溯 | 部署 |
| 用户要求"原始会话别参与 AI 加工" | 正合本方案（采集器不做提炼） |
| 用户只想让 agent 记住要点 | **不要**部署——那是已有的 `aimemory-remember` skill 的职责 |

## 第 1 步：确认前置

```bash
node -v                 # 需 ≥ 20（ZCode adapter 依赖内置 node:sqlite）
pm2 -v                  # 需已安装：npm install -g pm2
```

采集器源码需要在本机，任选其一：
- **本机已是 aimemory 仓库**：直接用仓库里的 `collector/`（推荐）。
- **只有普通用户机**：从服务端/仓库取 `collector/` 目录（Zip 或 git clone），放到一个固定路径。

## 第 2 步：dry-run 报告（必须先给用户确认）

先探测本机有哪些 agent 数据、各会采到多少，**不改动任何东西**：

```bash
cd <仓库或采集器所在目录>
node collector/index.js --dry-run
```

`--dry-run` 输出各 agent 的可采记录数/批次数（游标从零起算的冷启动全量口径），
不写 state、不上传。设备码与设备信息用 `--status` 查看（首次运行即生成，之后稳定不变）。每台机器
部署时会得到不同的设备码，服务端据此归类——用户可在任意一台机器的 Web「会话归档」页看到每台机器
分别做了什么。

同时报告将发生的事：
1. 安装常驻 pm2 服务 `aimemory-collector`（崩溃自动重启、开机自启）
2. 写入状态目录 `~/.aimemory-collector/`（设备身份 + 游标 + 上传队列）
3. 采集范围：本机 `<检测到的 agent>` 的会话原文，每 15 秒一轮增量上传
4. **不上传**：任何 `~/.ssh`、配置密钥、credentials 等非会话文件

将以上四项列给用户，**等用户明确同意再继续**。

## 第 3 步：签发本机 Token

引导用户到 Web「接入 Token」页新建一枚（命名建议 `collector-<主机名>`），复制明文。
Token 名称**必须**填写；本机每台设备用一枚，便于日后单独吊销。也可复用已签发在用的 Token。

## 第 4 步：安装

```bash
cd <仓库根目录>
AIMEMORY_TOKEN=<用户提供的 m0-xxx> \
AIMEMORY_SERVER_URL=http://<服务端IP>:18543 \
AIMEMORY_DEVICE_LABEL=<人类可读的设备名，如"张三的笔记本"> \
pm2 start collector/ecosystem.config.js --only aimemory-collector && pm2 save
```

`pm2 save` 才会注册开机自启（否则重启机器后采集停摆，Claude 有 30 天清理窗口，会永久丢数据）。
建议给设备起个可读名（`AIMEMORY_DEVICE_LABEL`），否则界面里只显示主机名，多机时不好分辨。

## 第 5 步：验证（必做，别只看"启动成功"）

```bash
pm2 logs aimemory-collector --lines 20     # 应看到「采集 N 条 | 上传 M 批」
node collector/index.js --status           # 本机 + 服务端双向对账
```

`--status` 输出里重点看：
- `token_set: true`、`last_upload_error: null`
- `queue_batches` 应逐步趋近 0（首次全量回填会有一段时间积压，正常）
- `remote.records` / `remote.batches` 在增长 = 服务端确实收到了

若 `queue_batches` 一直不降，看 `last_upload_error`：401 → Token 错；连不上 → 服务端地址错。

**首次全量回填会吃内存**：把存量会话（单机实测 3.5 万条 / 147MB）过一遍，峰值约 400MB，
V8 扩张后不立即归还（稳态会回落到 ~110MB）。若 `pm2 describe` 里 `restarts` 在回填期间增长、
而**错误日志为空**，就是 `max_memory_restart` 设太小被 SIGKILL（不是代码崩溃）。默认配置给了
700M，一般无需调整；资源紧张的机器可调 `AIMEMORY_BATCH_BYTES` 减小批次或分批部署。

## 日常运维

```bash
node collector/index.js --status      # 状态与对账（只读，不加锁，可随时跑）
pm2 logs aimemory-collector           # 实时日志
pm2 restart aimemory-collector        # 重启（状态在 ~/.aimemory-collector，不会丢）
pm2 stop aimemory-collector           # 临时停采
```

## 卸载

```bash
pm2 delete aimemory-collector && pm2 save
rm -rf ~/.aimemory-collector          # 删除本机游标与待传队列
```

服务端已归档的数据**不会**因卸载而删除（那正是备份的目的）。如用户要求一并清除服务端归档，
需另行确认——那是不可逆操作，且要逐个会话删除。

## 硬约束（务必知道）

- **Claude Code 默认 30 天清理**会话文件 → 采集器要尽早装、长期跑，晚装一天就永久缺那一天的历史。
- **同一台机器只能跑一个采集器实例**：新实例检测到 `state.lock` 会拒绝启动（防状态互相覆盖）；
  进程被 `kill -9` 后残留的锁会由下次启动自动接管，无需手工清理。
- **不碰源数据**：采集器只读 agent 的数据文件（ZCode 的 DB 以只读方式打开），绝不修改。
- **稳态无空转写盘**：没有新会话时采集器不会反复写状态文件。
- **设备身份在状态目录里**（`~/.aimemory-collector/device.json`）：删掉状态目录 = 变成新设备，
  服务端会把旧会话当新数据重传一遍。若确实要重装又不想重复，先记下原设备码并在安装时
  用 `AIMEMORY_DEVICE_CODE=<原设备码>` 固定身份。

## 与其他 skill 的关系

| 用户想要 | 用哪个 |
|---|---|
| 会话不丢、可回溯、跨机可查 | 本 skill（L0 原始会话备份） |
| 让 agent 记住要点、下次自动想起 | `aimemory-remember` / `aimemory-recall`（L2 记忆） |
| 管理已有记忆的增删改查 | `aimemory` |

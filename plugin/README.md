# aimemory · 客户端插件（ZCode + Claude Code）

让 agent 跨会话记住部署经验、踩坑记录、项目约定与个人偏好，基于公司内网的 [aimemory](../README.md) 记忆服务。

**双客户端支持**：同一份 `plugin/` 目录同时兼容 ZCode 与 Claude Code——skill 与 `/aimemory` 命令两端共享；MCP 服务器按各客户端标准方式接入（见下）。

```
plugin/
├── .zcode-plugin/plugin.json      # ZCode 插件清单（含 userConfig：server_url / api_key）
├── .claude-plugin/
│   ├── plugin.json                # Claude Code 插件清单（skill + 命令，共享组件）
│   └── marketplace.json           # Claude Code 本地 marketplace 声明
├── .mcp.json                      # MCP 服务器声明（ZCode 侧，${user_config.*} 注入）
├── skills/aimemory/SKILL.md       # 记忆使用准则（两端共享）
├── commands/
│   ├── aimemory.md                # /aimemory 总览与记忆操作（两端共享）
│   └── aimemory-key.md            # /aimemory-key 首次配置引导（两端共享）
└── README.md                      # 本文档
```

## 一、ZCode 安装（MCP 一键注入）

1. **获取插件目录**：从公司分发渠道获取本 `plugin/` 目录（局域网 Git 或拷贝）。
2. **添加为本地 marketplace**：ZCode → Settings → Plugin Management → Discover →「+」→ **Add local folder** → 指向本 `plugin/` 目录 → 确认。
3. **安装 aimemory 插件** → 运行 **`/aimemory-key`** 按引导配好个人 API Key。
4. `/aimemory status` 验证连通（MCP 工具自动注册：`add_memory` / `search_memories` / `get_memories` / `get_memory` / `update_memory` / `delete_memory`）。

密钥在 **Settings → Plugin Management → aimemory → 设置** 里填（`server_url` 保持管理员给的内网地址，`api_key` 填 Web 平台生成的 `m0-xxx`）。

## 二、Claude Code 安装（skill/命令 + 标准 MCP 配置）

> Claude Code 的插件机制不认 ZCode 的 `userConfig` 密钥注入，所以 **skill 与命令走插件，MCP 服务器走 Claude 标准配置**。两步配合使用。

**第 1 步：装插件（拿到 skill 与 /aimemory 命令）**

```bash
# 把 plugin/ 添加为本地 marketplace 并安装（路径换成你的实际位置）
claude plugin marketplace add /path/to/aimemory/plugin
claude plugin install aimemory
```

> 若你的版本 `claude plugin marketplace add` 不支持相对 `source: "./"`，把 `plugin/.claude-plugin/marketplace.json` 的 `plugins[0].source` 改为绝对路径或按 `claude plugin --help` 调整。安装后 `/aimemory`、`/aimemory-key` 命令与 aimemory skill 可用。

**第 2 步：配置 MCP 服务器（标准方式，二选一）**

方式 A · 命令行（生成密钥后执行）：

```bash
claude mcp add aimemory \
  --transport http \
  --url http://192.168.161.73:18543/mcp \
  --header "Authorization: Token m0-你的密钥"
```

方式 B · `~/.claude/settings.json`（推荐用环境变量，密钥不落配置文件）：

```json
{
  "mcpServers": {
    "aimemory": {
      "type": "http",
      "url": "http://192.168.161.73:18543/mcp",
      "headers": { "Authorization": "Token {env:AIMEMORY_API_KEY}" }
    }
  }
}
```

对应在 `~/.zshrc` 里 `export AIMEMORY_API_KEY=m0-你的密钥`。

> 各版本的 MCP 配置细节以 `claude mcp --help` / 官方文档为准。

**第 3 步**：让 agent 说一句"用 aimemory 记忆测试一下"验证 skill 与工具是否都生效。

## 三、首次配置（两端通用）

1. 浏览器打开 `http://<服务器>:18543` → 「通过登录平台登录」→ 公司统一账号登录。
2. 「🔑 接入密钥」→ 命名（如 `zcode` / `claude`）→ 生成 → **立即复制 `m0-xxx` 明文**（只显示一次）。
3. 按上面的对应客户端方式填入密钥。
4. 验证：`/aimemory status`（ZCode）或让 agent 调一次 `get_memories`（Claude）。

> 密钥只存在本机，只用于访问你自己的记忆；泄漏时去 Web 平台「吊销」立即失效。

## 四、使用

- 装好后无需手动指挥：agent 读 SKILL 会在合适时机自动写/查记忆（部署经验、踩坑、项目约定、偏好）。
- 手动操作：`/aimemory list` / `/aimemory search <关键词>` / `/aimemory add <内容>`。

## 五、分发方式（管理员）

- **局域网 Git 分发（推荐）**：员工 `git clone` / `git pull` 公司内网 aimemory 仓库，按上文对应客户端安装。更新 = 拉取主仓库。
- **将来独立插件市场**：把整个 `plugin/` 目录抽成独立仓库即可（`.zcode-plugin/` 与 `.claude-plugin/` 均为标准格式，抽出即用）。

## 六、双客户端差异速查

| | ZCode | Claude Code |
|---|---|---|
| 插件（skill/命令） | ✅ 完整 | ✅ 完整 |
| MCP 服务器 | 插件自动注册 | 标准配置（claude mcp add / settings.json） |
| 密钥注入 | 插件设置里填 `api_key` | 环境变量 `AIMEMORY_API_KEY` 或命令参数 |
| 组件文件 | 共享 `skills/` `commands/` | 共享同一份 |

## 七、安全

- 记忆按登录用户隔离（Keycloak 身份 + API Key 双重绑定），跨用户访问被服务端拒绝。
- 不把密码/密钥写进记忆内容（遵循 SKILL 安全红线）。
- API Key 泄漏：Web 平台一键吊销，立即失效。

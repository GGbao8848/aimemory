# aimemory plugin

为 agent（ZCode / Claude Code 等）提供 **持久化记忆能力** 的插件。解决"智能体不记得用记忆库"的问题——通过 skill 让记忆行为**被动触发**，通过 AGENTS.md 让 agent **持续知道**有记忆库。

## 组成

```
plugin/
├── plugin.json      # 插件声明（skills 装配）
├── .mcp.json        # 声明 aimemory MCP server（生产地址）
├── AGENTS.md        # 常驻引导：agent 何时查/存记忆
└── skills/
    ├── aimemory-recall/    # 任务开始自动加载相关记忆（只读）
    ├── aimemory-remember/  # 关键信息自动沉淀（messages 批量提炼）
    └── aimemory/           # 记忆库管理（查/列/改/删/清空）
```

## 依赖

- 已部署的 aimemory 服务（`http://<内网IP>:18543`），参见仓库根 README
- 已生成的 `m0-xxx` API Key（Web 平台生成）
- ZCode 客户端（或支持 skill 的 agent 客户端）

## 安装

### 方式 A：ZCode 全局 skill（最简单）

把 `skills/` 下的三个 skill 目录拷到 ZCode 用户 skill 目录：

```bash
cp -r plugin/skills/aimemory* ~/.agents/skills/
```

同时确保 MCP 已配置（ZCode `config.json` 的 `mcp.servers.aimemory`）：
```json
{
  "mcp": {
    "servers": {
      "aimemory": {
        "type": "http",
        "url": "http://<内网IP>:18543/mcp",
        "headers": { "Authorization": "Token m0-xxx" }
      }
    }
  }
}
```

重启 ZCode 客户端后生效（skill 在会话启动时扫描加载）。

### 方式 B：作为 ZCode 插件

- 本目录是标准 ZCode 插件结构（`plugin.json` + `"skills": "skills"`）
- 将 `.mcp.json` 中的 `${AIMEMORY_MCP_URL}` / `${MEM0_API_KEY}` 替换为实际值（或配置对应环境变量/用户配置）
- 通过 ZCode 插件市场/本地插件机制安装

## 使用效果

| 场景 | 之前（无插件） | 之后（有插件） |
|---|---|---|
| 开始新任务 | agent 不查历史，可能重复踩坑 | `aimemory-recall` 自动加载相关记忆 |
| 用户说"记住XXX" | 可能忽略或存错地方 | `aimemory-remember` 自动提炼入库 |
| 问"我之前说过什么" | agent 记不得 | `aimemory` 检索返回 |
| 跨会话一致性 | 每次重新开始 | 记忆跨会话持久，语义可检索 |

## 安全

- `AGENTS.md` 和 skills 不含任何真实 key（key 只通过 MCP 配置注入）
- 记忆按用户隔离，skill 只操作当前用户数据
- 删除/清空操作在 skill 中要求用户确认

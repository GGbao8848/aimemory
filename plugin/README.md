# aimemory plugin

为 agent（ZCode / Claude Code 等）提供 **持久化记忆能力** 的插件。解决"智能体不记得用记忆库"的问题——通过 skill 让记忆行为**被动触发**，通过 SessionStart hook 自动检查接入密钥。

> **本目录是插件的唯一事实源**（skills / hooks / scripts 都在此维护）。公司插件市场（br-ai-portal）只做分发口，构建时从这里取包，不在别处维护副本。

## 组成（ZCode 插件标准结构）

```
plugin/
├── .zcode-plugin/plugin.json   # 插件清单（ZCode 市场安装用：skills 装配）
├── .mcp.json                   # MCP server 声明（安装时注入密钥）
├── AGENTS.md                   # 常驻引导：agent 何时查/存记忆
├── hooks/hooks.json            # SessionStart hook：启动检查接入密钥状态
├── scripts/
│   ├── check.js                # hook 调用的密钥检测（未授权→注入提示）
│   └── connect.js              # 设备流自动授权（浏览器点一次确认→写密钥）
└── skills/
    ├── aimemory-recall/        # 任务开始自动加载相关记忆（只读）
    ├── aimemory-remember/      # 关键信息自动沉淀（messages 批量提炼）
    └── aimemory/               # 记忆库管理（查/列/改/删/导出）
```

## 依赖

- 已部署的 aimemory 服务（`http://<内网IP>:18543`），参见仓库根 README
- ZCode 客户端（或支持 skill / hooks 的 agent 客户端）

## 安装（推荐：公司插件市场）

公司统一入口是 **br-ai-portal 插件市场**（`http://<内网IP>:18765/market`），它只做引流口，包体构建时从本目录同步。在 ZCode 中：
1. 添加本地目录市场源：指向市场构建产物 `dist/market/`（含 `marketplace.json`）
2. 安装 aimemory 插件 → 自动装配 skills + MCP + hooks
3. 会话启动时 hook 自动检查密钥：未授权 → 提示运行 `connect.js` 完成设备流授权（用户浏览器点一次确认）

## 安装（备选：手动拷贝，仅 skills）

```bash
cp -r plugin/skills/aimemory* ~/.zcode/skills/
```
同时确保 `~/.zcode/cli/config.json` 的 `mcp.servers.aimemory` 已配置 `Authorization: Token m0-xxx`。
> 注意：手动拷贝**不含 hooks 与自动授权脚本**；要完整能力（自动授权）请走市场安装。

## 使用效果

| 场景 | 之前（无插件） | 之后（有插件） |
|---|---|---|
| 开始新任务 | agent 不查历史，可能重复踩坑 | `aimemory-recall` 自动加载相关记忆 |
| 用户说"记住XXX" | 可能忽略或存错地方 | `aimemory-remember` 自动提炼入库 |
| 问"我之前说过什么" | agent 记不得 | `aimemory` 检索返回 |
| 换新设备/重装 | 手动配 key 易出错 | SessionStart hook 检测 + 一键自动授权 |

## 安全

- 仓库内不含任何真实 key（key 只通过授权流程注入用户本机 config）
- 记忆按员工隔离，skill 只操作当前用户数据
- 删除/清空操作在 skill 中要求用户确认
- hook 异常静默，不阻塞会话

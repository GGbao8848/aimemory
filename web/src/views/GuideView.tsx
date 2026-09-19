export default function GuideView({ active }: { active: boolean }) {
  return (
    <section className={active ? 'view view-active' : 'view'}>
      <div className="card">
        <h2>📦 配套技能下载</h2>
        <p className="muted">
          零内部代码、零敏感配置，只描述记忆库工具编排与沉淀/召回流程。下载后放入 skills 目录或上传安装，agent
          即自动获得记忆读写能力（含 <code>aimemory</code> 管理 / <code>aimemory-recall</code> 自动召回 /{' '}
          <code>aimemory-remember</code> 自动沉淀，以及 <code>aimemory-collector</code> 会话自动备份部署）。技能源码同仓维护：
          <a href="https://github.com/GGbao8848/aimemory" target="_blank" rel="noopener"> GitHub · skills/</a>
        </p>
        <div className="skill-dl-actions">
          <a className="btn btn-primary" href="/skill/download" download>⬇ 下载 Skill（zip）</a>
          <a className="btn btn-ghost" href="/skill/SKILL.md" target="_blank" rel="noopener">查看 SKILL.md</a>
        </div>
      </div>

      <div className="card">
        <h2>🔌 MCP 接入步骤</h2>
        <ol className="steps">
          <li>
            <b>签发 Token</b>：登录后切到「接入 Token」，<b>填写名称</b>（必填）新建一枚；建议为每个客户端分别新建（命名区分），
            明文在创建响应里给出一次，请立即复制保存
          </li>
          <li><b>复制配置</b>：「MCP 配置」里复制完整 JSON（含本次新建的 Token），或切「手动模式」按字段复制</li>
          <li><b>填入客户端</b>：把 JSON 或字段粘贴到你的 agent 的 MCP 客户端配置（Claude Code / Codex / BR-Agent 自定义连接器…）</li>
          <li><b>验证</b>：agent 调用 <code>add_memory</code> 提交一条素材（等 AI 提炼完成后），再到本平台「我的记忆」确认</li>
        </ol>
        <p className="muted small">
          可同时持有多枚 Token，按客户端 / 设备分发、单独吊销；任一枚泄露只波及它自己。MCP 端点：
          <code>http://&lt;服务器内网IP&gt;:18543/mcp</code>
        </p>
      </div>

      <div className="card">
        <h2>🧰 MCP 工具一览</h2>
        <ul className="tool-list">
          <li><code>add_memory</code> — 提交素材（text / messages），AI 提炼成记忆后入库</li>
          <li><code>get_event_status</code> — 查询素材提炼状态（提炼需数秒）</li>
          <li><code>search_memories</code> — 语义 + 关键词混合检索（支持中文子串）</li>
          <li><code>get_memories</code> / <code>get_memory</code> — 列出 / 查看单条</li>
          <li><code>update_memory</code> / <code>delete_memory</code> — 修正 / 删除</li>
          <li><code>list_session_summaries</code> / <code>get_session_summary</code> — L1 会话摘要</li>
          <li><code>recall_context</code> — L3 画像只读注入（零 LLM）</li>
        </ul>
        <p className="muted small">
          所有记忆归属同一个账本，跨设备、跨 agent 共享。
        </p>
      </div>
    </section>
  );
}

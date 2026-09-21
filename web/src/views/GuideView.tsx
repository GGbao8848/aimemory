import { CheckIcon, CopyIcon, Download, FileText } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { copyText } from '../lib/dom';

const BASE = typeof window !== 'undefined' ? window.location.origin : 'http://127.0.0.1:18543';

const REST_EXAMPLES: { title: string; desc: string; code: string }[] = [
  {
    title: '写入记忆（异步提炼）',
    desc: 'messages 或 text 二选一；返回 event_id，用 GET /v1/event/{event_id} 轮询到 done/failed。',
    code: `curl -X POST ${BASE}/v1/memories/ \\
  -H "Authorization: Token m0-xxx" -H "Content-Type: application/json" \\
  -d '{"messages":[{"role":"user","content":"我们把网关迁到了 10.10.10.146"}],
       "user_id":"owner","agent_id":"zcode","run_id":"session-42"}'`,
  },
  {
    title: '写入记忆（原文直存，不经 LLM）',
    desc: 'infer=false 同步返回 results，适合已有明确结论的场景。',
    code: `curl -X POST ${BASE}/v1/memories/ \\
  -H "Authorization: Token m0-xxx" -H "Content-Type: application/json" \\
  -d '{"text":"部署端口钉死 18543","user_id":"owner","infer":false}'`,
  },
  {
    title: '语义检索',
    desc: '混合检索：向量语义 + FTS 关键词；filters 至少含一个实体维度。',
    code: `curl -X POST ${BASE}/v2/memories/search/ \\
  -H "Authorization: Token m0-xxx" -H "Content-Type: application/json" \\
  -d '{"query":"网关部署在哪","filters":{"user_id":"owner"},"top_k":5}'`,
  },
  {
    title: '列出 / 更新 / 删除 / 历史',
    desc: 'get_all 分页（count/next/previous）；update 与 delete 都会写入变更历史。',
    code: `curl -X POST ${BASE}/v2/memories/ \\
  -H "Authorization: Token m0-xxx" -H "Content-Type: application/json" \\
  -d '{"filters":{"user_id":"owner","agent_id":"zcode"},"page":1,"page_size":20}'

curl -X PUT ${BASE}/v1/memories/<id>/ \\
  -H "Authorization: Token m0-xxx" -H "Content-Type: application/json" \\
  -d '{"text":"更新后的记忆文本"}'

curl -X DELETE ${BASE}/v1/memories/<id>/ -H "Authorization: Token m0-xxx"

curl ${BASE}/v1/memories/<id>/history/ -H "Authorization: Token m0-xxx"`,
  },
];

function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await copyText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch { /* 浏览器限制时静默 */ }
  };
  return (
    <div className="relative">
      <pre className="bg-muted overflow-x-auto rounded-md p-3 pr-12 font-mono text-xs leading-relaxed">{code}</pre>
      <Button variant="ghost" size="icon" className="absolute top-1.5 right-1.5" onClick={copy} aria-label="复制">
        {copied ? <CheckIcon /> : <CopyIcon />}
      </Button>
    </div>
  );
}

export default function GuideView({ active }: { active: boolean }) {
  return (
    <div className={active ? 'flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto' : 'hidden'}>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">配套 Skill（给 agent 装上“会用记忆库”的能力）</CardTitle>
          <CardDescription>
            下载 <code className="font-mono">aimemory-skills.zip</code>，解压后把 <code className="font-mono">aimemory/</code> 目录放入
            agent 的 skills 目录（Claude Code / ZCode / Codex 等均支持），或在上传安装入口直接上传该 zip。
            skill 内含 SKILL.md 与 <code className="font-mono">references/</code>（召回 / 沉淀 / 管理三篇按需读）。
            安装后 agent 会自动在合适时机检索与沉淀长期记忆，无需手动配置。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {/* 公开端点：无需登录，直接附件下载 */}
          <Button asChild>
            <a href="/skill/download" download>
              <Download /> 下载 Skill 包（zip）
            </a>
          </Button>
          <Button variant="outline" asChild>
            <a href="/skill/SKILL.md" target="_blank" rel="noreferrer">
              <FileText /> 预览 SKILL.md
            </a>
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">鉴权方式</CardTitle>
          <CardDescription>
            与 mem0 相同的 Token 头：<code className="font-mono">Authorization: Token m0-xxx</code>
            （在「接入 Token」页签发）。本服务为个人自托管：记忆归属 Token 持有者，
            user_id 必须省略或与之一致；agent_id / run_id 是自由标签维度，用于区分写入来源。
          </CardDescription>
        </CardHeader>
      </Card>

      {REST_EXAMPLES.map((ex) => (
        <Card key={ex.title}>
          <CardHeader>
            <CardTitle className="text-base">{ex.title}</CardTitle>
            <CardDescription>{ex.desc}</CardDescription>
          </CardHeader>
          <CardContent>
            <CodeBlock code={ex.code} />
          </CardContent>
        </Card>
      ))}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">MCP 接入（agent 端）</CardTitle>
          <CardDescription>
            端点 <code className="font-mono">{BASE}/mcp</code>（Streamable HTTP），7 个工具：
            add_memory / get_event_status / search_memories / get_memories / get_memory / update_memory / delete_memory。
            完整配置模板见「接入 Token」页。
          </CardDescription>
        </CardHeader>
      </Card>
    </div>
  );
}

import { SearchIcon, Send } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { post } from '../api/client';
import { endpoints, type AcceptResult, type Mem0Memory } from '../api/contract';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

interface SearchResult extends Mem0Memory {
  score?: number;
}

export default function PlaygroundView({ active }: { active: boolean }) {
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [material, setMaterial] = useState('');
  const [adding, setAdding] = useState(false);

  const search = async () => {
    if (!query.trim()) return;
    setSearching(true);
    try {
      const r = await post<{ results: SearchResult[] }>('/v2/memories/search', {
        query: query.trim(),
        top_k: 10,
      });
      setResults(r.results);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSearching(false);
    }
  };

  const add = async () => {
    if (!material.trim()) return;
    setAdding(true);
    try {
      await post<AcceptResult>(endpoints.memories(), { text: material.trim() });
      toast.success('素材已受理，后台提炼中——稍后用检索验证召回');
      setMaterial('');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className={active ? 'flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto' : 'hidden'}>
      <div className="grid gap-3 xl:grid-cols-2">
        <Card className="gap-3 px-4 py-3">
          <span className="text-sm font-semibold">语义检索测试</span>
          <p className="text-muted-foreground text-xs">
            用口语化说法试试能否命中（向量语义召回 + 关键词兜底），如库里存的是"部署端口 18543"，可以搜"服务跑在哪个口"。
          </p>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <SearchIcon className="text-muted-foreground absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
              <Input
                className="pl-8"
                placeholder="要找什么…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && search()}
              />
            </div>
            <Button onClick={search} disabled={searching || !query.trim()}>
              {searching ? '检索中…' : '检索'}
            </Button>
          </div>
          {results !== null && (
            <div className="flex flex-col gap-2">
              {results.length === 0 ? (
                <p className="text-muted-foreground text-xs">没有命中——换个说法，或先写入相关记忆。</p>
              ) : (
                results.map((r) => (
                  <div key={r.id} className="border-border rounded-md border px-3 py-2">
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <span className="text-muted-foreground font-mono">score {r.score != null ? r.score.toFixed(3) : '—'}</span>
                      <div className="flex gap-1">
                        {(r.categories || []).slice(0, 2).map((c) => <Badge key={c} variant="secondary">{c}</Badge>)}
                        {(r.entities || []).slice(0, 3).map((e) => <Badge key={e} variant="outline">{e}</Badge>)}
                      </div>
                    </div>
                    <p className="mt-1 text-sm">{r.memory}</p>
                  </div>
                ))
              )}
            </div>
          )}
        </Card>

        <Card className="gap-3 px-4 py-3">
          <span className="text-sm font-semibold">写入素材测试</span>
          <p className="text-muted-foreground text-xs">
            提交一段素材，与 MCP add_memory 完全同语义：后台 LLM 提炼成事实、消解冲突、抽取实体与分类后入库。
          </p>
          <Textarea
            rows={6}
            placeholder="例如：我把 aimemory 的数据库备份改到了每天凌晨 3 点。"
            value={material}
            onChange={(e) => setMaterial(e.target.value)}
          />
          <Button onClick={add} disabled={adding || !material.trim()} className="self-start">
            <Send /> {adding ? '提交中…' : '提交素材'}
          </Button>
        </Card>
      </div>
    </div>
  );
}

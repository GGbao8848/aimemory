import { HistoryIcon, PencilIcon, PlusIcon, RefreshCwIcon, SearchIcon, Trash2Icon } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { get, patch, post, del } from '../api/client';
import { endpoints, type AcceptResult, type EventStatus, type Memory, type MemoryListResult } from '../api/contract';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { fmtCompactTime } from '../lib/format';
import { eventStatusLabel, filterByScope, historyMeta, scopeOptions, type Scope } from '../lib/memories';
import { useEnterReload } from '../lib/hooks';

const PAGE_SIZE = 10;

interface Mem0HistoryRow {
  id: string;
  event: string;
  old_memory: string | null;
  new_memory: string | null;
  created_at: string;
}

interface Props {
  active: boolean;
}

export default function MemoriesView({ active }: Props) {
  const [data, setData] = useState<MemoryListResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [scope, setScope] = useState<Scope>({ agentId: null, runId: null });
  const [error, setError] = useState<string | null>(null);

  // 新增素材
  const [addOpen, setAddOpen] = useState(false);
  const [addText, setAddText] = useState('');
  const [adding, setAdding] = useState(false);
  const [pendingEvent, setPendingEvent] = useState<string | null>(null);

  // 编辑 / 删除 / 历史
  const [editing, setEditing] = useState<Memory | null>(null);
  const [editText, setEditText] = useState('');
  const [deleting, setDeleting] = useState<Memory | null>(null);
  const [historyOf, setHistoryOf] = useState<Memory | null>(null);
  const [history, setHistory] = useState<Mem0HistoryRow[] | null>(null);

  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    const url = query.trim()
      ? `${endpoints.memories()}?q=${encodeURIComponent(query.trim())}`
      : `${endpoints.memories()}?page=${page}&page_size=${PAGE_SIZE}`;
    get<MemoryListResult>(url)
      .then(setData)
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [query, page]);

  useEnterReload(active, reload);

  // 异步提炼事件轮询：到终态即刷新列表（素材受理 ≠ 入库，必须等到 done/failed）
  useEffect(() => {
    if (!pendingEvent) return;
    const timer = setInterval(async () => {
      try {
        const { event } = await get<{ event: EventStatus }>(endpoints.event(pendingEvent));
        if (event.status === 'done' || event.status === 'failed') {
          clearInterval(timer);
          setPendingEvent(null);
          reload();
        }
      } catch { /* 轮询失败下一轮重试 */ }
    }, 2000);
    return () => clearInterval(timer);
  }, [pendingEvent, reload]);

  const allMemories = data?.results ?? [];
  const scoped = filterByScope(allMemories, scope);
  const scopes = scopeOptions(allMemories);

  const submitAdd = async () => {
    if (!addText.trim()) return;
    setAdding(true);
    setError(null);
    try {
      const r = await post<AcceptResult>(endpoints.memories(), { text: addText.trim() });
      setAddText('');
      setAddOpen(false);
      if (r.event_id) setPendingEvent(r.event_id);
      reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAdding(false);
    }
  };

  const submitEdit = async () => {
    if (!editing || !editText.trim()) return;
    try {
      await patch(endpoints.memory(editing.id), { text: editText.trim() });
      setEditing(null);
      reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      await del(endpoints.memory(deleting.id));
      setDeleting(null);
      reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  // 变更历史走 /v1 面（mem0 语义），同源 fetch 自动带会话 cookie
  const openHistory = async (m: Memory) => {
    setHistoryOf(m);
    setHistory(null);
    try {
      const r = await fetch(`/v1/memories/${encodeURIComponent(m.id)}/history/`);
      setHistory(r.ok ? ((await r.json()) as Mem0HistoryRow[]) : []);
    } catch {
      setHistory([]);
    }
  };

  return (
    <div className={active ? 'flex flex-col gap-4' : 'hidden'}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <SearchIcon className="text-muted-foreground absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
          <Input
            className="pl-8"
            placeholder="搜索记忆…"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setPage(1); }}
            onKeyDown={(e) => e.key === 'Enter' && reload()}
          />
        </div>
        {scopes.agents.length > 0 && (
          <select
            className="border-input bg-background h-9 rounded-md border px-2 text-sm"
            value={scope.agentId ?? ''}
            onChange={(e) => setScope((s) => ({ ...s, agentId: e.target.value || null }))}
            aria-label="按 agent 过滤"
          >
            <option value="">全部 agent</option>
            {scopes.agents.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        )}
        {scopes.runs.length > 0 && (
          <select
            className="border-input bg-background h-9 max-w-44 rounded-md border px-2 text-sm"
            value={scope.runId ?? ''}
            onChange={(e) => setScope((s) => ({ ...s, runId: e.target.value || null }))}
            aria-label="按 run 过滤"
          >
            <option value="">全部 run</option>
            {scopes.runs.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        )}
        <Button variant="outline" size="icon" onClick={reload} aria-label="刷新">
          <RefreshCwIcon />
        </Button>
        <Button onClick={() => setAddOpen(true)}>
          <PlusIcon /> 新增记忆
        </Button>
      </div>

      {pendingEvent && (
        <Card className="flex-row items-center gap-2 px-4 py-3 text-sm">
          <span className="bg-success size-2 animate-pulse rounded-full" />
          素材已受理，后台 LLM 提炼中（{eventStatusLabel('processing')}）…
        </Card>
      )}
      {error && <Card className="border-destructive px-4 py-3 text-sm text-destructive">{error}</Card>}

      {loading && !data ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-20 w-full" />)}
        </div>
      ) : scoped.length === 0 ? (
        <Card className="items-center gap-2 py-12 text-center">
          <p className="font-medium">{query ? '没有匹配的记忆' : '还没有记忆'}</p>
          <p className="text-muted-foreground text-sm">
            {query ? '换个关键词试试。' : '在上方新增一条，或用 mem0 API / MCP 让 agent 写入（POST /v1/memories/）。'}
          </p>
        </Card>
      ) : (
        <div className="flex flex-col gap-2">
          {scoped.map((m) => (
            <Card key={m.id} className="gap-2 px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <p className="text-sm leading-relaxed whitespace-pre-wrap">{m.text}</p>
                <div className="flex shrink-0 gap-1">
                  <Button variant="ghost" size="icon" aria-label="变更历史" onClick={() => openHistory(m)}>
                    <HistoryIcon />
                  </Button>
                  <Button variant="ghost" size="icon" aria-label="编辑" onClick={() => { setEditing(m); setEditText(m.text); }}>
                    <PencilIcon />
                  </Button>
                  <Button variant="ghost" size="icon" aria-label="删除" onClick={() => setDeleting(m)}>
                    <Trash2Icon className="text-destructive" />
                  </Button>
                </div>
              </div>
              <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
                <span>{fmtCompactTime(m.updated_at)}</span>
                {m.agent_id && <Badge variant="secondary">{m.agent_id}</Badge>}
                {m.run_id && <Badge variant="outline">{m.run_id}</Badge>}
                {Object.keys(m.metadata || {}).length > 0 && (
                  <Badge variant="outline">{JSON.stringify(m.metadata)}</Badge>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}

      {!query && data && data.total > PAGE_SIZE && (
        <div className="flex items-center justify-center gap-3 text-sm">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            上一页
          </Button>
          <span className="text-muted-foreground">
            第 {page} / {Math.max(1, Math.ceil(data.total / PAGE_SIZE))} 页 · 共 {data.total} 条
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= Math.ceil(data.total / PAGE_SIZE)}
            onClick={() => setPage((p) => p + 1)}
          >
            下一页
          </Button>
        </div>
      )}

      {/* 新增素材（异步受理：202 ≠ 入库，等事件终态后自动刷新） */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新增记忆素材</DialogTitle>
            <DialogDescription>
              提交后由后台 LLM 提炼入库（不存原文），与 agent 经 API/MCP 写入的语义一致。
            </DialogDescription>
          </DialogHeader>
          <Textarea
            rows={5}
            placeholder="要记住的内容…"
            value={addText}
            onChange={(e) => setAddText(e.target.value)}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>取消</Button>
            <Button onClick={submitAdd} disabled={adding || !addText.trim()}>
              {adding ? '提交中…' : '提交'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 编辑 */}
      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>编辑记忆</DialogTitle>
            <DialogDescription>改文本后服务端会异步做一次「同一事实」重消解。</DialogDescription>
          </DialogHeader>
          <Textarea rows={5} value={editText} onChange={(e) => setEditText(e.target.value)} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>取消</Button>
            <Button onClick={submitEdit} disabled={!editText.trim()}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认（AlertDialog 替代 window.confirm） */}
      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除这条记忆？</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting?.text.slice(0, 120)}
              {deleting && deleting.text.length > 120 ? '…' : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={confirmDelete}>
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 变更历史（mem0 语义：ADD/UPDATE/DELETE 留痕） */}
      <Dialog open={!!historyOf} onOpenChange={(o) => !o && setHistoryOf(null)}>
        <DialogContent className="max-h-[70vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>变更历史</DialogTitle>
            <DialogDescription>这条记忆的每次新增/更新/删除留痕（新 → 旧）。</DialogDescription>
          </DialogHeader>
          {history === null ? (
            <Skeleton className="h-24 w-full" />
          ) : history.length === 0 ? (
            <p className="text-muted-foreground text-sm">暂无历史记录。</p>
          ) : (
            <ol className="flex flex-col gap-3">
              {history.map((h) => {
                const meta = historyMeta(h.event);
                return (
                  <li key={h.id} className="border-border flex flex-col gap-1 border-l pl-3">
                    <div className="flex items-center gap-2">
                      <Badge variant={meta.variant}>{meta.label}</Badge>
                      <span className="text-muted-foreground text-xs">{fmtCompactTime(h.created_at)}</span>
                    </div>
                    {h.old_memory && <p className="text-muted-foreground text-xs line-through">{h.old_memory}</p>}
                    {h.new_memory && <p className="text-sm">{h.new_memory}</p>}
                  </li>
                );
              })}
            </ol>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

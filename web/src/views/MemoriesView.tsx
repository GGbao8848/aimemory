import { HistoryIcon, PencilIcon, PlusIcon, RefreshCwIcon, SearchIcon, Trash2Icon } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { get, patch, post, del } from '../api/client';
import {
  endpoints, type AcceptResult, type EntityInfo, type EntityScope, type EventStatus, type Memory, type MemoryListResult,
} from '../api/contract';
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
import { fmtFullTime } from '../lib/format';
import { eventStatusLabel, historyMeta, originMeta } from '../lib/memories';
import { useEnterReload } from '../lib/hooks';

/** 初始每页条数；实际容量由一屏自适应逻辑实测调整 */
const INITIAL_PAGE_SIZE = 12;
/** 自适应上限：防止内容极短时把太多条塞进一页 */
const MAX_PAGE_SIZE = 50;

interface Mem0HistoryRow {
  id: string;
  event: string;
  old_memory: string | null;
  new_memory: string | null;
  created_at: string;
}

interface Props {
  active: boolean;
  /** 实体页跳转过来的聚焦作用域（消费后回调置空） */
  focusScope?: { type: 'agent' | 'run'; name: string } | null;
  onFocusScopeConsumed?: () => void;
}

/** 表格行/表头列宽（与 mem0 控制台的列结构对齐：记忆 | 分类 | Agent | Run | 时间 | 操作） */
const COLS = 'minmax(0,1fr) 150px 110px 110px 150px 76px';
const ROW_GRID = { display: 'grid', gridTemplateColumns: COLS, gap: '0.75rem', alignItems: 'center' };

function Chips({ items, variant, empty }: { items: string[]; variant: 'secondary' | 'outline'; empty: string }) {
  if (!items.length) return <span className="text-muted-foreground/60 text-xs">{empty}</span>;
  return (
    <div className="flex flex-wrap items-center gap-1 overflow-hidden">
      {items.slice(0, 3).map((c) => (
        <Badge key={c} variant={variant} className="max-w-full truncate" title={c}>{c}</Badge>
      ))}
      {items.length > 3 && <span className="text-muted-foreground text-xs">+{items.length - 3}</span>}
    </div>
  );
}

export default function MemoriesView({ active, focusScope, onFocusScopeConsumed }: Props) {
  const [data, setData] = useState<MemoryListResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(INITIAL_PAGE_SIZE);
  const [entityFilter, setEntityFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [agentFilter, setAgentFilter] = useState('');
  const [runFilter, setRunFilter] = useState('');
  const [keywordList, setKeywordList] = useState<EntityInfo[]>([]);
  const [categoryList, setCategoryList] = useState<EntityInfo[]>([]);
  const [scopeList, setScopeList] = useState<EntityScope[]>([]);
  const [error, setError] = useState<string | null>(null);

  // 一屏自适应：列表容器（定高）与行列表（实测各行高度）
  const listWrapRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const lastFetchedSize = useRef<number>(INITIAL_PAGE_SIZE);
  const [resizeTick, setResizeTick] = useState(0);

  // 新增素材
  const [addOpen, setAddOpen] = useState(false);
  const [addText, setAddText] = useState('');
  const [adding, setAdding] = useState(false);
  const [pendingEvent, setPendingEvent] = useState<string | null>(null);

  // 编辑 / 删除 / 详情
  const [editing, setEditing] = useState<Memory | null>(null);
  const [editText, setEditText] = useState('');
  const [deleting, setDeleting] = useState<Memory | null>(null);
  const [detail, setDetail] = useState<Memory | null>(null);
  const [history, setHistory] = useState<Mem0HistoryRow[] | null>(null);

  // opts.*：翻页/容量/过滤变化时显式传参（setState 后闭包里是旧值，必须带参）
  const reload = useCallback((opts: { page?: number; pageSize?: number; entity?: string | null; category?: string | null; agent?: string | null; run?: string | null } = {}) => {
    setLoading(true);
    setError(null);
    const target = opts.page ?? page;
    const size = opts.pageSize ?? pageSize;
    const ent = opts.entity !== undefined ? opts.entity : entityFilter;
    const cat = opts.category !== undefined ? opts.category : categoryFilter;
    const agt = opts.agent !== undefined ? opts.agent : agentFilter;
    const run = opts.run !== undefined ? opts.run : runFilter;
    const sp = new URLSearchParams();
    if (query.trim()) sp.set('q', query.trim());
    sp.set('page', String(target));
    sp.set('page_size', String(size));
    if (ent) sp.set('entity', ent);
    if (cat) sp.set('category', cat);
    if (agt) sp.set('agent_id', agt);
    if (run) sp.set('run_id', run);
    get<MemoryListResult>(`${endpoints.memories()}?${sp}`)
      .then(setData)
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [query, page, pageSize, entityFilter, categoryFilter, agentFilter, runFilter]);

  useEnterReload(active, reload);

  // 过滤下拉（进入视图时拉一次）：作用域（agent/run）+ 关键词 + 分类
  useEffect(() => {
    if (!active) return;
    get<{ results: EntityScope[] }>(endpoints.entities()).then((r) => setScopeList(r.results)).catch(() => {});
    get<{ results: EntityInfo[] }>(endpoints.keywords()).then((r) => setKeywordList(r.results)).catch(() => {});
    get<{ results: EntityInfo[] }>(endpoints.categories()).then((r) => setCategoryList(r.results)).catch(() => {});
  }, [active, data]);

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

  // 窗口/布局变化时重新实测容量
  useEffect(() => {
    const wrap = listWrapRef.current;
    if (!wrap || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setResizeTick((t) => t + 1));
    ro.observe(wrap);
    return () => ro.disconnect();
  }, []);

  // 一屏容量自适应：渲染后实测行高，装不下则缩 pageSize，整页放下且富余一行则加大
  useLayoutEffect(() => {
    const wrap = listWrapRef.current;
    const list = listRef.current;
    if (!wrap || !list || !data || loading) return;
    if (query.trim()) return; // 搜索模式列表可滚动，不参与自适应
    const all = Array.from(list.querySelectorAll('[data-row="1"]')) as HTMLElement[];
    if (!all.length) return;
    const GAP = 2; // 行间 gap-0.5
    const H = wrap.clientHeight;
    let used = 0;
    let fitted = 0;
    for (const c of all) {
      const h = c.getBoundingClientRect().height;
      if (fitted > 0 && used + GAP + h > H) break;
      used = fitted === 0 ? h : used + GAP + h;
      fitted += 1;
    }
    if (fitted < all.length && fitted < pageSize) {
      const maxPage = Math.max(1, Math.ceil((data.total || 0) / fitted));
      setPage((p) => Math.min(p, maxPage));
      setPageSize(fitted);
      return;
    }
    if (
      fitted === all.length &&
      all.length === pageSize &&
      page * pageSize < data.total &&
      pageSize < MAX_PAGE_SIZE
    ) {
      const avg = used / fitted;
      const slack = H - used;
      if (slack >= avg + GAP) setPageSize(pageSize + 1);
    }
  }, [data, loading, query, page, pageSize, resizeTick]);

  // 容量变化后按新 page_size 重新取数（进入视图的首取由 useEnterReload 负责）
  useEffect(() => {
    if (query.trim()) return;
    if (lastFetchedSize.current === pageSize) return;
    lastFetchedSize.current = pageSize;
    reload({ page, pageSize });
  }, [pageSize, query, page, reload]);

  // agent/run/关键词/分类均已在服务端过滤，这里直接渲染整页结果
  const scoped = data?.results ?? [];

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
      if (detail?.id === deleting.id) setDetail(null);
      reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  // 行点击 → 详情抽屉（含事件时间线；mem0 的 Memory Details 语义）
  const openDetail = async (m: Memory) => {
    setDetail(m);
    setHistory(null);
    try {
      const r = await fetch(`/v1/memories/${encodeURIComponent(m.id)}/history/`);
      setHistory(r.ok ? ((await r.json()) as Mem0HistoryRow[]) : []);
    } catch {
      setHistory([]);
    }
  };

  const pickEntity = (v: string) => { setEntityFilter(v); setPage(1); reload({ page: 1, entity: v }); };
  const pickCategory = (v: string) => { setCategoryFilter(v); setPage(1); reload({ page: 1, category: v }); };
  const pickAgent = (v: string) => { setAgentFilter(v); setPage(1); reload({ page: 1, agent: v }); };
  const pickRun = (v: string) => { setRunFilter(v); setPage(1); reload({ page: 1, run: v }); };

  // 实体页钻取：把要聚焦的作用域（agent/run）应用到服务端过滤并取数（仅激活时消费）
  useEffect(() => {
    if (!active || !focusScope) return;
    if (focusScope.type === 'agent') pickAgent(focusScope.name);
    else pickRun(focusScope.name);
    onFocusScopeConsumed?.();
    // pick*/onFocusScopeConsumed 随渲染变化，刻意不进依赖：只响应 focusScope 变化
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, focusScope]);

  return (
    <div className={active ? 'flex min-h-0 flex-1 flex-col gap-3 overflow-hidden' : 'hidden'}>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <div className="relative min-w-52 flex-1">
          <SearchIcon className="text-muted-foreground absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
          <Input
            className="pl-8"
            placeholder="搜索记忆…"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setPage(1); }}
            onKeyDown={(e) => e.key === 'Enter' && reload({ page: 1 })}
          />
        </div>
        <select
          className="border-input bg-background h-9 max-w-44 rounded-md border px-2 text-sm"
          value={categoryFilter}
          onChange={(e) => pickCategory(e.target.value)}
          aria-label="按分类过滤"
        >
          <option value="">全部分类</option>
          {categoryList.map((c) => <option key={c.name} value={c.name}>{c.name} ({c.count})</option>)}
        </select>
        <select
          className="border-input bg-background h-9 max-w-44 rounded-md border px-2 text-sm"
          value={entityFilter}
          onChange={(e) => pickEntity(e.target.value)}
          aria-label="按关键词过滤"
        >
          <option value="">全部关键词</option>
          {keywordList.map((e) => <option key={e.name} value={e.name}>{e.name} ({e.count})</option>)}
        </select>
        <select
          className="border-input bg-background h-9 rounded-md border px-2 text-sm"
          value={agentFilter}
          onChange={(e) => pickAgent(e.target.value)}
          aria-label="按 agent 过滤"
        >
          <option value="">全部 agent</option>
          {scopeList.filter((s) => s.type === 'agent').map((s) => (
            <option key={s.name} value={s.name}>{s.name} ({s.memories})</option>
          ))}
        </select>
        <select
          className="border-input bg-background h-9 max-w-40 rounded-md border px-2 text-sm"
          value={runFilter}
          onChange={(e) => pickRun(e.target.value)}
          aria-label="按 run 过滤"
        >
          <option value="">全部 run</option>
          {scopeList.filter((s) => s.type === 'run').map((s) => (
            <option key={s.name} value={s.name}>{s.name} ({s.memories})</option>
          ))}
        </select>
        <Button variant="outline" size="icon" onClick={() => reload()} aria-label="刷新">
          <RefreshCwIcon />
        </Button>
        <Button onClick={() => setAddOpen(true)}>
          <PlusIcon /> 新增记忆
        </Button>
      </div>

      {pendingEvent && (
        <Card className="flex-row shrink-0 items-center gap-2 px-4 py-2.5 text-sm">
          <span className="bg-success size-2 animate-pulse rounded-full" />
          素材已受理，后台 LLM 提炼中（{eventStatusLabel('processing')}）…
        </Card>
      )}
      {error && <Card className="border-destructive shrink-0 px-4 py-2.5 text-sm text-destructive">{error}</Card>}

      {loading && !data ? (
        <div className="flex shrink-0 flex-col gap-2">
          {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-10 w-full" />)}
        </div>
      ) : scoped.length === 0 ? (
        <Card className="shrink-0 items-center gap-2 py-12 text-center">
          <p className="font-medium">{query || entityFilter || categoryFilter ? '没有匹配的记忆' : '还没有记忆'}</p>
          <p className="text-muted-foreground text-sm">
            {query || entityFilter || categoryFilter
              ? '换个搜索词或清空过滤器试试。'
              : '在上方新增一条，或用 mem0 API / MCP 让 agent 写入（POST /v1/memories/）。'}
          </p>
        </Card>
      ) : (
        <div
          ref={listWrapRef}
          className={`border-border bg-card min-h-0 flex-1 rounded-lg border ${query.trim() ? 'overflow-y-auto' : 'overflow-hidden'}`}
        >
          {/* 表头 */}
          <div
            className="text-muted-foreground border-b px-4 py-2 text-xs font-medium tracking-wide"
            style={ROW_GRID}
          >
            <span>记忆</span>
            <span>分类</span>
            <span>Agent</span>
            <span>Run</span>
            <span>更新时间</span>
            <span className="text-right">操作</span>
          </div>
          <div ref={listRef} className="flex flex-col gap-0.5 p-1.5">
            {scoped.map((m) => (
              <div
                key={m.id}
                data-row="1"
                className="hover:bg-accent/60 cursor-pointer rounded-md px-3 py-2"
                style={ROW_GRID}
                onClick={() => openDetail(m)}
              >
                <p className="min-w-0 truncate text-sm" title={m.text}>{m.text}</p>
                <Chips items={m.categories || []} variant="secondary" empty="—" />
                <span className="text-muted-foreground truncate text-xs" title={m.agent_id || ''}>{m.agent_id || '—'}</span>
                <span className="text-muted-foreground truncate text-xs" title={m.run_id || ''}>{m.run_id || '—'}</span>
                <span className="text-muted-foreground truncate text-xs" title={fmtFullTime(m.updated_at)}>{fmtFullTime(m.updated_at)}</span>
                <div
                  className="flex justify-end gap-0.5"
                  onClick={(e) => e.stopPropagation()}
                >
                  <Button variant="ghost" size="icon" className="size-7" aria-label="详情" onClick={() => openDetail(m)}>
                    <HistoryIcon className="size-3.5" />
                  </Button>
                  <Button variant="ghost" size="icon" className="size-7" aria-label="编辑" onClick={() => { setEditing(m); setEditText(m.text); }}>
                    <PencilIcon className="size-3.5" />
                  </Button>
                  <Button variant="ghost" size="icon" className="size-7" aria-label="删除" onClick={() => setDeleting(m)}>
                    <Trash2Icon className="text-destructive size-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {!query && data && data.total > pageSize && (
        <div className="flex shrink-0 items-center justify-center gap-3 text-sm">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => {
              const p = page - 1;
              setPage(p);
              reload({ page: p });
            }}
          >
            上一页
          </Button>
          <span className="text-muted-foreground">
            第 {page} / {Math.max(1, Math.ceil(data.total / pageSize))} 页 · 共 {data.total} 条 · 每页 {pageSize} 条
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= Math.ceil(data.total / pageSize)}
            onClick={() => {
              const p = page + 1;
              setPage(p);
              reload({ page: p });
            }}
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

      {/* 详情抽屉（mem0 Memory Details：全文 + 元数据 + 实体/分类 + 事件时间线） */}
      <Dialog open={!!detail} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent className="max-h-[80vh] max-w-2xl overflow-y-auto">
          {detail && (
            <>
              <DialogHeader>
                <DialogTitle>记忆详情</DialogTitle>
                <DialogDescription className="sr-only">这条记忆的完整内容与变更历史。</DialogDescription>
              </DialogHeader>
              <div className="flex flex-col gap-4">
                <p className="text-sm leading-relaxed whitespace-pre-wrap">{detail.text}</p>
                <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
                  {(() => {
                    const o = originMeta(detail.origin);
                    return <Badge variant={o.variant}>{o.label}</Badge>;
                  })()}
                  <span>创建 {fmtFullTime(detail.created_at)}</span>
                  <span>更新 {fmtFullTime(detail.updated_at)}</span>
                  {detail.agent_id && <Badge variant="secondary">{detail.agent_id}</Badge>}
                  {detail.run_id && <Badge variant="outline">{detail.run_id}</Badge>}
                </div>
                {(detail.categories?.length || detail.entities?.length) ? (
                  <div className="flex flex-col gap-2 text-xs">
                    {!!detail.categories?.length && (
                      <div className="flex flex-wrap items-center gap-1">
                        <span className="text-muted-foreground mr-1">分类</span>
                        {detail.categories.map((c) => <Badge key={c} variant="secondary">{c}</Badge>)}
                      </div>
                    )}
                    {!!detail.entities?.length && (
                      <div className="flex flex-wrap items-center gap-1">
                        <span className="text-muted-foreground mr-1">实体</span>
                        {detail.entities.map((e) => <Badge key={e} variant="outline">{e}</Badge>)}
                      </div>
                    )}
                  </div>
                ) : null}
                {Object.keys(detail.metadata || {}).length > 0 && (
                  <div className="flex flex-col gap-1 text-xs">
                    <span className="text-muted-foreground">元数据</span>
                    <pre className="bg-muted overflow-x-auto rounded-md p-3 text-xs">{JSON.stringify(detail.metadata, null, 2)}</pre>
                  </div>
                )}
                <div className="flex flex-col gap-2">
                  <span className="text-muted-foreground text-xs">事件时间线</span>
                  {history === null ? (
                    <Skeleton className="h-16 w-full" />
                  ) : history.length === 0 ? (
                    <p className="text-muted-foreground text-xs">暂无历史记录。</p>
                  ) : (
                    <ol className="flex flex-col gap-2.5">
                      {history.map((h) => {
                        const meta = historyMeta(h.event);
                        return (
                          <li key={h.id} className="border-border flex flex-col gap-1 border-l pl-3">
                            <div className="flex items-center gap-2">
                              <Badge variant={meta.variant}>{meta.label}</Badge>
                              <span className="text-muted-foreground text-xs">{fmtFullTime(h.created_at)}</span>
                            </div>
                            {h.old_memory && <p className="text-muted-foreground text-xs line-through">{h.old_memory}</p>}
                            {h.new_memory && <p className="text-xs">{h.new_memory}</p>}
                          </li>
                        );
                      })}
                    </ol>
                  )}
                </div>
              </div>
            </>
          )}
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
    </div>
  );
}

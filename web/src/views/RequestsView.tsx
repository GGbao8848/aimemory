import { RefreshCwIcon } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { get } from '../api/client';
import { endpoints, type OpsPage } from '../api/contract';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { fmtFullTime } from '../lib/format';
import { historyMeta } from '../lib/memories';
import { useEnterReload } from '../lib/hooks';

const PAGE_SIZE = 20;

export default function RequestsView({ active }: { active: boolean }) {
  const [data, setData] = useState<OpsPage | null>(null);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback((p = page) => {
    get<OpsPage>(`${endpoints.ops()}?page=${p}&page_size=${PAGE_SIZE}`)
      .then((d) => { setData(d); setError(null); })
      .catch((e) => setError((e as Error).message));
  }, [page]);

  useEnterReload(active, reload);
  useEffect(() => { if (active) reload(page); }, [page]); // 翻页取数

  const rows = data?.results ?? [];
  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <div className={active ? 'flex min-h-0 flex-1 flex-col gap-3 overflow-hidden' : 'hidden'}>
      <div className="flex shrink-0 items-center justify-between">
        <p className="text-muted-foreground text-sm">共 {data?.total ?? 0} 条变更记录</p>
        <Button variant="outline" size="icon" onClick={() => reload()} aria-label="刷新">
          <RefreshCwIcon />
        </Button>
      </div>

      {error && <Card className="border-destructive shrink-0 px-4 py-2.5 text-sm text-destructive">{error}</Card>}

      {!data ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-9 w-full" />)}
        </div>
      ) : rows.length === 0 ? (
        <Card className="shrink-0 py-12 text-center text-sm">还没有活动记录。</Card>
      ) : (
        <div className="border-border bg-card min-h-0 flex-1 overflow-y-auto rounded-lg border">
          <div className="text-muted-foreground grid grid-cols-[90px_minmax(0,1fr)_110px_110px_150px] gap-3 border-b px-4 py-2 text-xs font-medium">
            <span>操作</span>
            <span>内容</span>
            <span>来源</span>
            <span>状态</span>
            <span className="text-right">时间</span>
          </div>
          <div className="flex flex-col gap-0.5 p-1.5">
            {rows.map((r) => {
              const meta = historyMeta(r.op);
              return (
                <div
                  key={r.id}
                  className="hover:bg-accent/60 grid grid-cols-[90px_minmax(0,1fr)_110px_110px_150px] items-center gap-3 rounded-md px-3 py-2"
                  title={r.op === 'DELETE' ? `已删除：${r.before_text || ''}` : r.after_text || ''}
                >
                  <Badge variant={meta.variant}>{meta.label}</Badge>
                  <p className="min-w-0 truncate text-sm">
                    {r.op === 'DELETE' ? <span className="text-muted-foreground line-through">{r.before_text}</span> : r.after_text}
                  </p>
                  <span className="text-muted-foreground truncate text-xs">{r.source}</span>
                  <span className="text-xs">
                    {r.applied
                      ? <Badge variant="success">已生效</Badge>
                      : <Badge variant="outline" title="判定被安全阀拦下，未执行">被拦截</Badge>}
                  </span>
                  <span className="text-muted-foreground truncate text-right text-xs" title={fmtFullTime(r.created_at)}>
                    {fmtFullTime(r.created_at)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {data && data.total > PAGE_SIZE && (
        <div className="flex shrink-0 items-center justify-center gap-3 text-sm">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>上一页</Button>
          <span className="text-muted-foreground">第 {page} / {totalPages} 页 · 共 {data.total} 条</span>
          <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>下一页</Button>
        </div>
      )}
    </div>
  );
}

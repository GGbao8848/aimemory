import { ArchiveRestore, RefreshCwIcon, RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { get, post } from '../api/client';
import { endpoints, type RawMaterial, type RawMaterialPage } from '../api/contract';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { fmtFullTime } from '../lib/format';
import { eventStatusLabel } from '../lib/memories';
import { useEnterReload } from '../lib/hooks';

const PAGE_SIZE = 20;

function statusBadge(status: RawMaterial['status']) {
  if (status === 'none') return <Badge variant="outline" title="事件已随清理删除，但原文仍在归档">已过队列</Badge>;
  const tone = status === 'done' ? 'success' : status === 'failed' ? 'destructive' : 'secondary';
  return <Badge variant={tone as 'success' | 'destructive' | 'secondary'}>{eventStatusLabel(status)}</Badge>;
}

export default function ArchivesView({ active }: { active: boolean }) {
  const [data, setData] = useState<RawMaterialPage | null>(null);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [reextracting, setReextracting] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);

  const reload = useCallback((p = page) => {
    get<RawMaterialPage>(`${endpoints.rawMaterials()}?page=${p}&page_size=${PAGE_SIZE}`)
      .then((d) => { setData(d); setError(null); setSelected(new Set()); })
      .catch((e) => setError((e as Error).message));
  }, [page]);

  useEnterReload(active, reload);
  useEffect(() => { if (active) reload(page); }, [page]); // 翻页取数

  const rows = data?.results ?? [];
  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;
  const allChecked = rows.length > 0 && rows.every((r) => selected.has(r.id));

  const toggle = (id: string) => {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const reextract = async (payload: { ids?: string[]; all?: boolean }, done: () => void) => {
    setReextracting(true);
    try {
      const r = await post<{ accepted: number; deleted: number }>(endpoints.rawReextract(), payload);
      toast.success(`已受理重提 ${r.accepted} 份素材（删除旧产物 ${r.deleted} 条），后台串行重新提炼`);
      done();
      reload();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setReextracting(false);
    }
  };

  return (
    <div className={active ? 'flex min-h-0 flex-1 flex-col gap-3 overflow-hidden' : 'hidden'}>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
        <p className="text-muted-foreground text-sm">
          共 {data?.total ?? 0} 份素材原文 · 重提 = 删除该素材提炼的旧记忆后按原文重新提炼（直存/手工记忆不受影响）
        </p>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={reextracting || selected.size === 0}
            onClick={() => reextract({ ids: [...selected] }, () => setSelected(new Set()))}
          >
            <RotateCcw /> 批量重提{selected.size > 0 ? `（${selected.size}）` : ''}
          </Button>
          <Button variant="outline" size="sm" className="text-destructive" disabled={reextracting} onClick={() => setConfirmAll(true)}>
            <ArchiveRestore /> 全库重提
          </Button>
          <Button variant="outline" size="icon" onClick={() => reload()} aria-label="刷新">
            <RefreshCwIcon />
          </Button>
        </div>
      </div>

      {error && <Card className="border-destructive shrink-0 px-4 py-2.5 text-sm text-destructive">{error}</Card>}

      {!data ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-10 w-full" />)}
        </div>
      ) : rows.length === 0 ? (
        <Card className="shrink-0 py-12 text-center text-sm">
          <p className="font-medium">还没有归档素材</p>
          <p className="text-muted-foreground mt-1 text-xs">
            agent 经 API/MCP 提交素材后会自动归档在这里（保留期 RAW_ARCHIVE_DAYS，默认 90 天）。
          </p>
        </Card>
      ) : (
        <div className="border-border bg-card min-h-0 flex-1 overflow-y-auto rounded-lg border">
          <div className="text-muted-foreground grid grid-cols-[32px_150px_minmax(0,1fr)_90px_90px_76px] items-center gap-3 border-b px-4 py-2 text-xs font-medium">
            <input
              type="checkbox"
              aria-label="全选本页"
              checked={allChecked}
              onChange={() => setSelected(allChecked ? new Set() : new Set(rows.map((r) => r.id)))}
            />
            <span>时间</span>
            <span>素材原文</span>
            <span>提炼状态</span>
            <span>关联记忆</span>
            <span className="text-right">操作</span>
          </div>
          <div className="flex flex-col gap-0.5 p-1.5">
            {rows.map((r) => {
              const text = r.kind === 'messages'
                ? (JSON.parse(r.input) as { content: string }[]).map((m) => m.content).join(' / ')
                : r.input;
              return (
                <div
                  key={r.id}
                  className="hover:bg-accent/60 grid grid-cols-[32px_150px_minmax(0,1fr)_90px_90px_76px] items-center gap-3 rounded-md px-3 py-2"
                >
                  <input type="checkbox" aria-label={`选择 ${r.id}`} checked={selected.has(r.id)} onChange={() => toggle(r.id)} />
                  <span className="text-muted-foreground truncate text-xs" title={fmtFullTime(r.created_at)}>{fmtFullTime(r.created_at)}</span>
                  <p className="min-w-0 truncate text-sm" title={text}>{text}</p>
                  {statusBadge(r.status)}
                  <span className="text-muted-foreground text-xs">{r.memory_count} 条</span>
                  <div className="flex justify-end">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      aria-label="重提"
                      title="删除该素材提炼的记忆并重新提炼"
                      disabled={reextracting}
                      onClick={() => reextract({ ids: [r.id] }, () => {})}
                    >
                      <RotateCcw className="size-3.5" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {data && data.total > PAGE_SIZE && (
        <div className="flex shrink-0 items-center justify-center gap-3 text-sm">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>上一页</Button>
          <span className="text-muted-foreground">第 {page} / {totalPages} 页 · 共 {data.total} 份</span>
          <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>下一页</Button>
        </div>
      )}

      <AlertDialog open={confirmAll} onOpenChange={setConfirmAll}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>全库重提所有素材？</AlertDialogTitle>
            <AlertDialogDescription>
              将删除全部由素材提炼的记忆，并按原文重新提炼入库（直存与手工添加的记忆不受影响）。
              适用于换了模型或对提炼结果整体不满意。素材较多时后台会串行提炼较长时间；
              重提后低于重要性门槛的素材将不再产生记忆（宁缺毋滥）。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={reextracting}
              onClick={() => { setConfirmAll(false); reextract({ all: true }, () => {}); }}
            >
              全库重提
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

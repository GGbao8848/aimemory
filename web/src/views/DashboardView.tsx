import { Boxes, BrainCircuit, KeyRound, RefreshCwIcon, Zap } from 'lucide-react';
import { useCallback, useState } from 'react';
import { get } from '../api/client';
import { endpoints, type DashboardStats } from '../api/contract';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { fmtFullTime } from '../lib/format';
import { historyMeta } from '../lib/memories';
import { useEnterReload } from '../lib/hooks';

function StatCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: number | string }) {
  return (
    <Card className="flex-row items-center gap-3 px-4 py-3">
      <div className="bg-primary/10 text-primary rounded-lg p-2">{icon}</div>
      <div>
        <p className="text-muted-foreground text-xs">{label}</p>
        <p className="text-xl font-semibold">{value}</p>
      </div>
    </Card>
  );
}

export default function DashboardView({ active }: { active: boolean }) {
  const [data, setData] = useState<DashboardStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    get<DashboardStats>(endpoints.dashboard())
      .then((d) => { setData(d); setError(null); })
      .catch((e) => setError((e as Error).message));
  }, []);

  useEnterReload(active, reload);

  if (!data) {
    return (
      <div className={active ? 'flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto' : 'hidden'}>
        {error && <Card className="border-destructive px-4 py-2.5 text-sm text-destructive">{error}</Card>}
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-16 w-full" />)}
        </div>
      </div>
    );
  }

  const maxDaily = Math.max(1, ...data.daily.map((d) => d.n));
  const days: Record<string, number> = {};
  for (const d of data.daily) days[d.day] = d.n;
  const trend = Array.from({ length: 14 }, (_, i) => {
    const day = new Date(Date.now() - (13 - i) * 24 * 3600 * 1000).toISOString().slice(0, 10);
    return { day, n: days[day] || 0 };
  });

  return (
    <div className={active ? 'flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto' : 'hidden'}>
      <div className="flex justify-end">
        <Button variant="outline" size="icon" onClick={reload} aria-label="刷新">
          <RefreshCwIcon />
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <StatCard icon={<BrainCircuit className="size-4" />} label="记忆总数" value={data.memories} />
        <StatCard icon={<Boxes className="size-4" />} label="实体" value={data.entities} />
        <StatCard icon={<KeyRound className="size-4" />} label="生效 Token" value={data.keys} />
        <StatCard icon={<Zap className="size-4" />} label="30 天操作" value={data.ops30.total} />
      </div>

      <div className="grid gap-2 lg:grid-cols-[1fr_320px]">
        <Card className="gap-3 px-4 py-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold">近 14 天操作趋势</span>
            <span className="text-muted-foreground text-xs">
              新增 {data.ops30.ADD} · 更新 {data.ops30.UPDATE} · 删除 {data.ops30.DELETE}
            </span>
          </div>
          <div className="flex h-24 items-end gap-1">
            {trend.map((d) => (
              <div key={d.day} className="flex h-full flex-1 flex-col justify-end" title={`${d.day}：${d.n} 次操作`}>
                <div
                  className="bg-primary/70 rounded-sm"
                  style={{ height: `${Math.max(4, (d.n / maxDaily) * 100)}%` }}
                />
              </div>
            ))}
          </div>
          <div className="text-muted-foreground flex justify-between text-[10px]">
            <span>{trend[0]?.day.slice(5)}</span>
            <span>{trend[trend.length - 1]?.day.slice(5)}</span>
          </div>
        </Card>

        <Card className="gap-2 px-4 py-3">
          <span className="text-sm font-semibold">提炼队列</span>
          <div className="text-muted-foreground grid grid-cols-3 gap-2 text-center text-xs">
            <div><p className="text-foreground text-lg font-semibold">{data.backlog.pending}</p>排队中</div>
            <div><p className="text-foreground text-lg font-semibold">{data.backlog.processing}</p>提炼中</div>
            <div><p className="text-foreground text-lg font-semibold">{data.backlog.failed}</p>失败</div>
          </div>
          <p className="text-muted-foreground text-xs">
            队列长期积压说明提炼服务（模型设置里的对话模型）不可用，检索不受影响。
          </p>
        </Card>
      </div>

      <Card className="flex-col gap-2 px-4 py-3">
        <span className="text-sm font-semibold">最近活动</span>
        {data.recent.length === 0 ? (
          <p className="text-muted-foreground text-xs">还没有记忆变更记录。</p>
        ) : (
          <ol className="flex flex-col gap-1.5">
            {data.recent.map((r) => (
              <li key={r.id} className="flex items-center gap-2 text-xs">
                <Badge variant={historyMeta(r.op).variant}>{historyMeta(r.op).label}</Badge>
                <span className="min-w-0 flex-1 truncate" title={r.after_text || r.before_text || ''}>
                  {r.after_text || r.before_text || '—'}
                </span>
                <span className="text-muted-foreground shrink-0">{fmtFullTime(r.created_at)}</span>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </div>
  );
}

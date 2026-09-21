import { RefreshCwIcon } from 'lucide-react';
import { useCallback, useState } from 'react';
import { get } from '../api/client';
import { endpoints, type EntityScope } from '../api/contract';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { fmtFullTime } from '../lib/format';
import { useEnterReload } from '../lib/hooks';

interface Props {
  active: boolean;
  /** 点击 Agent/Run → 跳到记忆页按该作用域过滤（user 是部署者本人，不可再分） */
  onOpen: (type: 'agent' | 'run', name: string) => void;
}

export default function EntitiesView({ active, onOpen }: Props) {
  const [scopes, setScopes] = useState<EntityScope[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    setLoading(true);
    get<{ results: EntityScope[] }>(endpoints.entities())
      .then((r) => { setScopes(r.results); setError(null); })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, []);

  useEnterReload(active, reload);

  const groups: { type: 'user' | 'agent' | 'run'; label: string; hint: string; rows: EntityScope[] }[] = [
    { type: 'user', label: '用户', hint: '记忆的归属身份（单用户部署）', rows: (scopes ?? []).filter((s) => s.type === 'user') },
    { type: 'agent', label: 'Agent', hint: '哪个 agent 写入的（agent_id 维度）', rows: (scopes ?? []).filter((s) => s.type === 'agent') },
    { type: 'run', label: 'Run', hint: '哪次会话/运行写入的（run_id 维度）', rows: (scopes ?? []).filter((s) => s.type === 'run') },
  ];

  return (
    <div className={active ? 'flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto' : 'hidden'}>
      <div className="flex shrink-0 items-center justify-between gap-2">
        <p className="text-muted-foreground text-sm">
          作用域实体：记忆按 user / agent / run 三个维度归属。点击 Agent / Run 查看其写入的记忆。
        </p>
        <Button variant="outline" size="icon" onClick={reload} aria-label="刷新">
          <RefreshCwIcon />
        </Button>
      </div>

      {error && <Card className="border-destructive shrink-0 px-4 py-2.5 text-sm text-destructive">{error}</Card>}

      {loading && !scopes ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-12 w-full" />)}
        </div>
      ) : !scopes ? null : (
        groups.map((group) => (
          <Card key={group.type} className="gap-1 px-0 py-0 overflow-hidden">
            <div className="flex items-baseline justify-between border-b px-4 py-2">
              <span className="text-sm font-semibold">{group.label}</span>
              <span className="text-muted-foreground text-xs">{group.hint}</span>
            </div>
            {group.rows.length === 0 ? (
              <p className="text-muted-foreground px-4 py-3 text-xs">
                {group.type === 'user' ? '还没有记忆。' : `还没有 ${group.label} 维度的记忆（写入时带 ${group.type}__id 即会聚合到这里）。`}
              </p>
            ) : (
              <div className="flex flex-col">
                {group.rows.map((s) => {
                  const clickable = group.type !== 'user';
                  return (
                    <div
                      key={`${s.type}:${s.name}`}
                      className={`grid grid-cols-[minmax(0,1fr)_100px_170px] items-center gap-3 px-4 py-2.5 ${clickable ? 'hover:bg-accent/60 cursor-pointer' : ''}`}
                      onClick={clickable ? () => onOpen(group.type as 'agent' | 'run', s.name) : undefined}
                    >
                      <p className="min-w-0 truncate text-sm font-medium" title={s.name}>{s.name}</p>
                      <span className="text-muted-foreground text-xs">{s.memories} 条记忆</span>
                      <span className="text-muted-foreground truncate text-right text-xs" title={fmtFullTime(s.last_updated)}>
                        {fmtFullTime(s.last_updated)}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        ))
      )}
    </div>
  );
}

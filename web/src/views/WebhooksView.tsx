import { ExternalLink, PlusIcon, RefreshCwIcon, ScrollTextIcon, Trash2Icon } from 'lucide-react';
import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { del, get, patch, post } from '../api/client';
import {
  endpoints, type WebhookDelivery, type WebhookInfo,
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
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { fmtFullTime } from '../lib/format';
import { historyMeta } from '../lib/memories';
import { useEnterReload } from '../lib/hooks';

const EVENT_TYPES = ['ADD', 'UPDATE', 'DELETE'] as const;

export default function WebhooksView({ active }: { active: boolean }) {
  const [hooks, setHooks] = useState<WebhookInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [created, setCreated] = useState<WebhookInfo | null>(null); // 创建成功 → 展示 secret
  const [form, setForm] = useState({ url: '', description: '', events: ['ADD', 'UPDATE', 'DELETE'] as string[] });
  const [submitting, setSubmitting] = useState(false);
  const [deleting, setDeleting] = useState<WebhookInfo | null>(null);
  const [deliveriesOf, setDeliveriesOf] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<WebhookDelivery[] | null>(null);

  const reload = useCallback(() => {
    get<{ results: WebhookInfo[] }>(endpoints.webhooks())
      .then((r) => { setHooks(r.results); setError(null); })
      .catch((e) => setError((e as Error).message));
  }, []);

  useEnterReload(active, reload);

  const toggleEvents = (ev: string) => {
    setForm((f) => ({
      ...f,
      events: f.events.includes(ev) ? f.events.filter((e) => e !== ev) : [...f.events, ev],
    }));
  };

  const submitCreate = async () => {
    setSubmitting(true);
    try {
      const hook = await post<WebhookInfo>(endpoints.webhooks(), form);
      setCreateOpen(false);
      setForm({ url: '', description: '', events: ['ADD', 'UPDATE', 'DELETE'] });
      setCreated(hook);
      reload();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const toggleEnabled = async (hook: WebhookInfo) => {
    try {
      await patch(endpoints.webhook(hook.id), { enabled: !hook.enabled });
      reload();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      await del(endpoints.webhook(deleting.id));
      setDeleting(null);
      reload();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const openDeliveries = async (hookId: string) => {
    if (deliveriesOf === hookId) { setDeliveriesOf(null); return; }
    setDeliveriesOf(hookId);
    setDeliveries(null);
    try {
      const r = await get<{ results: WebhookDelivery[] }>(endpoints.webhookDeliveries(hookId));
      setDeliveries(r.results);
    } catch {
      setDeliveries([]);
    }
  };

  return (
    <div className={active ? 'flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto' : 'hidden'}>
      <div className="flex shrink-0 items-center justify-between gap-2">
        <p className="text-muted-foreground text-sm">
          记忆变更时向目标 URL 发 POST（HMAC-SHA256 签名头 X-Aimemory-Signature，失败自动重试 2 次）。
        </p>
        <div className="flex gap-2">
          <Button variant="outline" size="icon" onClick={reload} aria-label="刷新">
            <RefreshCwIcon />
          </Button>
          <Button onClick={() => setCreateOpen(true)}>
            <PlusIcon /> 新建 Webhook
          </Button>
        </div>
      </div>

      {error && <Card className="border-destructive shrink-0 px-4 py-2.5 text-sm text-destructive">{error}</Card>}

      {hooks !== null && hooks.length === 0 && (
        <Card className="shrink-0 py-12 text-center text-sm">
          <p className="font-medium">还没有 webhook</p>
          <p className="text-muted-foreground mt-1 text-xs">
            新建一个并填入你的接收地址（如 n8n / 自建服务），记忆每次新增、更新、删除都会通知它。
          </p>
        </Card>
      )}

      <div className="flex flex-col gap-2">
        {(hooks ?? []).map((hook) => (
          <Card key={hook.id} className="flex-col gap-2 px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <Switch checked={hook.enabled} onCheckedChange={() => toggleEnabled(hook)} aria-label="启用/停用" />
                <a
                  className="flex min-w-0 items-center gap-1 text-sm hover:underline"
                  href={hook.url}
                  target="_blank"
                  rel="noreferrer"
                  title={hook.url}
                >
                  <span className="truncate">{hook.url}</span>
                  <ExternalLink className="text-muted-foreground size-3.5 shrink-0" />
                </a>
              </div>
              <div className="flex items-center gap-2">
                {hook.events.map((ev) => (
                  <Badge key={ev} variant={historyMeta(ev).variant}>{historyMeta(ev).label}</Badge>
                ))}
                <Button variant="ghost" size="icon" className="size-7" aria-label="投递记录" onClick={() => openDeliveries(hook.id)}>
                  <ScrollTextIcon />
                </Button>
                <Button variant="ghost" size="icon" className="size-7" aria-label="删除" onClick={() => setDeleting(hook)}>
                  <Trash2Icon className="text-destructive size-3.5" />
                </Button>
              </div>
            </div>
            <p className="text-muted-foreground truncate text-xs" title={hook.secret || ''}>
              签名密钥：<span className="font-mono">{hook.secret.slice(0, 12)}…{hook.secret.slice(-4)}</span>
              <span className="ml-2">{fmtFullTime(hook.created_at)}</span>
            </p>
            {deliveriesOf === hook.id && (
              <div className="border-border flex flex-col gap-1 border-t pt-2">
                {deliveries === null ? (
                  <p className="text-muted-foreground text-xs">加载中…</p>
                ) : deliveries.length === 0 ? (
                  <p className="text-muted-foreground text-xs">还没有投递记录（记忆变更时才会有）。</p>
                ) : (
                  deliveries.map((d) => (
                    <div key={d.id} className="flex items-center gap-2 text-xs">
                      <Badge variant={d.status === 'ok' ? 'success' : 'destructive'}>
                        {d.status === 'ok' ? `✓ ${d.status_code}` : `✗ ${d.status_code ?? '超时'}`}
                      </Badge>
                      <Badge variant={historyMeta(d.op).variant}>{historyMeta(d.op).label}</Badge>
                      <span className="text-muted-foreground">{d.attempts} 次尝试</span>
                      {d.error && <span className="text-destructive min-w-0 truncate" title={d.error}>{d.error}</span>}
                      <span className="text-muted-foreground ml-auto shrink-0">{fmtFullTime(d.created_at)}</span>
                    </div>
                  ))
                )}
              </div>
            )}
          </Card>
        ))}
      </div>

      {/* 新建 */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建 Webhook</DialogTitle>
            <DialogDescription>订阅记忆变更事件，到达终态的每次变更都会推送。</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label>接收地址（URL）</Label>
              <Input placeholder="https://example.com/hook" value={form.url} onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>备注</Label>
              <Input placeholder="用途说明（可选）" value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
            </div>
            <div className="flex items-center gap-2">
              <Label>订阅事件</Label>
              {EVENT_TYPES.map((ev) => (
                <label key={ev} className="flex items-center gap-1 text-sm">
                  <input
                    type="checkbox"
                    checked={form.events.includes(ev)}
                    onChange={() => toggleEvents(ev)}
                  />
                  {historyMeta(ev).label}
                </label>
              ))}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>取消</Button>
            <Button onClick={submitCreate} disabled={submitting || !form.url.trim() || !form.events.length}>
              {submitting ? '创建中…' : '创建'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 创建成功：secret 一次性强调展示 */}
      <Dialog open={!!created} onOpenChange={(o) => !o && setCreated(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Webhook 已创建</DialogTitle>
            <DialogDescription>
              签名密钥（secret）用于在你的接收端校验 X-Aimemory-Signature。请立即保存，虽然列表里随时可见。
            </DialogDescription>
          </DialogHeader>
          <pre className="bg-muted overflow-x-auto rounded-md p-3 text-xs">{created?.secret}</pre>
          <DialogFooter>
            <Button onClick={() => setCreated(null)}>知道了</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除这个 webhook？</AlertDialogTitle>
            <AlertDialogDescription className="break-all">{deleting?.url}</AlertDialogDescription>
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

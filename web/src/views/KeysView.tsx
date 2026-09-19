import { CheckIcon, CopyIcon, DownloadIcon, KeyRound, Trash2Icon } from 'lucide-react';
import { useCallback, useState } from 'react';
import { download, get, post } from '../api/client';
import { endpoints, type KeyInfo } from '../api/contract';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { copyText } from '../lib/dom';
import { fmtTime } from '../lib/format';
import { buildMcpConfig } from '../lib/mcp-config';
import { useEnterReload } from '../lib/hooks';

interface Props {
  active: boolean;
}

export default function KeysView({ active }: Props) {
  const [keys, setKeys] = useState<KeyInfo[] | null>(null);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [plaintext, setPlaintext] = useState<string | null>(null); // 一次性明文
  const [copied, setCopied] = useState(false);
  const [revoking, setRevoking] = useState<KeyInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    get<{ results: KeyInfo[] }>(endpoints.keys())
      .then((r) => setKeys(r.results))
      .catch((e) => setError((e as Error).message));
  }, []);

  useEnterReload(active, reload);

  const create = async () => {
    const clean = name.trim();
    if (!clean) return;
    setCreating(true);
    setError(null);
    try {
      const key = await post<KeyInfo & { token: string }>(endpoints.keys(), { name: clean });
      setPlaintext(key.token);
      setName('');
      reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const confirmRevoke = async () => {
    if (!revoking) return;
    try {
      await post(endpoints.keyRevoke(revoking.id));
      setRevoking(null);
      reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const copy = async (text: string) => {
    try {
      await copyText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const mcp = buildMcpConfig({
    origin: window.location.origin,
    plaintext,
    hasKey: (keys?.length ?? 0) > 0,
  });

  return (
    <div className={active ? 'flex flex-col gap-4' : 'hidden'}>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <KeyRound className="size-4" /> 新建 Token
          </CardTitle>
          <CardDescription>
            明文只在创建响应里返回一次（服务端只存哈希），请立即复制保存。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="key-name">Token 名称</Label>
            <Input
              id="key-name"
              className="w-64"
              placeholder="如 zcode / claude-code"
              maxLength={50}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && create()}
            />
          </div>
          <Button onClick={create} disabled={creating || !name.trim()}>
            {creating ? '签发中…' : '签发 Token'}
          </Button>
          <Button variant="outline" onClick={() => download(endpoints.memoriesExport(), 'aimemory-memories.json')}>
            <DownloadIcon /> 导出全部记忆
          </Button>
        </CardContent>
      </Card>

      {plaintext && (
        <Card className="border-success">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base text-success">
              <CheckIcon className="size-4" /> Token 已创建，请立即复制（关闭后不再显示）
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-2">
            <code className="bg-muted flex-1 rounded-md px-3 py-2 font-mono text-sm break-all">{plaintext}</code>
            <Button onClick={() => copy(plaintext)}>
              {copied ? <CheckIcon /> : <CopyIcon />} 复制
            </Button>
            <Button variant="ghost" onClick={() => setPlaintext(null)}>我已保存</Button>
          </CardContent>
        </Card>
      )}

      {error && <Card className="border-destructive px-4 py-3 text-sm text-destructive">{error}</Card>}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">生效中的 Token</CardTitle>
          <CardDescription>按客户端分别签发、单独吊销；吊销不影响其他 Token。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {keys === null ? (
            <Skeleton className="h-12 w-full" />
          ) : keys.length === 0 ? (
            <p className="text-muted-foreground text-sm">还没有生效的 Token，用上方表单签发第一条。</p>
          ) : (
            keys.map((k) => (
              <div
                key={k.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2"
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{k.name}</span>
                  <Badge variant="secondary">{fmtTime(k.created_at)}</Badge>
                </div>
                <Button variant="ghost" size="sm" onClick={() => setRevoking(k)}>
                  <Trash2Icon className="text-destructive" /> 吊销
                </Button>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">MCP 接入配置</CardTitle>
          <CardDescription>
            {plaintext
              ? '下方 JSON 含本次新建的明文 Token，可直接粘贴到客户端的 mcpServers 配置。'
              : '尚无明文（明文只在创建时展示一次）。新建 Token 后可复制完整配置；也可复制模板自行填 Token。'}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <pre className="bg-muted overflow-x-auto rounded-md p-3 font-mono text-xs leading-relaxed">{mcp.json}</pre>
          <div>
            <Button variant="outline" onClick={() => copy(mcp.json)}>{copied ? <CheckIcon /> : <CopyIcon />} {mcp.copyLabel}</Button>
          </div>
        </CardContent>
      </Card>

      <AlertDialog open={!!revoking} onOpenChange={(o) => !o && setRevoking(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>吊销 Token「{revoking?.name}」？</AlertDialogTitle>
            <AlertDialogDescription>
              使用该 Token 的 agent 将立即失去访问能力，且此操作不可撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={confirmRevoke}>
              吊销
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

import { Eye, EyeOff, LoaderCircle, PlugZap, RotateCcw, Save, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { get, post, put } from '../api/client';
import { endpoints, type ProbeResult, type Settings, type VecRebuildResult } from '../api/contract';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';

/** 可编辑草稿：密钥用明文输入框（空串 = 保持现有值，服务端不回显明文） */
interface ModelDraft {
  enabled: boolean;
  baseUrl: string;
  model: string;
  apiKey: string;
  timeoutMs: number;
}
interface Draft {
  llm: ModelDraft;
  embedding: ModelDraft;
  l2: { reconcile: boolean; vec: boolean };
}

function toDraft(s: Settings): Draft {
  const sec = (m: Settings['llm']): ModelDraft => ({
    enabled: m.enabled, baseUrl: m.baseUrl, model: m.model, apiKey: '', timeoutMs: m.timeoutMs,
  });
  return { llm: sec(s.llm), embedding: sec(s.embedding), l2: { reconcile: s.l2.reconcile, vec: s.l2.vec } };
}

const NUM = (v: string, fallback: number) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

interface FieldProps {
  label: string;
  hint?: string;
  children: React.ReactNode;
}
function Field({ label, hint, children }: FieldProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      {children}
      {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
    </div>
  );
}

interface ModelSectionProps {
  section: 'llm' | 'embedding';
  title: string;
  description: string;
  draft: ModelDraft;
  keyHint: string;
  onChange: (patch: Partial<ModelDraft>) => void;
  probeState: { target: string; result: ProbeResult } | null;
  onProbe: () => void;
  probing: boolean;
}

function ModelSection({ section, title, description, draft, keyHint, onChange, probeState, onProbe, probing }: ModelSectionProps) {
  const [showKey, setShowKey] = useState(false);
  const [revealing, setRevealing] = useState(false);

  // 保存/重载后草稿密钥会清空（服务端不回显）——此时收起明文显示
  useEffect(() => {
    if (!draft.apiKey) setShowKey(false);
  }, [draft.apiKey]);

  /** 小眼睛：有输入内容直接切换显隐；否则向后端取回已保存的明文再显示 */
  const toggleKey = async () => {
    if (showKey) { setShowKey(false); return; }
    if (draft.apiKey) { setShowKey(true); return; }
    setRevealing(true);
    try {
      const r = await post<{ apiKey: string }>(endpoints.settingsReveal(), { section });
      onChange({ apiKey: r.apiKey });
      setShowKey(true);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setRevealing(false);
    }
  };

  return (
    <Card className="flex-col gap-4 px-5 py-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">{title}</h2>
          <p className="text-muted-foreground text-xs">{description}</p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={draft.enabled} onCheckedChange={(v) => onChange({ enabled: v })} aria-label={`启用${title}`} />
          {draft.enabled ? '已启用' : '已停用'}
        </label>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="接口地址（Base URL）">
          <Input
            value={draft.baseUrl}
            placeholder="http://host:port/v1"
            onChange={(e) => onChange({ baseUrl: e.target.value })}
          />
        </Field>
        <Field label="API Key" hint={keyHint}>
          <div className="relative">
            <Input
              type={showKey ? 'text' : 'password'}
              value={draft.apiKey}
              placeholder="留空保持现有密钥"
              autoComplete="new-password"
              className="pr-9"
              onChange={(e) => onChange({ apiKey: e.target.value })}
            />
            <button
              type="button"
              aria-label={showKey ? '隐藏 API Key' : '显示 API Key'}
              title={showKey ? '隐藏' : '显示已保存的 Key'}
              disabled={revealing}
              onClick={toggleKey}
              className="text-muted-foreground hover:text-foreground focus-visible:ring-ring absolute top-1/2 right-1.5 -translate-y-1/2 rounded-sm p-1 focus-visible:ring-2 focus-visible:outline-none disabled:opacity-50"
            >
              {revealing ? <LoaderCircle className="size-4 animate-spin" /> : showKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>
        </Field>
        <Field label="模型名称">
          <Input value={draft.model} onChange={(e) => onChange({ model: e.target.value })} />
        </Field>
        <Field label="超时（毫秒）">
          <Input
            type="number"
            min={1000}
            max={300000}
            value={draft.timeoutMs}
            onChange={(e) => onChange({ timeoutMs: NUM(e.target.value, draft.timeoutMs) })}
          />
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" size="sm" onClick={onProbe} disabled={probing}>
          <PlugZap /> {probing ? '测试中…' : '测试连接'}
        </Button>
        {probeState && (
          <span className={probeState.result.ok ? 'text-success text-xs' : 'text-destructive text-xs'}>
            {probeState.result.ok
              ? `✓ 连通正常（${probeState.result.latencyMs}ms）${probeState.result.detail ? ` · ${probeState.result.detail}` : ''}`
              : `✗ ${probeState.result.error}`}
          </span>
        )}
      </div>
    </Card>
  );
}

interface Props {
  active: boolean;
}

export default function SettingsView({ active }: Props) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [probing, setProbing] = useState<string | null>(null);
  const [probeState, setProbeState] = useState<{ target: string; result: ProbeResult } | null>(null);
  const [rebuilding, setRebuilding] = useState(false);
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);

  const load = useCallback(() => {
    get<Settings>(endpoints.settings())
      .then((s) => { setDraft(toDraft(s)); setError(null); })
      .catch((e) => setError((e as Error).message));
  }, []);

  useEffect(() => {
    if (active && !draft) load();
  }, [active, draft, load]);

  if (!draft) {
    return (
      <div className={active ? 'flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto' : 'hidden'}>
        {error ? (
          <Card className="border-destructive px-4 py-3 text-sm text-destructive">{error}</Card>
        ) : (
          <Card className="h-24 animate-pulse" />
        )}
      </div>
    );
  }

  const save = async () => {
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        llm: { ...draft.llm, apiKey: draft.llm.apiKey || undefined },
        embedding: { ...draft.embedding, apiKey: draft.embedding.apiKey || undefined },
        l2: draft.l2,
      };
      const s = await put<Settings>(endpoints.settings(), body);
      setDraft(toDraft(s));
      toast.success('设置已保存并即时生效');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const probe = async (target: 'llm' | 'embedding') => {
    setProbing(target);
    setProbeState(null);
    try {
      const result = await post<ProbeResult>(endpoints.settingsTest(), { target });
      setProbeState({ target, result });
    } catch (e) {
      setProbeState({ target, result: { ok: false, error: (e as Error).message } });
    } finally {
      setProbing(null);
    }
  };

  const rebuildVec = async (reset: boolean) => {
    setRebuilding(true);
    try {
      const r = await post<VecRebuildResult>(endpoints.vecRebuild(), { reset });
      toast.success(`向量索引重建完成：索引 ${r.indexed}/${r.scanned} 条${r.dim ? ` · 维度 ${r.dim}` : ''}`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setRebuilding(false);
      setResetConfirmOpen(false);
    }
  };

  return (
    <div className={active ? 'flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto' : 'hidden'}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-muted-foreground text-sm">
          保存后即时生效并回写 .env（重启沿用）；OpenAI 兼容端点，密钥仅服务器留存、页面不回显。
        </p>
        <Button onClick={save} disabled={saving}>
          <Save /> {saving ? '保存中…' : '保存设置'}
        </Button>
      </div>

      <ModelSection
        section="llm"
        title="对话模型（LLM）"
        description="素材提炼与冲突消解判定使用；停用后记忆写入会被拒绝"
        draft={draft.llm}
        keyHint="OpenAI 兼容 chat/completions 端点"
        onChange={(p) => setDraft((d) => d && { ...d, llm: { ...d.llm, ...p } })}
        probeState={probeState?.target === 'llm' ? probeState : null}
        onProbe={() => probe('llm')}
        probing={probing === 'llm'}
      />

      <ModelSection
        section="embedding"
        title="向量模型（Embedding）"
        description="语义召回使用；停用或不可用时检索自动退化为关键词，功能不受影响"
        draft={draft.embedding}
        keyHint="OpenAI 兼容 /embeddings 端点"
        onChange={(p) => setDraft((d) => d && { ...d, embedding: { ...d.embedding, ...p } })}
        probeState={probeState?.target === 'embedding' ? probeState : null}
        onProbe={() => probe('embedding')}
        probing={probing === 'embedding'}
      />

      <Card className="flex-col gap-4 px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold">写入行为</h2>
          <p className="text-muted-foreground text-xs">记忆入库链路上的功能开关，关闭即回退到更简单的行为</p>
        </div>
        {([
          ['reconcile', '冲突消解', '写入时与已有记忆比对（ADD/UPDATE/DELETE/NOOP），避免同一事实反复入库；关闭退化为纯追加'],
          ['vec', '向量索引', 'sqlite-vec 语义检索（sqlite-vec 扩展缺失时自动降级，此开关保留配置）'],
        ] as const).map(([key, label, desc]) => (
          <div key={key} className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm">{label}</p>
              <p className="text-muted-foreground text-xs">{desc}</p>
            </div>
            <label className="flex shrink-0 items-center gap-2 text-sm">
              <Switch
                checked={draft.l2[key]}
                onCheckedChange={(v) => setDraft((d) => d && { ...d, l2: { ...d.l2, [key]: v } })}
                aria-label={`开关：${label}`}
              />
            </label>
          </div>
        ))}
      </Card>

      <Card className="flex-col gap-3 px-5 py-4">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">向量索引维护</h2>
          <Badge variant="outline">换 embedding 模型后必须「清空重建」</Badge>
        </div>
        <p className="text-muted-foreground text-xs">
          增量补齐只索引尚缺向量的记忆；清空重建删除旧索引后按当前 embedding 模型全量重建（模型维度变化时必须，否则语义检索静默失效）。
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => rebuildVec(false)} disabled={rebuilding}>
            <RotateCcw /> 增量补齐
          </Button>
          <Button variant="outline" size="sm" className="text-destructive" onClick={() => setResetConfirmOpen(true)} disabled={rebuilding}>
            <TriangleAlert /> 清空重建
          </Button>
        </div>
      </Card>

      <AlertDialog open={resetConfirmOpen} onOpenChange={setResetConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>清空并重建向量索引？</AlertDialogTitle>
            <AlertDialogDescription>
              旧索引将被删除并按当前 embedding 模型全量重建（记忆本体不受影响）。换过模型或改过维度时必须执行；数据量大时会耗时较久。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => rebuildVec(true)}>
              清空重建
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

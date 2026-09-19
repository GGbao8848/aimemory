import { useEffect, useState, type FormEvent } from 'react';
import { del, download, get, patch, post } from '../api/client';
import { endpoints, type AcceptResult, type EventStatus, type Memory, type MemoryListResult } from '../api/contract';
import { EmptyArchiveIcon } from '../components/Icons';
import { useToast } from '../components/Toast';
import { fmtDate } from '../lib/format';

const PAGE_SIZE = 10;
const POLL_INTERVAL_MS = 1000;
const POLL_MAX_TRIES = 40;

interface Props {
  active: boolean;
}

export default function MemoriesView({ active }: Props) {
  const toast = useToast();
  const [items, setItems] = useState<Memory[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState('');
  const [draftQuery, setDraftQuery] = useState('');
  const [material, setMaterial] = useState('');
  const [error, setError] = useState('');
  const [nonce, setNonce] = useState(0);
  const [eventId, setEventId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const reload = () => setNonce((n) => n + 1);

  useEffect(() => {
    let cancelled = false;
    const qs = new URLSearchParams({ page: String(page), page_size: String(PAGE_SIZE) });
    if (query) qs.set('q', query);
    get<MemoryListResult>(`${endpoints.memories()}?${qs}`)
      .then((data) => {
        if (cancelled) return;
        setItems(data.results || []);
        setTotal(data.total || 0);
        setError('');
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [page, query, nonce]);

  // 写入是异步受理：轮询到 done/failed 才刷新列表（返回 ≠ 已入库）
  useEffect(() => {
    if (!eventId) return;
    let cancelled = false;
    let tries = 0;
    const finish = (msg: string | null) => {
      window.clearInterval(timer);
      setEventId(null);
      if (cancelled) return;
      if (msg) toast(msg);
      reload();
    };
    const timer = window.setInterval(async () => {
      tries += 1;
      try {
        const { event } = await get<{ event: EventStatus }>(endpoints.event(eventId));
        if (event?.status === 'done') {
          const count = event.result ? event.result.count : 0;
          finish(`提炼完成，新增 ${count} 条记忆`);
        } else if (event?.status === 'failed') {
          finish(`提炼失败：${event.error || '无有效产出，素材未入库'}`);
        } else if (tries >= POLL_MAX_TRIES) {
          finish(null);
        }
      } catch {
        finish(null);
      }
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [eventId, toast]);

  const submitMaterial = async (e: FormEvent) => {
    e.preventDefault();
    const text = material.trim();
    if (!text) {
      toast('内容不能为空');
      return;
    }
    try {
      const r = await post<AcceptResult>(endpoints.memories(), { text });
      setMaterial('');
      toast('素材已提交，AI 提炼入库中（本地模型较慢，稍后刷新可见）…');
      if (r?.event_id) setEventId(r.event_id);
      else reload();
    } catch (err) {
      toast((err as Error).message);
    }
  };

  const runSearch = (e: FormEvent) => {
    e.preventDefault();
    setQuery(draftQuery.trim());
    setPage(1);
  };

  const clearSearch = () => {
    setDraftQuery('');
    setQuery('');
    setPage(1);
  };

  const editText = async (m: Memory) => {
    const next = window.prompt('编辑记忆内容：', m.text);
    if (next === null || next.trim() === '' || next === m.text) return;
    try {
      await patch(endpoints.memory(m.id), { text: next.trim() });
      toast('已更新');
      reload();
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const removeOne = async (m: Memory) => {
    if (!window.confirm('确定删除这条记忆？')) return;
    try {
      await del(endpoints.memory(m.id));
      toast('已删除');
      reload();
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const exportAll = async () => {
    setExporting(true);
    try {
      await download(endpoints.memoriesExport(), `aimemory-memories-${new Date().toISOString().slice(0, 10)}.json`);
      toast('已导出记忆文件');
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setExporting(false);
    }
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <section className={active ? 'view view-active' : 'view'}>
      <div className="card">
        <div className="card-head">
          <h2>记忆列表</h2>
          <button className="btn btn-ghost" type="button" onClick={exportAll} disabled={exporting} title="把全部记忆导出为 JSON 文件（备份 / 迁移）">
            ↓ 导出
          </button>
        </div>

        <div className="toolbar">
          <form className="search-form" onSubmit={runSearch} role="search">
            <input
              type="search"
              value={draftQuery}
              onChange={(e) => setDraftQuery(e.target.value)}
              placeholder="搜索记忆…（语义 + 关键词，支持中文子串）"
            />
            <button className="btn btn-ghost" type="submit">搜索</button>
            {query && <button className="btn btn-ghost" type="button" onClick={clearSearch}>清除</button>}
          </form>
        </div>

        <form className="add-form" onSubmit={submitMaterial}>
          <div className="add-main">
            <textarea
              rows={3}
              value={material}
              onChange={(e) => setMaterial(e.target.value)}
              placeholder={'把要沉淀的内容贴进来（会议纪要 / 工作要点 / 一段对话），AI 会自动提炼成结构化记忆入库，原文不保留。\n\n例如：每月第一个周二下午在 302 会议室开预算评审会，由财务部牵头，各部门需提前一天把预算表发到部门群。'}
            />
            <button className="btn btn-primary" type="submit">提交提炼</button>
          </div>
        </form>

        <div className="memory-list">
          {error && <p className="error">{error}</p>}
          {!error && !items.length && (
            <div className="empty-state">
              <EmptyArchiveIcon />
              <p className="empty-title">还没有记忆</p>
              <p className="empty-hint">在上面添加一条，或让 agent 通过 MCP 写入</p>
            </div>
          )}
          {items.map((m) => (
            <div className="memory-item" key={m.id}>
              <div className="memory-body">
                <div className="memory-text">{m.text}</div>
                <div className="memory-meta">
                  <span className="stamp">{fmtDate(m.updated_at)}</span>
                </div>
              </div>
              <div className="memory-actions">
                <button className="btn btn-ghost" type="button" onClick={() => editText(m)}>编辑</button>
                <button className="btn btn-ghost danger" type="button" onClick={() => removeOne(m)}>删除</button>
              </div>
            </div>
          ))}
        </div>

        <div className="pagination">
          <button className="btn btn-ghost" type="button" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
            ‹ 上一页
          </button>
          <span className="pg-info">
            第 {page} / {totalPages} 页 · 共 {total} 条
          </span>
          <button className="btn btn-ghost" type="button" disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>
            下一页 ›
          </button>
        </div>
      </div>
    </section>
  );
}

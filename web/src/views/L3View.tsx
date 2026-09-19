import { useState } from 'react';
import { get, put } from '../api/client';
import { endpoints, type L3Entry, type L3History, type L3Stats } from '../api/contract';
import { useToast } from '../components/Toast';
import { useEnterReload } from '../lib/hooks';

interface Props {
  active: boolean;
}

export default function L3View({ active }: Props) {
  const toast = useToast();
  const [entries, setEntries] = useState<L3Entry[]>([]);
  const [stats, setStats] = useState<L3Stats | null>(null);
  const [history, setHistory] = useState<L3History | null>(null);

  const load = async () => {
    try {
      const [e, s] = await Promise.all([
        get<{ results: L3Entry[] }>(`${endpoints.l3Entries()}?include_superseded=1`),
        get<L3Stats>(endpoints.l3Stats()),
      ]);
      setEntries(e.results || []);
      setStats(s);
    } catch (err) {
      toast((err as Error).message);
    }
    // 历史链单独取：失败不影响条目列表主体
    try {
      setHistory(await get<L3History>(endpoints.l3History()));
    } catch {
      setHistory(null);
    }
  };
  useEnterReload(active, load);

  const edit = async (entry: L3Entry) => {
    const next = window.prompt('修改 L3 条目正文：', entry.text);
    if (next === null || next === entry.text) return;
    try {
      await put(endpoints.l3Entry(entry.id), { text: next });
      toast('已更新');
      await load();
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const chains = history?.chains || [];
  const orphans = history?.orphans || [];

  return (
    <section className={active ? 'view view-active' : 'view'}>
      <div className="card">
        <div className="card-head">
          <h2>L3 画像／知识</h2>
          <span className="muted" id="l3-stats">
            {stats
              ? `active ${stats.active} · 已取代 ${stats.superseded} · 平均有效置信 ${stats.effective_confidence ?? '—'}`
              : '—'}
          </span>
        </div>
        <p className="muted">
          长期成立的条目，存储于 data/l3/*.md（可直接改文件）。带删除线的表示已被新版本取代（保留可追溯）。点击「编辑」修改正文。
        </p>
        <ul className="l3-list">
          {!entries.length && (
            <li className="muted">暂无条目——后台凝练会自动生成，也可直接在 data/l3/ 写 markdown。</li>
          )}
          {entries.map((e) => (
            <li className={e.superseded_by ? 'l3-item superseded' : 'l3-item'} key={e.id}>
              <div className="l3-body">
                <span className="op-badge">{e.kind_label || e.kind}</span>
                <span className="l3-text">{e.text}</span>
                {e.superseded_by && <span className="muted">（已被 {e.superseded_by.slice(0, 8)} 取代）</span>}
                <div className="muted mono l3-meta">
                  置信 {e.confidence ?? '—'} → 有效 {e.effective_confidence ?? '—'} · {e.source || ''}
                </div>
              </div>
              {!e.superseded_by && (
                <button className="btn btn-ghost" type="button" onClick={() => edit(e)}>
                  编辑
                </button>
              )}
            </li>
          ))}
        </ul>

        {(chains.length > 0 || orphans.length > 0) && (
          <div className="l3-history">
            <h3 className="l3-hist-title">变更历史（现行 ← 被取代的旧版）</h3>
            {chains.map((c) => (
              <div className="l3-chain" key={c.active.id}>
                <div className="l3-chain-head">
                  <span className="op-badge">{c.active.kind_label || c.active.kind}</span>
                  <span>{c.active.text}</span>
                </div>
                {c.history.map((h) => (
                  <div className="l3-chain-old muted mono" key={h.id}>
                    ← {h.text}（更新于 {(h.updated_at || '').slice(0, 10)}）
                  </div>
                ))}
              </div>
            ))}
            {orphans.length > 0 && (
              <div className="l3-chain">
                <div className="muted">
                  ⚠ {orphans.length} 条孤儿链（取代者不存在，疑似人工改坏，请检查 data/l3/）：
                  {orphans.map((o) => o.id.slice(0, 8)).join('、')}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

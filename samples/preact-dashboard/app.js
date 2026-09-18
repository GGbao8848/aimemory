'use strict';
/**
 * 前端样例：Preact + htm 仪表盘（多框架对照用，非生产前端）。
 * 与「地图」相对的另一种信息架构：KPI 卡 + 分层进度 + 冲突消解审计表 + L3 条目流。
 * 为什么是 Preact 而不是 React：React 18 的 UMD 构建在 18.2/18.3 两代上均出现内部对象
 * 不匹配（#62 / ReactCurrentActuator 缺失，UMD 已停止跟进）；Preact standalone 单文件
 * 免构建且 Hooks API 与 React 同款，样例价值等价。数据与星图同源（overview / l2/ops / l3/entries）。
 */
import { html, render, useState, useEffect } from '/samples/lib/preact-standalone.module.js';

const DEMO = {
  overview: {
    stats: { memories: 1284 }, l1: { total: 129, done: 118, backlog: 7 },
    events: { pending: 2 }, l0: { records: 53528, disk_bytes: 231735296 },
    l2: { done: 118, backlog: 0, facts: { added: 320, updated: 41, deleted: 6, noop: 88 },
      ops: { ADD: 210, UPDATE: 41, DELETE: 6, NOOP: 88, total: 345 } },
    l3: { active: 9, superseded: 3 },
  },
  ops: [],
  entries: [],
};

const fmt = (v) => (typeof v === 'number' ? v.toLocaleString('zh-CN') : (v ?? '—'));
const bytes = (v) => (typeof v === 'number' && v ? `${(v / 1024 / 1024).toFixed(1)} MB` : '—');

function useApi(path, demoValue, intervalMs = 5000) {
  const [data, setData] = useState(demoValue);
  const [live, setLive] = useState(false);
  useEffect(() => {
    let stop = false;
    const pull = async () => {
      try {
        const r = await fetch(path, { credentials: 'same-origin' });
        if (!r.ok) throw new Error(r.status);
        if (!stop) { setData(await r.json()); setLive(true); }
      } catch { if (!stop) setLive(false); }
    };
    pull();
    const timer = setInterval(pull, intervalMs);
    return () => { stop = true; clearInterval(timer); };
  }, [path]);
  return [data, live];
}

const KPI = ({ k, v, unit }) => html`
  <div className="card">
    <div className="k">${k}</div>
    <div className="v">${fmt(v)}<small>${unit || ''}</small></div>
  </div>`;

const LAYER = ({ label, done, total }) => html`
  <div style="margin: 10px 0">
    <div style="display:flex; justify-content:space-between; font-size:12px; color:#a8bdd9">
      <span>${label}</span><span>${fmt(done)} / ${fmt(total)}</span>
    </div>
    <div className="bar"><i style=${{ width: `${total ? Math.round((done / total) * 100) : 0}%` }}></i></div>
  </div>`;

function App() {
  const [overview, liveOv] = useApi('/api/atlas/overview', DEMO.overview);
  const [ops] = useApi('/api/l2/ops?limit=8', DEMO.ops);
  const [entries] = useApi('/api/l3/entries', DEMO.entries);
  const live = liveOv;
  const o = overview;
  const l2ops = o.l2?.ops || {};
  const l3 = o.l3 || { active: 0, superseded: 0, byKind: {} };

  return html`
    <main>
      <${KPI} k="L2 事实记忆" v=${o.stats?.memories} unit="条" />
      <${KPI} k="L1 会话摘要" v=${`${fmt(o.l1?.done)}/${fmt(o.l1?.total)}`} unit="已完成" />
      <${KPI} k="L0 归档" v=${fmt(o.l0?.records)} unit="条 · " + ${bytes(o.l0?.disk_bytes)} />
      <${KPI} k="L3 画像/知识" v=${l3.active} unit=${`条 · 取代 ${fmt(l3.superseded)}`} />

      <div className="card w6">
        <h3>流水线水位</h3>
        <${LAYER} label="L1 摘要（已完成/总数）" done=${o.l1?.done} total=${o.l1?.total} />
        <${LAYER} label="L2 派生（已完成/总数）" done=${o.l2?.done} total=${(o.l2?.done || 0) + (o.l2?.backlog || 0)} />
        <${LAYER} label="待处理事件" done=${(o.events?.total || 0) - (o.events?.pending || 0)} total=${o.events?.total} />
      </div>

      <div className="card w6">
        <h3>冲突消解 · 近 30 天四操作</h3>
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px">
          <${KPI} k="ADD 新增" v=${l2ops.ADD} />
          <${KPI} k="UPDATE 更新" v=${l2ops.UPDATE} />
          <${KPI} k="DELETE 取代" v=${l2ops.DELETE} />
          <${KPI} k="NOOP 去重" v=${l2ops.NOOP} />
        </div>
        <div style="font-size:11px; color:#66799a; margin-top:8px">
          DELETE 为「删旧+存新」的取代语义；全部操作在 /api/l2/ops 可追溯。
        </div>
      </div>

      <div className="card w12">
        <h3>记忆操作审计（最新 8 条）</h3>
        <table>
          <thead><tr><th>操作</th><th>变更</th><th>来源</th><th>时间</th></tr></thead>
          <tbody>
            ${ops.results?.length ? ops.results.map((r) => html`
              <tr key=${r.id}>
                <td><span className=${'op ' + r.op}>${r.op}${r.applied === false ? '（拦截）' : ''}</span></td>
                <td className="mono">${(r.before_text ? `「${r.before_text.slice(0, 24)}…」→ ` : '') + (r.after_text ? `「${r.after_text.slice(0, 30)}」` : '—')}</td>
                <td className="mono">${r.source}</td>
                <td className="mono">${(r.created_at || '').slice(5, 19)}</td>
              </tr>`) : html`<tr><td colSpan="4" style="color:#66799a">暂无记录</td></tr>`}
          </tbody>
        </table>
      </div>

      <div className="card w12">
        <h3>L3 画像/知识（active ${l3.active} 条）</h3>
        ${(entries.results || []).length ? entries.results.map((e) => html`
          <div className="entry" key=${e.id}>
            <span className="kind">[${e.kind_label || e.kind}]</span>${e.text}
            <div className="src">置信 ${e.confidence ?? '—'} · 源 ${e.source || '—'}</div>
          </div>`) : html`<div style="color:#66799a; font-size:12px">暂无条目（未登录或库为空）</div>`}
      </div>
    </main>`;
}

/** 实时/演示角标：跟随 overview 接口的可达性 */
function Badge() {
  const [, live] = useApi('/api/atlas/overview', DEMO.overview);
  useEffect(() => {
    const badge = document.getElementById('badge');
    if (!badge) return;
    badge.textContent = live ? '实时数据' : '演示数据';
    badge.classList.toggle('demo', !live);
  }, [live]);
  return null;
}

render(html`
  <${Badge} />
  <${App} />`, document.getElementById('root'));

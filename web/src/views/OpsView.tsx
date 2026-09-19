import { useEffect, useState } from 'react';
import { get } from '../api/client';
import { endpoints, type OpRow } from '../api/contract';
import { useToast } from '../components/Toast';
import { fmtCompactTime } from '../lib/format';
import { useEnterReload } from '../lib/hooks';

const OPS_LIMIT = 50;

/** 变更内容：删除/更新给出前后对照，截断展示（全文在详情里另说） */
function opChange(r: OpRow): string {
  const before = r.before_text ? `「${r.before_text.slice(0, 30)}…」→ ` : '';
  const after = r.after_text ? `「${r.after_text.slice(0, 40)}」` : '';
  return `${before}${after}` || '—';
}

export default function OpsView({ active }: { active: boolean }) {
  const toast = useToast();
  const [rows, setRows] = useState<OpRow[]>([]);
  const [nonce, setNonce] = useState(0);
  const reload = () => setNonce((n) => n + 1);

  useEnterReload(active, reload);

  useEffect(() => {
    let cancelled = false;
    get<{ results: OpRow[] }>(`${endpoints.l2Ops()}?limit=${OPS_LIMIT}`)
      .then((d) => !cancelled && setRows(d.results || []))
      .catch((e: Error) => !cancelled && toast(e.message));
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  return (
    <section className={active ? 'view view-active' : 'view'}>
      <div className="card">
        <div className="card-head">
          <h2>记忆操作审计</h2>
          <button className="btn btn-ghost" type="button" onClick={reload}>刷新</button>
        </div>
        <p className="muted">
          冲突消解的每一次判定（新增 / 更新 / 取代 / 去重）。DELETE 记录被删原文，误删可据此复原；「拦截」= 判定了删除但被安全阀拦下。
        </p>
        <table className="ops-table">
          <thead>
            <tr>
              <th>操作</th>
              <th>变更内容</th>
              <th>来源</th>
              <th>时间</th>
            </tr>
          </thead>
          <tbody>
            {!rows.length && (
              <tr>
                <td colSpan={4} className="muted">暂无记录</td>
              </tr>
            )}
            {rows.map((r, i) => (
              <tr key={r.id || i}>
                <td>
                  <span className={`op-badge op-${r.op}`}>
                    {r.op}
                    {r.applied === false ? '·拦截' : ''}
                  </span>
                </td>
                <td className="mono">{opChange(r)}</td>
                <td className="mono op-src">{r.source || ''}</td>
                <td className="mono op-time">{fmtCompactTime(r.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

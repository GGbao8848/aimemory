import { useEffect, useState } from 'react';
import { get } from '../api/client';
import { endpoints, type L1Summary } from '../api/contract';
import { useToast } from '../components/Toast';
import {
  aggregateAgents,
  deviceName,
  emptyFilter,
  layersVisible,
  toggleAgent,
  toggleDevice,
  totalBytes,
  visibleSessions,
  type ArchiveFilter,
  type DeviceRow,
  type SessionRow,
} from '../lib/archive';
import { agentLabel, fingerprintLabel, fmtBytes, fmtTime, roleLabel } from '../lib/format';
import { useEnterReload } from '../lib/hooks';

const SESSION_LIMIT_HINT = 200;

interface Props {
  active: boolean;
}

interface SessionRecord {
  role?: string;
  content?: string;
  ts?: string;
  meta?: Record<string, unknown>;
  raw?: unknown;
}

interface SessionDetail {
  records?: SessionRecord[];
  total?: number;
  truncated?: boolean;
  summary?: L1Summary | null;
}

function SummaryBlock({ summary }: { summary: L1Summary | null | undefined }) {
  if (summary && summary.status === 'done' && summary.overview) {
    const list = (title: string, arr: unknown[] | undefined) =>
      arr && arr.length ? (
        <div className="sd-sum-block">
          <span className="sd-sum-label">{title}</span>
          <ul>{arr.map((x, i) => <li key={i}>{String(x)}</li>)}</ul>
        </div>
      ) : null;
    return (
      <div className="session-summary">
        <div className="sd-head">
          <span className="sd-role">📋 会话摘要</span>
          <span className="muted small">{summary.model || ''} · {summary.records || 0} 条记录收敛</span>
        </div>
        <p className="sd-sum-overview">{summary.overview}</p>
        {list('关键决定', summary.decisions)}
        {list('未决事项', summary.pending)}
        {list('产出物', summary.artifacts)}
      </div>
    );
  }
  if (summary && summary.status && summary.status !== 'done') {
    const label =
      { pending: '排队中', running: '生成中', failed: `失败${summary.error ? '：' + summary.error : ''}` }[
        summary.status
      ] || summary.status;
    return (
      <div className="session-summary muted small">📋 会话摘要：{label}（后台自动生成，稍后刷新可见）</div>
    );
  }
  return null;
}

function Detail({ agent, device, sessionId, onClose }: { agent: string; device: string; sessionId: string; onClose: () => void }) {
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [error, setError] = useState('');
  const [showRaw, setShowRaw] = useState<Record<number, boolean>>({});

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError('');
    setShowRaw({});
    const qs = new URLSearchParams({ agent, session_id: sessionId });
    if (device) qs.set('device', device);
    get<SessionDetail>(`${endpoints.l0Session()}?${qs}`)
      .then((d) => !cancelled && setDetail(d))
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [agent, device, sessionId]);

  const recs = detail?.records || [];
  const meta = detail
    ? `${agentLabel(agent)} · ${device || '未标注设备'} · 共 ${detail.total ?? recs.length} 条` +
      (detail.truncated ? `（仅显示前 ${recs.length} 条）` : '')
    : '加载中…';

  return (
    <div className="card">
      <div className="card-head">
        <h2>💬 {sessionId}</h2>
        <button className="btn btn-ghost" type="button" onClick={onClose}>关闭</button>
      </div>
      <div className="muted small">{error ? '' : meta}</div>
      <div className="session-detail">
        {error && <p className="muted">加载失败：{error}</p>}
        {!error && detail && (
          <>
            <SummaryBlock summary={detail.summary} />
            {!recs.length && <p className="muted">该会话暂无归档内容（文件可能已被清理）。</p>}
            {recs.map((r, i) => (
              <div className={`sd-item sd-${r.role || 'meta'}`} key={i}>
                <div className="sd-head">
                  <span className="sd-role">{roleLabel(r.role)}</span>
                  <span className="muted small">{fmtTime(r.ts)}</span>
                  {r.raw !== undefined && (
                    <button className="btn btn-ghost sd-raw-btn" type="button" onClick={() => setShowRaw((s) => ({ ...s, [i]: !s[i] }))}>
                      原始
                    </button>
                  )}
                </div>
                <pre className="sd-content">{r.content || '（无正文）'}</pre>
                {r.meta && Object.keys(r.meta).length > 0 && (
                  <div className="sd-meta muted small">{JSON.stringify(r.meta)}</div>
                )}
                {r.raw !== undefined && showRaw[i] && (
                  <pre className="sd-raw">{JSON.stringify(r.raw, null, 2)}</pre>
                )}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

export default function ArchiveView({ active }: Props) {
  const toast = useToast();
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [filter, setFilter] = useState<ArchiveFilter>(emptyFilter);
  const [opened, setOpened] = useState<{ agent: string; device: string; sessionId: string } | null>(null);
  const [nonce, setNonce] = useState(0);

  const reload = () => setNonce((n) => n + 1);
  useEnterReload(active, reload);

  // 数据只随「设备」变化：选中设备后一次取回该设备的会话，agent 层级在本地派生
  useEffect(() => {
    let cancelled = false;
    const qs = filter.device ? `?device=${encodeURIComponent(filter.device)}` : '';
    get<{ devices_list?: DeviceRow[]; sessions_list?: SessionRow[] }>(`${endpoints.l0Stats()}${qs}`)
      .then((d) => {
        if (cancelled) return;
        setDevices(d.devices_list || []);
        setSessions(d.sessions_list || []);
      })
      .catch((e: Error) => {
        if (!cancelled) toast(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [filter.device, nonce]);

  const show = layersVisible(filter);
  const agents = aggregateAgents(sessions);
  const rows = visibleSessions(sessions, filter);
  const devName = deviceName(devices, filter.device);

  return (
    <section className={active ? 'view view-active' : 'view'}>
      <div className="card">
        <div className="card-head">
          <h2>🖥 设备</h2>
          <button className="btn btn-ghost" type="button" onClick={reload}>↻ 刷新</button>
        </div>
        <p className="muted">
          每台安装采集器的机器是一个设备。依次选择「设备 → agent → 会话」查看原始会话，可跨机查看「另一台机器做了什么」。
        </p>
        <div className="device-list">
          {!devices.length && (
            <p className="muted">暂无设备上报。在目标机器上部署采集器后（见「接入指南」的 aimemory-collector skill），这里会出现该设备。</p>
          )}
          {devices.map((d) => {
            const info = (d.info || {}) as Record<string, string>;
            const os = [info.platform, info.os_release, info.arch].filter(Boolean).join(' ');
            return (
              <div
                key={d.device_code}
                className={filter.device === d.device_code ? 'device-item device-active' : 'device-item'}
                onClick={() => {
                  setFilter((f) => toggleDevice(f, d.device_code));
                  setOpened(null);
                }}
              >
                <div className="device-main">
                  <span className="device-name">{d.label || d.device_code}</span>
                  <span className="muted small">
                    <code>{d.device_code}</code>
                    {os ? ` · ${os}` : ''} · {(d.agents || []).map(agentLabel).join(' / ')}
                  </span>
                  {d.fingerprint ? (
                    <span
                      className="muted small"
                      title={`机器指纹（${fingerprintLabel(d.fingerprint_source)}）——重装采集器后仍能认回同一台设备`}
                    >
                      🔗 {d.fingerprint}
                    </span>
                  ) : (
                    <span className="muted small" title="未上报机器指纹：该设备无法在重装后自动认回">⚠ 无指纹</span>
                  )}
                </div>
                <div className="device-stats">
                  <span>{d.sessions || 0} 会话</span>
                  <span>{d.records || 0} 条</span>
                  <span>{fmtBytes(d.bytes)}</span>
                  <span className="muted small">最近 {fmtTime(d.last_seen)}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {show.agents && (
        <div className="card">
          <div className="card-head">
            <h2>🤖 Agent · {devName}</h2>
            <span className="muted small">{agents.length ? `${agents.length} 个 agent` : ''}</span>
          </div>
          <div className="agent-list">
            {!agents.length && <p className="muted">该设备暂无归档会话。</p>}
            {agents.map((a) => (
              <div
                key={a.agent}
                className={filter.agent === a.agent ? 'agent-item agent-active' : 'agent-item'}
                onClick={() => {
                  setFilter((f) => toggleAgent(f, a.agent));
                  setOpened(null);
                }}
              >
                <div className="agent-main">
                  <span className="agent-name">{agentLabel(a.agent)}</span>
                  <span className="muted small">{a.sessions} 会话 · {a.records} 条 · {fmtBytes(a.bytes)}</span>
                </div>
                <span className="muted small">最近 {fmtTime(a.last)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {show.sessions && (
        <div className="card">
          <div className="card-head">
            <h2>📄 会话 · {agentLabel(filter.agent || '')}</h2>
            <span className="muted small">{rows.length} 个会话 · {fmtBytes(totalBytes(rows))}</span>
          </div>
          <div className="session-list">
            {!rows.length && <p className="muted">该 agent 下暂无归档会话。</p>}
            {rows.map((s) => (
              <div
                key={s.session_id}
                className="session-item"
                onClick={() => setOpened({ agent: s.agent, device: s.device_code || '', sessionId: s.session_id })}
              >
                <div className="session-main">
                  <code className="session-id">{s.session_id}</code>
                  <span className="muted small">
                    {s.records || 0} 条 · {fmtBytes(s.bytes)} · 首次 {fmtTime(s.first_received)}
                  </span>
                </div>
                <span className="muted small">{fmtTime(s.last_received)}</span>
              </div>
            ))}
            {rows.length >= SESSION_LIMIT_HINT && <p className="muted small">仅列出最近 {SESSION_LIMIT_HINT} 个会话。</p>}
          </div>
        </div>
      )}

      {opened && <Detail {...opened} onClose={() => setOpened(null)} />}
    </section>
  );
}

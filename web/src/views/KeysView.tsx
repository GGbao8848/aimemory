import { useMemo, useState, type FormEvent } from 'react';
import { get, post } from '../api/client';
import { endpoints, type KeyInfo } from '../api/contract';
import { useToast } from '../components/Toast';
import { copyText } from '../lib/dom';
import { fmtDate } from '../lib/format';
import {
  buildMcpConfig,
  mcpUrl,
  MCP_HEADER_NAME,
  MCP_SERVER_NAME,
  authorizationHeader,
  type McpTarget,
} from '../lib/mcp-config';
import { useEnterReload } from '../lib/hooks';

interface Props {
  active: boolean;
}

interface CreatedKey extends KeyInfo {
  token?: string;
}

// 后端不存明文（G3）：只有本次会话新建的那枚拿得到明文，切换视图不能丢，故状态挂在本视图常驻实例上。
export default function KeysView({ active }: Props) {
  const toast = useToast();
  const [keys, setKeys] = useState<KeyInfo[]>([]);
  const [fresh, setFresh] = useState<{ id: string; token: string } | null>(null);
  const [name, setName] = useState('');
  const [mcpSeg, setMcpSeg] = useState<'json' | 'manual'>('json');

  const load = async () => {
    try {
      const data = await get<{ results: KeyInfo[] }>(endpoints.keys());
      setKeys(data.results || []);
    } catch (e) {
      toast((e as Error).message);
    }
  };
  useEnterReload(active, load);

  const selected = keys[0] || null;
  const target: McpTarget = useMemo(
    () => ({
      origin: window.location.origin,
      plaintext: fresh && selected && fresh.id === selected.id ? fresh.token : null,
      hasKey: !!selected,
    }),
    [fresh, selected],
  );
  const config = buildMcpConfig(target);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    const clean = name.trim();
    if (!clean) {
      toast('请先填写 Token 名称');
      return;
    }
    try {
      const data = await post<CreatedKey>(endpoints.keys(), { name: clean });
      setName('');
      if (data.token && data.id) setFresh({ id: data.id, token: data.token });
      toast(`Token「${clean}」已创建——明文仅显示这一次`);
      await load();
    } catch (err) {
      toast((err as Error).message);
    }
  };

  const revoke = async (k: KeyInfo) => {
    if (!window.confirm('吊销后该 Token 立即失效（正在使用它的 agent 会 401），确定？')) return;
    try {
      await post(endpoints.keyRevoke(k.id));
      if (fresh && fresh.id === k.id) setFresh(null);
      toast('已吊销');
      await load();
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const copy = async (text: string, okMsg = '已复制') => {
    try {
      await copyText(text);
      toast(okMsg);
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const manualFields: { label: string; value: string; indent?: boolean }[] = [
    { label: 'Header 名称', value: MCP_HEADER_NAME, indent: true },
    { label: 'Header 值', value: authorizationHeader(target), indent: true },
  ];

  return (
    <section className={active ? 'view view-active' : 'view'}>
      <div className="card">
        <h2>🔑 接入 Token</h2>
        <p className="muted">
          一枚 Token 对应一个 agent 客户端（如 zcode / claude-code 各一枚），互不影响、可单独吊销。
          名称为必填项；明文只在创建时返回一次，请立即保存。
        </p>
        <form className="key-create" onSubmit={create}>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Token 名称（必填，如 zcode / claude-code）"
            maxLength={50}
            required
          />
          <button className="btn btn-primary" type="submit">➕ 新建 Token</button>
        </form>
        <ul className="key-list">
          {!keys.length && <li className="muted">暂无 Token，请在上方命名新建。</li>}
          {keys.map((k) => {
            const isFresh = !!fresh && fresh.id === k.id;
            return (
              <li className="key-item" key={k.id}>
                <div className="key-main">
                  <span className="key-name">{k.name}</span>
                  <span className="muted">
                    · {fmtDate(k.created_at)} 创建{k.id === selected?.id ? ' · 用于下方配置' : ''}
                  </span>
                  {isFresh ? (
                    <>
                      <div className="muted small">明文仅此一次，请立即保存：</div>
                      <code className="key-plain">{fresh?.token}</code>
                    </>
                  ) : (
                    <span className="muted small">明文不回显（仅创建时展示一次）；丢失请吊销后重建，或走设备流自动签发</span>
                  )}
                </div>
                <div className="key-ops">
                  {isFresh && (
                    <button className="btn btn-ghost" type="button" onClick={() => copy(fresh?.token || '')}>
                      复制明文
                    </button>
                  )}
                  <button className="btn btn-ghost danger" type="button" onClick={() => revoke(k)}>
                    吊销
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="card">
        <h2>🔌 MCP 配置</h2>
        <p className="muted">选择一种方式接入：一键复制 JSON，或手动模式按字段填入你的 MCP 客户端（url 指向本服务器内网地址）。</p>
        <div className="seg" role="tablist" aria-label="MCP 配置格式">
          <button
            type="button"
            role="tab"
            aria-selected={mcpSeg === 'json'}
            className={mcpSeg === 'json' ? 'seg-btn active' : 'seg-btn'}
            onClick={() => setMcpSeg('json')}
          >
            JSON 配置
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mcpSeg === 'manual'}
            className={mcpSeg === 'manual' ? 'seg-btn active' : 'seg-btn'}
            onClick={() => setMcpSeg('manual')}
          >
            手动模式
          </button>
        </div>

        {mcpSeg === 'json' ? (
          <div id="json-config">
            <pre className="mcp-json">{config.json}</pre>
            <button
              className="btn btn-primary btn-block"
              type="button"
              onClick={() =>
                config.copyable
                  ? copy(config.json, '已复制完整 MCP 配置 JSON')
                  : toast('请先在上方新建一枚 Token，再复制完整配置')
              }
            >
              {config.copyLabel}
            </button>
          </div>
        ) : (
          <div id="manual-config">
            <div className="manual-field">
              <span className="label">服务器名称</span>
              <div className="row">
                <code>{MCP_SERVER_NAME}</code>
                <button className="btn btn-ghost" type="button" onClick={() => copy(MCP_SERVER_NAME)}>复制</button>
              </div>
            </div>
            <div className="manual-field">
              <span className="label">传输类型</span>
              <div className="row">
                <code>http</code>
                <button className="btn btn-ghost" type="button" onClick={() => copy('http')}>复制</button>
              </div>
            </div>
            <div className="manual-field">
              <span className="label">服务器 URL</span>
              <div className="row">
                <code>{mcpUrl(target.origin)}</code>
                <button className="btn btn-ghost" type="button" onClick={() => copy(mcpUrl(target.origin))}>复制</button>
              </div>
            </div>
            <div className="manual-field">
              <span className="label">自定义 Headers</span>
              {manualFields.map((f) => (
                <div className="row" key={f.label}>
                  <span className="hd-label">{f.label}</span>
                  <code>{f.value}</code>
                  <button className="btn btn-ghost" type="button" onClick={() => copy(f.value)}>复制</button>
                </div>
              ))}
            </div>
            <p className="muted small">
              按上面的「服务器名称 / 传输类型 / 服务器 URL / 自定义 Headers」对应填入你的 MCP 客户端（如 BR-Agent
              自定义连接器、Claude Code 等）。Token 明文只在创建时给一次，可回上方新建一枚再复制。
            </p>
          </div>
        )}
      </div>
    </section>
  );
}

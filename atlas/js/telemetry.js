/**
 * 遥测：把服务端真实状态拉成一个快照，驱动图形（节点数字、线路繁忙度、故障高亮）。
 *
 * 数据来源：
 *   GET /healthz              公开：db / llm / embedding 连通性
 *   GET /api/atlas/overview   需登录：L0/L1/L2 规模、队列积压、Token 数（单次聚合，避免 4 次往返）
 * 未登录或接口不可达 → 切演示数据（derived 状态标注为「演示」，界面上有明确角标）。
 */

const POLL_MS = 5000;

/** 采集链「新鲜」判定：最近上传距现在多久 */
const MIN = 60 * 1000;

export function createTelemetry(onUpdate) {
  let model = demoModel();
  let timer = null;
  let failures = 0;

  function snapshot() {
    return model;
  }

  async function pull() {
    const next = { ...model, at: Date.now() };

    // 1) 健康检查（公开接口，未登录也拿得到真实值）
    try {
      const r = await fetch('/healthz', { headers: { accept: 'application/json' } });
      const h = await r.json();
      next.health = {
        db: h.db !== false,
        llm: h.llm === 'disabled' ? null : h.llm === true,
        embedding: h.embedding === 'disabled' ? null : h.embedding === true,
        status: h.status || 'unknown',
      };
      next.healthLive = true;
    } catch {
      next.healthLive = false;
    }

    // 2) 聚合概览（需登录）
    try {
      const r = await fetch('/api/atlas/overview', {
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
      });
      if (r.status === 401 || r.status === 403) {
        next.live = false;
        next.authRequired = true;
        failures = 0;
      } else if (!r.ok) {
        throw new Error(`HTTP ${r.status}`);
      } else {
        const d = await r.json();
        Object.assign(next, d, { live: true, authRequired: false, demo: false });
        failures = 0;
      }
    } catch (e) {
      failures += 1;
      next.error = e.message;
      next.live = false;
      if (failures >= 2 && !model.demo) {
        next.demo = true; // 连不上：退回演示，但保留上次真实值以免数字跳成 0
      }
    }

    if (next.live === false && next.demo !== false && !next.authRequired) next.demo = true;
    if (next.authRequired) next.demo = true;

    next.derived = derive(next);
    model = next;
    onUpdate(model);
  }

  function start() {
    pull();
    timer = setInterval(pull, POLL_MS);
    return () => timer && clearInterval(timer);
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { start, stop, snapshot, pull };
}

/**
 * 把原始数字翻译成「线路繁忙度 / 节点状态」——这是概念图里流动速度的依据。
 * 全部来自真实字段，不做假：看不懂的（如 MCP 调用量无埋点）给中性基线并在面板注明。
 */
export function derive(m) {
  const l0 = m.l0 || {};
  const l1 = m.l1 || {};
  const ev = m.events || {};
  const health = m.health || {};

  const lastMs = l0.last_received ? Date.parse(l0.last_received) : 0;
  const ageMin = lastMs ? (Date.now() - lastMs) / MIN : Infinity;
  const ingestActivity = m.live
    ? ageMin < 5 ? 1.0 : ageMin < 60 ? 0.55 : ageMin < 60 * 24 ? 0.28 : 0.12
    : 0.85;
  const ingestAge = Number.isFinite(ageMin) ? fmtAge(ageMin) : null;

  const l1Backlog = (l1.pending || 0) + (l1.running || 0);
  const l1Activity = m.live
    ? Math.min(1, 0.3 + l1Backlog * 0.12 + (l1.running ? 0.4 : 0))
    : 0.7;

  const evBacklog = (ev.pending || 0) + (ev.processing || 0);
  const rememberActivity = m.live ? Math.min(1, 0.28 + evBacklog * 0.22) : 0.8;

  const llmDown = health.llm === false;
  const embDown = health.embedding === false;

  return {
    ingest: llmDown ? ingestActivity * 0.5 : ingestActivity,
    ingestAge,
    l1: l1Backlog > 0 ? l1Activity : Math.min(0.55, l1Activity),
    l1Backlog,
    remember: rememberActivity,
    eventsBacklog: evBacklog,
    recall: 0.62, // 无埋点：MCP 调用量服务端未统计，给中性基线
    llm: llmDown ? 0 : evBacklog > 0 || l1Backlog > 0 ? 1.0 : 0.5,
    llmDown,
    emb: embDown ? 0 : 0.6,
    embDown,
  };
}

export function fmtAge(minutes) {
  if (!Number.isFinite(minutes)) return null;
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${Math.floor(minutes)} 分钟前`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)} 小时前`;
  return `${Math.floor(minutes / (60 * 24))} 天前`;
}

/**
 * 演示数据：未登录 / 服务不可达时使用。
 * 数值刻意与真实量级一致（取自 docs 里的实测记录），避免误导对规模的判断。
 */
function demoModel() {
  const now = Date.now();
  const devices = [
    {
      device_code: 'dev_32def8ee',
      label: '服务器本机',
      fingerprint: 'fp_8f5e2a91c4d7b306',
      fingerprint_source: 'machine-id',
      info: { platform: 'linux', arch: 'x64', os_release: 'Ubuntu 22.04', hostname: 'user2' },
      agents: ['zcode', 'claude', 'codex'],
      sessions: 82,
      records: 35126,
      bytes: 154140672,
      last_seen: new Date(now - 3 * MIN).toISOString(),
    },
    {
      device_code: 'dev_9a1c04f2',
      label: '我的笔记本',
      fingerprint: 'fp_1c77be40aa9f2210',
      fingerprint_source: 'mac',
      info: { platform: 'darwin', arch: 'arm64', os_release: 'macOS 15.6', hostname: 'songkui-mbp' },
      agents: ['claude', 'zcode'],
      sessions: 47,
      records: 18402,
      bytes: 73400320,
      last_seen: new Date(now - 42 * MIN).toISOString(),
    },
  ];
  return {
    demo: true,
    live: false,
    at: now,
    health: { db: true, llm: true, embedding: true, status: 'ok' },
    healthLive: false,
    stats: { memories: 1284, keys: 3 },
    keys: { active: 3 },
    events: { pending: 1, processing: 1, done: 912, failed: 4 },
    l1: { total: 129, done: 118, pending: 6, running: 1, failed: 4, last_run: new Date(now - 6 * MIN).toISOString() },
    l0: {
      batches: 742,
      sessions: 129,
      agents: 3,
      devices: 2,
      records: 53528,
      bytes: 227540992,
      disk_bytes: 231735296,
      files: 129,
      last_received: new Date(now - 3 * MIN).toISOString(),
      devices_list: devices,
      sessions_list: [],
    },
    devices,
  };
}

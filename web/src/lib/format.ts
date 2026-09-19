// 展示层纯函数：不含 DOM 依赖，由 test/web-logic.test.js 用 node --test 直接守护。

export function fmtBytes(n: number | null | undefined): string {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

/** 完整时间（跟随浏览器本地化设置）；无法解析的原样返回 */
export function fmtTime(s: string | null | undefined): string {
  if (!s) return '—';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString();
}

export function fmtDate(s: string | null | undefined): string {
  if (!s) return '—';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString();
}

/** 审计表用的紧凑时间：2026-09-19T04:12:33Z → 09-19T04:12 */
export function fmtCompactTime(s: string | null | undefined): string {
  return String(s || '').slice(5, 16).replace('T', ' ');
}

const AGENT_LABELS: Record<string, string> = {
  codex: 'Codex',
  claude: 'Claude Code',
  zcode: 'ZCode',
};

export function agentLabel(a: string): string {
  return AGENT_LABELS[a] || a;
}

export const ROLE_LABELS: Record<string, string> = {
  user: '用户',
  assistant: '助手',
  system: '系统',
  tool: '工具',
  reasoning: '推理',
  meta: '元信息',
};

export function roleLabel(role: string | null | undefined): string {
  return ROLE_LABELS[role || 'meta'] || String(role);
}

/** 机器指纹来源的人话说明（未上报时界面给出「认不回」警示） */
const FINGERPRINT_LABELS: Record<string, string> = {
  'machine-id': '系统安装标识',
  mac: '物理网卡',
  hostname: '主机名',
  random: '随机',
};

export function fingerprintLabel(source: string | null | undefined): string {
  return FINGERPRINT_LABELS[source || ''] || source || '未知来源';
}

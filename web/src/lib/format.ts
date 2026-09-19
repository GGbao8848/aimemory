// 展示层纯函数：不含 DOM 依赖，由 test/web-logic.test.js 用 node --test 直接守护。

/** 完整时间（跟随浏览器本地化设置）；无法解析的原样返回 */
export function fmtTime(s: string | null | undefined): string {
  if (!s) return '—';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString();
}

/** 列表/历史用的紧凑时间：2026-09-19T04:12:33Z → 09-19 04:12 */
export function fmtCompactTime(s: string | null | undefined): string {
  if (!s) return '—';
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  return m ? `${m[2]}-${m[3]} ${m[4]}:${m[5]}` : String(s);
}

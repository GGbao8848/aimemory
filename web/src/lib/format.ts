// 展示层纯函数：不含 DOM 依赖，由 test/web-logic.test.js 用 node --test 直接守护。

const p2 = (n: number) => String(n).padStart(2, '0');

/** 完整时间：2026-09-19T04:12:33Z → 2026-09-19 12:12:33（本地时区，年月日时分秒）；无法解析的原样返回 */
export function fmtFullTime(s: string | null | undefined): string {
  if (!s) return '—';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return String(s);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

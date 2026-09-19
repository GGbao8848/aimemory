// 复制到剪贴板：安全上下文（HTTPS / localhost）走 clipboard API；
// 内网 http://IP:端口 下该 API 不可用，降级为隐藏 textarea + execCommand。
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  if (!ok) throw new Error('复制失败（浏览器限制）');
}

export type Theme = 'dark' | 'light';

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem('aimemory-theme', theme);
  } catch {
    /* 隐私模式下 localStorage 会抛，主题切换仅本次会话有效 */
  }
}

export function currentTheme(): Theme {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

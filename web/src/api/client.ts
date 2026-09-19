// REST 客户端：会话 cookie 由浏览器带上；401 统一交给 App 切回登录视图。

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

let unauthorized: (() => void) | null = null;

export function onUnauthorized(fn: () => void): void {
  unauthorized = fn;
}

async function parse(res: Response): Promise<unknown> {
  return res.json().catch(() => ({}));
}

export async function api<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  if (res.status === 401) {
    unauthorized?.();
    throw new ApiError('未登录', 401);
  }
  const data = await parse(res);
  if (!res.ok) {
    const msg = (data as { error?: string })?.error || `请求失败 (${res.status})`;
    throw new ApiError(msg, res.status);
  }
  return data as T;
}

export const get = <T>(url: string): Promise<T> => api<T>(url);

export const post = <T>(url: string, body?: unknown): Promise<T> =>
  api<T>(url, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });

export const put = <T>(url: string, body?: unknown): Promise<T> =>
  api<T>(url, { method: 'PUT', body: body === undefined ? undefined : JSON.stringify(body) });

export const patch = <T>(url: string, body?: unknown): Promise<T> =>
  api<T>(url, { method: 'PATCH', body: body === undefined ? undefined : JSON.stringify(body) });

export const del = <T>(url: string): Promise<T> => api<T>(url, { method: 'DELETE' });

/** 附件下载（导出记忆）：文件名优先取后端 Content-Disposition */
export async function download(url: string, fallbackName: string): Promise<void> {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (res.status === 401) {
    unauthorized?.();
    throw new ApiError('未登录', 401);
  }
  if (!res.ok) {
    const data = (await parse(res)) as { error?: string };
    throw new ApiError(data?.error || `导出失败 (${res.status})`, res.status);
  }
  const match = /filename="?([^";]+)"?/i.exec(res.headers.get('Content-Disposition') || '');
  const blob = await res.blob();
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = match ? match[1] : fallbackName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(href), 1000);
}

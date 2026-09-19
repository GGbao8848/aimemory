// MCP 接入配置生成：Token 明文只在创建响应里返回一次（后端不存明文），
// 因此「有没有明文」决定配置能否直接用，界面必须把三种状态说清楚。

export const MCP_SERVER_NAME = 'aimemory';
export const MCP_HEADER_NAME = 'Authorization';

export const TOKEN_PLACEHOLDER = '<在此粘贴你的 m0-xxx Token>';

export interface McpTarget {
  /** 当前浏览器来源，如 http://127.0.0.1:18543 */
  origin: string;
  /** 本次会话新建 Token 的一次性明文；刷新后不可得 */
  plaintext: string | null;
  /** 是否已有可选中的 Token（有 Token 但无明文时给占位符而非空值） */
  hasKey: boolean;
}

export function mcpUrl(origin: string): string {
  return `${origin}/mcp`;
}

export function authorizationHeader(target: McpTarget): string {
  if (target.plaintext) return `Token ${target.plaintext}`;
  if (target.hasKey) return `Token ${TOKEN_PLACEHOLDER}`;
  return 'Token m0-xxx（请先在上方新建 Token）';
}

export interface McpConfig {
  json: string;
  /** 复制按钮文案：有明文=完整配置，无明文=模板 */
  copyLabel: string;
  /** 无明文时不允许复制「完整配置」，点击改为引导新建 */
  copyable: boolean;
}

export function buildMcpConfig(target: McpTarget): McpConfig {
  const server: Record<string, unknown> = {
    type: 'http',
    url: mcpUrl(target.origin),
  };
  // 尚无 Token 时不输出空 headers 键，避免客户端提示「header 值为空」
  if (target.plaintext || target.hasKey) {
    server.headers = { [MCP_HEADER_NAME]: authorizationHeader(target) };
  }
  return {
    json: JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: server } }, null, 2),
    copyLabel: target.plaintext ? '复制 JSON（含 Token）' : '复制 JSON 模板',
    copyable: !!target.plaintext,
  };
}

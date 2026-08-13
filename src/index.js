'use strict';

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const config = require('./config');
const repo = require('./db/repo');
const { handleMcpRequest } = require('./mcp/server');
const keycloak = require('./auth/keycloak');
const web = require('./web/routes');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// ===== 静态管理页面 =====
app.use(express.static(path.join(__dirname, 'web', 'static')));

// ===== MCP 端点（Streamable HTTP）=====
app.post('/mcp', handleMcpRequest);
// Streamable HTTP 客户端可能用 GET 探测（部分实现），幂等返回提示
app.get('/mcp', (_req, res) =>
  res.status(200).json({ jsonrpc: '2.0', result: { protocolVersion: '2025-03-26', capabilities: { tools: {} } }, id: null })
);

// ===== REST /api（统一鉴权：Token API key 或 Web 会话 cookie）=====
app.use('/api', web.apiRouter);

// ===== Keycloak 登录流程 =====
app.get('/auth/login', async (req, res) => {
  try {
    const redirectUri = web.buildRedirectUri(req);
    const { url, state, verifier } = await keycloak.buildAuthorizeUrl(redirectUri);
    // state 校验 + verifier 都放 HttpOnly cookie（PKCE）
    res.cookie('kc_state', state, { httpOnly: true, sameSite: 'lax', maxAge: 10 * 60 * 1000 });
    res.cookie('kc_verifier', verifier, { httpOnly: true, sameSite: 'lax', maxAge: 10 * 60 * 1000 });
    res.redirect(url);
  } catch (e) {
    res.status(500).send(`登录发起失败: ${e.message}`);
  }
});

app.get('/auth/callback', async (req, res) => {
  try {
    const { code, state, error } = req.query;
    if (error) return res.status(400).send(`Keycloak 登录失败: ${error}`);
    if (state !== req.cookies?.kc_state) return res.status(400).send('state 校验失败（防 CSRF）');
    const redirectUri = web.buildRedirectUri(req);
    const { user, tokens: kcTokens } = await keycloak.exchangeCode(redirectUri, code, req.cookies.kc_verifier);
    // 建立本地会话
    const sid = require('crypto').randomBytes(24).toString('hex');
    repo.createSession(sid, user.id, config.sessionTtlMs, user.username);
    res.cookie('aim_session', sid, {
      httpOnly: true, sameSite: 'lax', maxAge: config.sessionTtlMs,
    });
    // 保存 Keycloak id_token（HttpOnly，仅用于登出时拼 end_session 参数）
    if (kcTokens.id_token) {
      res.cookie('kc_id_token', kcTokens.id_token, {
        httpOnly: true, sameSite: 'lax', maxAge: config.sessionTtlMs,
      });
    }
    res.clearCookie('kc_state');
    res.clearCookie('kc_verifier');
    res.redirect('/');
  } catch (e) {
    res.status(500).send(`登录回调失败: ${e.message}`);
  }
});

app.get('/auth/logout', async (req, res) => {
  const sid = req.cookies?.aim_session;
  if (sid) {
    repo.deleteSession(sid);
    res.clearCookie('aim_session');
  }
  res.clearCookie('kc_id_token');
  // 跳到 Keycloak 登出页（携带 id_token），再回首页
  const kcLogout = await keycloak.buildLogoutUrl(web.buildRedirectUri(req, '/'), req.cookies?.kc_id_token);
  res.redirect(kcLogout);
});

// ===== 启动 =====
repo.cleanupSessions();
setInterval(() => repo.cleanupSessions(), 3600_000).unref();

app.listen(config.port, '0.0.0.0', () => {
  console.log(`[aimemory] MCP + API + Web 已启动: http://0.0.0.0:${config.port}`);
  console.log(`[aimemory] MCP 端点: http://<内网IP>:${config.port}/mcp`);
  console.log(`[aimemory] Keycloak: ${config.keycloak.url}/realms/${config.keycloak.realm}`);
});

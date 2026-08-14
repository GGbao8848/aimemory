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
// ?next= 支持站内跳转（如 /connect）：回调后落到目标页，用于半自动连接授权
app.get('/auth/login', async (req, res) => {
  try {
    const next = typeof req.query.next === 'string' && req.query.next.startsWith('/') && !req.query.next.includes('//') ? req.query.next : '/';
    const redirectUri = web.buildRedirectUri(req);
    const { url, state, verifier } = await keycloak.buildAuthorizeUrl(redirectUri);
    // state 校验 + verifier + next 都放 HttpOnly cookie（PKCE）
    res.cookie('kc_state', state, { httpOnly: true, sameSite: 'lax', maxAge: 10 * 60 * 1000 });
    res.cookie('kc_verifier', verifier, { httpOnly: true, sameSite: 'lax', maxAge: 10 * 60 * 1000 });
    res.cookie('kc_next', next, { httpOnly: true, sameSite: 'lax', maxAge: 10 * 60 * 1000 });
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
    // 支持 /auth/login?next= 跳转（半自动连接落在 /connect）；否则首页带 logged=1 标记
    // （前端据此避免「回跳首页后又跳登录」的死循环）
    const next = req.cookies?.kc_next || '/';
    res.clearCookie('kc_next');
    res.redirect(next === '/connect' ? '/connect' : '/?logged=1');
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

// ===== 半自动连接授权页 =====
// 员工浏览器访问 → SSO 登录确认 → 生成密钥 + 短连接码 → agent 端用码兑换
app.get('/connect', (req, res) => {
  const id = web.resolveIdentity(req);
  if (!id) return res.redirect('/auth/login?next=/connect');
  const result = repo.createConnectRequest(id.userId);
  const mcpUrl = `${config.publicBaseUrl || `http://${req.get('host')}`}/mcp`;
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  res.type('html').send(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>aimemory · 连接授权</title>
<style>
  :root { --bg:#0b0f17; --surface:#131a29; --surface-2:#1a2336; --border:#243049;
          --text:#e8ecf4; --muted:#8a94a8; --accent:#4c8dff; --ok:#34d399; --mono:ui-monospace,Menlo,Consolas,monospace; }
  * { box-sizing:border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:radial-gradient(600px 300px at 70% -10%, rgba(76,141,255,.08), transparent 60%), var(--bg);
         font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif; color:var(--text); }
  .card { width:100%; max-width:520px; margin:24px; padding:36px 32px; background:var(--surface);
          border:1px solid var(--border); border-radius:16px; box-shadow:0 10px 30px rgba(0,0,0,.35); }
  h1 { margin:0 0 6px; font-size:20px; }
  .sub { margin:0 0 24px; color:var(--muted); font-size:13px; }
  .okline { display:flex; align-items:center; gap:8px; color:var(--ok); font-size:13px; margin-bottom:20px; }
  .okline .dot { width:8px; height:8px; border-radius:50%; background:var(--ok); box-shadow:0 0 8px rgba(52,211,153,.6); }
  label { display:block; font-size:12px; color:var(--muted); margin:16px 0 6px; }
  .code { font-family:var(--mono); font-size:28px; font-weight:700; letter-spacing:.08em;
          background:var(--surface-2); border:1px solid var(--border); border-radius:10px;
          padding:14px 18px; text-align:center; color:var(--accent); }
  .token { font-family:var(--mono); font-size:12.5px; word-break:break-all; background:var(--surface-2);
           border:1px solid var(--border); border-radius:8px; padding:10px 12px; color:#c3cbe0; }
  .row { display:flex; gap:8px; align-items:center; margin-top:8px; }
  .btn { border:1px solid var(--accent); background:var(--accent); color:#fff; border-radius:8px;
         padding:8px 14px; font-size:13px; cursor:pointer; font-family:inherit; }
  .btn:hover { background:#3a6fd8; }
  .steps { margin:24px 0 0; padding:16px; background:rgba(76,141,255,.08); border:1px solid rgba(76,141,255,.25);
           border-radius:10px; font-size:13px; line-height:1.8; }
  .steps code { font-family:var(--mono); background:var(--surface-2); border:1px solid var(--border); border-radius:4px; padding:1px 6px; font-size:12px; }
  .hint { color:var(--muted); font-size:12px; margin-top:6px; }
</style>
</head>
<body>
  <div class="card">
    <h1>✅ 连接授权成功</h1>
    <p class="sub">已为你自动生成接入密钥，并准备好连接码。</p>
    <div class="okline"><span class="dot"></span><span>已通过统一登录平台确认身份：${esc(id.username || id.userId.slice(0,8))}</span></div>

    <label>连接码（10 分钟有效，一次性）</label>
    <div class="code" id="code">${esc(result.code)}</div>
    <button class="btn" id="copy-code" style="margin-top:10px">复制连接码</button>

    <label>API Key（兜底：若 agent 端兑换失败，可手动复制使用）</label>
    <div class="row">
      <span class="token" id="token" style="flex:1">${esc(result.api_key)}</span>
      <button class="btn" id="copy-token" type="button">复制</button>
    </div>

    <div class="steps">
      <b>回到 ZCode：</b>运行 <code>/aimemory-connect ${esc(result.code)}</code>，
      密钥会自动写入你的 ZCode 配置并连上（或运行 <code>/aimemory-connect</code> 查看指引）。
      <div class="hint">MCP 端点：${esc(mcpUrl)}</div>
    </div>
  </div>
  <script>
    const cp = (id) => { const el = document.getElementById(id);
      (navigator.clipboard ? navigator.clipboard.writeText(el.textContent.trim())
        : Promise.reject()).catch(() => { const r = document.createRange(); r.selectNode(el);
        window.getSelection().removeAllRanges(); window.getSelection().addRange(r);
        document.execCommand('copy'); });
      el.closest('.row, .card')?.querySelector('.btn').innerText = '已复制';
    };
    document.getElementById('copy-code').onclick = () => cp('code');
    document.getElementById('copy-token').onclick = () => cp('token');
  </script>
</body>
</html>`);
});

// ===== 单点登出（SLO）：Keycloak front-channel logout iframe 加载本端点 =====
// Keycloak 在某 client 登出（end_session）后，会以 iframe 加载本 realm 下所有配置了
// frontChannelLogoutUri 的 client 的对应 URL（浏览器带 cookie 请求）——本端点据此清除
// 本地会话 cookie，实现「在 BR-Agent 登出 → aimemory 也退出」。必须返回 200（iframe 要求）。
app.get('/slo-logout', (req, res) => {
  const sid = req.cookies?.aim_session;
  if (sid) {
    repo.deleteSession(sid);
    res.clearCookie('aim_session');
  }
  res.clearCookie('kc_id_token');
  res.clearCookie('kc_state');
  res.clearCookie('kc_verifier');
  res.status(200).type('text/plain').send('ok');
});

// ===== 启动 =====
repo.cleanupSessions();
repo.cleanupConnectCodes();
setInterval(() => repo.cleanupSessions(), 3600_000).unref();
setInterval(() => repo.cleanupConnectCodes(), 600_000).unref();

app.listen(config.port, '0.0.0.0', () => {
  console.log(`[aimemory] MCP + API + Web 已启动: http://0.0.0.0:${config.port}`);
  console.log(`[aimemory] MCP 端点: http://<内网IP>:${config.port}/mcp`);
  console.log(`[aimemory] Keycloak: ${config.keycloak.url}/realms/${config.keycloak.realm}`);
});

'use strict';

/**
 * REST 契约一致性测试：docs/api/openapi.json 的「路径+方法集」必须与实现同步。
 *
 * 实现 = 从 routes.js / index.js 源码里正则提取的路由注册（比启动 app 轻且稳）。
 * 方向：实现的 REST 路由（除豁免的 HTML 页/静态资源）⊆ 契约；契约 ⊆ 实现。
 * 加接口忘了补契约 → 这里红。
 */
const fs = require('fs');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert');

const ROOT = path.join(__dirname, '..');
const src = ['src/web/routes.js', 'src/index.js']
  .map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8'))
  .join('\n');

const EXEMPT = new Set([
  'GET /auth/login', 'POST /auth/local-login', 'GET /auth/logout', // HTML 登录流
  'GET /skill/download', 'GET /skill/SKILL.md', // 静态资源
]);

function implementedRoutes() {
  const out = new Set();
  // routes.js 的 apiRouter 挂载在 /api 下（index.js: app.use('/api', web.apiRouter)），提取时补前缀；
  // index.js 里的 app 级路由路径自带全路径（/api/l0/ingest、/healthz、/mcp）。
  const sources = [
    { file: 'src/web/routes.js', prefix: '/api', marker: 'apiRouter' },
    { file: 'src/api/mem0.js', prefix: '', marker: 'router' },
    { file: 'src/index.js', prefix: '', marker: 'app' },
  ];
  for (const { file, prefix, marker } of sources) {
    const code = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const re = new RegExp(`${marker}\\.(get|post|put|delete)\\(\\s*'([^']+)'`, 'g');
    let m;
    while ((m = re.exec(code))) {
      let p = prefix + m[2];
      if (!p.startsWith('/api') && !p.startsWith('/v1') && !p.startsWith('/v2') && !['/healthz', '/mcp'].includes(p)) continue; // 只看 REST 面
      p = p.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
      out.add(`${m[1].toUpperCase()} ${p}`);
    }
  }
  return out;
}

function documentedRoutes() {
  const doc = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'api', 'openapi.json'), 'utf8'));
  const out = new Set();
  for (const [p, methods] of Object.entries(doc.paths)) {
    for (const m of Object.keys(methods)) {
      if (m.startsWith('x-')) continue;
      out.add(`${m.toUpperCase()} ${p}`);
    }
  }
  return { set: out, count: out.size };
}

test('契约覆盖：实现的 REST 路由全部入契约（豁免除外）', () => {
  const impl = implementedRoutes();
  const doc = documentedRoutes();
  const missing = [...impl].filter((r) => !EXEMPT.has(r) && !doc.set.has(r)).sort();
  assert.deepEqual(missing, [], `以下路由未写入 docs/api/openapi.json：${missing.join(', ')}`);
});

test('契约不虚报：文档里的路由必须真实存在', () => {
  const impl = implementedRoutes();
  const doc = documentedRoutes();
  const phantom = [...doc.set].filter((r) => !impl.has(r)).sort();
  assert.deepEqual(phantom, [], `契约中存在实现里没有的路由：${phantom.join(', ')}`);
});

test('契约体量与可解析性：覆盖充分且为合法 JSON', () => {
  const doc = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'api', 'openapi.json'), 'utf8'));
  assert.equal(doc.openapi.startsWith('3.'), true, '应为 OpenAPI 3.x');
  assert.ok(documentedRoutes().count >= 14, `契约至少覆盖 14 个操作，当前 ${documentedRoutes().count}`);
});

'use strict';

/**
 * Codex CLI 适配器。
 *
 * 数据源：~/.codex/sessions/YYYY/MM/DD/rollout-<ISO时间戳>-<uuid>.jsonl
 *   （另有 ~/.codex/archived_sessions/ 存放归档会话）
 * 格式：append-only JSONL，一行一个 RolloutItem：
 *   { timestamp, ordinal?, type, payload }
 *   type ∈ session_meta | response_item | turn_context | compacted | event_msg | ...
 *
 * 行为：纯追加 → 按文件 offset 增量读取即可（最友好的一家）。
 * 会话 id 从文件名解析（rollout-<ts>-<uuid>.jsonl）。
 */

const fs = require('fs');
const path = require('path');
const { readNewLines, parseJsonLine } = require('../lib/jsonl');
const { ROLE, makeRid, makeRecord, clip } = require('../lib/schema');

const NAME_RE = /^rollout-(.+?)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:_(.+?))?\.jsonl$/;

/** 递归发现 rollout 文件（sessions/ 与 archived_sessions/ 都在候选内） */
function discoverFiles(root) {
  const out = [];
  const dirs = [path.join(root, 'sessions'), path.join(root, 'archived_sessions')];
  const walk = (dir, depth) => {
    if (depth > 5) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) out.push(p);
    }
  };
  for (const d of dirs) walk(d, 0);
  return out;
}

/** 从文件名解析会话 id 与 rollout 变体（revert 会产生 _<rollout_id> 后缀） */
function parseName(file) {
  const base = path.basename(file);
  const m = base.match(NAME_RE);
  if (!m) return { sessionId: base.replace(/\.jsonl$/, ''), rolloutSuffix: null };
  return { sessionId: m[2], rolloutSuffix: m[3] || null };
}

/** 把一行 RolloutItem 转成归一化记录（可能产出 0 或 1 条） */
function normalizeLine(agent, sessionId, line, { keepRaw }) {
  const d = parseJsonLine(line);
  if (!d || typeof d !== 'object') return null;

  const ts = d.timestamp || new Date().toISOString();
  const raw = keepRaw ? d : undefined;
  const payload = d.payload || {};

  switch (d.type) {
    case 'session_meta': {
      // 会话元信息：项目目录、模型、cli 版本等
      const meta = {
        cwd: payload.cwd,
        cli_version: payload.cli_version,
        model: payload.model || payload.model_provider,
        git: payload.git,
      };
      const nativeId = 'session-meta';
      return makeRecord({
        rid: makeRid(agent, sessionId, nativeId),
        ts: payload.timestamp || ts,
        role: ROLE.META,
        content: payload.instructions ? clip(payload.instructions) : '',
        meta: stripUndef(meta),
        raw,
      });
    }

    case 'response_item': {
      const item = payload;
      const t = item.type;
      if (t === 'message') {
        const text = (item.content || [])
          .map((c) => (c.type === 'input_text' || c.type === 'output_text' ? c.text : ''))
          .filter(Boolean)
          .join('\n');
        return makeRecord({
          rid: makeRid(agent, sessionId, item.id || `msg-${d.ordinal ?? ts}`),
          ts,
          version: d.ordinal ?? undefined,
          seq: d.ordinal ?? undefined,
          role: item.role === 'user' ? ROLE.USER : item.role === 'system' || item.role === 'developer' ? ROLE.SYSTEM : ROLE.ASSISTANT,
          content: clip(text),
          meta: stripUndef({ phase: item.phase }),
          raw,
        });
      }
      if (t === 'reasoning') {
        const text = (item.summary || [])
          .map((s) => s.text || '')
          .concat((item.content || []).map((c) => c.text || ''))
          .filter(Boolean)
          .join('\n');
        return makeRecord({
          rid: makeRid(agent, sessionId, item.id || `reasoning-${d.ordinal ?? ts}`),
          ts,
          version: d.ordinal ?? undefined,
          seq: d.ordinal ?? undefined,
          role: ROLE.REASONING,
          content: clip(text),
          raw,
        });
      }
      if (t === 'function_call' || t === 'local_shell_call' || t === 'custom_tool_call') {
        return makeRecord({
          rid: makeRid(agent, sessionId, item.id || item.call_id || `call-${d.ordinal ?? ts}`),
          ts,
          version: d.ordinal ?? undefined,
          seq: d.ordinal ?? undefined,
          role: ROLE.TOOL,
          content: clip(item.arguments || item.command || item.input || ''),
          meta: stripUndef({ kind: 'call', tool: item.name || t, call_id: item.call_id }),
          raw,
        });
      }
      if (t === 'function_call_output' || t === 'custom_tool_call_output') {
        return makeRecord({
          rid: makeRid(agent, sessionId, item.call_id || item.id || `out-${d.ordinal ?? ts}`),
          ts,
          version: d.ordinal ?? undefined,
          seq: d.ordinal ?? undefined,
          role: ROLE.TOOL,
          content: clip(typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '')),
          meta: stripUndef({ kind: 'output', call_id: item.call_id }),
          raw,
        });
      }
      // 其余 response_item（web_search_call 等）——保留为 tool 事件，不丢
      return makeRecord({
        rid: makeRid(agent, sessionId, item.id || `item-${d.ordinal ?? ts}`),
        ts,
        version: d.ordinal ?? undefined,
        seq: d.ordinal ?? undefined,
        role: ROLE.TOOL,
        content: '',
        meta: { kind: t || 'unknown' },
        raw,
      });
    }

    case 'compacted': {
      // 上下文压缩点：记录替换摘要，L1 需要知道历史在此被裁剪过
      return makeRecord({
        rid: makeRid(agent, sessionId, `compacted-${d.ordinal ?? ts}`),
        ts,
        version: d.ordinal ?? undefined,
        seq: d.ordinal ?? undefined,
        role: ROLE.META,
        content: clip(payload.message || ''),
        meta: stripUndef({ kind: 'compacted', window: payload.window_number }),
        raw,
      });
    }

    case 'turn_context':
      return makeRecord({
        rid: makeRid(agent, sessionId, `turn-context-${d.ordinal ?? ts}`),
        ts,
        version: d.ordinal ?? undefined,
        seq: d.ordinal ?? undefined,
        role: ROLE.META,
        content: '',
        meta: stripUndef({ kind: 'turn_context', cwd: payload.cwd, model: payload.model }),
        raw,
      });

    default:
      // 其余类型（token_usage_record / event_msg / world_state…）不产出内容记录，
      // 但保留原始行到 meta 记录里，确保 L0 可重建（不静默丢弃）
      if (!keepRaw) return null;
      return makeRecord({
        rid: makeRid(agent, sessionId, `${d.type}-${d.ordinal ?? ts}`),
        ts,
        version: d.ordinal ?? undefined,
        seq: d.ordinal ?? undefined,
        role: ROLE.META,
        content: '',
        meta: { kind: d.type || 'unknown' },
        raw,
      });
  }
}

function stripUndef(o) {
  const out = {};
  for (const [k, v] of Object.entries(o || {})) if (v !== undefined && v !== null) out[k] = v;
  return out;
}

/**
 * 采集一轮（流式）。
 * 每个文件归一化后立即通过 emit 交出，不跨文件累积（大仓库里会话文件可能很多）。
 * @param {(sessionId:string, records:object[])=>void} emit
 */
function collect(config, state, emit) {
  const root = config.paths.codex;
  const emitSafe = typeof emit === 'function' ? emit : () => {};
  if (!fs.existsSync(root)) return { files: 0, cursorUpdates: [], seenKeys: [] };

  const files = discoverFiles(root);
  const cursorUpdates = [];
  const seenKeys = [];

  for (const file of files) {
    const key = `codex:${file}`;
    seenKeys.push(key);
    const { sessionId, rolloutSuffix } = parseName(file);
    const effectiveSession = rolloutSuffix ? `${sessionId}_${rolloutSuffix}` : sessionId;
    const cur = state.getCursor(key) || { offset: 0 };
    const r = readNewLines(file, cur.offset || 0);
    if (r.truncated) {
      // 文件被重写（revert / 轮转）：归零重读并标记，交由 L1 按 rid+version 收敛
      cursorUpdates.push([key, { offset: 0, truncated_at: new Date().toISOString() }]);
    }
    if (!r.lines.length) {
      cursorUpdates.push([key, { ...(cur || {}), offset: r.offset }]);
      continue;
    }
    // 单个文件的行可能很多 → 分批边转边交，避免整文件攒在内存里
    const FLUSH = 2000;
    let batch = [];
    for (const line of r.lines) {
      try {
        const rec = normalizeLine('codex', effectiveSession, line, { keepRaw: config.keepRaw });
        if (rec) batch.push(rec);
      } catch {
        // 单行解析失败不中断整批（不静默失败：由调用方汇总 parse_errors）
      }
      if (batch.length >= FLUSH) {
        emitSafe(effectiveSession, batch);
        batch = [];
      }
    }
    if (batch.length) emitSafe(effectiveSession, batch);
    cursorUpdates.push([key, { offset: r.offset, size: r.size, updated_at: new Date().toISOString() }]);
  }

  return { files: files.length, cursorUpdates, seenKeys };
}

module.exports = { name: 'codex', collect, discoverFiles, parseName, normalizeLine };

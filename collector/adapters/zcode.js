'use strict';

/**
 * ZCode 适配器 —— 三家里面唯一需要非平凡逻辑的。
 *
 * 数据源：~/.zcode/cli/db/db.sqlite（WAL 模式；采集器只读打开，绝不写/不加锁）
 *   session(id, project_id, directory, title, time_created, time_updated, task_type, ...)
 *   message(id, session_id, time_created, time_updated, data, sequence)
 *   part(id, message_id, session_id, time_created, time_updated, data, sequence)
 *   其中 message.data / part.data 是 JSON 字符串。
 *
 * 为什么不能用 offset 增量：
 *   实测 18622 条 message 里有 16140 条 time_updated > time_created——消息在生成
 *   过程中被反复更新（流式输出、工具结果回填）。所以既不是 append-only，
 *   也无法靠文件尾部推进。正确做法是：
 *
 *     水位线（time_updated）+ 重叠窗口（overlap）→ 每轮重读窗口内的行，
 *     产出带 version（= time_updated）的记录。L1 按 rid 取最大版本收敛，
 *     因此重读/重复发送是无害的（幂等由 L1 保证，L0 只负责"忠实记录观察"）。
 *
 * 展平：message 是外壳（含 role 等元信息），part 才是内容。故本适配器以
 * **part 为记录单位**，从所属 message 取 role，并丢掉纯 UI 噪音
 * （step-start / step-finish / timeline——它们不承载对话内容）。
 */

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { ROLE, makeRid, makeRecord, clip } = require('../lib/schema');

/** 重叠窗口：覆盖"写入时刻早于水位线、但更新时刻晚于水位线"的漏读风险 */
const OVERLAP_MS = 5 * 60 * 1000;

/** 纯 UI 噪音的 part 类型（不承载对话内容，跳过以免 L0 被界面细节淹没） */
const UI_NOISE = new Set(['step-start', 'step-finish', 'timeline', 'snapshot']);

function dbPathFor(config) {
  return path.join(config.paths.zcode, 'cli', 'db', 'db.sqlite');
}

/** 只读打开；失败返回 null（DB 不存在 / 被独占） */
function openDb(config) {
  const p = dbPathFor(config);
  if (!fs.existsSync(p)) return null;
  try {
    return new DatabaseSync(p, { readOnly: true });
  } catch {
    return null;
  }
}

function safeJson(s) {
  if (!s) return null;
  if (typeof s === 'object') return s;
  try { return JSON.parse(s); } catch { return null; }
}

function roleOf(msgData) {
  const r = msgData && msgData.role;
  switch (r) {
    case 'user': return ROLE.USER;
    case 'assistant': return ROLE.ASSISTANT;
    case 'system': return ROLE.SYSTEM;
    default: return ROLE.META;
  }
}

/** 把一个 part 转成归一化记录 */
function partToRecord(sessionId, msgRole, row, keepRaw) {
  const data = safeJson(row.data);
  if (!data) return { rec: null, noise: false };
  const type = data.type;
  if (UI_NOISE.has(type)) return { rec: null, noise: true };

  const version = Number(row.time_updated || row.time_created || 0);
  const ts = new Date(Number(row.time_created || row.time_updated || Date.now())).toISOString();
  const rid = makeRid('zcode', sessionId, `part_${row.id}`);
  const base = { rid, ts, version, seq: row.sequence ?? undefined, raw: keepRaw ? data : undefined };

  if (type === 'text') {
    return { rec: makeRecord({ ...base, role: msgRole, content: clip(data.text || '') }), noise: false };
  }
  if (type === 'reasoning') {
    return { rec: makeRecord({ ...base, role: ROLE.REASONING, content: clip(data.text || data.reasoning || '') }), noise: false };
  }
  if (type === 'tool') {
    const st = data.state || {};
    const isOutput = st.status === 'completed' && st.output != null;
    const content = isOutput ? st.output : st.input != null ? JSON.stringify(st.input) : '';
    return {
      rec: makeRecord({
        ...base,
        role: ROLE.TOOL,
        content: clip(content),
        meta: {
          kind: isOutput ? 'output' : 'call',
          tool: data.tool,
          call_id: data.callID,
          status: st.status,
          title: st.title,
        },
      }),
      noise: false,
    };
  }
  if (type === 'file') {
    return { rec: makeRecord({ ...base, role: ROLE.META, content: '', meta: { kind: 'file', ...(data.filename ? { file: data.filename } : {}) } }), noise: false };
  }

  // 未知类型：保留为 meta（不静默丢弃）
  return { rec: makeRecord({ ...base, role: ROLE.META, content: '', meta: { kind: type || 'unknown' } }), noise: false };
}

function stripUndef(o) {
  const out = {};
  for (const [k, v] of Object.entries(o || {})) if (v !== undefined && v !== null) out[k] = v;
  return out;
}

/**
 * 采集一轮（流式）。
 *
 * **内存纪律**：本机实测 part 有 6.7 万行、message 1.8 万行，若整轮 .all() 读进内存
 * 再归一化，峰值可达 800MB+（足以触发 pm2 max_memory_restart 反复重启）。
 * 因此按 rowid 键集分页读取，每页归一化后立刻通过 emit 交出，不跨页累积。
 *
 * 水位线存 state，key = `zcode:chat`（全局）/ `zcode:sessions`（会话元信息）。
 * @param {(sessionId:string, records:object[])=>void} emit 每页/每组记录产出时调用
 * @returns {{files:number, cursorUpdates:Array, seenKeys:Array, skippedNoise:number}}
 */
function collect(config, state, emit) {
  const db = openDb(config);
  if (!db) return { files: 0, cursorUpdates: [], seenKeys: [], skippedNoise: 0 };

  let skippedNoise = 0;
  const emitSafe = typeof emit === 'function' ? emit : () => {};

  try {
    // ---- 1) 会话元信息（新增/改名都按 time_updated 增量；仅数十行，可整取） ----
    const sessKey = 'zcode:sessions';
    const sessCur = state.getCursor(sessKey) || { watermark: 0 };
    const sessRows = db
      .prepare('SELECT id, project_id, directory, title, time_created, time_updated, task_type FROM session WHERE time_updated > ?')
      .all(Math.max(0, (sessCur.watermark || 0) - OVERLAP_MS));
    for (const s of sessRows) {
      emitSafe(s.id, [
        makeRecord({
          rid: makeRid('zcode', s.id, 'session'),
          ts: new Date(Number(s.time_created || s.time_updated)).toISOString(),
          version: Number(s.time_updated || 0),
          role: ROLE.META,
          content: '',
          meta: stripUndef({ kind: 'session', title: s.title, directory: s.directory, project: s.project_id, task_type: s.task_type }),
        }),
      ]);
    }

    // ---- 2) 内容：以 part 为单位，水位线 + 重叠窗口；按键集分页流式处理 ----
    const chatKey = 'zcode:chat';
    const chatCur = state.getCursor(chatKey) || { watermark: 0 };
    const since = Math.max(0, (chatCur.watermark || 0) - OVERLAP_MS);

    const PAGE = 2000;
    const pageStmt = db.prepare(
      `SELECT rowid AS rid_, id, message_id, session_id, time_created, time_updated, data, sequence
         FROM part
        WHERE time_updated > ? AND rowid > ?
        ORDER BY rowid ASC
        LIMIT ?`
    );

    let lastRowid = 0;
    let maxPart = chatCur.watermark || 0;
    for (;;) {
      const rows = pageStmt.all(since, lastRowid, PAGE);
      if (!rows.length) break;

      // part 的 role 来自所属 message —— 只取本页涉及的 message_id（本页量级）
      const msgIds = [...new Set(rows.map((r) => r.message_id))];
      const roleMap = new Map();
      const CHUNK = 500; // SQLite 变量上限保护
      for (let i = 0; i < msgIds.length; i += CHUNK) {
        const chunk = msgIds.slice(i, i + CHUNK);
        const ph = chunk.map(() => '?').join(',');
        for (const m of db.prepare(`SELECT id, data FROM message WHERE id IN (${ph})`).all(...chunk)) {
          roleMap.set(m.id, roleOf(safeJson(m.data)));
        }
      }

      // 本页归一化后按会话交出（同一会话可能跨页，多次 emit 是允许的——服务端追加到同一文件）
      const bySession = new Map();
      for (const row of rows) {
        const msgRole = roleMap.get(row.message_id) || ROLE.META;
        const { rec, noise } = partToRecord(row.session_id, msgRole, row, config.keepRaw);
        if (noise) { skippedNoise += 1; continue; }
        if (!rec) continue;
        if (!bySession.has(row.session_id)) bySession.set(row.session_id, []);
        bySession.get(row.session_id).push(rec);
      }
      for (const [sid, recs] of bySession) emitSafe(sid, recs);

      lastRowid = rows[rows.length - 1].rid_;
      for (const p of rows) maxPart = Math.max(maxPart, Number(p.time_updated || 0));

      if (rows.length < PAGE) break;
    }

    // ---- 3) 推进水位线（取本轮见到的最大 time_updated） ----
    const cursorUpdates = [];
    const maxSess = sessRows.reduce((n, s) => Math.max(n, Number(s.time_updated || 0)), sessCur.watermark || 0);
    if (sessRows.length) cursorUpdates.push([sessKey, { watermark: maxSess, updated_at: new Date().toISOString() }]);
    if (maxPart > (chatCur.watermark || 0)) {
      cursorUpdates.push([chatKey, { watermark: maxPart, updated_at: new Date().toISOString() }]);
    }

    return { files: 1, cursorUpdates, seenKeys: [sessKey, chatKey], skippedNoise };
  } finally {
    try { db.close(); } catch { /* 只读句柄，关闭失败无副作用 */ }
  }
}

module.exports = { name: 'zcode', collect, openDb, partToRecord, dbPathFor, OVERLAP_MS, UI_NOISE };

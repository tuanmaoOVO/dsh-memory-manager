// @dsh-external/dsh-memory-manager — 会话读取 / 轮次构建 / 排除与恢复
// 会话读取优先走 live Session（ctx.sessions），只读回退走 ctx.sessionQuery（可选服务）。
// 读取语义面向「会话事件表面（surface）」—— 与 DSH 内部实现解耦：
//  - live：session.surface.nodes + session.snapshotEvents()
//  - 只读：sessionQuery.readSurface()（当前模型表面，已是模型历史顺序）
// 排除/恢复需要可写 live 会话（session.append + surfaceOp），只读视图只提供浏览。
//
// 0.2.0 迁移要点：
//  - `Session.append` 对可上表面的事件（system/user/assistant/tool）**强制**携带 surfaceOp，
//    位置替换只接受 `{ op:'replace', startSeq, endSeq }`（恰好 3 个自有键），
//    且 sourceEventSeqs 必须完整覆盖被遮蔽的表面节点、引用更早的事件、不得重复。
//  - tool/result 的替换**只允许改 content**（其余字段须与原事件深度相等）。
//  - assistant/message 仍然不能携带 sourceEventSeqs（错误文案未变），恢复时降级为 user 文本。
//  - 消息来源不再有通用 'plugin' kind：本插件写入的标记用 `{ kind:'memory-manager' }`，
//    同时仍识别 0.1.x 历史会话里已落盘的 `{ kind:'plugin', plugin:'memory-manager' }`。

import { rand, isOwnSource, PLUGIN_KIND } from './util.js'

/** 排除标记前缀（写入表面的事件文本） */
export const MARKER_PREFIX = '[记忆管理] 该轮已被排除'
/** 0.1.5+ 无法原样还原 assistant 事件时的降级前缀（见 m.excludeTurn 的恢复分支） */
export const ASSISTANT_RESTORE_PREFIX = '[已恢复的助手回复] '
const MARKER_RE = /^\[记忆管理\] 该轮已被排除 \| turn=([A-Za-z0-9_-]+)/

/**
 * 在 manager 对象上安装会话能力。
 * @param m - 共享状态 { ctx, cfg, log, logger }（见 lib/index.js）
 */
export function installSessions(m) {
  // ================= 会话对象获取 =================
  m.liveSession = function liveSession(sessionId) {
    if (!sessionId) return null
    const sessions = m.ctx.get('sessions') ?? m.ctx.get('sessions', false)
    if (!sessions) return null
    try { return sessions.get(sessionId) || null } catch { return null }
  }
  // 把「会话」统一成视图：{ view: { surface: { nodes }, events, append? }, writable, live? }
  // view.events 按 seq 作下标（与历史代码契约一致）；live 会话额外提供 append（可写）。
  const wrapLive = (session) => {
    let snapshot = []
    try { snapshot = session.snapshotEvents ? session.snapshotEvents() : [] } catch { snapshot = [] }
    const nodes = session.surface && session.surface.nodes ? Array.from(session.surface.nodes) : []
    const events = new Array(Math.max(snapshot.length, ...(nodes.length ? nodes : [0])) + 1)
    for (const e of snapshot) events[e.seq] = e
    return {
      view: {
        surface: { nodes },
        events,
        append: (type, data, opts) => session.append(type, data, opts),
      },
      writable: true,
      live: session,
    }
  }
  // 只读回退：sessionQuery.readSurface（当前模型表面，已是模型历史顺序）。
  // 0.2.0 起 live 会话也可用 sessionQuery.readSurface（live-preferred），
  // 因此当 live Session 的 snapshotEvents 不可用（未来版本移除该 deprecated 读法）时，
  // 仍能拿到「当前表面 + 全部事件」；此时 writable=false，排除/恢复明确报错。
  m.readSessionSurfaceView = async function readSessionSurfaceView(sessionId) {
    const sq = m.ctx.get('sessionQuery') ?? m.ctx.get('sessionQuery', false)
    if (!sq || !sessionId) return null
    try {
      const snap = await sq.readSurface(sessionId)
      if (!snap || !Array.isArray(snap.events)) return null
      const events = new Array((snap.events.at(-1)?.seq ?? -1) + 1)
      for (const e of snap.events) events[e.seq] = e
      return { view: { surface: { nodes: snap.events.map((e) => e.seq) }, events }, writable: false }
    } catch { return null }
  }
  // live 视图：优先用内核 Session 自身的表面读法（与 append 同一份数据，写入前后一致）；
  // 该读法在 0.2.0 已标记 deprecated（docs/subsystems/session.md 的 Session 公共 API），
  // 因此失败时退回 sessionQuery.readSurface —— 此时不可写，排除/恢复会明确报错而不是静默出错。
  m.sessionView = async function sessionView(sessionId) {
    const live = m.liveSession(sessionId)
    if (live) {
      try {
        const wrapped = wrapLive(live)
        if (wrapped.view.events.length > 1 || wrapped.view.surface.nodes.length > 0) return wrapped
        // 空日志：新会话也走 live（可写），无需回退
        return wrapped
      } catch (e) {
        m.log('sessionView: live read failed, falling back to sessionQuery: ' + String((e && e.message) || e))
      }
    }
    return m.readSessionSurfaceView(sessionId)
  }

  // ================= 表面替换标记的跨版本适配 =================
  // 0.2.0（以及 0.1.5+）的 `SurfaceOp` 位置替换是 `{ op:'replace', startSeq, endSeq }`：
  // 校验函数 isReplaceOp 按 `Object.keys(op).length === 3` + `Object.hasOwn` 精确匹配
  // （packages/core/session/src/surface.ts），字段名不对会抛
  // `... carries an invalid replace surfaceOp`。
  // 0.1.2 用的是 `{ start, end }`；插件保留「首次探测 + 缓存」的回退链，
  // 使同一个包在 0.1.2 → 0.2.0 之间都能写：
  //  - 新形状优先（0.1.5+ / 0.2.0）
  //  - 旧形状仅在新形状被明确拒绝时尝试
  // Session.append 在校验失败时于写入日志**之前**抛出（0.2.0 的 validateNext 在 log.push 之前），
  // 因此回退重试不会产生脏日志。
  let replaceShape = null // 'seq' = 0.1.5+ / 0.2.0（startSeq/endSeq）；'range' = 0.1.2（start/end）
  const replaceIntent = (seq, shape) => ({
    surfaceOp: shape === 'range'
      ? { op: 'replace', start: seq, end: seq }
      : { op: 'replace', startSeq: seq, endSeq: seq },
    // 0.2.0：sourceEventSeqs 必须完整覆盖被遮蔽的表面节点（单节点替换即 [seq]）
    sourceEventSeqs: [seq],
  })
  /** 用 replace 语义写入一个事件；字段名按内核版本自适应。 */
  m.appendReplace = function appendReplace(view, type, data, seq) {
    if (replaceShape) return view.append(type, data, replaceIntent(seq, replaceShape))
    try {
      const event = view.append(type, data, replaceIntent(seq, 'seq'))
      replaceShape = 'seq'
      return event
    } catch (error) {
      if (!/invalid replace surfaceOp/.test(String((error && error.message) || error))) throw error
      const event = view.append(type, data, replaceIntent(seq, 'range'))
      replaceShape = 'range'
      m.log('sessions: surfaceOp 使用旧版字段名 start/end（dsh < 0.1.5）')
      return event
    }
  }

  // ================= 事件映射 =================
  m.nodeInfo = function nodeInfo(event) {
    if (!event) return null
    if (event.type === 'user/message') {
      const d = event.data || {}
      return { kind: 'user', id: d.id, text: m.textOf(d.content), time: event.time }
    }
    if (event.type === 'assistant/message') {
      const d = event.data || {}
      const msg = d.message || {}
      return { kind: 'assistant', id: msg.id, text: m.textOf(msg.content), time: event.time }
    }
    if (event.type === 'tool/result') {
      const d = event.data || {}
      const msg = d.message || {}
      return { kind: 'tool', id: msg.id, text: m.textOf(msg.content), time: event.time }
    }
    // 0.2.0 的表面类型集合新增 developer/message；system/message 是系统提示节点。
    // 两者都不是「对话轮次」的组成部分，刻意不映射（buildTurns 会自然跳过）。
    return null
  }
  m.isMarkerEvent = function isMarkerEvent(event) {
    if (!event) return false
    // 0.2.0 起本插件写入的标记 source 为 { kind:'memory-manager' }；
    // 0.1.x 写入的历史标记为 { kind:'plugin', plugin:'memory-manager' } —— 两者都算。
    if (event.type === 'user/message' && isOwnSource(event.data && event.data.source)) return true
    return event.type === 'tool/result' && m.markerTurnIdOf(event) !== null
  }
  // 事件文本：普通事件取其 text 块；tool 标记的标记文本存放在 tool-result 块的 content 中
  m.eventText = function eventText(event) {
    const info = m.nodeInfo(event)
    if (info && info.text) return info.text
    if (event && event.type === 'tool/result') {
      const c = event.data && event.data.message && event.data.message.content
      const b = Array.isArray(c) && c[0]
      if (b && typeof b === 'object') {
        if (typeof b.content === 'string') return b.content
        if (Array.isArray(b.content)) return m.textOf(b.content)
      }
    }
    return ''
  }
  m.markerTurnIdOf = function markerTurnIdOf(event) {
    const match = MARKER_RE.exec(m.eventText(event))
    return match ? match[1] : null
  }

  // ================= 轮次构建（基于会话表面） =================
  m.buildTurns = function buildTurns(view, sessionId, _plan) {
    const turns = []
    let cur = null
    const excluded = new Set(m.excludedOf(sessionId))
    for (const seq of view.surface.nodes) {
      const event = view.events[seq]
      if (!event) continue
      const info = m.nodeInfo(event)
      if (!info) continue
      if (m.isMarkerEvent(event)) {
        const turnId = m.markerTurnIdOf(event) || String(info.id)
        if (!cur || !cur.marker || cur.turnId !== turnId) {
          cur = { turnId, marker: true, excluded: true, nodes: [] }
          turns.push(cur)
        }
      } else if (event.type === 'user/message') {
        cur = { turnId: String(info.id), marker: false, excluded: excluded.has(String(info.id)), nodes: [] }
        turns.push(cur)
      }
      if (cur) {
        const full = m.eventText(event)
        cur.nodes.push({
          seq,
          kind: info.kind,
          id: String(info.id),
          preview: m.preview(full, 120),
          text: full,
          time: info.time,
        })
      }
    }
    return turns
  }

  // ================= 轮次定位 / 标记 =================
  m.findTurnSpan = function findTurnSpan(view, turnId) {
    const seqs = []
    let inTurn = false
    for (const seq of view.surface.nodes) {
      const event = view.events[seq]
      if (!event) continue
      const info = m.nodeInfo(event)
      if (!info) continue
      if (event.type === 'user/message' && !m.isMarkerEvent(event)) {
        if (String(info.id) === turnId) { inTurn = true; seqs.push(seq) }
        else if (inTurn) break
      } else if (inTurn && !m.isMarkerEvent(event)) {
        seqs.push(seq)
      }
    }
    return seqs
  }
  m.findMarkers = function findMarkers(view, turnId) {
    const out = []
    for (const seq of view.surface.nodes) {
      const event = view.events[seq]
      if (!event) continue
      if (!m.isMarkerEvent(event)) continue
      if (m.markerTurnIdOf(event) === turnId) out.push({ seq, event })
    }
    return out
  }
  m.makeMarker = function makeMarker(turnId) {
    return {
      id: 'mem-marker-' + rand(12),
      role: 'user',
      content: [{ type: 'text', text: MARKER_PREFIX + ' | turn=' + turnId }],
      // 0.2.0：MessageSource 没有通用 'plugin' kind，生产者声明自己的 kind
      source: { kind: PLUGIN_KIND },
    }
  }
  // 工具节点标记：data 与原 tool/result 事件深度相等（仅 message.content[0].content 替换为标记文本子块）
  m.makeToolMarker = function makeToolMarker(turnId, event) {
    const data = event && event.data
    const msg = data && data.message
    if (!msg || !Array.isArray(msg.content)) return null
    const b0 = msg.content[0]
    if (!b0 || typeof b0 !== 'object') return null
    return {
      ...data,
      message: {
        ...msg,
        content: [{ ...b0, content: [{ type: 'text', text: MARKER_PREFIX + ' | turn=' + turnId }] }],
      },
    }
  }

  // ================= 排除 / 恢复（非破坏；需要可写 live 会话） =================
  m.excludeTurn = async function excludeTurn(view, sessionId, turnId, exclude) {
    const excluded = await m.loadExcluded(sessionId)
    if (exclude) {
      if (excluded.includes(turnId)) return { ok: true }
      const span = m.findTurnSpan(view, turnId)
      if (!span.length) return { error: '未找到该轮次（可能已被排除或压缩）' }
      // 只统计目标轮之后的真实用户消息（不含插件标记）：保证「不能排除当前最新一轮」判定正确
      const spanSet = new Set(span)
      let laterUser = false
      let sawTarget = false
      for (const seq of view.surface.nodes) {
        const event = view.events[seq]
        if (!event) continue
        if (event.type === 'user/message' && !m.isMarkerEvent(event)) {
          if (sawTarget) { laterUser = true; break }
          if (spanSet.has(seq)) sawTarget = true
        }
      }
      if (!laterUser) return { error: '不能排除当前最新一轮（其后没有可作对话锚点的用户消息）' }
      // 预检查：span 内所有 tool/result 节点都必须能生成深度相等的标记；
      // 异常 shape 整体拒绝并返回错误，避免 user/assistant 已替换而 tool 失败的部分残留
      for (const seq of span) {
        const event = view.events[seq]
        if (event && event.type === 'tool/result' && !m.makeToolMarker(turnId, event)) {
          return { error: '该轮包含无法处理的工具结果节点（异常数据），已取消排除' }
        }
      }
      for (const seq of span) {
        const event = view.events[seq]
        if (!event) continue
        if (event.type === 'tool/result') {
          const marker = m.makeToolMarker(turnId, event)
          if (marker) {
            m.appendReplace(view, 'tool/result', marker, seq)
          } else {
            m.appendReplace(view, 'user/message', m.makeMarker(turnId), seq)
          }
        } else {
          m.appendReplace(view, 'user/message', m.makeMarker(turnId), seq)
        }
      }
      await m.saveExcluded(sessionId, [...excluded, turnId])
      return { ok: true }
    }
    // 恢复：自愈门槛不依赖 excluded.includes(turnId) —— 只要表面仍有标记就执行恢复
    const markers = m.findMarkers(view, turnId)
    if (!markers.length) return { ok: true }
    for (const { seq, event } of markers) {
      const origSeq = Array.isArray(event.sourceEventSeqs) ? event.sourceEventSeqs[0] : undefined
      const orig = origSeq !== undefined ? view.events[origSeq] : undefined
      if (!orig) continue
      const type = orig.type
      if (type === 'tool/result') {
        if (event.type === 'tool/result') {
          // 新版工具标记：data 与原事件深度相等（仅 content 替换为标记文本），可原样还原
          m.appendReplace(view, type, orig.data, seq)
        } else {
          // 旧版排除产生的 user 标记遮蔽了 tool 节点：以 user 文本形式还原内容（原始事件仍在日志中）
          m.appendReplace(view, 'user/message', {
            id: 'mem-restored-' + rand(10),
            role: 'user',
            source: { kind: 'user' },
            content: [{ type: 'text', text: m.eventText(orig) || '（工具结果，无文本）' }],
          }, seq)
        }
      } else if (type === 'assistant/message') {
        // 0.2.0（以及 0.1.5+）的 assistant/message 不能作为表面替换事件：内核禁止它携带
        // sourceEventSeqs（surface.ts 的 assertSourceEventReferences），而替换又必须携带被遮蔽
        // 节点的 seq，因此无法原样还原。降级为 user 文本还原，保证内容不丢
        // （与工具节点的降级路径一致）。注意：降级消息刻意使用 `kind:'user'`，
        // 不能用插件自己的 kind —— 否则会被 isMarkerEvent 当成新的排除标记。
        try {
          m.appendReplace(view, type, orig.data, seq)
        } catch (error) {
          if (!/assistant\/message embeds its source stream/.test(String((error && error.message) || error))) throw error
          m.appendReplace(view, 'user/message', {
            id: 'mem-restored-' + rand(10),
            role: 'user',
            source: { kind: 'user' },
            content: [{ type: 'text', text: ASSISTANT_RESTORE_PREFIX + (m.eventText(orig) || '（助手回复，无文本）') }],
          }, seq)
        }
      } else if (type === 'user/message') {
        m.appendReplace(view, type, orig.data, seq)
      }
    }
    if (excluded.includes(turnId)) {
      await m.saveExcluded(sessionId, excluded.filter((t) => t !== turnId))
    }
    return { ok: true }
  }

  // ================= 会话列表（跨工作区，只读） =================
  // 数据源全部可选读取，任一缺失即降级：
  //  - workspaceRegistry：工作区分组（list() → {id,title,sessionIds}）与 archivedSessionIds
  //  - sessionQuery：0.2.0 的 readTitle(id) → SessionTitleSnapshot{title,updatedAt}；
  //    listSessions() → SessionRecord[]{header{id,cwd,createdAt}, live, persisted}（完整逻辑语料，
  //    跨工作区、live+persisted 去重、按最新优先排序）
  // 工作区注册表整体缺失时，用 sessionQuery.listSessions() 合成一个「全部会话」分组，
  // 保证「跨工作区会话列表」在无 workspace 服务的组合里仍然可用。
  m.listWorkspaceSessions = async function listWorkspaceSessions() {
    const ws = m.ctx.get('workspaceRegistry') ?? m.ctx.get('workspaceRegistry', false)
    const sq = m.ctx.get('sessionQuery') ?? m.ctx.get('sessionQuery', false)
    m.log('sessions.list: ws=' + (ws ? 'ok' : 'undefined') + ' sq=' + (sq ? 'ok' : 'undefined'))
    const archived = new Set(ws !== undefined && ws.archivedSessionIds ? Array.from(ws.archivedSessionIds).map(String) : [])

    // 标题 / 时间：优先 sessionQuery.readTitle（0.2.0 返回 SessionTitleSnapshot）。
    const describe = async (sid) => {
      let title = '#' + String(sid).slice(-10)
      let updatedAt = null
      if (sq !== undefined) {
        try {
          const t = await sq.readTitle(sid)
          if (t && t.title) title = String(t.title)
          if (t && typeof t.updatedAt === 'number') updatedAt = t.updatedAt
        } catch { /* 容错：标题/时间缺失时回退 */ }
      }
      return { id: String(sid), title, updatedAt, archived: archived.has(String(sid)) }
    }

    const workspaces = []
    if (ws !== undefined) {
      let list = []
      try { list = ws.list() || [] } catch { list = [] }
      for (const w of list) {
        let sids = []
        try { sids = (w.sessionIds || []).map(String) } catch (e) { m.log('sessions.list: workspace sessionIds threw: ' + String((e && e.message) || e)) }
        m.log('sessions.list: workspace=' + String(w && (w.title || w.id)) + ' sids=' + sids.length)
        const sessions = await Promise.all(sids.map(describe))
        sessions.sort((x, y) => (y.updatedAt || 0) - (x.updatedAt || 0))
        workspaces.push({ id: String(w.id), title: String(w.title || '(未命名工作区)'), sessions })
      }
    } else if (sq !== undefined && typeof sq.listSessions === 'function') {
      // 0.2.0 新增：完整逻辑语料（live + persisted），作为无工作区服务时的兜底分组
      try {
        const records = await sq.listSessions()
        if (Array.isArray(records) && records.length) {
          const sids = records.map((r) => String(r && r.header ? r.header.id : '')).filter(Boolean)
          const sessions = await Promise.all(sids.map(describe))
          sessions.sort((x, y) => (y.updatedAt || 0) - (x.updatedAt || 0))
          workspaces.push({ id: '__all__', title: '（全部会话）', sessions })
          m.log('sessions.list: fallback corpus sessions=' + sessions.length)
        }
      } catch (e) {
        m.log('sessions.list: listSessions failed: ' + String((e && e.message) || e))
      }
    }
    m.log('sessions.list: workspaces=' + workspaces.length + ' totalSessions='
      + workspaces.reduce((n, w) => n + (w.sessions ? w.sessions.length : 0), 0))
    return { workspaces }
  }
}

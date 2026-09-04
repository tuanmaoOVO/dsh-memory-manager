// @dsh-external/dsh-memory-manager — 会话读取 / 轮次构建 / 排除与恢复
// 会话读取优先走 live Session（ctx.sessions），只读回退走 ctx.sessionQuery（可选服务）。
// 读取语义面向「会话事件表面（surface）」—— 与 DSH 内部实现解耦：
//  - live：session.surface.nodes + session.snapshotEvents()
//  - 只读：sessionQuery.readSurface()（当前模型表面，已是模型历史顺序）
// 排除/恢复需要可写 live 会话（session.append + surfaceOp），只读视图只提供浏览。

import { rand } from './util.js'

/** 排除标记前缀（写入表面的事件文本） */
export const MARKER_PREFIX = '[记忆管理] 该轮已被排除'
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
  // 只读回退：sessionQuery.readSurface（0.1.2 起的当前模型表面）
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
  m.sessionView = async function sessionView(sessionId) {
    const live = m.liveSession(sessionId)
    if (live) return wrapLive(live)
    return m.readSessionSurfaceView(sessionId)
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
    return null
  }
  m.isMarkerEvent = function isMarkerEvent(event) {
    if (!event) return false
    if (event.type === 'user/message' && event.data && event.data.source
      && event.data.source.kind === 'plugin' && event.data.source.plugin === m.pluginTag) return true
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
      source: { kind: 'plugin', plugin: m.pluginTag },
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
            view.append('tool/result', marker, { surfaceOp: { op: 'replace', start: seq, end: seq }, sourceEventSeqs: [seq] })
          } else {
            view.append('user/message', m.makeMarker(turnId), { surfaceOp: { op: 'replace', start: seq, end: seq }, sourceEventSeqs: [seq] })
          }
        } else {
          view.append('user/message', m.makeMarker(turnId), { surfaceOp: { op: 'replace', start: seq, end: seq }, sourceEventSeqs: [seq] })
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
          view.append(type, orig.data, { surfaceOp: { op: 'replace', start: seq, end: seq }, sourceEventSeqs: [seq] })
        } else {
          // 旧版排除产生的 user 标记遮蔽了 tool 节点：以 user 文本形式还原内容（原始事件仍在日志中）
          view.append('user/message', {
            id: 'mem-restored-' + rand(10),
            role: 'user',
            source: { kind: 'user' },
            content: [{ type: 'text', text: m.eventText(orig) || '（工具结果，无文本）' }],
          }, { surfaceOp: { op: 'replace', start: seq, end: seq }, sourceEventSeqs: [seq] })
        }
      } else if (type === 'user/message' || type === 'assistant/message') {
        view.append(type, orig.data, { surfaceOp: { op: 'replace', start: seq, end: seq }, sourceEventSeqs: [seq] })
      }
    }
    if (excluded.includes(turnId)) {
      await m.saveExcluded(sessionId, excluded.filter((t) => t !== turnId))
    }
    return { ok: true }
  }

  // ================= 会话列表（跨工作区，只读） =================
  m.listWorkspaceSessions = async function listWorkspaceSessions() {
    // workspaceRegistry（list/archivedSessionIds）+ sessionQuery（readTitle）均 ctx.get 可选读取，
    // 缺失时降级：仅返回工作区结构，标题回退 id 尾部。
    const ws = m.ctx.get('workspaceRegistry') ?? m.ctx.get('workspaceRegistry', false)
    const sq = m.ctx.get('sessionQuery') ?? m.ctx.get('sessionQuery', false)
    m.log('sessions.list: ws=' + (ws ? 'ok' : 'undefined') + ' sq=' + (sq ? 'ok' : 'undefined'))
    const archived = new Set(ws !== undefined && ws.archivedSessionIds ? Array.from(ws.archivedSessionIds).map(String) : [])
    const workspaces = []
    if (ws !== undefined) {
      let list = []
      try { list = ws.list() || [] } catch { list = [] }
      for (const w of list) {
        let sids = []
        try { sids = (w.sessionIds || []).map(String) } catch (e) { m.log('sessions.list: workspace sessionIds threw: ' + String((e && e.message) || e)) }
        m.log('sessions.list: workspace=' + String(w && (w.title || w.id)) + ' sids=' + sids.length)
        const sessions = await Promise.all(sids.map(async (sid) => {
          let title = '#' + String(sid).slice(-10)
          let updatedAt = null
          if (sq !== undefined) {
            try {
              const t = await sq.readTitle(sid)
              if (t && t.title) title = String(t.title)
              if (t && typeof t.updatedAt === 'number') updatedAt = t.updatedAt
            } catch { /* 容错：标题/时间缺失时回退 */ }
          }
          return { id: sid, title, updatedAt, archived: archived.has(sid) }
        }))
        sessions.sort((x, y) => (y.updatedAt || 0) - (x.updatedAt || 0))
        workspaces.push({ id: String(w.id), title: String(w.title || '(未命名工作区)'), sessions })
      }
    }
    m.log('sessions.list: workspaces=' + workspaces.length + ' totalSessions='
      + workspaces.reduce((n, w) => n + (w.sessions ? w.sessions.length : 0), 0))
    return { workspaces }
  }
}

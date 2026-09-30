// @dsh-external/dsh-memory-manager — HTTP API（宿主 ↔ 浏览器）
// 双通道（同一 handler）：
//  1) 标准通道：ctx.connection.rpc.intercept('/api', ...)  —— 经 DSH 连接层的同源认证 POST（如果存在）
//  2) 兼容通道：ctx.webServer.register({ kind:'exact', path:'/_dsh/memory-manager/api', ... }) —— 始终可用
// 客户端只认 GET/POST JSON 信封 { op, sessionId?, args? }，响应 { ok, value }。

import { rand } from './util.js'

export const API_PATH = '/_dsh/memory-manager/api'
/** 标准 RPC 通道的 endpoint 前缀：memory-manager/<op> */
export const RPC_ENDPOINT_PREFIX = 'memory-manager/'

/**
 * 在 manager 对象上安装 HTTP API 能力。
 * @param m - 共享状态（见 lib/index.js）
 * @returns disposers 数组
 */
export function installApi(m) {
  // ================= RPC 分发（纯业务；被两个通道共用） =================
  m.handler = async function handler(rawArgs) {
    try {
      if (!m.cfg.enabled && rawArgs && rawArgs.op !== 'state.get' && rawArgs.op !== 'state.setEnabled' && rawArgs.op !== 'diag.log') {
        return { error: '记忆管理已禁用（设置 → 记忆管理 中开启）' }
      }
      const args = (rawArgs && typeof rawArgs === 'object') ? rawArgs : {}
      const op = String(args.op || '')
      const sessionId = args.sessionId ? String(args.sessionId) : null
      const a = (args.args && typeof args.args === 'object') ? args.args : {}
      switch (op) {
        case 'state.get': {
          const plan = await m.loadPlan(sessionId)
          return {
            config: {
              enabled: m.cfg.enabled, mode: m.cfg.mode, view: m.cfg.view, modelTools: m.cfg.modelTools,
              libraryPath: m.libPath(), ready: true, reason: '',
              memoryChars: m.cfg.memoryChars, totalChars: m.cfg.totalChars, pinChars: m.cfg.pinChars,
              autoInjectConvention: m.cfg.autoInjectConvention !== false,
            },
            plan: plan ? {
              pinned: (plan.pinned || []).map((p) => ({ id: String(p.id), role: p.role || '', text: m.preview(p.text, 80), at: p.at || 0 })),
              memories: (plan.memories || []).map((item) => ({ id: String(item.id), title: String(item.title || ''), impressions: Array.isArray(item.impressions) ? item.impressions.map(String) : [], tags: Array.isArray(item.tags) ? item.tags.map(String) : [] })),
              excluded: await m.loadExcluded(sessionId),
              once: await m.loadOnce(),
              injectOnce: plan.injectOnce === true,
            } : null,
          }
        }
        case 'state.setEnabled': {
          m.cfg.enabled = a.v === true
          await m.settingsUpdate({ enabled: m.cfg.enabled })
          return { ok: true, enabled: m.cfg.enabled }
        }
        case 'state.setMode': {
          m.cfg.mode = a.mode === 'on' ? 'on' : 'off'
          await m.settingsUpdate({ mode: m.cfg.mode })
          return { ok: true, mode: m.cfg.mode }
        }
        case 'state.setView': {
          m.cfg.view = a.view === 'compact' ? 'compact' : 'full'
          await m.settingsUpdate({ view: m.cfg.view })
          return { ok: true, view: m.cfg.view }
        }
        case 'state.setModelTools': {
          m.cfg.modelTools = a.v === true
          await m.settingsUpdate({ modelTools: m.cfg.modelTools })
          return { ok: true }
        }
        case 'state.setAutoInject': {
          m.cfg.autoInjectConvention = a.v !== false
          await m.settingsUpdate({ autoInjectConvention: m.cfg.autoInjectConvention })
          return { ok: true, autoInjectConvention: m.cfg.autoInjectConvention }
        }
        case 'state.setLibrary': {
          const raw = String(a.path || '').trim()
          if (!raw) return { error: '路径不能为空' }
          if (!/^[A-Za-z]:[\\/]/.test(raw) && !raw.startsWith('/')) return { error: '请输入绝对路径' }
          m.cfg.libraryPath = m.norm(raw)
          if (!m.cfg.libraryPath) return { error: '路径解析失败' }
          await m.settingsUpdate({ libraryPath: m.cfg.libraryPath })
          await m.scanLibrary()
          return { ok: true, libraryPath: m.cfg.libraryPath }
        }
        case 'state.setCaps': {
          const patch = {}
          if (typeof a.memoryChars === 'number') { m.cfg.memoryChars = m.clamp(a.memoryChars, 500, 50000); patch.memoryChars = m.cfg.memoryChars }
          if (typeof a.totalChars === 'number') { m.cfg.totalChars = m.clamp(a.totalChars, 1000, 100000); patch.totalChars = m.cfg.totalChars }
          if (typeof a.pinChars === 'number') { m.cfg.pinChars = m.clamp(a.pinChars, 500, 50000); patch.pinChars = m.cfg.pinChars }
          await m.settingsUpdate(patch)
          return { ok: true }
        }
        case 'sessions.list':
          return await m.listWorkspaceSessions()
        case 'library.scan': {
          await m.scanLibrary()
          const list = []
          for (const mem of m.memoryIndex.values()) list.push(m.memoryMetaOf(mem))
          list.sort((x, y) => (y.updatedAt || 0) - (x.updatedAt || 0))
          return { memories: list }
        }
        case 'memory.read': {
          const id = String(a.id || '')
          const mem = m.memoryIndex.get(id)
          if (!mem) return { error: '记忆不存在: ' + id }
          return { meta: m.memoryMetaOf(mem), snapshot: mem.snapshot, notes: mem.notes }
        }
        case 'memory.save': {
          const dir = m.libPath()
          if (!dir) return { error: '记忆库未配置' }
          const title = String(a.title || '').trim() || ('记忆 ' + new Date().toISOString().slice(0, 10))
          const meta = {
            id: 'm_' + rand(10), title,
            impressions: m.sanitizeImpressions(a.impressions),
            tags: m.sanitizeImpressions(a.tags),
            enabled: a.enabled !== false,
            links: m.sanitizeIds(a.links),
            composedOf: [],
            sourceSession: sessionId,
            createdAt: Date.now(), updatedAt: Date.now(), revision: 1,
          }
          await m.writeMemory(meta, String(a.snapshot || '').slice(0, 40000), String(a.notes || '').slice(0, 20000))
          return m.memoryMetaOf(m.memoryIndex.get(meta.id))
        }
        case 'memory.update': {
          const id = String(a.id || '')
          const mem = m.memoryIndex.get(id)
          if (!mem) return { error: '记忆不存在: ' + id }
          const patch = (a.patch && typeof a.patch === 'object') ? a.patch : {}
          const meta = { ...mem.meta }
          if (patch.title !== undefined) meta.title = String(patch.title).slice(0, 200)
          if (patch.impressions !== undefined) meta.impressions = m.sanitizeImpressions(patch.impressions)
          if (patch.tags !== undefined) meta.tags = m.sanitizeImpressions(patch.tags)
          if (patch.enabled !== undefined) meta.enabled = patch.enabled === true
          if (patch.links !== undefined) {
            meta.links = m.sanitizeIds(patch.links).filter((l) => l !== id)
            meta.composedOf = Array.isArray(meta.composedOf) ? meta.composedOf : []
          }
          meta.revision = Number(meta.revision || 1) + 1
          meta.updatedAt = Date.now()
          const notes = patch.notes !== undefined ? String(patch.notes).slice(0, 20000) : mem.notes
          await m.writeMemory(meta, mem.snapshot, notes)
          return m.memoryMetaOf(m.memoryIndex.get(id))
        }
        case 'memory.setEnabled': {
          const id = String(a.id || '')
          const mem = m.memoryIndex.get(id)
          if (!mem) return { error: '记忆不存在: ' + id }
          const meta = { ...mem.meta, enabled: a.enabled !== false }
          meta.revision = Number(meta.revision || 1) + 1
          meta.updatedAt = Date.now()
          await m.writeMemory(meta, mem.snapshot, mem.notes)
          // 禁用时从所有会话的注入计划中移除该记忆（全局生效，含内存缓存与已落盘计划）
          if (a.enabled === false) {
            try { await m.purgeMemoryFromPlans(id) } catch (e) { m.log('memory.setEnabled: purge failed: ' + String((e && e.message) || e)) }
          }
          return m.memoryMetaOf(m.memoryIndex.get(id))
        }
        case 'memory.delete': {
          const id = String(a.id || '')
          const mem = m.memoryIndex.get(id)
          if (!mem) return { error: '记忆不存在: ' + id }
          await m.deleteMemoryFile(id)
          return { ok: true }
        }
        case 'memory.compose': {
          const dir = m.libPath()
          if (!dir) return { error: '记忆库未配置' }
          const ids = m.sanitizeIds(a.ids)
          if (!ids.length) return { error: '未选择记忆' }
          const srcs = ids.map((id) => m.memoryIndex.get(id)).filter(Boolean)
          if (!srcs.length) return { error: '所选记忆不存在' }
          const mode = a.mode === 'llm' ? 'llm' : (a.mode === 'manual' ? 'manual' : 'concat')
          let body
          if (mode === 'concat') {
            body = srcs.map((m) => '--- ' + String(m.meta.title || m.meta.id) + ' ---\n' + m.snapshot).join('\n\n')
          } else if (mode === 'manual') {
            body = String(a.body || '').trim()
            if (!body) return { error: '手动模式需要填写正文' }
          } else {
            const input = srcs.map((mem, i) => '【' + (i + 1) + '】' + String(mem.meta.title || mem.meta.id) + '\n' + String(mem.snapshot || '').slice(0, 5000)).join('\n\n')
            const out = await m.askLlm(
              '你是记忆整理助手。将下面多段记忆综合成一段新的结构化记忆：保留关键事实、决定、待办和重要细节，合并重复信息，条理清晰，直接输出正文（Markdown），不要标题前缀。',
              input, 2000)
            if (!out) return { error: 'LLM 生成失败' }
            body = out
          }
          const title = String(a.title || '').trim() || '组合记忆'
          const meta = {
            id: 'm_' + rand(10), title,
            impressions: m.sanitizeImpressions(a.impressions),
            composedOf: ids,
            sourceSession: sessionId,
            createdAt: Date.now(), updatedAt: Date.now(), revision: 1,
          }
          meta.links = ids.filter((l) => l !== meta.id)
          await m.writeMemory(meta, body.slice(0, 40000), '')
          return m.memoryMetaOf(m.memoryIndex.get(meta.id))
        }
        case 'memory.related': {
          const id = String(a.id || '')
          if (!m.memoryIndex.has(id)) return { error: '记忆不存在: ' + id }
          const depth = m.clamp(Number(a.depth) || 2, 1, 4)
          const limit = m.clamp(Number(a.limit) || 30, 1, 100)
          return { related: m.relatedOf(id, depth, limit) }
        }
        case 'memory.suggest': {
          const content = String(a.content || '').slice(0, 8000)
          if (!content) return { error: '内容为空' }
          return await m.suggestImpressions(content)
        }
        case 'session.messages': {
          const view = await m.sessionView(sessionId)
          if (!view) return { error: '会话不存在或不在线' }
          const plan = await m.loadPlan(sessionId)
          const turns = m.buildTurns(view.view, sessionId, plan)
          const limit = m.clamp(Number(a.limit) || 30, 5, 200)
          return { turns: turns.slice(-limit).map((t) => ({ turnId: t.turnId, excluded: t.excluded, marker: !!t.marker, nodes: t.nodes })) }
        }
        case 'session.summarize':
          return await m.summarizeSession(sessionId, a)
        case 'session.saveAsMemory': {
          const view = await m.sessionView(sessionId)
          if (!view) return { error: '会话不存在或不在线' }
          const dir = m.libPath()
          if (!dir) return { error: '记忆库未配置' }
          const ids = Array.isArray(a.messageIds) ? a.messageIds.map(String) : []
          if (!ids.length) return { error: '未选择消息' }
          const want = new Set(ids)
          const parts = []
          const sourceSeqs = []
          let found = 0
          for (const seq of view.view.surface.nodes) {
            const event = view.view.events[seq]
            if (!event) continue
            const info = m.nodeInfo(event)
            if (!info) continue
            if (!want.has(String(info.id))) continue
            found++
            sourceSeqs.push(seq)
            const roleLabel = info.kind === 'user' ? '用户' : (info.kind === 'assistant' ? '助手' : '工具结果')
            parts.push('### ' + roleLabel + '\n' + (info.text || '（无文本内容）'))
            if (found >= want.size) break
          }
          if (!found) return { error: '未找到所选消息（可能已被排除或压缩）' }
          const title = String(a.title || '').trim() || ('记忆 ' + new Date().toISOString().slice(0, 10))
          const meta = {
            id: 'm_' + rand(10), title,
            impressions: m.sanitizeImpressions(a.impressions),
            tags: m.sanitizeImpressions(a.tags),
            links: m.sanitizeIds(a.links),
            composedOf: [],
            sourceSession: sessionId,
            sourceSeqs,
            createdAt: Date.now(), updatedAt: Date.now(), revision: 1,
          }
          await m.writeMemory(meta, parts.join('\n\n'), String(a.notes || ''))
          return m.memoryMetaOf(m.memoryIndex.get(meta.id))
        }
        case 'session.pin': {
          const view = await m.sessionView(sessionId)
          if (!view) return { error: '会话不存在或不在线' }
          const plan = await m.loadPlan(sessionId)
          const ids = Array.isArray(a.messageIds) ? a.messageIds.map(String) : []
          const want = new Set(ids)
          const found = []
          for (const seq of view.view.surface.nodes) {
            const event = view.view.events[seq]
            if (!event) continue
            const info = m.nodeInfo(event)
            if (!info) continue
            if (want.has(String(info.id))) found.push({ kind: info.kind, id: String(info.id), text: info.text })
            if (found.length >= want.size) break
          }
          if (a.pin === false) {
            const keep = new Set(ids)
            plan.pinned = (plan.pinned || []).filter((p) => !keep.has(String(p.id)))
          } else {
            for (const n of found) {
              const already = (plan.pinned || []).some((p) => String(p.id) === n.id)
              if (already) continue
              plan.pinned.push({ id: n.id, role: n.kind, text: String(n.text || '').slice(0, 4000), at: Date.now() })
            }
          }
          await m.savePlan(sessionId, plan)
          return { ok: true, pinned: (plan.pinned || []).map((p) => ({ id: String(p.id), role: p.role || '', text: m.preview(p.text, 80), at: p.at || 0 })) }
        }
        case 'session.injectNow': {
          // 直接注入：把记忆作为模型上下文注入当前会话（Agent.inject —— 官方上下文注入机制），
          // 并唤醒 driver（Agent.steer）让模型立即基于它响应一次。
          // 0.2.0：Agent.inject / Agent.steer 仍在（core/agent 的 AgentHandle 接口），
          // 且 MessageSource 使用插件自己的 kind（通用 'plugin' kind 已移除）。
          if (!sessionId) return { error: '缺少会话 id' }
          const id = String(a.id || '')
          const mem = m.memoryIndex.get(id)
          if (!mem) return { error: '记忆不存在: ' + id }
          if (mem.meta.enabled === false) return { error: '该记忆已禁用' }
          const agentsSvc = m.ctx.get('agents') ?? m.ctx.get('agents', false)
          const agent = agentsSvc && typeof agentsSvc.get === 'function' ? agentsSvc.get(sessionId) : undefined
          if (!agent || typeof agent.inject !== 'function') {
            return { error: '当前会话不是可注入的活动会话（live agent）' }
          }
          const title = String(mem.meta.title || id)
          const imp = Array.isArray(mem.meta.impressions) ? mem.meta.impressions.map(String).join('、') : ''
          let text = '【记忆注入】' + title + (imp ? '（印象: ' + imp + '）' : '')
          text += '\n' + String(mem.snapshot || '').slice(0, 12000)
          const notes = String(mem.notes || '').trim()
          if (notes) text += '\n[标注] ' + notes.slice(0, 4000)
          try {
            agent.inject({
              id: 'mem-inject-' + rand(10),
              role: 'user',
              content: [{ type: 'text', text }],
              source: { kind: m.pluginKind, form: 'notice', summary: '记忆注入：' + title.slice(0, 60) },
            })
          } catch (e) {
            return { error: '上下文注入失败: ' + String((e && e.message) || e) }
          }
          let replied = false
          try {
            if (typeof agent.steer === 'function') {
              agent.steer({
                id: 'mem-inject-steer-' + rand(10),
                role: 'user',
                content: [{ type: 'text', text: '（参考记忆已注入，请结合它继续当前对话；若无需回应的要点请简要确认）' }],
                source: { kind: m.pluginKind },
              })
              replied = true
            }
          } catch (e) { m.log('session.injectNow: steer failed: ' + String((e && e.message) || e)) }
          m.log('session.injectNow: ' + sessionId + ' <- ' + id + ' replied=' + replied)
          return { ok: true, title, replied }
        }
        case 'plan.addMemory': {
          const plan = await m.loadPlan(sessionId)
          const id = String(a.id || '')
          const mem = m.memoryIndex.get(id)
          if (!mem) return { error: '记忆不存在: ' + id }
          if (mem.meta.enabled === false) return { error: '该记忆已禁用（启用后才可加入注入计划）' }
          const exists = (plan.memories || []).some((item) => String(item.id) === id)
          if (!exists) plan.memories.push({ id, title: String(mem.meta.title || ''), impressions: Array.isArray(mem.meta.impressions) ? mem.meta.impressions.map(String) : [], tags: Array.isArray(mem.meta.tags) ? mem.meta.tags.map(String) : [] })
          await m.savePlan(sessionId, plan)
          return { ok: true }
        }
        case 'plan.removeMemory': {
          const plan = await m.loadPlan(sessionId)
          const id = String(a.id || '')
          plan.memories = (plan.memories || []).filter((item) => String(item.id) !== id)
          await m.savePlan(sessionId, plan)
          return { ok: true }
        }
        case 'plan.injectOnce': {
          const plan = await m.loadPlan(sessionId)
          plan.injectOnce = a.v === true
          await m.savePlan(sessionId, plan)
          return { ok: true }
        }
        case 'plan.injectOnceMemory': {
          // 选中记忆 → 下一次发送时注入（全局队列，不入计划；任何会话的第一次请求渲染后自动清除）
          const id = String(a.id || '')
          if (a.cancel === true) {
            const once = await m.loadOnce()
            const next = once.filter((item) => String(item.id) !== id)
            if (next.length !== once.length) {
              await m.saveOnce(next)
              m.log('plan.injectOnceMemory(cancel): session=' + sessionId + ' <- ' + id + ' onceCount=' + next.length)
            }
            return { ok: true, onceCount: next.length }
          }
          const mem = m.memoryIndex.get(id)
          if (!mem) return { error: '记忆不存在: ' + id }
          if (mem.meta.enabled === false) return { error: '该记忆已禁用' }
          const once = await m.loadOnce()
          if (!once.some((item) => String(item.id) === id)) {
            once.push({
              id, title: String(mem.meta.title || ''),
              impressions: Array.isArray(mem.meta.impressions) ? mem.meta.impressions.map(String) : [],
              tags: Array.isArray(mem.meta.tags) ? mem.meta.tags.map(String) : [],
            })
            await m.saveOnce(once)
          }
          m.log('plan.injectOnceMemory: session=' + sessionId + ' <- ' + id + ' onceCount=' + once.length)
          return { ok: true, onceCount: once.length }
        }
        case 'plan.excludeTurn': {
          const view = await m.sessionView(sessionId)
          if (!view) return { error: '会话不存在或不在线' }
          if (!view.writable) return { error: '排除/恢复需要 live 会话（宿主模式暂不支持）' }
          const turnId = String(a.turnId || '')
          if (!turnId) return { error: '缺少轮次 id' }
          return await m.excludeTurn(view.view, sessionId, turnId, a.exclude !== false)
        }
        case 'diag.log': {
          // 前端日志落盘（client → host），供界面排错
          m.logClientLine([new Date().toISOString(), a.level || 'info', a.tag || '', String(a.msg || '').slice(0, 4000)].join(' | '))
          if (a.stack) m.logClientLine('  stack: ' + String(a.stack).slice(0, 4000))
          return { ok: true }
        }
        default:
          return { error: '未知操作: ' + op }
      }
    } catch (err) {
      return { error: (err && err.message) ? err.message : String(err) }
    }
  }

  // ================= HTTP 传输（node:http） =================
  const readBody = async (req, maxBytes) => {
    const chunks = []
    let bytes = 0
    for await (const chunk of req) {
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += part.length
      if (bytes > maxBytes) throw new Error('请求体过大')
      chunks.push(part)
    }
    return Buffer.concat(chunks).toString('utf8')
  }
  const sendJson = (res, status, body) => {
    const text = JSON.stringify(body)
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.writeHead(status)
    res.end(text)
  }
  const routeHandler = async (req, res) => {
    try {
      if (req.method === 'GET') {
        sendJson(res, 200, { ok: true, service: 'memory-manager', enabled: m.cfg.enabled })
        return
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      const raw = await readBody(req, 256 * 1024)
      let body
      try { body = JSON.parse(raw) } catch { body = null }
      if (!body || typeof body !== 'object') {
        sendJson(res, 400, { ok: false, error: 'bad json' })
        return
      }
      const result = await m.handler(body)
      sendJson(res, 200, { ok: !result || !result.error, value: result })
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  const disposers = []

  // 1) 兼容通道：webServer 精确路由（所有 web profile 均可用）
  try {
    if (typeof m.ctx.inject === 'function') {
      const injected = m.ctx.inject(['webServer'], (webCtx) => webCtx.effect(() => webCtx.webServer.register({
        kind: 'exact',
        path: API_PATH,
        handler: routeHandler,
      }), 'memory-manager: http api'))
      // cordis 的 ctx.inject 返回 thenable（可能只有 .then 没有 .catch），统一包成 Promise 吞掉异步错误
      if (injected && typeof injected.then === 'function') Promise.resolve(injected).catch(() => {})
    }
    m.log('http route registered (webServer)')
  } catch (error) {
    m.logError(error)
    m.logger.warn('dsh-memory-manager: webServer route attach failed — %s', error instanceof Error ? error.message : String(error))
  }

  // 2) 标准通道：connection.rpc.intercept('/api', ...)（更正式的鉴权通道；存在才注册）
  try {
    const connection = m.ctx.get('connection') ?? m.ctx.get('connection', false)
    const rpc = connection && connection.rpc
    if (rpc && typeof rpc.intercept === 'function') {
      const disposePromise = rpc.intercept(
        '/api',
        (endpoint) => typeof endpoint === 'string' && endpoint.startsWith(RPC_ENDPOINT_PREFIX),
        async (endpoint, payload) => {
          const op = String(endpoint).slice(RPC_ENDPOINT_PREFIX.length)
          const envelope = (payload && typeof payload === 'object' && payload.args && typeof payload.args === 'object')
            ? { op, ...payload.args }
            : { op }
          const result = await m.handler(envelope)
          if (result && result.error) return { ok: false, error: { code: 'MEMORY_MANAGER_ERROR', message: String(result.error), details: {} } }
          return { ok: true, value: result }
        },
      )
      if (typeof disposePromise === 'object' && disposePromise !== null && typeof disposePromise.then === 'function') {
        Promise.resolve(disposePromise).then((dispose) => { if (typeof dispose === 'function') disposers.push(dispose) }).catch(() => {})
      }
      m.log('rpc channel registered (connection.rpc.intercept)')
    }
  } catch (error) {
    m.log('rpc channel attach skipped: ' + String((error && error.message) || error))
  }

  return disposers
}

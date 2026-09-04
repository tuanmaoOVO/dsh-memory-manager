// @dsh-external/dsh-memory-manager — 注入计划 / 轮次排除 / 一次性注入 / 自动注入 / 注入渲染
// 数据全部落盘在记忆库 pinned/ 下（node:fs 直读写），与 DSH 会话存储完全隔离。

import { readJson, writeJson } from './util.js'

/** 规约记忆标签：tags 含该值的记忆被视为规约记忆，参与新会话自动注入（需 enabled=true） */
export const CONVENTION_TAG = 'convention'
/** 会话总结记忆标签：tags 含该值的记忆视为「会话总结」记忆，默认参与新会话自动注入 */
export const SUMMARY_TAG = '会话总结'
/** 新会话自动注入的会话总结记忆上限（按 updatedAt 降序取最近 N 条） */
export const SUMMARY_AUTO_INJECT_MAX = 8

/**
 * 在 manager 对象上安装计划能力。
 * @param m - 共享状态 { ctx, cfg, planCache, excludedCache, onceCacheList, log, logger }（见 lib/index.js）
 */
export function installPlan(m) {
  m.planPath = function planPath() {
    const dir = m.libPath()
    return dir ? m.libPath() + '/pinned/plan.json' : null
  }
  m.excludedFile = function excludedFile() {
    const dir = m.libPath()
    return dir ? dir + '/pinned/excluded.json' : null
  }
  m.onceFile = function onceFile() {
    const dir = m.libPath()
    return dir ? dir + '/pinned/once.json' : null
  }

  // ================= 注入计划（全局单一：所有会话共享同一份计划） =================
  m.loadPlan = async function loadPlan(_sessionId) {
    let plan = m.planCache.get('global')
    if (plan === undefined) {
      const p = m.planPath()
      const saved = p ? await readJson(p) : null
      m.log('loadPlan: global saved=' + (saved ? 'yes' : 'no'))
      plan = (saved && typeof saved === 'object') ? saved : {}
      if (!Array.isArray(plan.pinned)) plan.pinned = []
      if (!Array.isArray(plan.memories)) plan.memories = []
      if (plan.injectOnce !== true) plan.injectOnce = false
      m.planCache.set('global', plan)
      // 全局计划首次创建：自动注入当前启用的规约记忆与最近会话总结（仅此一次初始化，之后完全由用户掌控）
      if (!saved) {
        try { await m.autoInjectConventions(plan) } catch (e) { m.log('loadPlan: autoInject threw: ' + String((e && e.message) || e)) }
      }
    }
    return plan
  }
  m.savePlan = async function savePlan(_sessionIdOrPlan, maybePlan) {
    const plan = maybePlan !== undefined ? maybePlan : _sessionIdOrPlan
    m.planCache.set('global', plan)
    const p = m.planPath()
    if (p) await writeJson(p, { pinned: plan.pinned, memories: plan.memories, injectOnce: plan.injectOnce === true })
  }

  // ================= 会话级轮次排除存储（pinned/excluded.json，按会话 id 分键） =================
  m.loadExcluded = async function loadExcluded(sessionId) {
    if (!sessionId) return []
    if (m.excludedCache.has(sessionId)) return m.excludedCache.get(sessionId)
    const p = m.excludedFile()
    let list = []
    if (p) {
      const data = await readJson(p)
      if (data && Array.isArray(data[sessionId])) list = data[sessionId].map(String)
    }
    m.excludedCache.set(sessionId, list)
    return list
  }
  m.excludedOf = function excludedOf(sessionId) {
    return sessionId && m.excludedCache.has(sessionId) ? m.excludedCache.get(sessionId) : []
  }
  m.saveExcluded = async function saveExcluded(sessionId, list) {
    if (!sessionId) return
    m.excludedCache.set(sessionId, list)
    const p = m.excludedFile()
    if (!p) return
    const data = (await readJson(p)) || {}
    data[sessionId] = list
    await writeJson(p, data)
  }

  // ================= 一次性注入记忆存储（pinned/once.json，全局队列） =================
  m.loadOnce = async function loadOnce() {
    if (m.onceCacheList) return m.onceCacheList
    const p = m.onceFile()
    let list = []
    if (p) {
      const data = await readJson(p)
      if (Array.isArray(data)) list = data
      else if (data && typeof data === 'object') {
        // 旧版按会话分键结构（{ sessionId: [...] }）：合并迁移为全局数组
        list = Object.values(data).flat().filter(Boolean)
        if (list.length) await writeJson(p, list)
      }
    }
    m.onceCacheList = list
    return list
  }
  m.onceOf = function onceOf() {
    return m.onceCacheList || []
  }
  m.saveOnce = async function saveOnce(list) {
    m.onceCacheList = list
    const p = m.onceFile()
    if (!p) return
    await writeJson(p, list)
  }

  // 从全局注入计划（内存缓存 + pinned/plan.json）中移除指定记忆（禁用记忆时全局生效）
  m.purgeMemoryFromPlans = async function purgeMemoryFromPlans(id) {
    const plan = m.planCache.get('global')
    if (plan && Array.isArray(plan.memories) && plan.memories.some((item) => String(item.id) === id)) {
      plan.memories = plan.memories.filter((item) => String(item.id) !== id)
      try { await m.savePlan(plan) } catch { /* ignore */ }
    }
    const p = m.planPath()
    if (p) {
      const saved = await readJson(p)
      if (saved && Array.isArray(saved.memories) && saved.memories.some((item) => String(item.id) === id)) {
        saved.memories = saved.memories.filter((item) => String(item.id) !== id)
        try { await writeJson(p, { pinned: saved.pinned || [], memories: saved.memories, injectOnce: saved.injectOnce === true }) } catch { /* ignore */ }
      }
    }
  }

  // ================= 规约记忆自动注入（新会话常驻） =================
  // 新会话判定：会话尚无任何对话消息（user/message 或 assistant/message）。
  // 系统策略事件（permission/preset、sandbox/mode、approval/policy 等）不算「有历史」。
  m.isNewSession = async function isNewSession(sessionId, hintSession) {
    if (hintSession && typeof hintSession === 'object') {
      let log = null
      try {
        if (Array.isArray(hintSession.log)) log = hintSession.log
        else if (Array.isArray(hintSession.events)) log = hintSession.events
        else if (typeof hintSession.snapshotEvents === 'function') log = hintSession.snapshotEvents()
      } catch (e) { m.log('isNewSession: hint snapshot threw: ' + String((e && e.message) || e)) }
      const hasDialogue = Array.isArray(log) && log.some((e) => e && (e.type === 'user/message' || e.type === 'assistant/message'))
      m.log('isNewSession: ' + sessionId + ' logLen=' + (Array.isArray(log) ? log.length : 'n/a') + ' hasDialogue=' + hasDialogue)
      return !hasDialogue
    }
    const live = m.liveSession ? m.liveSession(sessionId) : null
    if (live) {
      let slog = []
      try { slog = live.snapshotEvents ? live.snapshotEvents() : (Array.isArray(live.log) ? live.log : []) } catch { slog = [] }
      const hasDialogue = slog.some((e) => e && (e.type === 'user/message' || e.type === 'assistant/message'))
      m.log('isNewSession: ' + sessionId + ' live logLen=' + slog.length + ' hasDialogue=' + hasDialogue)
      return !hasDialogue
    }
    return false
  }
  // 启用状态的规约记忆（tags 含 convention 且 enabled !== false）
  m.conventionMemories = async function conventionMemories() {
    if (m.memoryIndex.size === 0) await m.scanLibrary()
    m.log('conventionMemories: index=' + m.memoryIndex.size + ' lib=' + String(m.libPath()))
    const out = []
    for (const mem of m.memoryIndex.values()) {
      const tags = Array.isArray(mem.meta.tags) ? mem.meta.tags.map(String) : []
      if (!tags.includes(CONVENTION_TAG)) continue
      if (mem.meta.enabled === false) continue
      out.push({
        id: String(mem.meta.id),
        title: String(mem.meta.title || mem.meta.id),
        impressions: Array.isArray(mem.meta.impressions) ? mem.meta.impressions.map(String) : [],
        tags,
      })
    }
    return out
  }
  // 启用状态的会话总结记忆（tags 含 会话总结 且 enabled !== false），按 updatedAt 降序取最近 limit 条
  m.summaryMemories = async function summaryMemories(limit) {
    if (m.memoryIndex.size === 0) await m.scanLibrary()
    const caps = Number(limit) > 0 ? Number(limit) : SUMMARY_AUTO_INJECT_MAX
    const out = []
    for (const mem of m.memoryIndex.values()) {
      const tags = Array.isArray(mem.meta.tags) ? mem.meta.tags.map(String) : []
      if (!tags.includes(SUMMARY_TAG)) continue
      if (mem.meta.enabled === false) continue
      out.push({
        id: String(mem.meta.id),
        title: String(mem.meta.title || mem.meta.id),
        impressions: Array.isArray(mem.meta.impressions) ? mem.meta.impressions.map(String) : [],
        tags,
        updatedAt: Number(mem.meta.updatedAt) || 0,
      })
    }
    out.sort((x, y) => (y.updatedAt || 0) - (x.updatedAt || 0))
    return out.slice(0, caps)
  }
  // 全局计划初始化：把启用中的规约记忆 + 最近 N 条会话总结加入计划（仅首次创建计划文件时调用）
  m.autoInjectConventions = async function autoInjectConventions(plan) {
    m.log('autoInject: enabled=' + m.cfg.enabled + ' autoInjectConvention=' + m.cfg.autoInjectConvention)
    if (!m.cfg.enabled || m.cfg.autoInjectConvention === false) return false
    const convs = await m.conventionMemories()
    m.log('autoInject: conventions=' + convs.length)
    const summs = (await m.summaryMemories(SUMMARY_AUTO_INJECT_MAX)).map((s) => ({ id: s.id, title: s.title, impressions: s.impressions, tags: s.tags }))
    m.log('autoInject: summaries=' + summs.length)
    if (!convs.length && !summs.length) return false
    let added = false
    const push = (items) => {
      for (const c of items) {
        if ((plan.memories || []).some((item) => String(item.id) === c.id)) continue
        plan.memories.push(c)
        added = true
      }
    }
    push(convs)
    push(summs)
    if (added) {
      // 并发防护：autoInject 的异步链（scanLibrary 等）期间用户可能已操作计划；
      // 若计划文件已被写入则以文件为准，放弃本次注入，避免覆盖用户修改。
      const p = m.planPath()
      const current = p ? await readJson(p) : null
      if (current && typeof current === 'object' && Array.isArray(current.memories)) {
        m.planCache.set('global', current)
        m.log('autoInject: concurrent plan write detected, skip inject save')
      } else {
        await m.savePlan(plan)
      }
    }
    return added
  }

  // ================= 注入渲染（纯函数：不消费 once 队列 / 不复位 injectOnce） =================
  m.renderContextFor = function renderContextFor(sessionId) {
    if (!m.cfg.enabled) return ''
    let plan = m.planCache.get('global')
    if (!plan) plan = { pinned: [], memories: [], injectOnce: false }
    const onceList = m.onceOf()
    const active = m.cfg.mode === 'on' || plan.injectOnce === true || onceList.length > 0
    if (!active) return ''
    if (onceList.length) m.log('renderContextFor: session=' + sessionId + ' once=' + onceList.map((item) => item && item.id).join(',') + ' mode=' + m.cfg.mode)
    const parts = []
    let budget = Number(m.cfg.totalChars) || 12000
    const pinBudget = Math.min(Number(m.cfg.pinChars) || 6000, budget)
    let pinUsed = 0
    for (const pin of plan.pinned || []) {
      if (pinUsed >= pinBudget) break
      const t = String(pin.text || '').trim()
      if (!t) continue
      const take = Math.min(t.length, pinBudget - pinUsed)
      parts.push('[固定消息' + (pin.role ? ' ·' + pin.role : '') + '] ' + t.slice(0, take))
      pinUsed += take
    }
    budget -= pinUsed
    for (const mref of plan.memories || []) {
      if (budget <= 0) break
      const mem = m.memoryIndex.get(String(mref.id))
      if (!mem) continue
      if (mem.meta.enabled === false) continue
      const tags = Array.isArray(mem.meta.tags) ? mem.meta.tags.map(String) : []
      const perCap = Number(m.cfg.memoryChars) || 6000
      let body
      if (m.cfg.view === 'compact') {
        const imp = Array.isArray(mem.meta.impressions) ? mem.meta.impressions.join('、') : ''
        body = '标题「' + String(mem.meta.title || mref.id) + '」' + (imp ? ' 印象: ' + imp : '') + ' 预览: ' + String(mem.snapshot || '').slice(0, 300)
      } else {
        body = String(mem.snapshot || '')
        const notes = String(mem.notes || '').trim()
        if (notes) body += '\n[标注] ' + notes
      }
      const take = Math.min(body.length, perCap, budget)
      // 会话总结记忆自动注入时用独立标注，与规约/普通记忆区分
      const ann = tags.includes(SUMMARY_TAG) ? '会话总结·自动注入' : ('记忆·' + String(mem.meta.title || mref.id))
      parts.push('【' + ann + '】' + body.slice(0, take))
      budget -= take
    }
    // 一次性注入记忆（全局队列，不入计划；注入后自动清除）
    for (const mref of onceList) {
      if (budget <= 0) break
      const mem = m.memoryIndex.get(String(mref.id))
      if (!mem) continue
      const perCap = Number(m.cfg.memoryChars) || 6000
      let body
      if (m.cfg.view === 'compact') {
        const imp = Array.isArray(mem.meta.impressions) ? mem.meta.impressions.join('、') : ''
        body = '标题「' + String(mem.meta.title || mref.id) + '」' + (imp ? ' 印象: ' + imp : '') + ' 预览: ' + String(mem.snapshot || '').slice(0, 300)
      } else {
        body = String(mem.snapshot || '')
        const notes = String(mem.notes || '').trim()
        if (notes) body += '\n[标注] ' + notes
      }
      const take = Math.min(body.length, perCap, budget)
      parts.push('【一次性注入·' + String(mem.meta.title || mref.id) + '】' + body.slice(0, take))
      budget -= take
    }
    if (!parts.length) return ''
    let text = parts.join('\n\n')
    if (budget <= 0) text += '\n[记忆库上下文已截断]'
    if (m.cfg.view === 'compact' && m.cfg.modelTools) text += '\n（需要完整内容时可调用 memory_recall 读取）'
    return '=== 记忆库上下文（用户指定，供参考；非当前对话的实时内容） ===\n' + text + '\n=== 记忆库上下文结束 ==='
  }
  // 注入成功后消费一次性状态（once 队列 / 仅本次发送注入）
  m.consumeInjectState = function consumeInjectState() {
    const plan = m.planCache.get('global')
    if (plan && plan.injectOnce === true) {
      plan.injectOnce = false
      m.savePlan(plan).catch(() => {})
    }
    if (m.onceOf().length) {
      m.saveOnce([]).catch(() => {})
    }
  }
  // 预载某会话的排除记录与全局一次性注入队列（供消息页/注入渲染同步读取）
  m.preloadSession = async function preloadSession(sessionId) {
    if (!sessionId) return
    await m.loadExcluded(String(sessionId)).catch(() => {})
    await m.loadOnce().catch(() => {})
  }
}

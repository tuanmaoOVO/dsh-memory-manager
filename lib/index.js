// @dsh-external/dsh-memory-manager — 记忆管理插件（宿主级）
// 所有能力按需注册；settings 命名空间 memory-manager 提供全局开关（enabled）与各项配置。
// enabled=false 时：不注入、工具拒绝执行、API 仅返回状态（供设置页重新开启）。
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from 'schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { appendFileSync } from 'node:fs'
import { readFile, writeFile, readdir, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { foldSurface } from '@deepseek-ai/dsh-session'

const LOG_FILE = 'C:/Users/yuzhenyu/.dsh/memory-manager-boot.log'
const CLIENT_LOG_FILE = 'C:/Users/yuzhenyu/.dsh/memory-manager-client.log'
function logLine(line) {
  try { appendFileSync(LOG_FILE, new Date().toISOString() + ' ' + line + '\n') } catch { /* ignore */ }
}
function logClientLine(line) {
  try { appendFileSync(CLIENT_LOG_FILE, line + '\n') } catch { /* ignore */ }
}
function logError(error) {
  try { appendFileSync(LOG_FILE, new Date().toISOString() + ' ERROR ' + (error instanceof Error ? (error.stack || error.message) : String(error)) + '\n') } catch { /* ignore */ }
}

export const name = '@dsh-external/dsh-memory-manager'
// 硬依赖（base/web 组合的 root 级服务）；其余服务一律 ctx.get 可选读取
export const inject = ['settings', 'tools', 'systemPrompt']

const NS = settingsNamespace('memory-manager')
const API_PATH = '/_dsh/memory-manager/api'
const PLUGIN_TAG = 'memory-manager'
const MARKER_PREFIX = '[记忆管理] 该轮已被排除'
const MARKER_RE = /^\[记忆管理\] 该轮已被排除 \| turn=([A-Za-z0-9_-]+)/
const CONFIG_FILE = 'config.json'
const MEM_ID_RE = /^[A-Za-z0-9_-]{3,64}$/
// 规约记忆标签：tags 含该值的记忆被视为规约记忆，参与新会话自动注入（需 enabled=true）
const CONVENTION_TAG = 'convention'
const CONVENTION_LABEL = '规约'
// 会话总结记忆标签：tags 含该值的记忆视为"会话总结"记忆，同样默认参与新会话自动注入（需 enabled=true）
const SUMMARY_TAG = '会话总结'
// 新会话自动注入的会话总结记忆上限（按 updatedAt 降序取最近 N 条）：
// 会话总结记忆可能很多，全部注入会超出 totalChars 注入预算，故只取最近 N 条。
const SUMMARY_AUTO_INJECT_MAX = 8

export const Config = z.object({
  enabled: z.boolean().default(true),
  mode: z.union(['on', 'off']).default('off'),
  view: z.union(['full', 'compact']).default('full'),
  modelTools: z.boolean().default(true),
  libraryPath: z.string().default(''),
  memoryChars: z.number().default(6000),
  totalChars: z.number().default(12000),
  pinChars: z.number().default(6000),
  // 新会话自动注入开关：开启后新会话默认常驻启用中的规约记忆（tags 含 convention）与
  // 最近 SUMMARY_AUTO_INJECT_MAX 条会话总结记忆（tags 含 会话总结）；旧会话不自动注入，可手动加入
  autoInjectConvention: z.boolean().default(true),
})

export async function apply(ctx, config = {}) {
  logLine('apply() called')
  const logger = ctx.logger ?? { info() {}, warn() {}, error(...a) { console.error(...a) } }
  const disposers = []
  try {
    return await install(ctx, logger, config, disposers)
  } catch (error) {
    logError(error)
    logger.error('dsh-memory-manager: install failed — %s', error instanceof Error ? error.message : String(error))
    for (const dispose of disposers.reverse()) { try { dispose() } catch { /* ignore */ } }
    return () => { /* nothing mounted */ }
  }
}

async function install(ctx, logger, config, disposers) {
  logLine('install() begin')

  // ================= 服务可见性诊断 =================
  try {
    const probe = {}
    for (const name of ['fs', 'tools', 'settings', 'systemPrompt', 'webServer', 'sessions', 'sessionQuery', 'agents', 'shell', 'sandboxPolicy', 'llm', 'agentDefaultModel', 'workspaceRegistry', 'skills', 'subprocess']) {
      let v
      try { v = ctx.get(name) !== undefined ? 'ok' : 'undefined' } catch (e) { v = 'throw:' + (e && e.message) }
      let loose
      try { loose = ctx.get(name, false) !== undefined ? 'ok' : 'undefined' } catch (e) { loose = 'throw' }
      let prop
      try { prop = ctx[name] !== undefined ? 'ok' : 'undefined' } catch (e) { prop = 'throw' }
      probe[name] = { strict: v, loose, prop }
    }
    logLine('service probe: ' + JSON.stringify(probe))
  } catch (e) {
    logLine('probe failed: ' + String(e && e.message || e))
  }

  // ================= 状态 =================
  const planCache = new Map()
  const memoryIndex = new Map()
  const backlinkIndex = new Map()
  const cfg = {
    enabled: true, mode: 'off', view: 'full', modelTools: true,
    libraryPath: '', memoryChars: 6000, totalChars: 12000, pinChars: 6000,
    autoInjectConvention: true,
  }

  // ================= 基础工具 =================
  const rand = (n = 8) => Math.random().toString(36).slice(2, 2 + n)
  const uid = (prefix) => `${prefix}_${rand(10)}`
  const now = () => Date.now()
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
  const textOf = (blocks) => (blocks || []).filter((b) => b && b.type === 'text').map((b) => b.text).join('\n').trim()
  const preview = (s, n = 120) => {
    const t = String(s ?? '').replace(/\s+/g, ' ').trim()
    return t.length > n ? t.slice(0, n) + '…' : t
  }
  const norm = (p) => (p ? String(p).replace(/[\\/]+$/, '') : null)

  // ================= 文件系统（node 直读，不依赖 ctx.fs） =================
  async function readText(p) { try { return await readFile(p, 'utf8') } catch { return null } }
  async function readJson(p) { const t = await readText(p); if (t === null) return null; try { return JSON.parse(t) } catch { return null } }
  async function writeText(p, content) { try { await mkdir(join(p, '..'), { recursive: true }); await writeFile(p, content, 'utf8') } catch (e) { throw e } }
  async function writeJson(p, obj) { await writeText(p, JSON.stringify(obj, null, 2)) }
  async function listDir(p) {
    try {
      const entries = await readdir(p, { withFileTypes: true })
      return entries.map((e) => ({ name: e.name, type: e.isDirectory() ? 'directory' : 'file' }))
    } catch { return [] }
  }
  async function removeFile(p) { try { await rm(p, { force: true }) } catch { /* ignore */ } }

  // ================= 记忆库路径 =================
  function defaultLibraryPath() {
    const ws = ctx.get('workspaceRegistry')
    if (ws !== undefined) {
      try { const list = ws.list(); if (list && list.length && list[0].path) return String(list[0].path).replace(/[\\/]+$/, '') + '/.dsh-memory' } catch { /* fall through */ }
    }
    const agents = ctx.get('agents')
    if (agents !== undefined) {
      try {
        const root = (agents.roots && agents.roots()[0]) || (agents.list && agents.list()[0])
        const cwd = root && root.session && root.session.header && root.session.header.cwd
        if (cwd) return String(cwd).replace(/[\\/]+$/, '') + '/.dsh-memory'
      } catch { /* fall through */ }
    }
    return null
  }
  function libPath() {
    if (!cfg.libraryPath) {
      const d = defaultLibraryPath()
      if (d) cfg.libraryPath = d
    }
    return norm(cfg.libraryPath)
  }

  // ================= Settings（含总开关，live 应用） =================
  let settingsScope
  const settingsService = ctx.get('settings')
  if (!settingsService) {
    logLine('settings service unavailable — 使用内存配置')
    Object.assign(cfg, config)
  } else {
    let base = { ...config }
    // 迁移旧版 config.json（首次运行）
    try {
      const anchor = norm(defaultLibraryPath())
      if (anchor) {
        const legacy = await readJson(anchor + '/' + CONFIG_FILE)
        if (legacy && typeof legacy === 'object') {
          for (const k of ['mode', 'view', 'modelTools', 'libraryPath', 'memoryChars', 'totalChars', 'pinChars']) {
            if (legacy[k] !== undefined) base[k] = legacy[k]
          }
        }
      }
    } catch { /* ignore legacy */ }
    try {
      settingsScope = settingsService.register(NS, Config, {
        base,
        applies: 'live',
        validate: (value) => {
          if (typeof value.libraryPath === 'string' && value.libraryPath.length > 0 && value.libraryPath.length > 4096) {
            throw new Error('libraryPath 过长')
          }
        },
      })
      logLine('settings registered')
      disposers.push(() => { try { settingsScope?.dispose?.() } catch { /* ignore */ } })
      Object.assign(cfg, settingsScope.get())
      logLine('settings snapshot: ' + JSON.stringify(cfg))
      disposers.push(settingsScope.watch((next) => {
        Object.assign(cfg, next)
      }))
    } catch (error) {
      logError(error)
      logger.warn('dsh-memory-manager: settings register failed — %s', error instanceof Error ? error.message : String(error))
      Object.assign(cfg, config)
    }
  }
  const settingsUpdate = (patch) => {
    if (settingsScope && settingsService) {
      try {
        Object.assign(cfg, patch)
        return settingsService.update(NS, patch)
      } catch (error) {
        return Promise.resolve({ error: error instanceof Error ? error.message : String(error) })
      }
    }
    Object.assign(cfg, patch)
    return Promise.resolve({ ok: true })
  }

  // ================= 记忆库扫描 =================
  async function scanLibrary() {
    memoryIndex.clear()
    backlinkIndex.clear()
    const dir = libPath()
    if (!dir) return
    const entries = await listDir(dir + '/memories')
    for (const e of entries) {
      if (!e || e.type !== 'file' || !/\.md$/.test(String(e.name))) continue
      const text = await readText(dir + '/memories/' + e.name)
      if (text === null) continue
      const mem = parseMemory(text)
      if (!mem || !mem.meta || typeof mem.meta.id !== 'string') continue
      memoryIndex.set(mem.meta.id, { meta: mem.meta, snapshot: mem.snapshot, notes: mem.notes })
    }
    for (const mem of memoryIndex.values()) {
      for (const lid of Array.isArray(mem.meta.links) ? mem.meta.links : []) {
        if (typeof lid !== 'string') continue
        if (!backlinkIndex.has(lid)) backlinkIndex.set(lid, [])
        backlinkIndex.get(lid).push(mem.meta.id)
      }
    }
  }

  // ================= front-matter 解析 =================
  function parseFrontMatter(text) {
    const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
    if (!m) return null
    const meta = {}
    for (const line of m[1].split(/\r?\n/)) {
      const i = line.indexOf(':')
      if (i <= 0) continue
      const k = line.slice(0, i).trim()
      if (!k) continue
      const v = line.slice(i + 1).trim()
      try { meta[k] = JSON.parse(v) } catch { meta[k] = v }
    }
    return { meta, body: m[2] }
  }
  function parseMemory(text) {
    const fm = parseFrontMatter(text)
    if (!fm || !fm.meta || typeof fm.meta.id !== 'string') return null
    const [snap = '', notes = ''] = fm.body.split('<!-- mem:notes -->')
    return { meta: fm.meta, snapshot: snap.replace(/^## 快照\s*\r?\n/, '').trim(), notes: notes.trim() }
  }
  function serializeMemory(meta, snapshot, notes) {
    const order = ['id', 'title', 'impressions', 'tags', 'links', 'composedOf', 'sourceSession', 'sourceSeqs', 'createdAt', 'updatedAt', 'revision', 'enabled']
    const lines = ['---']
    for (const k of order) if (meta[k] !== undefined) lines.push(`${k}: ${JSON.stringify(meta[k])}`)
    lines.push('---', '', '## 快照', '', snapshot || '', '', '<!-- mem:notes -->', '', notes || '', '')
    return lines.join('\n')
  }

  async function writeMemory(meta, snapshot, notes) {
    const id = meta.id
    const dir = libPath()
    if (!dir) throw new Error('记忆库未配置')
    await writeText(dir + '/memories/' + id + '.md', serializeMemory(meta, snapshot, notes))
    memoryIndex.set(id, { meta, snapshot, notes })
    backlinkIndex.clear()
    for (const mem of memoryIndex.values()) {
      for (const lid of Array.isArray(mem.meta.links) ? mem.meta.links : []) {
        if (typeof lid !== 'string') continue
        if (!backlinkIndex.has(lid)) backlinkIndex.set(lid, [])
        backlinkIndex.get(lid).push(mem.meta.id)
      }
    }
  }
  function memoryMetaOf(mem) {
    const links = Array.isArray(mem.meta.links) ? mem.meta.links.map(String) : []
    const backlinks = (backlinkIndex.get(mem.meta.id) || []).map(String)
    return {
      id: String(mem.meta.id),
      title: String(mem.meta.title ?? ''),
      impressions: Array.isArray(mem.meta.impressions) ? mem.meta.impressions.map(String) : [],
      tags: Array.isArray(mem.meta.tags) ? mem.meta.tags.map(String) : [],
      enabled: mem.meta.enabled !== false,
      links,
      composedOf: Array.isArray(mem.meta.composedOf) ? mem.meta.composedOf.map(String) : [],
      sourceSession: mem.meta.sourceSession ?? null,
      sourceSeqs: Array.isArray(mem.meta.sourceSeqs) ? mem.meta.sourceSeqs.map(Number).filter(Number.isFinite) : [],
      createdAt: mem.meta.createdAt ?? null,
      updatedAt: mem.meta.updatedAt ?? null,
      revision: mem.meta.revision ?? 1,
      backlinks,
    }
  }
  function sanitizeImpressions(v) {
    if (!Array.isArray(v)) return []
    return v.map((s) => String(s).trim()).filter((s) => s && s.length <= 40).slice(0, 12)
  }
  function sanitizeIds(v) {
    if (!Array.isArray(v)) return []
    const out = []
    for (const s of v) {
      const t = String(s).trim()
      if (MEM_ID_RE.test(t) && !out.includes(t)) out.push(t)
    }
    return out
  }

  // ================= 注入计划（全局单一：所有会话共享同一份计划，注入计划中的信息） =================
  // 计划文件固定为 pinned/plan.json；轮次排除（excluded）为会话级，存 pinned/excluded.json。
  function planPath() {
    const dir = libPath()
    return dir ? norm(dir) + '/pinned/plan.json' : null
  }
  async function loadPlan() {
    let plan = planCache.get('global')
    if (plan === undefined) {
      const p = planPath()
      const saved = p ? await readJson(p) : null
      logLine('loadPlan: global saved=' + (saved ? 'yes' : 'no'))
      plan = (saved && typeof saved === 'object') ? saved : {}
      if (!Array.isArray(plan.pinned)) plan.pinned = []
      if (!Array.isArray(plan.memories)) plan.memories = []
      if (plan.injectOnce !== true) plan.injectOnce = false
      planCache.set('global', plan)
      // 全局计划首次创建：自动注入当前启用的规约记忆与最近会话总结（仅此一次初始化，之后完全由用户掌控）
      if (!saved) {
        try { await autoInjectConventions(plan) } catch (e) { logLine('loadPlan: autoInject threw: ' + String((e && e.message) || e)) }
      }
    }
    return plan
  }
  async function savePlan(sessionIdOrPlan, maybePlan) {
    const plan = maybePlan !== undefined ? maybePlan : sessionIdOrPlan
    planCache.set('global', plan)
    const p = planPath()
    if (p) await writeJson(p, { pinned: plan.pinned, memories: plan.memories, injectOnce: plan.injectOnce === true })
  }

  // ================= 会话级轮次排除存储（pinned/excluded.json） =================
  const excludedCache = new Map() // sessionId -> [turnId]
  const EXCLUDED_FILE = () => {
    const dir = libPath()
    return dir ? norm(dir) + '/pinned/excluded.json' : null
  }
  async function loadExcluded(sessionId) {
    if (!sessionId) return []
    if (excludedCache.has(sessionId)) return excludedCache.get(sessionId)
    const p = EXCLUDED_FILE()
    let list = []
    if (p) {
      const data = await readJson(p)
      if (data && Array.isArray(data[sessionId])) list = data[sessionId].map(String)
    }
    excludedCache.set(sessionId, list)
    return list
  }
  function excludedOf(sessionId) { // 同步读取（内存缓存；未加载时为空，预载/排除操作会填充）
    return sessionId && excludedCache.has(sessionId) ? excludedCache.get(sessionId) : []
  }
  async function saveExcluded(sessionId, list) {
    if (!sessionId) return
    excludedCache.set(sessionId, list)
    const p = EXCLUDED_FILE()
    if (!p) return
    const data = (await readJson(p)) || {}
    data[sessionId] = list
    await writeJson(p, data)
  }

  // ================= 一次性注入记忆存储（pinned/once.json，全局队列） =================
  // 「选中记忆 → 下一次发送时注入」：不入全局计划；任何会话的第一次请求渲染后自动清除。
  // 语义绑定「下一次发送」而非「点击时会话」：用户点击后可能切换会话再发送，队列跟随下一次请求。
  let onceCacheList = null // [{ id, title, impressions, tags }]
  const ONCE_FILE = () => {
    const dir = libPath()
    return dir ? norm(dir) + '/pinned/once.json' : null
  }
  async function loadOnce() {
    if (onceCacheList) return onceCacheList
    const p = ONCE_FILE()
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
    onceCacheList = list
    return list
  }
  function onceOf() { // 同步读取（内存缓存；未加载时为空，点击注入/预载会填充）
    return onceCacheList || []
  }
  async function saveOnce(list) {
    onceCacheList = list
    const p = ONCE_FILE()
    if (!p) return
    await writeJson(p, list)
  }

  // 从全局注入计划（planCache + pinned/plan.json）中移除指定记忆（禁用记忆时全局生效）
  async function purgeMemoryFromPlans(id) {
    const plan = planCache.get('global')
    if (plan && Array.isArray(plan.memories) && plan.memories.some((m) => String(m.id) === id)) {
      plan.memories = plan.memories.filter((m) => String(m.id) !== id)
      try { await savePlan(plan) } catch { /* ignore */ }
    }
    const p = planPath()
    if (p) {
      const saved = await readJson(p)
      if (saved && Array.isArray(saved.memories) && saved.memories.some((m) => String(m.id) === id)) {
        saved.memories = saved.memories.filter((m) => String(m.id) !== id)
        try { await writeJson(p, { pinned: saved.pinned || [], memories: saved.memories, injectOnce: saved.injectOnce === true }) } catch { /* ignore */ }
      }
    }
  }

  // ================= 规约记忆自动注入（新会话常驻） =================
  // 新会话判定：会话尚无任何对话消息。注意新会话 log 也含系统策略事件
  // （permission/preset、sandbox/mode、approval/policy 等），不能按 events 为空判断；
  // 只有 user/assistant 消息才是"有历史"的标志。优先用 agent/created 提供的 live session。
  async function isNewSession(sessionId, hintSession) {
    if (hintSession && typeof hintSession === 'object') {
      let log = null
      try {
        if (Array.isArray(hintSession.log)) log = hintSession.log
        else if (hintSession.events) log = hintSession.events
      } catch (e) { logLine('isNewSession: hint.log threw: ' + String((e && e.message) || e)) }
      const hasDialogue = Array.isArray(log) && log.some((e) => e && (e.type === 'user/message' || e.type === 'assistant/message'))
      logLine('isNewSession: ' + sessionId + ' logLen=' + (Array.isArray(log) ? log.length : 'n/a') + ' hasDialogue=' + hasDialogue)
      return !hasDialogue
    }
    const s = liveSession(sessionId)
    if (s) {
      const slog = Array.isArray(s.log) ? s.log : (s.events || [])
      const hasDialogue = slog.some((e) => e && (e.type === 'user/message' || e.type === 'assistant/message'))
      logLine('isNewSession: ' + sessionId + ' live logLen=' + slog.length + ' hasDialogue=' + hasDialogue)
      return !hasDialogue
    }
    return false
  }
  // 收集启用状态的规约记忆（tags 含 convention 且 enabled !== false）
  async function conventionMemories() {
    if (memoryIndex.size === 0) await scanLibrary()
    logLine('conventionMemories: index=' + memoryIndex.size + ' lib=' + String(libPath()))
    const out = []
    for (const mem of memoryIndex.values()) {
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
  // 收集启用状态的会话总结记忆（tags 含 会话总结 且 enabled !== false），按 updatedAt 降序取最近 limit 条。
  // 会话总结记忆可能很多，为避免超出 totalChars 注入预算，只取最近 N 条（默认 SUMMARY_AUTO_INJECT_MAX）。
  async function summaryMemories(limit) {
    if (memoryIndex.size === 0) await scanLibrary()
    const caps = Number(limit) > 0 ? Number(limit) : SUMMARY_AUTO_INJECT_MAX
    const out = []
    for (const mem of memoryIndex.values()) {
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
  async function autoInjectConventions(plan) {
    logLine('autoInject: enabled=' + cfg.enabled + ' autoInjectConvention=' + cfg.autoInjectConvention)
    if (!cfg.enabled || cfg.autoInjectConvention === false) return false
    const convs = await conventionMemories()
    logLine('autoInject: conventions=' + convs.length)
    // 会话总结记忆：按 updatedAt 最新 SUMMARY_AUTO_INJECT_MAX 条（避免全部注入超出 totalChars 预算）
    const summs = (await summaryMemories(SUMMARY_AUTO_INJECT_MAX)).map((s) => ({ id: s.id, title: s.title, impressions: s.impressions, tags: s.tags }))
    logLine('autoInject: summaries=' + summs.length)
    if (!convs.length && !summs.length) return false
    let added = false
    const push = (items) => {
      for (const c of items) {
        if ((plan.memories || []).some((m) => String(m.id) === c.id)) continue
        plan.memories.push(c)
        added = true
      }
    }
    push(convs)
    push(summs)
    if (added) {
      // 并发防护：autoInject 的异步链（scanLibrary 等）期间用户可能已操作计划
      // （移除记忆等），若计划文件已被写入则以文件为准，放弃本次注入，避免覆盖用户修改。
      const p = planPath()
      const current = p ? await readJson(p) : null
      if (current && typeof current === 'object' && Array.isArray(current.memories)) {
        planCache.set('global', current)
        logLine('autoInject: concurrent plan write detected, skip inject save')
      } else {
        await savePlan(plan)
      }
    }
    return added
  }

  // ================= 会话/事件工具 =================
  function liveSession(sessionId) {
    if (!sessionId) return null
    const sessions = ctx.get('sessions')
    if (!sessions) return null
    try { return sessions.get(sessionId) || null } catch { return null }
  }
  // 只读会话视图（sessionQuery + foldSurface），宿主模式下替代 live session 读取
  async function readSessionSurface(sessionId) {
    const sq = ctx.get('sessionQuery')
    if (!sq || !sessionId) return null
    try {
      const snap = await sq.readSession(sessionId)
      if (!snap || !Array.isArray(snap.events)) return null
      const events = snap.events
      const folded = foldSurface(events)
      return { events, surface: { nodes: folded.nodes } }
    } catch { return null }
  }
  async function sessionView(sessionId) {
    const live = liveSession(sessionId)
    if (live) return { session: live, writable: true }
    const read = await readSessionSurface(sessionId)
    if (read) return { session: read, writable: false }
    return null
  }
  function nodeInfo(event) {
    if (event.type === 'user/message') return { kind: 'user', id: event.data.id, text: textOf(event.data.content), time: event.time }
    if (event.type === 'assistant/message') return { kind: 'assistant', id: event.data.message.id, text: textOf(event.data.message.content), time: event.time }
    if (event.type === 'tool/result') return { kind: 'tool', id: event.data.message.id, text: textOf(event.data.message.content), time: event.time }
    return null
  }
  function isMarkerEvent(event) {
    if (event.type === 'user/message' && event.data && event.data.source &&
      event.data.source.kind === 'plugin' && event.data.source.plugin === PLUGIN_TAG) return true
    // 工具标记：tool/result 事件的 data 必须与原事件深度相等（surface 校验仅允许替换 content[0].content），
    // 因此不能携带 source 字段，改用标记前缀文本识别
    return event.type === 'tool/result' && markerTurnIdOf(event) !== null
  }
  // 事件文本：普通事件取其 text 块；tool 标记的标记文本存放在 tool-result 块的 content（text 子块数组）中
  function eventText(event) {
    const info = nodeInfo(event)
    if (info && info.text) return info.text
    if (event.type === 'tool/result') {
      const c = event.data && event.data.message && event.data.message.content
      const b = Array.isArray(c) && c[0]
      if (b && typeof b === 'object') {
        if (typeof b.content === 'string') return b.content
        if (Array.isArray(b.content)) return textOf(b.content)
      }
    }
    return ''
  }
  function markerTurnIdOf(event) {
    const m = MARKER_RE.exec(eventText(event))
    return m ? m[1] : null
  }
  function buildTurns(session, sessionId, plan) {
    const turns = []
    let cur = null
    const excluded = new Set(excludedOf(sessionId))
    for (const seq of session.surface.nodes) {
      const event = session.events[seq]
      if (!event) continue
      const info = nodeInfo(event)
      if (!info) continue
      if (isMarkerEvent(event)) {
        const turnId = markerTurnIdOf(event) || String(info.id)
        if (cur && cur.marker && cur.turnId === turnId) { /* 同轮标记，继续追加 */ }
        else { cur = { turnId, marker: true, excluded: true, nodes: [] }; turns.push(cur) }
      } else if (event.type === 'user/message') {
        cur = { turnId: String(info.id), marker: false, excluded: excluded.has(String(info.id)), nodes: [] }
        turns.push(cur)
      }
      if (cur) {
        const full = eventText(event)
        cur.nodes.push({ seq, kind: info.kind, id: String(info.id), preview: preview(full), text: full, time: info.time })
      }
    }
    return turns
  }
  function findTurnSpan(session, turnId) {
    const seqs = []
    let inTurn = false
    for (const seq of session.surface.nodes) {
      const event = session.events[seq]
      if (!event) continue
      const info = nodeInfo(event)
      if (!info) continue
      if (event.type === 'user/message' && !isMarkerEvent(event)) {
        if (String(info.id) === turnId) { inTurn = true; seqs.push(seq) }
        else if (inTurn) break
      } else if (inTurn && !isMarkerEvent(event)) {
        // 已排除轮次的标记不属于本轮 span，避免排除后续轮次时误吞其他轮次的标记
        seqs.push(seq)
      }
    }
    return seqs
  }
  function findMarkers(session, turnId) {
    const out = []
    for (const seq of session.surface.nodes) {
      const event = session.events[seq]
      if (!event) continue
      if (!isMarkerEvent(event)) continue
      if (markerTurnIdOf(event) === turnId) out.push({ seq, event })
    }
    return out
  }
  function makeMarker(turnId) {
    return {
      id: 'mem-marker-' + rand(12),
      role: 'user',
      content: [{ type: 'text', text: MARKER_PREFIX + ' | turn=' + turnId }],
      source: { kind: 'plugin', plugin: PLUGIN_TAG },
    }
  }
  // 工具节点标记：data 与原 tool/result 事件深度相等（仅 message.content[0].content 替换为标记文本子块），
  // 以满足 surface 契约 "tool/result surface replacement may change only content"。
  // 必须完整镜像 data 顶层（真实事件带 turn/step 等字段）与 message 内全部字段（id/role/source），
  // 深度相等校验比较的是整个 data 对象，任何字段缺失都会抛错。
  function makeToolMarker(turnId, event) {
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

  async function excludeTurn(session, sessionId, turnId, exclude) {
    const excluded = await loadExcluded(sessionId)
    if (exclude) {
      if (excluded.includes(turnId)) return { ok: true }
      const span = findTurnSpan(session, turnId)
      if (!span.length) return { error: '未找到该轮次（可能已被排除或压缩）' }
      // 只统计目标轮之后的真实用户消息（不含本插件标记）：保证"不能排除当前最新一轮"判定正确
      const spanSet = new Set(span)
      let laterUser = false
      let sawTarget = false
      for (const seq of session.surface.nodes) {
        const event = session.events[seq]
        if (!event) continue
        if (event.type === 'user/message' && !isMarkerEvent(event)) {
          if (sawTarget) { laterUser = true; break }
          if (spanSet.has(seq)) sawTarget = true
        }
      }
      if (!laterUser) return { error: '不能排除当前最新一轮（其后没有可作对话锚点的用户消息）' }
      // 预检查：span 内所有 tool/result 节点都必须能生成深度相等的标记；
      // 异常 shape 整体拒绝并返回错误，避免 user/assistant 已替换而 tool 失败的部分残留
      for (const seq of span) {
        const event = session.events[seq]
        if (event && event.type === 'tool/result' && !makeToolMarker(turnId, event)) {
          return { error: '该轮包含无法处理的工具结果节点（异常数据），已取消排除' }
        }
      }
      for (const seq of span) {
        const event = session.events[seq]
        if (!event) continue
        if (event.type === 'tool/result') {
          const marker = makeToolMarker(turnId, event)
          if (marker) {
            session.append('tool/result', marker, { surfaceOp: { op: 'replace', start: seq, end: seq }, sourceEventSeqs: [seq] })
          } else {
            session.append('user/message', makeMarker(turnId), { surfaceOp: { op: 'replace', start: seq, end: seq }, sourceEventSeqs: [seq] })
          }
        } else {
          session.append('user/message', makeMarker(turnId), { surfaceOp: { op: 'replace', start: seq, end: seq }, sourceEventSeqs: [seq] })
        }
      }
      await saveExcluded(sessionId, [...excluded, turnId])
      return { ok: true }
    } else {
      // 自愈门槛：不依赖 excluded.includes(turnId)——只要 surface 上还有该轮的标记就执行恢复，
      // 并顺带从 excluded 中移除；一个标记都没有才视为无需恢复。这样即使 excluded 记录与
      // surface 不一致（如旧缺陷导致的残留标记）也能恢复。
      const markers = findMarkers(session, turnId)
      if (!markers.length) return { ok: true }
      for (const { seq, event } of markers) {
        const origSeq = Array.isArray(event.sourceEventSeqs) ? event.sourceEventSeqs[0] : undefined
        const orig = origSeq !== undefined ? session.events[origSeq] : undefined
        if (!orig) continue
        const type = orig.type
        if (type === 'tool/result') {
          if (event.type === 'tool/result') {
            // 新版工具标记：data 与原事件深度相等（仅 content 替换为标记文本），可原样还原
            session.append(type, orig.data, { surfaceOp: { op: 'replace', start: seq, end: seq }, sourceEventSeqs: [seq] })
          } else {
            // 旧版排除产生的 user 标记遮蔽了 tool 节点：surface 契约不允许 tool/result 覆盖 user 标记，
            // 以 user 文本形式还原内容（原始事件仍保留在日志中，不丢失数据）；带合法 source 保证持久化回读通过
            session.append('user/message', { id: 'mem-restored-' + rand(10), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: eventText(orig) || '（工具结果，无文本）' }] },
              { surfaceOp: { op: 'replace', start: seq, end: seq }, sourceEventSeqs: [seq] })
          }
        } else if (type === 'user/message' || type === 'assistant/message') {
          session.append(type, orig.data, { surfaceOp: { op: 'replace', start: seq, end: seq }, sourceEventSeqs: [seq] })
        }
      }
      if (excluded.includes(turnId)) {
        await saveExcluded(sessionId, excluded.filter((t) => t !== turnId))
      }
      return { ok: true }
    }
  }

  // ================= 注入渲染 =================
  function renderContextFor(sessionId) {
    if (!cfg.enabled) return ''
    // 全局计划可能尚未 loadPlan（如首次请求），一次性注入不应因此被跳过
    let plan = planCache.get('global')
    if (!plan) plan = { pinned: [], memories: [], injectOnce: false }
    const onceList = onceOf()
    const active = cfg.mode === 'on' || plan.injectOnce === true || onceList.length > 0
    if (!active) return ''
    if (onceList.length) logLine('renderContextFor: session=' + sessionId + ' once=' + onceList.map((m) => m && m.id).join(',') + ' mode=' + cfg.mode)
    const parts = []
    let budget = Number(cfg.totalChars) || 12000
    const pinBudget = Math.min(Number(cfg.pinChars) || 6000, budget)
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
      const mem = memoryIndex.get(String(mref.id))
      if (!mem) continue
      if (mem.meta.enabled === false) continue
      const tags = Array.isArray(mem.meta.tags) ? mem.meta.tags.map(String) : []
      const perCap = Number(cfg.memoryChars) || 6000
      let body
      if (cfg.view === 'compact') {
        const imp = Array.isArray(mem.meta.impressions) ? mem.meta.impressions.join('、') : ''
        body = '标题「' + String(mem.meta.title || mref.id) + '」' + (imp ? ' 印象: ' + imp : '') + ' 预览: ' + String(mem.snapshot || '').slice(0, 300)
      } else {
        body = String(mem.snapshot || '')
        const notes = String(mem.notes || '').trim()
        if (notes) body += '\n[标注] ' + notes
      }
      const take = Math.min(body.length, perCap, budget)
      // 会话总结记忆自动注入时用独立标注，与规约/普通记忆区分（新会话自动注入的最近 N 条总结）
      const ann = tags.includes(SUMMARY_TAG)
        ? '会话总结·自动注入'
        : ('记忆·' + String(mem.meta.title || mref.id))
      parts.push('【' + ann + '】' + body.slice(0, take))
      budget -= take
    }
    // 一次性注入记忆（当前会话手动指定，不入全局计划；渲染后自动清除）
    for (const mref of onceList) {
      if (budget <= 0) break
      const mem = memoryIndex.get(String(mref.id))
      if (!mem) continue
      const perCap = Number(cfg.memoryChars) || 6000
      let body
      if (cfg.view === 'compact') {
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
    if (cfg.view === 'compact' && cfg.modelTools) text += '\n（需要完整内容时可调用 memory_recall 读取）'
    if (plan.injectOnce === true) {
      plan.injectOnce = false
      savePlan(plan).catch(() => {})
    }
    if (onceList.length) {
      logLine('injectOnce consumed: session=' + sessionId + ' chars=' + text.length + ' parts=' + parts.length)
      saveOnce([]).catch(() => {})
    }
    return '=== 记忆库上下文（用户指定，供参考；非当前对话的实时内容） ===\n' + text + '\n=== 记忆库上下文结束 ==='
  }

  // ================= LLM 辅助 =================
  async function askLlm(system, user, maxTokens) {
    const llm = ctx.get('llm')
    const adm = ctx.get('agentDefaultModel')
    if (!llm || !adm) return null
    let sel = null
    try { sel = adm.currentSelection() } catch { sel = null }
    if (!sel || !sel.provider || !sel.model) return null
    let text = ''
    try {
      const stream = llm.stream({
        provider: sel.provider,
        model: sel.model,
        system,
        maxTokens: maxTokens || 1000,
        messages: [{ id: 'mem-ask-' + rand(12), role: 'user', content: [{ type: 'text', text: String(user).slice(0, 12000) }], source: { kind: 'plugin', plugin: PLUGIN_TAG } }],
      })
      for await (const chunk of stream) {
        if (chunk && chunk.type === 'text-delta') text += chunk.text
      }
    } catch { return null }
    const out = text.trim()
    return out || null
  }
  async function suggestImpressions(content) {
    const out = await askLlm(
      '你是记忆整理助手。为下面的记忆内容生成 2-6 个简短印象标签（每个 2-10 个汉字或单词，用逗号分隔，只输出标签本身，不要编号和解释）。',
      content, 300)
    if (!out) return { error: 'LLM 不可用或生成失败' }
    const tags = out.split(/[,，、;；\n]+/).map((s) => s.trim()).filter((s) => s && s.length <= 30).slice(0, 6)
    if (!tags.length) return { error: '未能生成印象' }
    return { impressions: tags }
  }

  // ================= 会话总结（session.summarize 的 LLM 辅助） =================
  // 从 LLM 输出中稳健地抽取第一个 JSON 对象 / 数组（容忍前后缀与换行）
  function extractJson(text, kind) {
    if (!text) return kind === 'array' ? null : null
    const s = String(text)
    const open = kind === 'array' ? '[' : '{'
    const close = kind === 'array' ? ']' : '}'
    const start = s.indexOf(open)
    if (start < 0) return null
    let depth = 0
    for (let i = start; i < s.length; i++) {
      const c = s[i]
      if (c === open) depth++
      else if (c === close) { depth--; if (depth === 0) { try { return JSON.parse(s.slice(start, i + 1)) } catch { return null } } }
    }
    return null
  }
  // 把一个轮次的对话内容整理成供 LLM 总结的输入文本
  function turnSummaryInput(turn, pos) {
    const rows = []
    for (const n of turn.nodes || []) {
      if (!n) continue
      const who = n.kind === 'user' ? '用户' : (n.kind === 'tool' ? '工具结果' : '助手')
      const t = String(n.text || n.preview || '').trim()
      rows.push('[' + who + '] ' + (t || '（无文本）'))
    }
    return '第 ' + pos + ' 轮（turnId=' + turn.turnId + '）\n' + rows.join('\n')
  }
  // 让 LLM 判断哪些连续轮次在处理同一事务（merge=true 时调用）；返回分组数组（每项为连续轮次下标 0..n-1），失败返回 null
  async function groupSameTransactions(scope) {
    if (scope.length <= 1) return scope.map((t, i) => [i])
    const idxInput = scope.map((t) => t._brief.replace(/\n+/g, ' ')).join('\n')
    const sys = '你是对话轮次分组助手。给定按顺序编号（1..N）的对话轮次，判断哪些【连续轮次】在处理"同一事务"（例如同一问题的多轮追问与答复、同一任务的连续步骤），把同事务的连续轮次合并为一组；其余各自成组。\n' +
      '严格输出一个 JSON 二维数组，每个元素是若干连续轮次编号的数组（编号升序且组内连续），如 [[1],[2,3],[4]]，覆盖全部 1..N 轮次，不可缺漏、不可重叠。只输出数组，不要任何解释。'
    const raw = await askLlm(sys, idxInput, 800)
    const arr = extractJson(raw, 'array')
    if (!Array.isArray(arr) || !arr.length) return null
    const seen = new Set()
    for (const g of arr) {
      if (!Array.isArray(g) || !g.length) return null
      const nums = g.map((x) => Number(x)).filter((x) => Number.isFinite(x)).sort((x, y) => x - y)
      if (!nums.length || nums[0] < 1 || nums[nums.length - 1] > scope.length) return null
      // 组内编号必须连续（保证"覆盖轮次 X-Y"范围语义正确）
      for (let i = 0; i < nums.length - 1; i++) if (nums[i] + 1 !== nums[i + 1]) return null
      for (const x of nums) { if (seen.has(x)) return null; seen.add(x) }
    }
    if (seen.size !== scope.length) return null
    const out = []
    for (const g of arr) {
      const nums = g.map((x) => Number(x)).filter((x) => Number.isFinite(x)).sort((x, y) => x - y)
      out.push(nums.map((x) => scope[x - 1]))
    }
    return out
  }
  // 把一组轮次总结成一条六要素会话总结（正文 body + 标注 notes + 覆盖源消息 seq）
  async function summarizeGroup(sessionId, group) {
    const posList = group.map((t) => t._pos)
    const firstPos = posList[0]
    const lastPos = posList[posList.length - 1]
    const ids = group.map((t) => String(t.turnId))
    const seqs = []
    for (const t of group) for (const n of t.nodes || []) if (n && typeof n.seq === 'number') seqs.push(n.seq)
    const minSeq = seqs.length ? Math.min.apply(null, seqs) : null
    const maxSeq = seqs.length ? Math.max.apply(null, seqs) : null
    const input = group.map((t) => t._full).join('\n\n---\n\n')
    const sys = '你是会话总结助手。根据提供的对话轮次内容，提炼信息并严格输出一个 JSON 对象（字段固定）：\n' +
      '{"user":"用户请求（核心意图，1-2 句）","thinking":"思考链（模型的分析/推理要点）","processing":"处理链（调用了哪些动作/工具/步骤）","result":"结果（最终结论/产物/决定）"}\n' +
      '只输出这一个 JSON 对象，不要多余文字、不要 markdown。缺失的要素填"（无）"。使用简体中文。'
    const out = await askLlm(sys, input, 1500)
    const d = extractJson(out, 'object')
    const user = d && typeof d.user === 'string' ? d.user.trim() : ''
    const thinking = d && typeof d.thinking === 'string' ? d.thinking.trim() : ''
    const processing = d && typeof d.processing === 'string' ? d.processing.trim() : ''
    const result = d && typeof d.result === 'string' ? d.result.trim() : ''
    const rangeLabel = group.length > 1 ? ('覆盖轮次 ' + firstPos + '-' + lastPos) : ('轮次 ' + firstPos)
    const body = '会话id：' + sessionId + '\n' +
      '轮次：' + rangeLabel + '\n' +
      '用户请求：' + (user || (group[0]._user || '（无）')) + '\n' +
      '思考链：' + (thinking || '（无）') + '\n' +
      '处理链：' + (processing || '（无）') + '\n' +
      '结果：' + (result || '（无）')
    const notes = '源会话：' + sessionId +
      '；覆盖轮次：' + rangeLabel +
      '；覆盖轮次 id：' + ids.join(', ') +
      (minSeq != null ? '；边界 seq：' + minSeq + '..' + maxSeq : '')
    return { body, notes, sourceSeqs: seqs, firstPos, lastPos }
  }

  // ================= 链式回忆（BFS） =================
  function relatedOf(id, depth, limit) {
    const seen = new Set([id])
    const out = []
    let frontier = [id]
    for (let d = 1; d <= depth && frontier.length && out.length < limit; d++) {
      const next = []
      for (const cur of frontier) {
        const mem = memoryIndex.get(cur)
        if (!mem) continue
        const links = Array.isArray(mem.meta.links) ? mem.meta.links.map(String) : []
        const backs = backlinkIndex.get(cur) || []
        for (const lid of [...links, ...backs]) {
          if (seen.has(lid) || !memoryIndex.has(lid)) continue
          seen.add(lid)
          const t = memoryIndex.get(lid)
          out.push({
            id: lid,
            title: String(t.meta.title || lid),
            impressions: Array.isArray(t.meta.impressions) ? t.meta.impressions.map(String) : [],
            distance: d,
          })
          next.push(lid)
          if (out.length >= limit) break
        }
        if (out.length >= limit) break
      }
      frontier = next
    }
    return out
  }

  // ================= RPC 处理器（HTTP POST JSON） =================
  const handler = async (rawArgs) => {
    try {
      if (!cfg.enabled && rawArgs && rawArgs.op !== 'state.get' && rawArgs.op !== 'state.setEnabled' && rawArgs.op !== 'diag.log') {
        return { error: '记忆管理已禁用（设置 → 记忆管理 中开启）' }
      }
      const args = (rawArgs && typeof rawArgs === 'object') ? rawArgs : {}
      const op = String(args.op || '')
      const sessionId = args.sessionId ? String(args.sessionId) : null
      const a = (args.args && typeof args.args === 'object') ? args.args : {}
      switch (op) {
        case 'state.get': {
          const plan = sessionId ? await loadPlan(sessionId) : null
          return {
            config: {
              enabled: cfg.enabled, mode: cfg.mode, view: cfg.view, modelTools: cfg.modelTools,
              libraryPath: libPath(), ready: true, reason: '',
              memoryChars: cfg.memoryChars, totalChars: cfg.totalChars, pinChars: cfg.pinChars,
              autoInjectConvention: cfg.autoInjectConvention !== false,
            },
            plan: plan ? {
              pinned: (plan.pinned || []).map((p) => ({ id: String(p.id), role: p.role || '', text: preview(p.text, 80), at: p.at || 0 })),
              memories: (plan.memories || []).map((m) => ({ id: String(m.id), title: String(m.title || ''), impressions: Array.isArray(m.impressions) ? m.impressions.map(String) : [], tags: Array.isArray(m.tags) ? m.tags.map(String) : [] })),
              excluded: sessionId ? await loadExcluded(sessionId) : [],
              once: await loadOnce(),
              injectOnce: plan.injectOnce === true,
            } : null,
          }
        }
        case 'state.setEnabled': {
          cfg.enabled = a.v === true
          await settingsUpdate({ enabled: cfg.enabled })
          return { ok: true, enabled: cfg.enabled }
        }
        case 'state.setMode': {
          cfg.mode = a.mode === 'on' ? 'on' : 'off'
          await settingsUpdate({ mode: cfg.mode })
          return { ok: true, mode: cfg.mode }
        }
        case 'state.setView': {
          cfg.view = a.view === 'compact' ? 'compact' : 'full'
          await settingsUpdate({ view: cfg.view })
          return { ok: true, view: cfg.view }
        }
        case 'state.setModelTools': {
          cfg.modelTools = a.v === true
          await settingsUpdate({ modelTools: cfg.modelTools })
          return { ok: true }
        }
        case 'state.setAutoInject': {
          cfg.autoInjectConvention = a.v !== false
          await settingsUpdate({ autoInjectConvention: cfg.autoInjectConvention })
          return { ok: true, autoInjectConvention: cfg.autoInjectConvention }
        }
        case 'state.setLibrary': {
          const raw = String(a.path || '').trim()
          if (!raw) return { error: '路径不能为空' }
          if (!/^[A-Za-z]:[\\/]/.test(raw) && !raw.startsWith('/')) return { error: '请输入绝对路径' }
          cfg.libraryPath = norm(raw)
          if (!cfg.libraryPath) return { error: '路径解析失败' }
          await settingsUpdate({ libraryPath: cfg.libraryPath })
          await scanLibrary()
          return { ok: true, libraryPath: cfg.libraryPath }
        }
        case 'state.setCaps': {
          const patch = {}
          if (typeof a.memoryChars === 'number') { cfg.memoryChars = clamp(a.memoryChars, 500, 50000); patch.memoryChars = cfg.memoryChars }
          if (typeof a.totalChars === 'number') { cfg.totalChars = clamp(a.totalChars, 1000, 100000); patch.totalChars = cfg.totalChars }
          if (typeof a.pinChars === 'number') { cfg.pinChars = clamp(a.pinChars, 500, 50000); patch.pinChars = cfg.pinChars }
          await settingsUpdate(patch)
          return { ok: true }
        }
        case 'sessions.list': {
          // 跨工作区会话列表：workspaceRegistry（list()）提供各工作区 id/title/sessionIds 与
          // archivedSessionIds 归档集合；sessionQuery.readTitle 折叠会话标题。均 ctx.get 可选读取，
          // 缺失或异常时容错降级（标题回退到 id 尾部）。返回 [{ id, title, sessions:[{id,title,updatedAt,archived}] }]
          // 注意：workspaceRegistry / sessionQuery 在插件 ctx 上 strict get 可能拿不到（probe 显示 strict undefined/loose ok），
          // 必须用 loose 模式（ctx.get(name, false)）兜底。
          const ws = ctx.get('workspaceRegistry') ?? ctx.get('workspaceRegistry', false)
          const sq = ctx.get('sessionQuery') ?? ctx.get('sessionQuery', false)
          logLine('sessions.list: ws=' + (ws ? 'ok' : 'undefined') + ' sq=' + (sq ? 'ok' : 'undefined') + ' strictWs=' + (ctx.get('workspaceRegistry') !== undefined))
          const archived = new Set((ws !== undefined && ws.archivedSessionIds)
            ? Array.from(ws.archivedSessionIds).map(String) : [])
          const workspaces = []
          if (ws !== undefined) {
            let list = []
            try { list = ws.list() || [] } catch { list = [] }
            for (const w of list) {
              let sids = []
              try { sids = (w.sessionIds || []).map(String) } catch (e) { logLine('sessions.list: workspace ' + String(w && (w.title || w.id)) + ' sessionIds getter threw: ' + String(e && e.message || e)) }
              logLine('sessions.list: workspace=' + String(w && (w.title || w.id)) + ' sids=' + sids.length)
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
          logLine('sessions.list: workspaces=' + workspaces.length + ' totalSessions=' + workspaces.reduce((n, w) => n + (w.sessions ? w.sessions.length : 0), 0))
          return { workspaces }
        }
        case 'library.scan': {
          await scanLibrary()
          const list = []
          for (const mem of memoryIndex.values()) list.push(memoryMetaOf(mem))
          list.sort((x, y) => (y.updatedAt || 0) - (x.updatedAt || 0))
          return { memories: list }
        }
        case 'memory.read': {
          const id = String(a.id || '')
          const mem = memoryIndex.get(id)
          if (!mem) return { error: '记忆不存在: ' + id }
          return { meta: memoryMetaOf(mem), snapshot: mem.snapshot, notes: mem.notes }
        }
        case 'memory.save': {
          const dir = libPath()
          if (!dir) return { error: '记忆库未配置' }
          const title = String(a.title || '').trim() || ('记忆 ' + new Date().toISOString().slice(0, 10))
          const meta = {
            id: uid('m'), title,
            impressions: sanitizeImpressions(a.impressions),
            tags: sanitizeImpressions(a.tags),
            enabled: a.enabled !== false,
            links: sanitizeIds(a.links),
            composedOf: [],
            sourceSession: sessionId,
            createdAt: now(), updatedAt: now(), revision: 1,
          }
          await writeMemory(meta, String(a.snapshot || '').slice(0, 40000), String(a.notes || '').slice(0, 20000))
          return memoryMetaOf(memoryIndex.get(meta.id))
        }
        case 'memory.update': {
          const id = String(a.id || '')
          const mem = memoryIndex.get(id)
          if (!mem) return { error: '记忆不存在: ' + id }
          const patch = (a.patch && typeof a.patch === 'object') ? a.patch : {}
          const meta = { ...mem.meta }
          if (patch.title !== undefined) meta.title = String(patch.title).slice(0, 200)
          if (patch.impressions !== undefined) meta.impressions = sanitizeImpressions(patch.impressions)
          if (patch.tags !== undefined) meta.tags = sanitizeImpressions(patch.tags)
          if (patch.enabled !== undefined) meta.enabled = patch.enabled === true
          if (patch.links !== undefined) {
            meta.links = sanitizeIds(patch.links).filter((l) => l !== id)
            meta.composedOf = Array.isArray(meta.composedOf) ? meta.composedOf : []
          }
          meta.revision = Number(meta.revision || 1) + 1
          meta.updatedAt = now()
          const notes = patch.notes !== undefined ? String(patch.notes).slice(0, 20000) : mem.notes
          await writeMemory(meta, mem.snapshot, notes)
          return memoryMetaOf(memoryIndex.get(id))
        }
        case 'memory.setEnabled': {
          const id = String(a.id || '')
          const mem = memoryIndex.get(id)
          if (!mem) return { error: '记忆不存在: ' + id }
          const meta = { ...mem.meta, enabled: a.enabled !== false }
          meta.revision = Number(meta.revision || 1) + 1
          meta.updatedAt = now()
          await writeMemory(meta, mem.snapshot, mem.notes)
          // 禁用时从所有会话的注入计划中移除该记忆（全局生效，含内存缓存与已落盘计划）
          if (a.enabled === false) {
            try { await purgeMemoryFromPlans(id) } catch (e) { logLine('memory.setEnabled: purge failed: ' + String((e && e.message) || e)) }
          }
          return memoryMetaOf(memoryIndex.get(id))
        }
        case 'memory.delete': {
          const id = String(a.id || '')
          const mem = memoryIndex.get(id)
          if (!mem) return { error: '记忆不存在: ' + id }
          const dir = libPath()
          if (!dir) return { error: '记忆库未配置' }
          await removeFile(dir + '/memories/' + id + '.md')
          memoryIndex.delete(id)
          backlinkIndex.clear()
          for (const m of memoryIndex.values()) {
            for (const lid of Array.isArray(m.meta.links) ? m.meta.links : []) {
              if (typeof lid !== 'string') continue
              if (!backlinkIndex.has(lid)) backlinkIndex.set(lid, [])
              backlinkIndex.get(lid).push(m.meta.id)
            }
          }
          return { ok: true }
        }
        case 'memory.compose': {
          const dir = libPath()
          if (!dir) return { error: '记忆库未配置' }
          const ids = sanitizeIds(a.ids)
          if (!ids.length) return { error: '未选择记忆' }
          const srcs = ids.map((id) => memoryIndex.get(id)).filter(Boolean)
          if (!srcs.length) return { error: '所选记忆不存在' }
          const mode = a.mode === 'llm' ? 'llm' : (a.mode === 'manual' ? 'manual' : 'concat')
          let body
          if (mode === 'concat') {
            body = srcs.map((m) => '--- ' + String(m.meta.title || m.meta.id) + ' ---\n' + m.snapshot).join('\n\n')
          } else if (mode === 'manual') {
            body = String(a.body || '').trim()
            if (!body) return { error: '手动模式需要填写正文' }
          } else {
            const input = srcs.map((m, i) => '【' + (i + 1) + '】' + String(m.meta.title || m.meta.id) + '\n' + String(m.snapshot || '').slice(0, 5000)).join('\n\n')
            const out = await askLlm(
              '你是记忆整理助手。将下面多段记忆综合成一段新的结构化记忆：保留关键事实、决定、待办和重要细节，合并重复信息，条理清晰，直接输出正文（Markdown），不要标题前缀。',
              input, 2000)
            if (!out) return { error: 'LLM 生成失败' }
            body = out
          }
          const title = String(a.title || '').trim() || '组合记忆'
          const meta = {
            id: uid('m'), title,
            impressions: sanitizeImpressions(a.impressions),
            composedOf: ids,
            sourceSession: sessionId,
            createdAt: now(), updatedAt: now(), revision: 1,
          }
          meta.links = ids.filter((l) => l !== meta.id)
          await writeMemory(meta, body.slice(0, 40000), '')
          return memoryMetaOf(memoryIndex.get(meta.id))
        }
        case 'memory.related': {
          const id = String(a.id || '')
          if (!memoryIndex.has(id)) return { error: '记忆不存在: ' + id }
          const depth = clamp(Number(a.depth) || 2, 1, 4)
          const limit = clamp(Number(a.limit) || 30, 1, 100)
          return { related: relatedOf(id, depth, limit) }
        }
        case 'memory.suggest': {
          const content = String(a.content || '').slice(0, 8000)
          if (!content) return { error: '内容为空' }
          return await suggestImpressions(content)
        }
        case 'session.messages': {
          const view = await sessionView(sessionId)
          if (!view) return { error: '会话不存在或不在线' }
          const plan = await loadPlan(sessionId)
          const turns = buildTurns(view.session, sessionId, plan)
          const limit = clamp(Number(a.limit) || 30, 5, 200)
          return { turns: turns.slice(-limit).map((t) => ({ turnId: t.turnId, excluded: t.excluded, marker: !!t.marker, nodes: t.nodes })) }
        }
        case 'session.summarize': {
          // 会话总结：把所选会话（默认全部轮次；可选最近 N 轮）交给 LLM 提炼为
          // 「会话id / 轮次 / 用户请求 / 思考链 / 处理链 / 结果」六要素记忆，逐条 memory_save 入库。
          // merge=true 时先由 LLM 判断哪些连续轮次属于同一事务并合并为一条总结（其余仍每轮一条）。
          const view = await sessionView(sessionId)
          if (!view) return { error: '会话不存在或不在线' }
          const dir = libPath()
          if (!dir) return { error: '记忆库未配置' }
          const plan = await loadPlan(sessionId)
          const allTurns = buildTurns(view.session, sessionId, plan)
          // 已排除的轮次内容会被标记文本替代，无法总结，跳过
          const validTurns = allTurns.filter((t) => !t.excluded)
          if (!validTurns.length) return { error: '该会话没有可总结的轮次' }
          // 范围：默认全部；可选最近 N 轮（0=全部）
          const recent = clamp(Number(a.recent) || 0, 0, 100)
          // 规范化：附全会话 1-based 轮次位置（用于「覆盖轮次 X-Y」）、完整输入、精简输入、用户请求回退
          const normalized = validTurns.map((t, i) => ({
            turnId: t.turnId,
            nodes: t.nodes || [],
            _pos: i + 1,
            _full: turnSummaryInput(t, i + 1),
            _brief: turnSummaryInput(t, i + 1),
            _user: (() => { const n = (t.nodes || []).find((x) => x && x.kind === 'user'); return n ? String(n.text || n.preview || '').trim() : '' })(),
          }))
          const startIdx = (recent > 0 && recent < normalized.length) ? normalized.length - recent : 0
          const scope = normalized.slice(startIdx)
          if (!scope.length) return { error: '该会话没有可总结的轮次' }
          // 预检 LLM 可用性：不可用则明确报错（不落库任何记忆）
          const llm = ctx.get('llm')
          const adm = ctx.get('agentDefaultModel')
          let llmOk = false
          try { const sel = adm && adm.currentSelection ? adm.currentSelection() : null; llmOk = !!(llm && sel && sel.provider && sel.model) } catch { llmOk = false }
          if (!llmOk) return { error: 'LLM 不可用，无法生成会话总结（请确认已配置默认模型）' }
          const merge = a.merge === true
          let groups = null
          if (merge) {
            try { groups = await groupSameTransactions(scope) } catch (e) { logLine('session.summarize: group threw: ' + String((e && e.message) || e)); groups = null }
          }
          if (!groups || !Array.isArray(groups) || !groups.length) groups = scope.map((t) => [t])
          const saved = []
          for (const g of groups) {
            if (!Array.isArray(g) || !g.length) continue
            const gs = await summarizeGroup(sessionId, g)
            const rangeTitle = g.length > 1 ? ('覆盖轮次 ' + gs.firstPos + '-' + gs.lastPos) : ('轮次 ' + gs.firstPos)
            const meta = {
              id: uid('m'),
              title: '会话总结（' + String(sessionId).slice(-8) + ' · ' + rangeTitle + '）',
              impressions: sanitizeImpressions([SUMMARY_TAG, '会话 ' + String(sessionId).slice(-8)]),
              tags: sanitizeImpressions([SUMMARY_TAG]),
              enabled: true,
              links: [], composedOf: [],
              sourceSession: sessionId,
              // sourceSeqs 是数字 seq（供「消息位置」跳转），不是记忆 id
              sourceSeqs: gs.sourceSeqs,
              createdAt: now(), updatedAt: now(), revision: 1,
            }
            await writeMemory(meta, gs.body.slice(0, 40000), gs.notes.slice(0, 20000))
            const full = memoryMetaOf(memoryIndex.get(meta.id))
            saved.push(Object.assign(full, { notes: gs.notes, snapshot: gs.body }))
          }
          return { summaries: saved, count: saved.length }
        }
        case 'session.saveAsMemory': {
          const view = await sessionView(sessionId)
          if (!view) return { error: '会话不存在或不在线' }
          const dir = libPath()
          if (!dir) return { error: '记忆库未配置' }
          const ids = Array.isArray(a.messageIds) ? a.messageIds.map(String) : []
          if (!ids.length) return { error: '未选择消息' }
          const want = new Set(ids)
          const parts = []
          const sourceSeqs = []
          let found = 0
          for (const seq of view.session.surface.nodes) {
            const event = view.session.events[seq]
            if (!event) continue
            const info = nodeInfo(event)
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
            id: uid('m'), title,
            impressions: sanitizeImpressions(a.impressions),
            tags: sanitizeImpressions(a.tags),
            links: sanitizeIds(a.links),
            composedOf: [],
            sourceSession: sessionId,
            sourceSeqs,
            createdAt: now(), updatedAt: now(), revision: 1,
          }
          await writeMemory(meta, parts.join('\n\n'), String(a.notes || ''))
          return memoryMetaOf(memoryIndex.get(meta.id))
        }
        case 'session.pin': {
          const view = await sessionView(sessionId)
          if (!view) return { error: '会话不存在或不在线' }
          const plan = await loadPlan(sessionId)
          const ids = Array.isArray(a.messageIds) ? a.messageIds.map(String) : []
          const want = new Set(ids)
          const found = []
          for (const seq of view.session.surface.nodes) {
            const event = view.session.events[seq]
            if (!event) continue
            const info = nodeInfo(event)
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
              plan.pinned.push({ id: n.id, role: n.kind, text: String(n.text || '').slice(0, 4000), at: now() })
            }
          }
          await savePlan(sessionId, plan)
          return { ok: true, pinned: (plan.pinned || []).map((p) => ({ id: String(p.id), role: p.role || '', text: preview(p.text, 80), at: p.at || 0 })) }
        }
        case 'session.injectNow': {
          // 直接注入：把记忆作为模型上下文注入当前会话（Agent.inject，官方上下文注入机制，
          // 不会作为对话消息显示），并唤醒 driver（Agent.steer）让模型立即基于它响应一次。
          if (!sessionId) return { error: '缺少会话 id' }
          const id = String(a.id || '')
          const mem = memoryIndex.get(id)
          if (!mem) return { error: '记忆不存在: ' + id }
          if (mem.meta.enabled === false) return { error: '该记忆已禁用' }
          const agentsSvc = ctx.get('agents')
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
            agent.inject({ id: 'mem-inject-' + rand(10), role: 'user', content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: 'dsh-memory-manager' } })
          } catch (e) {
            return { error: '上下文注入失败: ' + String((e && e.message) || e) }
          }
          // 唤醒 driver：idle 时启动一轮响应，模型将基于注入的上下文继续当前对话
          let replied = false
          try {
            if (typeof agent.steer === 'function') {
              agent.steer({ id: 'mem-inject-steer-' + rand(10), role: 'user', content: [{ type: 'text', text: '（参考记忆已注入，请结合它继续当前对话；若无需回应的要点请简要确认）' }], source: { kind: 'plugin', plugin: 'dsh-memory-manager' } })
              replied = true
            }
          } catch (e) { logLine('session.injectNow: steer failed: ' + String((e && e.message) || e)) }
          logLine('session.injectNow: ' + sessionId + ' <- ' + id + ' replied=' + replied)
          return { ok: true, title, replied }
        }
        case 'plan.addMemory': {
          const plan = await loadPlan(sessionId)
          const id = String(a.id || '')
          const mem = memoryIndex.get(id)
          if (!mem) return { error: '记忆不存在: ' + id }
          if (mem.meta.enabled === false) return { error: '该记忆已禁用（启用后才可加入注入计划）' }
          const exists = (plan.memories || []).some((m) => String(m.id) === id)
          if (!exists) plan.memories.push({ id, title: String(mem.meta.title || ''), impressions: Array.isArray(mem.meta.impressions) ? mem.meta.impressions.map(String) : [], tags: Array.isArray(mem.meta.tags) ? mem.meta.tags.map(String) : [] })
          await savePlan(sessionId, plan)
          return { ok: true }
        }
        case 'plan.removeMemory': {
          const plan = await loadPlan(sessionId)
          const id = String(a.id || '')
          plan.memories = (plan.memories || []).filter((m) => String(m.id) !== id)
          await savePlan(sessionId, plan)
          return { ok: true }
        }
        case 'plan.injectOnce': {
          const plan = await loadPlan(sessionId)
          plan.injectOnce = a.v === true
          await savePlan(sessionId, plan)
          return { ok: true }
        }
        case 'plan.injectOnceMemory': {
          // 选中记忆 → 下一次发送时注入（全局队列，不入计划；任何会话的第一次请求渲染后自动清除）
          const id = String(a.id || '')
          if (a.cancel === true) {
            const once = await loadOnce()
            const next = once.filter((m) => String(m.id) !== id)
            if (next.length !== once.length) {
              await saveOnce(next)
              logLine('plan.injectOnceMemory(cancel): session=' + sessionId + ' <- ' + id + ' onceCount=' + next.length)
            }
            return { ok: true, onceCount: next.length }
          }
          const mem = memoryIndex.get(id)
          if (!mem) return { error: '记忆不存在: ' + id }
          if (mem.meta.enabled === false) return { error: '该记忆已禁用' }
          const once = await loadOnce()
          if (!once.some((m) => String(m.id) === id)) {
            once.push({
              id, title: String(mem.meta.title || ''),
              impressions: Array.isArray(mem.meta.impressions) ? mem.meta.impressions.map(String) : [],
              tags: Array.isArray(mem.meta.tags) ? mem.meta.tags.map(String) : [],
            })
            await saveOnce(once)
          }
          logLine('plan.injectOnceMemory: session=' + sessionId + ' <- ' + id + ' onceCount=' + once.length)
          return { ok: true, onceCount: once.length }
        }
        case 'plan.excludeTurn': {
          const view = await sessionView(sessionId)
          if (!view) return { error: '会话不存在或不在线' }
          if (!view.writable) return { error: '排除/恢复需要 live 会话（宿主模式暂不支持）' }
          const turnId = String(a.turnId || '')
          if (!turnId) return { error: '缺少轮次 id' }
          return await excludeTurn(view.session, sessionId, turnId, a.exclude !== false)
        }
        case 'diag.log': {
          // 前端日志落盘（client → host），供界面排错
          const line = [new Date().toISOString(), a.level || 'info', a.tag || '', String(a.msg || '').slice(0, 4000)].join(' | ')
          logClientLine(line)
          if (a.stack) logClientLine('  stack: ' + String(a.stack).slice(0, 4000))
          return { ok: true }
        }
        default:
          return { error: '未知操作: ' + op }
      }
    } catch (err) {
      return { error: (err && err.message) ? err.message : String(err) }
    }
  }

  // ================= HTTP API 路由（webServer，ctx.inject 等待服务） =================
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
  try {
    disposers.push(ctx.inject(['webServer'], (webCtx) => {
      webCtx.effect(() => {
        const dispose = webCtx.webServer.register({
          kind: 'exact',
          path: API_PATH,
          handler: async (req, res) => {
            try {
              if (req.method === 'GET') {
                sendJson(res, 200, { ok: true, service: 'memory-manager', enabled: cfg.enabled })
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
              const result = await handler(body)
              sendJson(res, 200, { ok: !result || !result.error, value: result })
            } catch (error) {
              sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
            }
          },
        })
        logLine('route registered')
        return dispose
      })
    }))
  } catch (error) {
    logError(error)
    logger.warn('dsh-memory-manager: webServer route attach failed — %s', error instanceof Error ? error.message : String(error))
  }

  // ================= Agent 记忆工具 =================
  const toolsService = ctx.get('tools')
  if (toolsService !== undefined) {
    const renderJson = (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }]
    const out = { schema: { type: 'json' }, render: renderJson }
    const gate = () => {
      if (!cfg.enabled) return '记忆管理已禁用（设置 → 记忆管理 中开启）'
      if (!cfg.modelTools) return '模型记忆工具未开启（设置中可开启）'
      return null
    }
    const toolDefs = [
      defineTool({
        name: 'memory_search',
        description: '搜索记忆库：按关键词匹配记忆的标题、印象与正文，返回匹配记忆的 id、标题、印象与预览。',
        parameters: {
          query: { type: 'string', required: true, description: '关键词' },
        },
        output: out,
        async execute(args, exec) {
          const blocked = gate()
          if (blocked) return { error: blocked }
          const q = String((args && args.query) || '').trim().toLowerCase()
          if (!q) return { error: '缺少关键词' }
          const hits = []
          for (const mem of memoryIndex.values()) {
            const meta = mem.meta
            const title = String(meta.title || '').toLowerCase()
            const impressions = (Array.isArray(meta.impressions) ? meta.impressions : []).join(' ').toLowerCase()
            const body = String(mem.snapshot || '').slice(0, 8000).toLowerCase()
            if (title.includes(q) || impressions.includes(q) || body.includes(q)) {
              hits.push({
                id: String(meta.id),
                title: String(meta.title || meta.id),
                impressions: Array.isArray(meta.impressions) ? meta.impressions.map(String) : [],
                preview: preview(mem.snapshot, 200),
              })
            }
          }
          hits.sort((x, y) => y.impressions.length - x.impressions.length)
          return { count: hits.length, memories: hits.slice(0, 20) }
        },
      }),
      defineTool({
        name: 'memory_recall',
        description: '读取一条记忆的完整内容（快照与标注）及其链接、组合来源与被引用关系。',
        parameters: {
          id: { type: 'string', required: true, description: '记忆 id' },
        },
        output: out,
        async execute(args, exec) {
          const blocked = gate()
          if (blocked) return { error: blocked }
          const id = String((args && args.id) || '')
          const mem = memoryIndex.get(id)
          if (!mem) return { error: '记忆不存在: ' + id }
          return Object.assign(memoryMetaOf(mem), {
            snapshot: String(mem.snapshot || '').slice(0, 20000),
            notes: String(mem.notes || ''),
          })
        },
      }),
      defineTool({
        name: 'memory_save',
        description: '保存一条新记忆到记忆库：提供标题、印象标签数组与正文快照，可附标注；tags 为分类标签（可选），填 "convention" 即标记为规约记忆，填 "会话总结" 即标记为会话总结记忆（两者在新会话默认自动注入）；enabled 默认 true 表示该记忆启用（禁用后不参与自动注入、不能加入计划）。',
        parameters: {
          title: { type: 'string', required: true, description: '记忆标题' },
          impressions: { type: 'array', items: { type: 'string' }, required: true, description: '印象标签数组' },
          snapshot: { type: 'string', required: true, description: '正文快照' },
          notes: { type: 'string', required: true, description: '标注（可为空字符串）' },
          tags: { type: 'array', items: { type: 'string' }, description: '分类标签数组（可选），"convention" 表示规约记忆，"会话总结" 表示会话总结记忆' },
          enabled: { type: 'boolean', description: '是否启用（可选，默认 true）' },
        },
        output: out,
        async execute(args, exec) {
          const blocked = gate()
          if (blocked) return { error: blocked }
          const dir = libPath()
          if (!dir) return { error: '记忆库未配置' }
          const a = (args && typeof args === 'object') ? args : {}
          const sessionId = exec && exec.agent && exec.agent.id ? String(exec.agent.id) : null
          const title = String(a.title || '').trim() || ('记忆 ' + new Date().toISOString().slice(0, 10))
          const meta = {
            id: uid('m'), title,
            impressions: sanitizeImpressions(a.impressions),
            tags: sanitizeImpressions(a.tags),
            enabled: a.enabled !== false,
            links: [], composedOf: [],
            sourceSession: sessionId,
            createdAt: now(), updatedAt: now(), revision: 1,
          }
          await writeMemory(meta, String(a.snapshot || '').slice(0, 40000), String(a.notes || '').slice(0, 20000))
          return memoryMetaOf(memoryIndex.get(meta.id))
        },
      }),
      defineTool({
        name: 'memory_set_enabled',
        description: '启用或禁用一条记忆：禁用后不参与新会话自动注入、不能被加入注入计划（已在计划中的也不再注入），直到重新启用。',
        parameters: {
          id: { type: 'string', required: true, description: '记忆 id' },
          enabled: { type: 'boolean', required: true, description: 'true=启用，false=禁用' },
        },
        output: out,
        async execute(args, exec) {
          const blocked = gate()
          if (blocked) return { error: blocked }
          const id = String((args && args.id) || '')
          const mem = memoryIndex.get(id)
          if (!mem) return { error: '记忆不存在: ' + id }
          const meta = { ...mem.meta, enabled: (args && args.enabled) !== false }
          meta.revision = Number(meta.revision || 1) + 1
          meta.updatedAt = now()
          await writeMemory(meta, mem.snapshot, mem.notes)
          return memoryMetaOf(memoryIndex.get(id))
        },
      }),
      defineTool({
        name: 'session_inject',
        description: '把一条记忆加入或移出当前会话的注入计划：加入后（记忆模式开启时）每轮自动注入；移出后不再注入。用于会话内按需管理注入内容。',
        parameters: {
          id: { type: 'string', required: true, description: '记忆 id' },
          inject: { type: 'boolean', required: true, description: 'true=加入当前会话计划，false=移出' },
        },
        output: out,
        async execute(args, exec) {
          const blocked = gate()
          if (blocked) return { error: blocked }
          const sessionId = exec && exec.agent && exec.agent.id ? String(exec.agent.id) : null
          if (!sessionId) return { error: '无法确定当前会话' }
          const id = String((args && args.id) || '')
          const mem = memoryIndex.get(id)
          if (!mem) return { error: '记忆不存在: ' + id }
          const plan = await loadPlan(sessionId)
          if (args && args.inject === false) {
            plan.memories = (plan.memories || []).filter((m) => String(m.id) !== id)
          } else {
            if (mem.meta.enabled === false) return { error: '该记忆已禁用（启用后才可加入注入计划）' }
            const exists = (plan.memories || []).some((m) => String(m.id) === id)
            if (!exists) plan.memories.push({ id, title: String(mem.meta.title || ''), impressions: Array.isArray(mem.meta.impressions) ? mem.meta.impressions.map(String) : [], tags: Array.isArray(mem.meta.tags) ? mem.meta.tags.map(String) : [] })
          }
          await savePlan(sessionId, plan)
          return { ok: true, memories: (plan.memories || []).map((m) => String(m.id)) }
        },
      }),
      defineTool({
        name: 'memory_pin',
        description: '把一段文本固定为当前会话的临时记忆（记忆模式开启时每次发送自动注入）。',
        parameters: {
          content: { type: 'string', required: true, description: '要固定的文本' },
          label: { type: 'string', required: true, description: '标签（可为空字符串）' },
        },
        output: out,
        async execute(args, exec) {
          const blocked = gate()
          if (blocked) return { error: blocked }
          const sessionId = exec && exec.agent && exec.agent.id ? String(exec.agent.id) : null
          if (!sessionId) return { error: '无法确定当前会话' }
          const a = (args && typeof args === 'object') ? args : {}
          const content = String(a.content || '').trim()
          if (!content) return { error: '内容为空' }
          const plan = await loadPlan(sessionId)
          plan.pinned.push({
            id: 'tool-pin-' + rand(10),
            role: 'pin',
            text: ((a.label && String(a.label).trim()) ? '[' + String(a.label).trim() + '] ' : '') + content.slice(0, 4000),
            at: now(),
          })
          await savePlan(sessionId, plan)
          return { ok: true, pinnedCount: plan.pinned.length }
        },
      }),
    ]
    for (const tool of toolDefs) {
      disposers.push(toolsService.register(tool))
    }
  }

  // ================= 注入段 =================
  const sysPrompt = ctx.get('systemPrompt')
  logLine('systemPrompt present: ' + (sysPrompt !== undefined))
  if (sysPrompt !== undefined) {
    disposers.push(sysPrompt.section({
      name: 'memory-manager:context',
      order: 300,
      text: (assembleCtx) => {
        try {
          const agent = assembleCtx && (assembleCtx.agent || assembleCtx.scope)
          const sessionId = agent && agent.id ? String(agent.id) : null
          if (!sessionId) return ''
          return renderContextFor(sessionId)
        } catch { return '' }
      },
    }))
  }

  // ================= 预载计划 =================
  const agentsSvc = ctx.get('agents')
  if (agentsSvc !== undefined) {
    // global:true 绕过 scope 过滤 —— agent/created 经 scopeTarget(agent,agent) carrier 派发，
    // 根组合监听器不在 agent 的 scope 祖先链上会被过滤（见 @deepseek-ai/dsh-scope）
    disposers.push(ctx.on('agent/created', (payload) => {
      logLine('agent/created observed: ' + (payload && payload.agent && payload.agent.id))
      if (payload && payload.agent && payload.agent.id) {
        // 全局计划首次创建时自动注入规约记忆/会话总结（幂等：planCache 已有则跳过）
        loadPlan().then((plan) => {
          logLine('loadPlan done global memories=' + (plan && plan.memories ? plan.memories.length : '?'))
        }).catch((e) => { logLine('loadPlan failed: ' + String(e && e.message || e)) })
        // 预载该会话的排除记录与全局一次性注入队列（供消息页/注入渲染同步读取）
        loadExcluded(String(payload.agent.id)).catch(() => {})
        loadOnce().catch(() => {})
      }
    }, { global: true }))
    try {
      const list = agentsSvc.list ? agentsSvc.list() : []
      for (const ag of list) {
        if (!ag || !ag.id) continue
        loadPlan().catch(() => {})
        loadExcluded(String(ag.id)).catch(() => {})
        loadOnce().catch(() => {})
      }
    } catch { /* ignore */ }
  }

  // 启动即扫描记忆库（尽力而为）
  scanLibrary().catch(() => {})

  return () => {
    for (const dispose of disposers.reverse()) {
      try { dispose() } catch { /* ignore */ }
    }
  }
}
// @dsh-external/dsh-memory-manager — 记忆管理插件（宿主级）
// 所有能力按需注册；settings 命名空间 memory-manager 提供全局开关（enabled）与各项配置。
// enabled=false 时：不注入、工具拒绝执行、API 仅返回状态（供设置页重新开启）。
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from 'schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { appendFileSync } from 'node:fs'
import { readFile, writeFile, readdir, mkdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { foldSurface } from '@deepseek-ai/dsh-session'

// 日志默认落在 <homedir>/.dsh/ 下；可用环境变量 DSH_MEMORY_LOG_DIR 重定向目录
const LOG_DIR = process.env.DSH_MEMORY_LOG_DIR || join(homedir(), '.dsh')
const LOG_FILE = join(LOG_DIR, 'memory-manager-boot.log')
const CLIENT_LOG_FILE = join(LOG_DIR, 'memory-manager-client.log')
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

export const Config = z.object({
  enabled: z.boolean().default(true),
  mode: z.union(['on', 'off']).default('off'),
  view: z.union(['full', 'compact']).default('full'),
  modelTools: z.boolean().default(true),
  libraryPath: z.string().default(''),
  memoryChars: z.number().default(6000),
  totalChars: z.number().default(12000),
  pinChars: z.number().default(6000),
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
    const order = ['id', 'title', 'impressions', 'links', 'composedOf', 'sourceSession', 'createdAt', 'updatedAt', 'revision']
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
      links,
      composedOf: Array.isArray(mem.meta.composedOf) ? mem.meta.composedOf.map(String) : [],
      sourceSession: mem.meta.sourceSession ?? null,
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

  // ================= 计划（每会话） =================
  function planPath(sessionId) {
    const dir = libPath()
    return dir ? dir + '/pinned/' + sessionId + '.json' : null
  }
  async function loadPlan(sessionId) {
    let plan = planCache.get(sessionId)
    if (plan === undefined) {
      const p = planPath(sessionId)
      const saved = p ? await readJson(p) : null
      plan = (saved && typeof saved === 'object') ? saved : {}
      if (!Array.isArray(plan.pinned)) plan.pinned = []
      if (!Array.isArray(plan.memories)) plan.memories = []
      if (!Array.isArray(plan.excluded)) plan.excluded = []
      if (plan.injectOnce !== true) plan.injectOnce = false
      planCache.set(sessionId, plan)
    }
    return plan
  }
  async function savePlan(sessionId, plan) {
    planCache.set(sessionId, plan)
    const p = planPath(sessionId)
    if (p) await writeJson(p, { pinned: plan.pinned, memories: plan.memories, excluded: plan.excluded, injectOnce: plan.injectOnce === true })
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
    return event.type === 'user/message' && event.data && event.data.source &&
      event.data.source.kind === 'plugin' && event.data.source.plugin === PLUGIN_TAG
  }
  function buildTurns(session, plan) {
    const turns = []
    let cur = null
    const excluded = new Set((plan.excluded || []).map(String))
    for (const seq of session.surface.nodes) {
      const event = session.events[seq]
      if (!event) continue
      const info = nodeInfo(event)
      if (!info) continue
      if (isMarkerEvent(event)) {
        const m = MARKER_RE.exec(info.text)
        const turnId = m ? m[1] : String(info.id)
        if (cur && cur.marker && cur.turnId === turnId) { /* 同轮标记，继续追加 */ }
        else { cur = { turnId, marker: true, excluded: true, nodes: [] }; turns.push(cur) }
      } else if (event.type === 'user/message') {
        cur = { turnId: String(info.id), marker: false, excluded: excluded.has(String(info.id)), nodes: [] }
        turns.push(cur)
      }
      if (cur) cur.nodes.push({ seq, kind: info.kind, id: String(info.id), preview: preview(info.text), time: info.time })
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
      } else if (inTurn) {
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
      const info = nodeInfo(event)
      if (!info) continue
      const m = MARKER_RE.exec(info.text)
      if (m && m[1] === turnId) out.push({ seq, event })
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

  async function excludeTurn(session, sessionId, turnId, exclude) {
    const plan = await loadPlan(sessionId)
    const excluded = (plan.excluded || []).map(String)
    if (exclude) {
      if (excluded.includes(turnId)) return { ok: true }
      const span = findTurnSpan(session, turnId)
      if (!span.length) return { error: '未找到该轮次（可能已被排除或压缩）' }
      let laterUser = false
      for (const seq of session.surface.nodes) {
        const event = session.events[seq]
        if (!event) continue
        if (event.type === 'user/message' && !isMarkerEvent(event)) {
          const info = nodeInfo(event)
          if (info && String(info.id) !== turnId && !span.includes(seq)) { laterUser = true; break }
        }
      }
      if (!laterUser) return { error: '不能排除当前最新一轮' }
      for (const seq of span) {
        session.append('user/message', makeMarker(turnId), { surfaceOp: { op: 'replace', start: seq, end: seq }, sourceEventSeqs: [seq] })
      }
      plan.excluded = [...excluded, turnId]
      await savePlan(sessionId, plan)
      return { ok: true }
    } else {
      if (!excluded.includes(turnId)) return { ok: true }
      const markers = findMarkers(session, turnId)
      for (const { seq, event } of markers) {
        const origSeq = Array.isArray(event.sourceEventSeqs) ? event.sourceEventSeqs[0] : undefined
        const orig = origSeq !== undefined ? session.events[origSeq] : undefined
        if (!orig) continue
        const type = orig.type
        if (type === 'user/message' || type === 'assistant/message' || type === 'tool/result') {
          session.append(type, orig.data, { surfaceOp: { op: 'replace', start: seq, end: seq }, sourceEventSeqs: [seq] })
        }
      }
      plan.excluded = excluded.filter((t) => t !== turnId)
      await savePlan(sessionId, plan)
      return { ok: true }
    }
  }

  // ================= 注入渲染 =================
  function renderContextFor(sessionId) {
    if (!cfg.enabled) return ''
    const plan = planCache.get(sessionId)
    if (!plan) return ''
    const active = cfg.mode === 'on' || plan.injectOnce === true
    if (!active) return ''
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
      parts.push('【记忆·' + String(mem.meta.title || mref.id) + '】' + body.slice(0, take))
      budget -= take
    }
    if (!parts.length) return ''
    let text = parts.join('\n\n')
    if (budget <= 0) text += '\n[记忆库上下文已截断]'
    if (cfg.view === 'compact' && cfg.modelTools) text += '\n（需要完整内容时可调用 memory_recall 读取）'
    if (plan.injectOnce === true) {
      plan.injectOnce = false
      savePlan(sessionId, plan).catch(() => {})
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
            },
            plan: plan ? {
              pinned: (plan.pinned || []).map((p) => ({ id: String(p.id), role: p.role || '', text: preview(p.text, 80), at: p.at || 0 })),
              memories: (plan.memories || []).map((m) => ({ id: String(m.id), title: String(m.title || ''), impressions: Array.isArray(m.impressions) ? m.impressions.map(String) : [] })),
              excluded: (plan.excluded || []).map(String),
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
          const turns = buildTurns(view.session, plan)
          const limit = clamp(Number(a.limit) || 30, 5, 200)
          return { turns: turns.slice(-limit).map((t) => ({ turnId: t.turnId, excluded: t.excluded, marker: !!t.marker, nodes: t.nodes })) }
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
          let found = 0
          for (const seq of view.session.surface.nodes) {
            const event = view.session.events[seq]
            if (!event) continue
            const info = nodeInfo(event)
            if (!info) continue
            if (!want.has(String(info.id))) continue
            found++
            const roleLabel = info.kind === 'user' ? '用户' : (info.kind === 'assistant' ? '助手' : '工具结果')
            parts.push('### ' + roleLabel + '\n' + (info.text || '（无文本内容）'))
            if (found >= want.size) break
          }
          if (!found) return { error: '未找到所选消息（可能已被排除或压缩）' }
          const title = String(a.title || '').trim() || ('记忆 ' + new Date().toISOString().slice(0, 10))
          const meta = {
            id: uid('m'), title,
            impressions: sanitizeImpressions(a.impressions),
            links: sanitizeIds(a.links),
            composedOf: [],
            sourceSession: sessionId,
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
        case 'plan.addMemory': {
          const plan = await loadPlan(sessionId)
          const id = String(a.id || '')
          const mem = memoryIndex.get(id)
          if (!mem) return { error: '记忆不存在: ' + id }
          const exists = (plan.memories || []).some((m) => String(m.id) === id)
          if (!exists) plan.memories.push({ id, title: String(mem.meta.title || ''), impressions: Array.isArray(mem.meta.impressions) ? mem.meta.impressions.map(String) : [] })
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
        description: '保存一条新记忆到记忆库：提供标题、印象标签数组与正文快照，可附标注。',
        parameters: {
          title: { type: 'string', required: true, description: '记忆标题' },
          impressions: { type: 'array', items: { type: 'string' }, required: true, description: '印象标签数组' },
          snapshot: { type: 'string', required: true, description: '正文快照' },
          notes: { type: 'string', required: true, description: '标注（可为空字符串）' },
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
            links: [], composedOf: [],
            sourceSession: sessionId,
            createdAt: now(), updatedAt: now(), revision: 1,
          }
          await writeMemory(meta, String(a.snapshot || '').slice(0, 40000), String(a.notes || '').slice(0, 20000))
          return memoryMetaOf(memoryIndex.get(meta.id))
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
    disposers.push(ctx.on('agent/created', (payload) => {
      if (payload && payload.agent && payload.agent.id) loadPlan(String(payload.agent.id)).catch(() => {})
    }))
    try {
      const list = agentsSvc.list ? agentsSvc.list() : []
      for (const ag of list) if (ag && ag.id) loadPlan(String(ag.id)).catch(() => {})
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

// 本地集成测试：mock ctx 调用宿主插件 apply，验证新版 DSH API 适配路径
//
// 用法：
//   node tests/test-apply.mjs [插件模块路径] [临时记忆库路径]
//
// 依赖解析（DSH 包名为 @deepseek-ai/*，本仓库 node_modules 需可解析）：
//   node_modules/@deepseek-ai/dsh-tools  → DSH 检出的 packages/core/tools
//   node_modules/schemastery            → DSH 检出的 vendor/schemastery（API 兼容 npm schemastery）
// 参见 docs/DEVELOPMENT.md。
import { pathToFileURL } from 'node:url'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const argPath = process.argv[2]
const libDir = process.argv[3] && join(process.argv[3])
const modUrl = argPath
  ? (argPath.startsWith('file:') ? argPath : pathToFileURL(argPath).href)
  : new URL('../lib/index.js', import.meta.url).href

const listeners = new Map() // event -> [{ handler, options }]
let toolNames = []
let settingsRegistered = null
let routes = []
let mockSessions = new Map()
let queryTitles = new Map()
let wsList = []

function makeCtx() {
  let cfg = {}
  const settingsService = {
    register(ns, schema, opts) {
      settingsRegistered = { ns, schema, opts }
      cfg = { ...(opts && opts.base) }
      return {
        get: () => ({ ...cfg }),
        watch: () => () => {},
        update: async (patch) => { Object.assign(cfg, patch) },
        dispose: () => {},
      }
    },
    update: async (ns, patch) => { Object.assign(cfg, patch); return { ok: true } },
  }
  const toolsService = {
    register(tool) {
      toolNames.push(tool && tool.name)
      return () => {}
    },
  }
  const sessionQuery = {
    readSurface: async (sessionId) => {
      const events = mockSessions.get(String(sessionId)) || []
      return { session: { id: sessionId }, inheritedEventCount: 0, capturedThroughSeq: events.at(-1)?.seq ?? null, events }
    },
    readTitle: async (sessionId) => queryTitles.get(String(sessionId)) || undefined,
    readSession: async (sessionId) => ({ session: { id: sessionId }, inheritedEventCount: 0, events: mockSessions.get(String(sessionId)) || [] }),
  }
  const sessions = {
    get: (id) => mockLive.get(String(id)) || undefined,
    list: () => [...mockLive.values()],
  }
  const mockLive = new Map()
  const agents = {
    list: () => [],
    get: (id) => agentsById.get(String(id)),
  }
  const agentsById = new Map()
  const workspaceRegistry = {
    list: () => wsList,
    get archivedSessionIds() { return [] },
  }
  const llm = {
    stream: (options) => (async function* () {
      yield { type: 'text-delta', index: 0, text: '{"user":"u","thinking":"t","processing":"p","result":"r"}' }
      yield { type: 'finish', kind: 'stop' }
    })(),
  }
  const agentDefaultModel = { currentSelection: () => ({ provider: 'mock', model: 'mock' }) }
  const httpServer = { register: (r) => { routes.push(r); return () => {} } }
  const ctx = {
    get(name, _loose) {
      if (name === 'settings') return settingsService
      if (name === 'tools') return toolsService
      if (name === 'sessionQuery') return sessionQuery
      if (name === 'sessions') return sessions
      if (name === 'agents') return agents
      if (name === 'workspaceRegistry') return workspaceRegistry
      if (name === 'llm') return llm
      if (name === 'agentDefaultModel') return agentDefaultModel
      if (name === 'webServer') return httpServer
      return undefined
    },
    inject(names, cb) {
      if (names && names.includes('webServer')) {
        const sub = { webServer: httpServer, effect: (fn) => { const r = fn(); return () => { if (typeof r === 'function') r() } } }
        cb(sub)
        return Promise.resolve()
      }
      return Promise.resolve()
    },
    on(event, handler, options) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push({ handler, options })
      return () => {}
    },
    logger: { info() {}, warn() {}, error(...a) { console.error('[logger]', ...a) } },
    root: {},
  }
  return { ctx, mockLive, agentsById, sessions }
}

// ================= 主流程 =================
const tmp = libDir || mkdtempSync(join(tmpdir(), 'mem-test-'))
const mod = await import(modUrl)
const { ctx, mockLive, agentsById } = makeCtx()
const disposer = await mod.apply(ctx, {})
console.log('[test] apply completed, disposer:', typeof disposer)

let failed = 0
const check = (label, cond) => {
  console.log((cond ? '[ ok ]' : '[FAIL]') + ' ' + label)
  if (!cond) failed++
}

// 生效的 manager 可从工具注册 / settings 注册 / 路由判断
check('settings 注册了 memory-manager 命名空间', settingsRegistered && settingsRegistered.ns === 'memory-manager')
check('注册了 6 个记忆工具', toolNames.length === 6 && toolNames.includes('memory_search') && toolNames.includes('memory_pin'))
check('webServer 精确路由已注册', routes.some((r) => r.kind === 'exact' && r.path === '/_dsh/memory-manager/api'))

// 通过 listener 拿到内部 handler 太难 —— 改为通过 HTTP 路由 handler 走一遍业务层
const handler = routes.find((r) => r.kind === 'exact')
check('路由 handler 存在', !!handler)

// 配置一个临时记忆库，先用 handler 保存一条规约记忆 —— 这要求 cfg.libraryPath 已指向 tmp
// （settings.register 的 base 为空时，libPath 依赖 workspaceRegistry/agents，测试中应走 workspace anchor；
//  由于默认锚点不可控，这里直接通过 state.setLibrary 设置）
let res = null
const post = async (body) => {
  const req = { method: 'POST' }
  const chunks = [Buffer.from(JSON.stringify(body))]
  req[Symbol.asyncIterator] = async function* () { yield* chunks }
  const out = { headers: {}, setHeader(k, v) { this.headers[k] = v }, writeHead: (s) => { out.status = s }, end: (t) => { out.body = t } }
  await handler.handler(req, out)
  return JSON.parse(out.body)
}
const get = async () => {
  const out = { headers: {}, setHeader(k, v) { this.headers[k] = v }, writeHead: (s) => { out.status = s }, end: (t) => { out.body = t } }
  await handler.handler({ method: 'GET' }, out)
  return JSON.parse(out.body)
}

const probe = await get()
check('GET 探测返回 ok', probe && probe.ok === true && probe.service === 'memory-manager')

res = await post({ op: 'state.setLibrary', args: { path: tmp } })
check('state.setLibrary 成功', res && res.ok === true || (res && res.value && res.value.ok === true))

res = await post({ op: 'memory.save', args: { title: '测试规约', impressions: ['规约', '测试'], snapshot: '这是快照内容', notes: '', tags: ['convention'] } })
check('memory.save 成功', res && res.value && res.value.id && res.value.id.startsWith('m_') && res.value.tags.includes('convention'))

const savedId = res.value.id
res = await post({ op: 'memory.read', args: { id: savedId } })
check('memory.read 返回快照', res && res.value && res.value.snapshot === '这是快照内容')

res = await post({ op: 'state.get' })
check('state.get 返回配置与计划', res && res.value && res.value.config && Array.isArray(res.value.plan.memories) && res.value.plan.memories.length >= 1)
check('新会话自动注入发现规约记忆', res.value.plan.memories.some((m) => m.id === savedId))

res = await post({ op: 'library.scan' })
check('library.scan 列出记忆', res && res.value && res.value.memories.length >= 1)

res = await post({ op: 'plan.addMemory', args: { id: savedId }, sessionId: 'session-test-1' })
check('plan.addMemory 成功', res && res.value && res.value.ok === true)

res = await post({ op: 'state.setMode', args: { mode: 'on' } })
check('state.setMode 成功', res && res.value && res.value.mode === 'on')

res = await post({ op: 'sessions.list' })
check('sessions.list 返回工作区结构', res && res.value && Array.isArray(res.value.workspaces))

// ================= agent/pre-step 注入 =================
{
  const entry = (listeners.get('agent/pre-step') || [])[0]
  check('agent/pre-step 监听已注册', !!entry)
  if (entry) {
    let decisionCalled = false
    const next = async () => { decisionCalled = true; return { kind: 'enter', messages: [{ id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] }] } }
    const decision = await entry.handler(
      { agent: { id: 'session-test-1' }, messages: [{ id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] }], turn: 1, step: 1, signal: new AbortController().signal },
      next,
    )
    check('pre-step 委托 next()', decisionCalled)
    check('pre-step 注入记忆库上下文消息', decision && decision.kind === 'enter' && decision.messages.length === 2
      && decision.messages[1].source && decision.messages[1].source.kind === 'plugin'
      && decision.messages[1].source.plugin === 'memory-manager'
      && /记忆库上下文/.test(decision.messages[1].content[0].text))
  }
}

// ================= agent/created 预载 =================
{
  for (const entry of listeners.get('agent/created') || []) {
    entry.handler({ agent: { id: 'session-test-2' } })
  }
  await new Promise((r) => setTimeout(r, 100))
  check('agent/created 预载不抛错', true)
}

await disposer()
console.log('[test] dispose OK')
if (failed) { console.error('[test] FAILED: ' + failed); process.exit(1) }
console.log('[test] ALL PASS')

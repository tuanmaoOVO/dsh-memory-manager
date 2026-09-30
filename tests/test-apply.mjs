// 本地集成测试：mock ctx 调用宿主插件 apply，验证 DSH 0.2.0 的适配路径
//
// 用法：
//   node tests/test-apply.mjs [插件模块路径] [临时记忆库路径]
//
// 依赖解析（DSH 包名为 @deepseek-ai/*，本仓库 node_modules 需可解析）：
//   node_modules/@deepseek-ai/dsh-tools  → DSH 检出的 packages/core/tools
//   node_modules/schemastery            → DSH 检出的 vendor/schemastery（API 兼容 npm schemastery）
// 参见 docs/DEVELOPMENT.md。
//
// 覆盖的 0.2.0 变更点：
//   1) ctx.settings.register(...) 已被移除 → 插件读取 apply() 收到的 volatile Config 引用，
//      写回走 ctx.settings.update(<profile entry id>, patch)；
//   2) loader/volatile-update 通知后进程内 cfg 快照同步；
//   3) MessageSource 不再有通用 'plugin' kind → 注入消息 source.kind === 'memory-manager'
//      且 form:'snapshot' 必须携带 sections；
//   4) 旧版记忆库 config.json 一次性迁移进设置。
import { pathToFileURL } from 'node:url'
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const argPath = process.argv[2]
const libDir = process.argv[3] && join(process.argv[3])
const modUrl = argPath
  ? (argPath.startsWith('file:') ? argPath : pathToFileURL(argPath).href)
  : new URL('../lib/index.js', import.meta.url).href

const listeners = new Map() // event -> [{ handler, options }]
let toolNames = []
let settingsWrites = []      // [{ ns, patch }]
let routes = []
let mockSessions = new Map()
let queryTitles = new Map()
let wsList = []

/** 复刻 DSH 0.2.0 的 volatile Config 引用（@deepseek-ai/cosmokit 的 Volatile<T>：Object.freeze({ get })） */
const volatileSetters = new WeakMap()
function volatileRef(initial) {
  let current = initial
  const ref = Object.freeze({ get: () => current })
  volatileSetters.set(ref, (v) => { current = v })
  return ref
}
const setVolatile = (ref, value) => { volatileSetters.get(ref)(value) }

function makeCtx() {
  // 0.2.0：设置不再由插件注册；SettingsForms 只提供 describe/update/replace/mutate，
  // 表单的 ns 就是 profile 条目 id（cordis.patch.yml 里的 `- id: memory-manager`）。
  const settingsService = {
    async update(ns, patch) { settingsWrites.push({ ns, patch }); return undefined },
    describe: () => [],
    configure: () => () => {},
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
    listSessions: async () => [],
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
    // 0.2.0：设置写入需要 profile 条目 id；内核把它挂在 ctx.fiber.entry.options.id 上
    fiber: { entry: { options: { id: 'memory-manager' } } },
    root: {},
  }
  return { ctx, mockLive, agentsById, sessions }
}

// ================= 主流程 =================
const tmp = libDir || mkdtempSync(join(tmpdir(), 'mem-test-'))
const mod = await import(modUrl)

// 0.2.0 的 Config 输出：volatile 字段是 { get() } 引用对象
const liveConfig = {
  enabled: volatileRef(true),
  mode: volatileRef('off'),
  view: volatileRef('full'),
  modelTools: volatileRef(true),
  libraryPath: volatileRef(''),
  memoryChars: volatileRef(6000),
  totalChars: volatileRef(12000),
  pinChars: volatileRef(6000),
  autoInjectConvention: volatileRef(true),
}

const { ctx, mockLive, agentsById } = makeCtx()
const disposer = await mod.apply(ctx, liveConfig)
console.log('[test] apply completed, disposer:', typeof disposer)

let failed = 0
const check = (label, cond, detail = '') => {
  console.log((cond ? '[ ok ]' : '[FAIL]') + ' ' + label + (cond || !detail ? '' : '  — ' + detail))
  if (!cond) failed++
}

check('Config 导出为 schemastery schema（可调用 + 可 toJSON）',
  Boolean(mod.Config) && (typeof mod.Config === 'function' || typeof mod.Config === 'object')
  && typeof mod.Config.toJSON === 'function')
check('inject 不再硬依赖 settings（0.2.0 起无 register）', Array.isArray(mod.inject) && !mod.inject.includes('settings'))
check('注册了 6 个记忆工具', toolNames.length === 6 && toolNames.includes('memory_search') && toolNames.includes('memory_pin'))
check('webServer 精确路由已注册', routes.some((r) => r.kind === 'exact' && r.path === '/_dsh/memory-manager/api'))
check('订阅了 loader/volatile-update（0.2.0 的 live 配置变更通知）', (listeners.get('loader/volatile-update') || []).length >= 1)

// 通过 HTTP 路由 handler 走一遍业务层
const handler = routes.find((r) => r.kind === 'exact')
check('路由 handler 存在', !!handler)

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
check('state.setLibrary 成功', res && res.ok === true || (res && res.value && res.value.ok === true), JSON.stringify(res))

res = await post({ op: 'memory.save', args: { title: '测试规约', impressions: ['规约', '测试'], snapshot: '这是快照内容', notes: '', tags: ['convention'] } })
check('memory.save 成功', res && res.value && res.value.id && res.value.id.startsWith('m_') && res.value.tags.includes('convention'), JSON.stringify(res))

const savedId = res.value && res.value.id
res = await post({ op: 'memory.read', args: { id: savedId } })
check('memory.read 返回快照', res && res.value && res.value.snapshot === '这是快照内容', JSON.stringify(res))

res = await post({ op: 'state.get' })
check('state.get 返回配置与计划', res && res.value && res.value.config && Array.isArray(res.value.plan.memories) && res.value.plan.memories.length >= 1, JSON.stringify(res))
check('新会话自动注入发现规约记忆', Boolean(res.value && res.value.plan && res.value.plan.memories.some((m) => m.id === savedId)))

res = await post({ op: 'library.scan' })
check('library.scan 列出记忆', res && res.value && res.value.memories.length >= 1, JSON.stringify(res))

res = await post({ op: 'plan.addMemory', args: { id: savedId }, sessionId: 'session-test-1' })
check('plan.addMemory 成功', res && res.value && res.value.ok === true, JSON.stringify(res))

res = await post({ op: 'state.setMode', args: { mode: 'on' } })
check('state.setMode 成功', res && res.value && res.value.mode === 'on', JSON.stringify(res))

// ================= 0.2.0 设置写回：profile 条目 id + patch =================
{
  const write = settingsWrites.find((w) => w && w.patch && w.patch.mode === 'on')
  check('settings.update 使用 profile 条目 id 作为 namespace', Boolean(write) && write.ns === 'memory-manager', JSON.stringify(settingsWrites))
  const libWrite = settingsWrites.find((w) => w && w.patch && typeof w.patch.libraryPath === 'string')
  check('settings.update 落盘 libraryPath', Boolean(libWrite) && libWrite.patch.libraryPath.length > 0, JSON.stringify(libWrite))
}

// ================= volatile 配置热更新（loader/volatile-update） =================
{
  setVolatile(liveConfig.mode, 'off')
  for (const entry of listeners.get('loader/volatile-update') || []) entry.handler([])
  res = await post({ op: 'state.get' })
  check('volatile-update 后 cfg 快照同步（mode 回到 off）', res && res.value && res.value.config.mode === 'off', JSON.stringify(res && res.value && res.value.config))
  setVolatile(liveConfig.mode, 'on')
  for (const entry of listeners.get('loader/volatile-update') || []) entry.handler([])
}

res = await post({ op: 'sessions.list' })
check('sessions.list 返回工作区结构', res && res.value && Array.isArray(res.value.workspaces))

// ================= agent/pre-step 注入 =================
{
  const entry = (listeners.get('agent/pre-step') || [])[0]
  check('agent/pre-step 监听已注册', !!entry)
  check('agent/pre-step 监听使用 prepend', Boolean(entry && entry.options && entry.options.prepend === true))
  if (entry) {
    let decisionCalled = false
    const next = async () => { decisionCalled = true; return { kind: 'enter', messages: [{ id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] }] } }
    const decision = await entry.handler(
      { agent: { id: 'session-test-1' }, messages: [{ id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] }], turn: 1, step: 1, signal: new AbortController().signal },
      next,
    )
    check('pre-step 委托 next()', decisionCalled)
    const injected = decision && decision.messages && decision.messages[1]
    check('pre-step 注入记忆库上下文消息', Boolean(injected) && /记忆库上下文/.test(injected.content[0].text))
    check('0.2.0：注入消息 source.kind 用插件自己的标识（不再有通用 plugin kind）',
      Boolean(injected) && injected.source && injected.source.kind === 'memory-manager', injected && JSON.stringify(injected.source))
    check('0.2.0：form:snapshot 必须携带 sections',
      Boolean(injected) && injected.source.form === 'snapshot' && Array.isArray(injected.source.sections)
      && injected.source.sections[0] && injected.source.sections[0].name === 'memory-manager:context')
  }
  // 非用户触发的 step（工具结果 step）不注入
  if (entry) {
    const decisions = await entry.handler(
      { agent: { id: 'session-test-1' }, messages: [], turn: 1, step: 2, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [] }),
    )
    check('工具结果 step 不注入', decisions && decisions.messages.length === 0)
  }
}

// ================= agent/created 预载 =================
{
  const entries = listeners.get('agent/created') || []
  check('agent/created 监听使用 global:true', entries.length >= 1 && entries.every((e) => e.options && e.options.global === true))
  for (const entry of entries) {
    entry.handler({ agent: { id: 'session-test-2' }, source: 'startup' })
  }
  await new Promise((r) => setTimeout(r, 100))
  check('agent/created 预载不抛错', true)
}

// ================= 旧版 config.json 一次性迁移 =================
{
  await post({ op: 'state.setLibrary', args: { path: join(tmp, 'legacy') } })
  const legacyDir = join(tmp, 'legacy')
  mkdirSync(legacyDir, { recursive: true })
  writeFileSync(join(legacyDir, 'config.json'), JSON.stringify({ view: 'compact', pinChars: 1234, mode: 'on' }))
  settingsWrites.length = 0
  const imported = await mod.importLegacyConfigFor({
    cfg: { enabled: true },
    libPath: () => legacyDir,
    norm: (p) => String(p).replace(/[\\/]+$/, ''),
    settingsUpdate: async (patch) => { settingsWrites.push({ ns: 'memory-manager', patch }); return { ok: true } },
    log: () => {},
  })
  check('旧版 config.json 迁移进设置（view / pinChars / mode）',
    imported === true && settingsWrites.length === 1
    && settingsWrites[0].patch.view === 'compact' && settingsWrites[0].patch.pinChars === 1234 && settingsWrites[0].patch.mode === 'on',
    JSON.stringify(settingsWrites))
  const marker = existsSync(join(legacyDir, 'pinned', '.config-imported'))
  check('迁移后写入一次性标记', marker)
  settingsWrites.length = 0
  const again = await mod.importLegacyConfigFor({
    cfg: { enabled: true },
    libPath: () => legacyDir,
    norm: (p) => String(p).replace(/[\\/]+$/, ''),
    settingsUpdate: async (patch) => { settingsWrites.push({ ns: 'memory-manager', patch }); return { ok: true } },
    log: () => {},
  })
  check('迁移幂等（第二次不重复导入）', again === false && settingsWrites.length === 0)
}

await disposer()
console.log('[test] dispose OK')
if (failed) { console.error('[test] FAILED: ' + failed); process.exit(1) }
console.log('[test] ALL PASS')

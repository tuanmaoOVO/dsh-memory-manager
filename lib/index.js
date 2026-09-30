// @dsh-external/dsh-memory-manager — 记忆管理插件（宿主级，标准 Cordis 插件）
//
// 设计原则（跨版本适配 / 官方升级影响面最小化）：
//  - 只依赖 DSH 最稳定的核心扩展点：Config(.volatile) / ctx.settings.update / tools.register /
//    ctx.on('agent/pre-step') / ctx.on('agent/created') / ctx.inject(['webServer']) —— 全部经
//    ctx.get 可选探测，缺失即降级。
//  - 记忆库 / 注入计划 / 轮次排除 / 会话总结 / 图谱数据均自实现（node:fs 直接读写），
//    不依赖任何官方插件包（session-title-llm、session-query-sqlite、storage 等一律不依赖）。
//  - 会话读取优先 live Session，只读回退 ctx.sessionQuery；两者皆缺失时相关功能降级报错。
//
// 0.2.0 迁移要点（相对 0.1.x）：
//  - `ctx.settings.register(ns, Config, opts)` 已被移除：0.2.0 的设置页直接投影「插件导出的
//    Config schema 中标记 .volatile() 的字段」，运行中的插件读取 apply() 收到的 config 引用本身
//    （volatile 字段是 `{ get() }` 引用对象，内核就地更新并派发 loader/volatile-update）。
//    写回改为 `ctx.settings.update(<profile entry id>, patch)`。
//  - `MessageSource` 不再有通用 `'plugin'` kind（每个生产者声明自己的 kind），本插件使用
//    `kind: 'memory-manager'`；历史会话里 0.1.x 写入的 `{kind:'plugin', plugin:'memory-manager'}`
//    仍被识别（见 lib/util.js 的 isOwnSource）。
//  - `Session.append` 对可上表面的事件强制要求 surfaceOp；位置替换只接受 `{op,startSeq,endSeq}`。
//
// 实现分层：
//  - lib/util.js      通用工具 + 消息来源/volatile 配置读取（零 DSH 依赖）
//  - lib/memory.js    记忆库（文件层）
//  - lib/plan.js      注入计划 / 自动注入 / 注入渲染
//  - lib/sessions.js  会话读取 / 轮次构建 / 排除恢复 / 会话列表
//  - lib/llm.js       LLM 辅助（印象建议 / 智能合并 / 会话总结）
//  - lib/tools.js     6 个 Agent 记忆工具
//  - lib/api.js       HTTP API（webServer 兼容通道 + connection.rpc 标准通道）
//  - lib/index.js     插件装配（本文件）

import {
  readJson, writeText, logLine, logClientLine, logError, norm, clamp, textOf, preview,
  sanitizeImpressions, sanitizeIds, rand, readConfigValue, PLUGIN_KIND,
} from './util.js'
import { installMemory } from './memory.js'
import { installPlan } from './plan.js'
import { installSessions } from './sessions.js'
import { installLlm } from './llm.js'
import { installTools } from './tools.js'
import { installApi, API_PATH, RPC_ENDPOINT_PREFIX } from './api.js'

export const name = '@dsh-external/dsh-memory-manager'
// 硬依赖：`tools` 是工具注册面（core 组合必装）。`settings` 不再硬依赖——
// 0.2.0 起设置写入是懒调用（ctx.settings.update），缺失时退化为进程内配置。
export const inject = ['tools']

const NS = 'memory-manager'
const PLUGIN_TAG = 'memory-manager'
const CONFIG_FILE = 'config.json'
/** 旧版 config.json 一次性迁移标记（写入记忆库 pinned/ 下） */
const LEGACY_IMPORT_MARKER = 'pinned/.config-imported'

/**
 * 解析 schemastery 实现。
 *
 * 0.2.0 起设置表单要求字段带 `meta.volatile`（.volatile()），并且内核按
 * `Symbol.for('cosmokit.volatile.write')` 识别 volatile 引用；DSH 自己的
 * schemastery 是 `@deepseek-ai/schemastery`（vendor/schemastery，npm 同名发布）。
 * 这里优先取它，其次退回旧的裸 `schemastery`（无 .volatile()，此时降级为
 * 「无设置表单」而不是加载失败）。两者都不可用时 `Config` 为 undefined，
 * 内核 `resolveConfig` 会原样透传 profile 里的 config。
 * @returns schemastery 命名空间，或 null
 */
async function loadSchemastery() {
  for (const id of ['@deepseek-ai/schemastery', 'schemastery']) {
    try {
      const mod = await import(id)
      const candidate = mod && mod.default ? mod.default : mod
      if (candidate && typeof candidate.object === 'function' && typeof candidate.boolean === 'function') {
        logLine('schemastery: 使用 ' + id)
        return candidate
      }
    } catch { /* 试下一个 */ }
  }
  logLine('schemastery: 不可用 —— Config 不导出，设置页不可用（插件其余能力正常）')
  return null
}

const z = await loadSchemastery()

/**
 * 配置默认值。0.2.0 起字段一律以 `.volatile()` 声明：设置页据此投影表单，
 * 内核在配置变更时就地更新 volatile 引用并派发 `loader/volatile-update`，
 * 无需重挂插件。
 */
const CFG_DEFAULTS = {
  enabled: true,
  mode: 'off',
  view: 'full',
  modelTools: true,
  libraryPath: '',
  memoryChars: 6000,
  totalChars: 12000,
  pinChars: 6000,
  autoInjectConvention: true,
}
const CFG_KEYS = Object.keys(CFG_DEFAULTS)

/** 有 .volatile() 就标记，没有就原样返回（旧 schemastery 下的降级路径）。 */
const vol = (schema) => (typeof schema.volatile === 'function' ? schema.volatile() : schema)

export const Config = z ? z.object({
  enabled: vol(z.boolean().default(true)),
  mode: vol(z.union(['on', 'off']).default('off')),
  view: vol(z.union(['full', 'compact']).default('full')),
  modelTools: vol(z.boolean().default(true)),
  libraryPath: vol(z.string().default('')),
  memoryChars: vol(z.number().default(6000)),
  totalChars: vol(z.number().default(12000)),
  pinChars: vol(z.number().default(6000)),
  // 新会话自动注入开关：开启后新会话默认常驻启用中的规约记忆（tags 含 convention）与
  // 最近 8 条会话总结记忆（tags 含 会话总结）；旧会话不自动注入，可手动加入
  autoInjectConvention: vol(z.boolean().default(true)),
}) : undefined

export async function apply(ctx, config = {}) {
  logLine('apply() called')
  const logger = ctx.logger ?? { info() {}, warn() {}, error(...a) { console.error(...a) } }
  const disposers = []
  // ================= 共享状态（manager） =================
  const m = {
    ctx, logger, config,
    // cfg 是进程内配置快照：初值来自 Config 解析结果（volatile 引用解包），
    // 之后由 loader/volatile-update 与本地写入同步。所有模块读 m.cfg.<field>。
    cfg: { ...CFG_DEFAULTS },
    cfgSource: (config && typeof config === 'object') ? config : {},
    settingsService: null, settingsNamespace: null,
    planCache: new Map(),
    excludedCache: new Map(),
    memoryIndex: new Map(),
    backlinkIndex: new Map(),
    onceCacheList: null,
    pluginTag: PLUGIN_TAG,
    pluginKind: PLUGIN_KIND,
    apiPath: API_PATH,
    rpcEndpointPrefix: RPC_ENDPOINT_PREFIX,
    // 工具函数（挂到 m 上供各模块使用）
    log: logLine, logClientLine, logError, logger,
    norm, clamp, textOf, preview, sanitizeImpressions, sanitizeIds,
  }

  try {
    return await install(ctx, m, config, disposers)
  } catch (error) {
    logError(error)
    logger.error('dsh-memory-manager: install failed — %s', error instanceof Error ? error.message : String(error))
    for (const dispose of disposers.reverse()) { try { dispose() } catch { /* ignore */ } }
    return () => { /* nothing mounted */ }
  }
}

async function install(ctx, m, config, disposers) {
  m.log('install() begin dsh>=0.2 (volatile Config)')

  // ================= 能力安装（顺序无关；方法均为懒调用） =================
  installMemory(m)
  installPlan(m)
  installSessions(m)
  installLlm(m)

  // ================= 配置（0.2.0：Config + volatile + ctx.settings.update） =================
  // 与 0.1.x 的差别：不再有 settings.register(ns, Config, {applies:'live'})。
  //  - 读：apply() 收到的 config 引用，volatile 字段是 { get() } 引用对象（内核就地更新）。
  //  - 写：ctx.settings.update(<profile entry id>, patch)，落盘到 profile 的 cordis.patch.yml。
  m.syncCfg = () => {
    for (const key of CFG_KEYS) {
      const value = readConfigValue(m.cfgSource, key)
      if (value !== undefined) m.cfg[key] = value
    }
    return m.cfg
  }
  m.syncCfg()
  m.log('config snapshot: ' + JSON.stringify(m.cfg))

  // profile 条目 id：设置服务的 namespace 就是该 id（cordis.patch.yml 里 `- id: memory-manager`）。
  // 取不到时回退到插件固定 id（与包内 cordis.patch.yml 保持一致）。
  const fiberEntryId = ctx.fiber && ctx.fiber.entry && ctx.fiber.entry.options
    ? ctx.fiber.entry.options.id
    : undefined
  m.settingsNamespace = typeof fiberEntryId === 'string' && fiberEntryId ? fiberEntryId : NS
  m.settingsService = ctx.get('settings') ?? ctx.get('settings', false)
  m.log('settings service: ' + (m.settingsService ? 'ok' : 'unavailable') + ' ns=' + m.settingsNamespace)

  // 本插件自带设置页（客户端 `settings.section` 插槽），因此关闭 0.2.0 的
  // 自动生成表单，避免同一组字段在设置页出现两份。
  // 官方写法：在可选 `ctx.inject(['settings'], …)` 子作用域里绑定到本插件 fiber，
  // 使设置服务晚到/被替换时策略仍能生效，而插件本身不因缺少 settings 而不加载。
  try {
    const injected = ctx.inject(['settings'], (settingsCtx) => {
      settingsCtx.effect(() => {
        try {
          settingsCtx.settings.configure({ auto: false }, ctx.fiber)
        } catch (error) {
          // 同一 fiber 重复 configure 会抛；重复运行（设置服务被替换后重新注入）时忽略即可
          m.log('settings.configure ignored: ' + String((error && error.message) || error))
        }
      }, 'memory-manager: settings page policy')
    })
    if (injected && typeof injected.then === 'function') Promise.resolve(injected).catch(() => {})
  } catch (error) {
    m.log('settings.configure skipped: ' + String((error && error.message) || error))
  }

  // 内核把 volatile 变更就地在 config 引用上提交，并向插件 fiber 派发 loader/volatile-update。
  // 这里只需把新值同步进 m.cfg 快照。
  try {
    disposers.push(ctx.on('loader/volatile-update', () => {
      const before = JSON.stringify(m.cfg)
      m.syncCfg()
      const after = JSON.stringify(m.cfg)
      if (before !== after) m.log('config updated by settings: ' + after)
    }))
  } catch (error) {
    m.log('loader/volatile-update subscribe skipped: ' + String((error && error.message) || error))
  }

  // 配置写入：先乐观更新进程内快照（UI 立即可见），再落盘到 profile；
  // 内核随后把权威值就地提交到 volatile 引用上并派发 loader/volatile-update，
  // 由上面的监听器把快照同步回权威值。
  //
  // 刻意**不在** settings.update 成功后立即 syncCfg()：落盘 → 重组 → 提交 volatile 是
  // 异步链路，立刻回读会把乐观值覆盖成尚未更新的旧值（旧版 config.json 迁移、设置页
  // 开关都会因此失效）。写失败时才用权威配置回滚。
  m.settingsUpdate = async (patch) => {
    try {
      Object.assign(m.cfg, patch)
      // 优先实时查找：settings 可能晚于本插件出现，或在本插件运行期间被替换
      const settings = (ctx.get('settings') ?? ctx.get('settings', false)) ?? m.settingsService
      if (settings && typeof settings.update === 'function' && m.settingsNamespace) {
        await settings.update(m.settingsNamespace, patch)
        return { ok: true, persisted: true }
      }
      m.log('settings.update unavailable — 配置仅作用于本进程')
      return { ok: true, persisted: false }
    } catch (error) {
      // 写被拒绝：以权威配置（volatile 引用当前值）回滚乐观改动
      try { m.syncCfg() } catch { /* ignore */ }
      m.logError(error)
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }

  // ================= Agent 记忆工具（自实现 6 工具；官方 defineTool 不可用时内置兜底） =================
  const toolDisposers = await installTools(m)
  disposers.push(...toolDisposers)

  // ================= HTTP API（webServer 路由 + connection.rpc 标准通道） =================
  disposers.push(...installApi(m))

  // ================= 注入段（agent/pre-step 消息注入） =================
  // 经 agent/pre-step 在请求消息末尾追加一条 form=snapshot 的 user 消息，随本次请求发送：
  //  - 不依赖 systemPrompt：极简模式（persona complete:true）会丢弃所有 sections
  //  - 不依赖 runtime context：不受 includeRuntimeContext 门控
  //  - 0.2.0 起 source.kind 必须声明生产者自己的标识（官方 time-context 即 kind:'time-context'），
  //    通用 'plugin' kind 已不存在；form:'snapshot' 仍要求携带 sections。
  //  - 注入与「用户发送」绑定：仅当本次请求由用户消息（source.kind==='user'）触发时注入一次
  disposers.push(ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (!decision || decision.kind === 'reject') return decision
    try {
      // 仅用户消息触发的请求注入（工具结果 step、steer 注入等不含 source.kind==='user'）
      const hasUserMsg = Array.isArray(payload.messages) && payload.messages.some((msg) => msg && msg.source && msg.source.kind === 'user')
      if (!hasUserMsg) return decision
      const agent = payload && payload.agent
      const sessionId = agent && agent.id ? String(agent.id) : null
      if (!sessionId) return decision
      // 计划与记忆索引是懒加载的；首个请求可能早于它们完成，先补齐再渲染，
      // 否则第一次注入会静默落空（两者都带缓存，命中后 O(1)）。
      await m.ensureInjectionReady(sessionId)
      const text = m.renderContextFor(sessionId)
      if (!text) return decision
      // 注入成功后才消费一次性状态（once 队列 / 仅本次发送注入）
      m.consumeInjectState()
      m.log('injectOnce consumed: session=' + sessionId + ' chars=' + text.length)
      const baseMessages = Array.isArray(decision.messages) ? decision.messages : payload.messages
      return {
        ...decision,
        messages: [...baseMessages, {
          content: [{ type: 'text', text }],
          source: {
            kind: PLUGIN_KIND,
            form: 'snapshot',
            sections: [{ name: 'memory-manager:context', text }],
          },
          role: 'user',
          id: 'mem-ctx-' + rand(12),
        }],
      }
    } catch { return decision }
  }, { prepend: true }))

  // ================= 预载计划（agent/created + 启动时存量 agent） =================
  const agentsSvc = ctx.get('agents') ?? ctx.get('agents', false)
  if (agentsSvc !== undefined && typeof ctx.on === 'function') {
    // global:true 让根组合监听器收到 scope 过滤后的 agent 事件（见 @deepseek-ai/dsh-scope）
    disposers.push(ctx.on('agent/created', (payload) => {
      m.log('agent/created observed: ' + (payload && payload.agent && payload.agent.id))
      if (payload && payload.agent && payload.agent.id) {
        // 全局计划首次创建时自动注入规约记忆/会话总结（幂等：planCache 已有则跳过）
        m.loadPlan().then(() => {
          m.log('loadPlan done global memories=' + (m.planCache.get('global') && m.planCache.get('global').memories ? m.planCache.get('global').memories.length : '?'))
        }).catch((e) => { m.log('loadPlan failed: ' + String(e && e.message || e)) })
        m.preloadSession(String(payload.agent.id)).catch(() => {})
      }
    }, { global: true }))
    try {
      const list = agentsSvc.list ? agentsSvc.list() : []
      for (const ag of list) {
        if (!ag || !ag.id) continue
        m.loadPlan().catch(() => {})
        m.preloadSession(String(ag.id)).catch(() => {})
      }
    } catch { /* ignore */ }
  }

  // 启动即扫描记忆库（尽力而为），随后做一次旧版 config.json 的一次性迁移
  m.importLegacyConfig = () => importLegacyConfigFor(m)
  m.scanLibrary()
    .then(() => m.importLegacyConfig())
    .catch(() => {})

  m.log('install() complete: api=' + m.apiPath + ' rpcPrefix=' + m.rpcEndpointPrefix)
  return () => {
    for (const dispose of disposers.reverse()) {
      try { dispose() } catch { /* ignore */ }
    }
  }
}

/**
 * 旧版 `config.json` 的一次性迁移。
 *
 * 0.1.x 把 mode / view / modelTools / libraryPath / caps 等写在**记忆库目录**下的
 * `config.json`；0.2.0 起这些字段由 profile 的 `cordis.patch.yml` 承载（设置页写入）。
 * 为了让升级用户不丢配置，这里把旧文件里的已知字段**一次性**写回 profile，
 * 然后落一个标记文件避免重复导入。
 * @param m - manager 共享状态
 * @returns 是否发生过导入
 */
export async function importLegacyConfigFor(m) {
  try {
    if (!m.cfg.enabled) return false
    const dir = m.libPath()
    if (!dir) return false
    const marker = dir + '/' + LEGACY_IMPORT_MARKER
    if (await readJson(marker) !== null) return false
    const legacy = await readJson(dir + '/' + CONFIG_FILE)
    if (!legacy || typeof legacy !== 'object') return false
    const patch = {}
    for (const key of ['mode', 'view', 'modelTools', 'libraryPath', 'memoryChars', 'totalChars', 'pinChars']) {
      const value = legacy[key]
      if (value === undefined) continue
      if (key === 'mode') patch.mode = value === 'on' ? 'on' : 'off'
      else if (key === 'view') patch.view = value === 'compact' ? 'compact' : 'full'
      else if (key === 'modelTools') patch.modelTools = value === true
      else if (key === 'libraryPath') patch.libraryPath = typeof value === 'string' ? m.norm(value) || '' : ''
      else if (typeof value === 'number' && Number.isFinite(value)) patch[key] = value
    }
    if (!Object.keys(patch).length) {
      await writeText(marker, JSON.stringify({ imported: false, at: Date.now() }))
      return false
    }
    const result = await m.settingsUpdate(patch)
    if (result && result.error) {
      m.log('legacy config.json import failed: ' + result.error)
      return false
    }
    await writeText(marker, JSON.stringify({ imported: true, at: Date.now(), patch }))
    m.log('legacy config.json imported into settings: ' + JSON.stringify(patch))
    return true
  } catch (error) {
    m.log('legacy config.json import skipped: ' + String((error && error.message) || error))
    return false
  }
}

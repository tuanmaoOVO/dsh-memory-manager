// @dsh-external/dsh-memory-manager — 记忆管理插件（宿主级，标准 Cordis 插件）
//
// 设计原则（跨版本适配 / 官方升级影响面最小化）：
//  - 只依赖 DSH 最稳定的核心扩展点：settings.register / tools.register / ctx.on('agent/pre-step') /
//    ctx.on('agent/created') / ctx.inject(['webServer']) —— 全部经 ctx.get 可选探测，缺失即降级。
//  - 记忆库 / 注入计划 / 轮次排除 / 会话总结 / 图谱数据均自实现（node:fs 直接读写），
//    不依赖任何官方插件包（session-title-llm、session-query-sqlite、storage 等一律不依赖）。
//  - 会话读取优先 live Session，只读回退 ctx.sessionQuery；两者皆缺失时相关功能降级报错。
//
// 实现分层：
//  - lib/util.js      通用工具（零 DSH 依赖）
//  - lib/memory.js    记忆库（文件层）
//  - lib/plan.js      注入计划 / 自动注入 / 注入渲染
//  - lib/sessions.js  会话读取 / 轮次构建 / 排除恢复 / 会话列表
//  - lib/llm.js       LLM 辅助（印象建议 / 智能合并 / 会话总结）
//  - lib/tools.js     6 个 Agent 记忆工具
//  - lib/api.js       HTTP API（webServer 兼容通道 + connection.rpc 标准通道）
//  - lib/index.js     插件装配（本文件）

import z from 'schemastery'
import { readJson, logLine, logClientLine, logError, norm, clamp, textOf, preview, sanitizeImpressions, sanitizeIds, rand } from './util.js'
import { installMemory } from './memory.js'
import { installPlan } from './plan.js'
import { installSessions } from './sessions.js'
import { installLlm } from './llm.js'
import { installTools } from './tools.js'
import { installApi, API_PATH, RPC_ENDPOINT_PREFIX } from './api.js'

export const name = '@dsh-external/dsh-memory-manager'
// 硬依赖（dsh-base 的 root 级服务）；其余服务一律 ctx.get 可选读取
export const inject = ['settings', 'tools']

const NS = 'memory-manager'
const PLUGIN_TAG = 'memory-manager'
const CONFIG_FILE = 'config.json'

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
  // 最近 8 条会话总结记忆（tags 含 会话总结）；旧会话不自动注入，可手动加入
  autoInjectConvention: z.boolean().default(true),
})

export async function apply(ctx, config = {}) {
  logLine('apply() called')
  const logger = ctx.logger ?? { info() {}, warn() {}, error(...a) { console.error(...a) } }
  const disposers = []
  // ================= 共享状态（manager） =================
  const m = {
    ctx, logger, config,
    cfg: {
      enabled: true, mode: 'off', view: 'full', modelTools: true,
      libraryPath: '', memoryChars: 6000, totalChars: 12000, pinChars: 6000,
      autoInjectConvention: true,
    },
    settingsScope: null, settingsService: null,
    planCache: new Map(),
    excludedCache: new Map(),
    memoryIndex: new Map(),
    backlinkIndex: new Map(),
    onceCacheList: null,
    pluginTag: PLUGIN_TAG,
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
  m.log('install() begin')

  // ================= 能力安装（顺序无关；方法均为懒调用） =================
  installMemory(m)
  installPlan(m)
  installSessions(m)
  installLlm(m)

  // ================= Settings（含总开关，live 应用） =================
  m.settingsService = m.ctx.get('settings') ?? m.ctx.get('settings', false)
  if (m.settingsService && typeof m.settingsService.register === 'function') {
    let base = { ...config }
    // 迁移旧版 config.json（首次运行，位于默认记忆库锚点下）
    try {
      const anchor = norm(m.defaultLibraryPath())
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
      m.settingsScope = m.settingsService.register(NS, Config, {
        base,
        applies: 'live',
        validate: (value) => {
          if (typeof value.libraryPath === 'string' && value.libraryPath.length > 0 && value.libraryPath.length > 4096) {
            throw new Error('libraryPath 过长')
          }
        },
      })
      m.log('settings registered')
      disposers.push(() => { try { m.settingsScope?.dispose?.() } catch { /* ignore */ } })
      Object.assign(m.cfg, m.settingsScope.get())
      m.log('settings snapshot: ' + JSON.stringify(m.cfg))
      disposers.push(m.settingsScope.watch((next) => {
        Object.assign(m.cfg, next)
      }))
    } catch (error) {
      logError(error)
      m.logger.warn('dsh-memory-manager: settings register failed — %s', error instanceof Error ? error.message : String(error))
      Object.assign(m.cfg, config)
    }
  } else {
    m.log('settings service unavailable — 使用内存配置')
    Object.assign(m.cfg, config)
  }
  m.settingsUpdate = async (patch) => {
    try {
      Object.assign(m.cfg, patch)
      if (m.settingsScope && typeof m.settingsScope.update === 'function') {
        await m.settingsScope.update(patch)
      } else if (m.settingsService && typeof m.settingsService.update === 'function') {
        await m.settingsService.update(NS, patch)
      }
      return { ok: true }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }

  // ================= Agent 记忆工具（自实现 6 工具；官方 defineTool 不可用时内置兜底） =================
  const toolDisposers = await installTools(m)
  disposers.push(...toolDisposers)

  // ================= HTTP API（webServer 路由 + connection.rpc 标准通道） =================
  disposers.push(...installApi(m))

  // ================= 注入段（agent/pre-step 消息注入） =================
  // 经 agent/pre-step 在请求消息末尾追加一条 form=snapshot 的 plugin 消息，随本次请求发送：
  //  - 不依赖 systemPrompt.section：极简模式（persona complete:true）会丢弃所有其他 sections
  //  - 不依赖 runtime context：不受 includeRuntimeContext:false 门控
  //  - form='snapshot' 让 UI 折叠显示（同 time-context），模型可见、不污染对话流
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
            kind: 'plugin',
            plugin: PLUGIN_TAG,
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

  // 启动即扫描记忆库（尽力而为）
  m.scanLibrary().catch(() => {})

  m.log('install() complete: api=' + m.apiPath + ' rpcPrefix=' + m.rpcEndpointPrefix)
  return () => {
    for (const dispose of disposers.reverse()) {
      try { dispose() } catch { /* ignore */ }
    }
  }
}

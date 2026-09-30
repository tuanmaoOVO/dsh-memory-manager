// @dsh-external/dsh-memory-manager — 6 个 Agent 记忆工具（完全自实现，不依赖官方工具包）
// 通过 ctx.tools.register 注册到 DSH 工具注册表（scope 由宿主按 agent 组合分摊）。
// 工具定义经官方 @deepseek-ai/dsh-tools 的 defineTool 生成（保持 JSON-Schema 参数受校验）；
// 若 DSH 移除/改名该导出，则回退到本包内置的等价实现（参数 JSON-Schema 形状一致），
// 官方升级不阻断本插件的工具注册。
//
// 0.2.0 核对（packages/core/tools）：
//  - `ctx.tools.register(definition: ToolDefinition): () => void` 未变；
//  - `defineTool({ name, description, parameters, output, execute, isConcurrencySafe })` 仍在
//    （packages/core/tools/src/schema.ts 的 defineTool），参数 DSL 仍是
//    `{ key: { type, required?: true, description? } }` 的隐式开放对象根；
//  - `output` 现在是**必需**的规范输出声明：`{ schema: JsonSchemaNode, render(args, value): ContentBlock[] }`，
//    其中 `{ type: 'json' }` 作为 ValueSchemaSpec 仍是合法的「任意 JSON」声明（编译为空 schema）；
//  - `execute(args, exec: ToolRunContext)` 的 `exec` 继承 `ToolExecutionInput`，
//    `exec.agent` 即当前会话的 Agent（其 `id` 就是 session id）。
// 行为受 enabled / modelTools 双重门控；memory_save / session_inject / memory_pin 需能确定当前会话。

import { rand, sanitizeImpressions } from './util.js'

/**
 * 内置 defineTool 等价实现（官方 API 不可用时兜底；产出形状与 0.2.0 的 ToolDefinition 一致）。
 *
 * 导出它是为了让回归测试能把这个兜底形状直接喂给真实内核的
 * `ctx.tools.register()`（见 tests/test-tools-020.mjs），
 * 从而覆盖「官方 @deepseek-ai/dsh-tools 不可用」时的降级路径。
 * @param options - 与官方 defineTool 相同的选项形状
 * @returns 一个符合 0.2.0 `ToolDefinition` 契约的工具定义
 */
export function defineToolLocal(options) {
  const properties = {}
  const required = []
  for (const [key, spec] of Object.entries(options.parameters || {})) {
    const { required: isRequired, ...rest } = spec
    properties[key] = { ...rest }
    if (isRequired === true) required.push(key)
  }
  const parameters = {
    type: 'object',
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  }
  return {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      // 官方 `{ type: 'json' }`（ValueSchemaSpec）编译为空 schema（任意 JSON）；render 原样呈现
      schema: options.output && options.output.schema ? {} : {},
      render: options.output ? options.output.render : (_a, v) => [{ type: 'text', text: JSON.stringify(v) }],
    },
    ...(options.isConcurrencySafe ? { isConcurrencySafe: options.isConcurrencySafe } : {}),
    execute: async (args, exec) => options.execute(args, exec),
  }
}

/**
 * 在 manager 对象上安装工具注册能力（await 完成后生效）。
 * @param m - 共享状态 { ctx, cfg, memoryIndex, log, ... }（见 lib/index.js）
 * @returns 工具注册 disposers 数组
 */
export async function installTools(m) {
  // 优先官方 defineTool；失败时回退内置等价实现（不阻断插件启动）
  let defineTool = null
  try {
    const mod = await import('@deepseek-ai/dsh-tools')
    defineTool = (mod && typeof mod.defineTool === 'function') ? mod.defineTool : null
  } catch { defineTool = null }
  if (defineTool) {
    m.log('tools: 使用官方 @deepseek-ai/dsh-tools defineTool')
  } else {
    m.log('tools: @deepseek-ai/dsh-tools 不可用 —— 使用内置 defineTool 等价实现')
    defineTool = defineToolLocal
  }

  const gate = () => {
    if (!m.cfg.enabled) return '记忆管理已禁用（设置 → 记忆管理 中开启）'
    if (!m.cfg.modelTools) return '模型记忆工具未开启（设置中可开启）'
    return null
  }
  const sessionIdOf = (exec) => (exec && exec.agent && exec.agent.id ? String(exec.agent.id) : null)

  const tools = [
    defineTool({
      name: 'memory_search',
      description: '搜索记忆库：按关键词匹配记忆的标题、印象与正文，返回匹配记忆的 id、标题、印象与预览。',
      parameters: {
        query: { type: 'string', required: true, description: '关键词' },
      },
      output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }] },
      isConcurrencySafe: () => true,
      async execute(args) {
        const blocked = gate()
        if (blocked) return { error: blocked }
        const q = String((args && args.query) || '').trim().toLowerCase()
        if (!q) return { error: '缺少关键词' }
        const hits = []
        for (const mem of m.memoryIndex.values()) {
          const meta = mem.meta
          const title = String(meta.title || '').toLowerCase()
          const impressions = (Array.isArray(meta.impressions) ? meta.impressions : []).join(' ').toLowerCase()
          const body = String(mem.snapshot || '').slice(0, 8000).toLowerCase()
          if (title.includes(q) || impressions.includes(q) || body.includes(q)) {
            hits.push({
              id: String(meta.id),
              title: String(meta.title || meta.id),
              impressions: Array.isArray(meta.impressions) ? meta.impressions.map(String) : [],
              preview: m.preview(mem.snapshot, 200),
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
      output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }] },
      isConcurrencySafe: () => true,
      async execute(args) {
        const blocked = gate()
        if (blocked) return { error: blocked }
        const id = String((args && args.id) || '')
        const mem = m.memoryIndex.get(id)
        if (!mem) return { error: '记忆不存在: ' + id }
        return Object.assign(m.memoryMetaOf(mem), {
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
      output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }] },
      async execute(args, exec) {
        const blocked = gate()
        if (blocked) return { error: blocked }
        const dir = m.libPath()
        if (!dir) return { error: '记忆库未配置' }
        const a = (args && typeof args === 'object') ? args : {}
        const sessionId = sessionIdOf(exec)
        const title = String(a.title || '').trim() || ('记忆 ' + new Date().toISOString().slice(0, 10))
        const meta = {
          id: 'm_' + rand(10), title,
          impressions: sanitizeImpressions(a.impressions),
          tags: sanitizeImpressions(a.tags),
          enabled: a.enabled !== false,
          links: [], composedOf: [],
          sourceSession: sessionId,
          createdAt: Date.now(), updatedAt: Date.now(), revision: 1,
        }
        await m.writeMemory(meta, String(a.snapshot || '').slice(0, 40000), String(a.notes || '').slice(0, 20000))
        return m.memoryMetaOf(m.memoryIndex.get(meta.id))
      },
    }),
    defineTool({
      name: 'memory_set_enabled',
      description: '启用或禁用一条记忆：禁用后不参与新会话自动注入、不能被加入注入计划（已在计划中的也不再注入），直到重新启用。',
      parameters: {
        id: { type: 'string', required: true, description: '记忆 id' },
        enabled: { type: 'boolean', required: true, description: 'true=启用，false=禁用' },
      },
      output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }] },
      isConcurrencySafe: () => true,
      async execute(args) {
        const blocked = gate()
        if (blocked) return { error: blocked }
        const id = String((args && args.id) || '')
        const mem = m.memoryIndex.get(id)
        if (!mem) return { error: '记忆不存在: ' + id }
        const meta = { ...mem.meta, enabled: (args && args.enabled) !== false }
        meta.revision = Number(meta.revision || 1) + 1
        meta.updatedAt = Date.now()
        await m.writeMemory(meta, mem.snapshot, mem.notes)
        if (meta.enabled === false) {
          try { await m.purgeMemoryFromPlans(id) } catch (e) { m.log('memory_set_enabled: purge failed: ' + String((e && e.message) || e)) }
        }
        return m.memoryMetaOf(m.memoryIndex.get(id))
      },
    }),
    defineTool({
      name: 'session_inject',
      description: '把一条记忆加入或移出当前会话的注入计划：加入后（记忆模式开启时）每轮自动注入；移出后不再注入。用于会话内按需管理注入内容。',
      parameters: {
        id: { type: 'string', required: true, description: '记忆 id' },
        inject: { type: 'boolean', required: true, description: 'true=加入当前会话计划，false=移出' },
      },
      output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }] },
      async execute(args, exec) {
        const blocked = gate()
        if (blocked) return { error: blocked }
        const sessionId = sessionIdOf(exec)
        if (!sessionId) return { error: '无法确定当前会话' }
        const id = String((args && args.id) || '')
        const mem = m.memoryIndex.get(id)
        if (!mem) return { error: '记忆不存在: ' + id }
        const plan = await m.loadPlan(sessionId)
        if (args && args.inject === false) {
          plan.memories = (plan.memories || []).filter((item) => String(item.id) !== id)
        } else {
          if (mem.meta.enabled === false) return { error: '该记忆已禁用（启用后才可加入注入计划）' }
          const exists = (plan.memories || []).some((item) => String(item.id) === id)
          if (!exists) plan.memories.push({
            id,
            title: String(mem.meta.title || ''),
            impressions: Array.isArray(mem.meta.impressions) ? mem.meta.impressions.map(String) : [],
            tags: Array.isArray(mem.meta.tags) ? mem.meta.tags.map(String) : [],
          })
        }
        await m.savePlan(sessionId, plan)
        return { ok: true, memories: (plan.memories || []).map((item) => String(item.id)) }
      },
    }),
    defineTool({
      name: 'memory_pin',
      description: '把一段文本固定为当前会话的临时记忆（记忆模式开启时每次发送自动注入）。',
      parameters: {
        content: { type: 'string', required: true, description: '要固定的文本' },
        label: { type: 'string', required: true, description: '标签（可为空字符串）' },
      },
      output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }] },
      async execute(args, exec) {
        const blocked = gate()
        if (blocked) return { error: blocked }
        const sessionId = sessionIdOf(exec)
        if (!sessionId) return { error: '无法确定当前会话' }
        const a = (args && typeof args === 'object') ? args : {}
        const content = String(a.content || '').trim()
        if (!content) return { error: '内容为空' }
        const plan = await m.loadPlan(sessionId)
        plan.pinned.push({
          id: 'tool-pin-' + rand(10),
          role: 'pin',
          text: ((a.label && String(a.label).trim()) ? '[' + String(a.label).trim() + '] ' : '') + content.slice(0, 4000),
          at: Date.now(),
        })
        await m.savePlan(sessionId, plan)
        return { ok: true, pinnedCount: plan.pinned.length }
      },
    }),
  ]

  const disposers = []
  const toolsService = m.ctx.get('tools') ?? m.ctx.get('tools', false)
  if (toolsService && typeof toolsService.register === 'function') {
    for (const tool of tools) {
      try { disposers.push(toolsService.register(tool)) } catch (e) { m.log('tools.register failed: ' + String((e && e.message) || e)) }
    }
  } else {
    m.log('tools service unavailable — Agent 记忆工具未注册')
  }
  return disposers
}

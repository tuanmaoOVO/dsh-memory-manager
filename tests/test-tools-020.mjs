// 回归测试：把插件注册的 6 个记忆工具喂给**真实 DSH 0.2.0 内核**的
// `ctx.tools.register()`，验证工具定义满足 0.2.0 的 ToolDefinition 契约。
//
// 为什么需要它：0.2.0 的 packages/core/tools 在 `register()` 里做运行时校验——
//   if (output === undefined || typeof output !== 'object'
//     || typeof output.render !== 'function'
//     || (output.presentationMeta !== undefined && typeof output.presentationMeta !== 'function'))
//     throw new TypeError(`tool "${name}" must declare output { schema, render, presentationMeta? }`);
// 并且 `schemas()` 只按白名单投影 name/description/parameters 到模型请求
// （output/execute/isConcurrencySafe 绝不能泄漏到 wire）。
// 插件的 `defineToolLocal` 兜底形状必须同样被接受，否则「官方包不可用」的降级路径会在
// DSH 升级后直接抛错、6 个工具全部注册失败。
//
// 用法：
//   node tests/test-tools-020.mjs <dsh-checkout-root>
//   DSH_ROOT=<dsh-checkout-root> node tests/test-tools-020.mjs
// 未提供检出路径时打印 SKIP 并正常退出。
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installTools, defineToolLocal } from '../lib/tools.js'
import { installMemory } from '../lib/memory.js'
import { installPlan } from '../lib/plan.js'
import { preview, textOf, sanitizeImpressions, sanitizeIds } from '../lib/util.js'

// DSH 0.2.0 的构建产物使用 structuredClone（Node ≥17），DSH 本身也要求 Node ^22.19 或 ≥24。
// 在旧 Node 上给出明确提示，而不是让内核抛 ReferenceError。
if (typeof structuredClone !== 'function') {
  console.log(`[skip] 需要 Node ≥18（当前 ${process.version}）：DSH 0.2.0 构建产物使用 structuredClone。请用 nvm 切到 Node 22+（如 nvm use 22.23.2）后重跑。`)
  process.exit(0)
}

const rawRoot = process.argv[2] || process.env.DSH_ROOT || ''
if (!rawRoot) {
  console.log('[skip] 未提供 DSH 检出路径（参数或 DSH_ROOT）；跳过真实工具注册测试')
  process.exit(0)
}
const root = String(rawRoot).replace(/\\/g, '/').replace(/\/+$/, '')

let Context
let ToolRuntime
let checkoutDefineTool
try {
  ;({ Context } = await import(`file:///${root}/vendor/cordis/lib/index.js`))
  ;({ ToolRuntime, defineTool: checkoutDefineTool } = await import(`file:///${root}/packages/core/tools/lib/index.js`))
} catch (error) {
  console.log(`[skip] 无法从 ${root} 载入 dsh 构建产物（先在该检出执行 pnpm run build）：${String((error && error.message) || error)}`)
  process.exit(0)
}
console.log(`[test] dsh 检出: ${root}`)

const results = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '[ ok ]' : '[FAIL]'} ${label}${detail ? '  — ' + detail : ''}`)
  results.push(ok)
}

/** 建一个最小可用的真实 ToolRuntime：它只 static inject ['systemPrompt']。 */
async function makeToolRuntime() {
  const ctx = new Context()
  ctx.provide('systemPrompt', { tools: () => () => {}, section: () => () => {} })
  const fiber = ctx.plugin(ToolRuntime)
  await fiber
  return ctx
}

const libDir = mkdtempSync(join(tmpdir(), 'mem-tools-'))
const makeManager = (toolsCtx) => {
  const m = {
    ctx: { get: (name) => (name === 'tools' ? toolsCtx.tools : undefined) },
    logger: { info() {}, warn() {}, error() {} },
    cfg: {
      enabled: true, mode: 'off', view: 'full', modelTools: true,
      libraryPath: libDir, memoryChars: 6000, totalChars: 12000, pinChars: 6000,
      autoInjectConvention: true,
    },
    log: () => {},
    textOf, preview, sanitizeImpressions, sanitizeIds,
    memoryIndex: new Map(),
    backlinkIndex: new Map(),
    planCache: new Map(),
    excludedCache: new Map(),
    onceCacheList: null,
  }
  installMemory(m)
  installPlan(m)
  return m
}

// ================= 1. 插件注册 6 个工具到真实注册表 =================
const ctx = await makeToolRuntime()
const m = makeManager(ctx)
const disposers = await installTools(m)
const schemas = ctx.tools.schemas()
check('真实 ctx.tools.register() 接纳 6 个工具定义', schemas.length === 6, `count=${schemas.length}`)
check('工具名齐全',
  ['memory_search', 'memory_recall', 'memory_save', 'memory_set_enabled', 'session_inject', 'memory_pin']
    .every((n) => schemas.some((s) => s.name === n)),
  schemas.map((s) => s.name).join(','))
check('返回 6 个 disposer', Array.isArray(disposers) && disposers.length === 6)

// ================= 2. 模型可见投影只含白名单字段 =================
{
  const leaked = []
  for (const s of schemas) {
    for (const key of Object.keys(s)) {
      if (!['name', 'description', 'parameters'].includes(key)) leaked.push(s.name + '.' + key)
    }
    if (s.parameters === undefined || typeof s.parameters !== 'object') leaked.push(s.name + '.parameters 缺失')
    if (typeof s.description !== 'string' || !s.description.length) leaked.push(s.name + '.description 缺失')
  }
  check('schemas() 只投影 name/description/parameters（output/execute 不泄漏到 wire）',
    leaked.length === 0, leaked.join(', '))
}

// ================= 3. 参数 schema 仍是 0.2.0 的隐式开放对象根 + required 注解 =================
{
  const search = schemas.find((s) => s.name === 'memory_search')
  const save = schemas.find((s) => s.name === 'memory_save')
  check('必填参数编译为 required 数组', Boolean(search && Array.isArray(search.parameters.required) && search.parameters.required.includes('query')),
    JSON.stringify(search && search.parameters))
  check('可选参数不进入 required',
    Boolean(save) && Array.isArray(save.parameters.required)
    && !save.parameters.required.includes('tags') && !save.parameters.required.includes('enabled')
    && save.parameters.required.includes('title') && save.parameters.required.includes('notes'),
    JSON.stringify(save && save.parameters.required))
  check('数组参数编译为 { type:array, items }',
    Boolean(save) && save.parameters.properties.impressions.type === 'array'
    && save.parameters.properties.impressions.items && save.parameters.properties.impressions.items.type === 'string',
    JSON.stringify(save && save.parameters.properties.impressions))
}

// ================= 4. 兜底 defineToolLocal 的形状同样被真实注册表接纳 =================
{
  const ctx2 = await makeToolRuntime()
  const optionSets = [
    { name: 'memory_search', description: 'd', parameters: { query: { type: 'string', required: true, description: 'q' } },
      output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
      isConcurrencySafe: () => true, execute: async () => ({ ok: true }) },
    { name: 'memory_recall', description: 'd', parameters: { id: { type: 'string', required: true } },
      output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
      isConcurrencySafe: () => true, execute: async () => ({ ok: true }) },
    { name: 'memory_save', description: 'd', parameters: {
      title: { type: 'string', required: true },
      impressions: { type: 'array', items: { type: 'string' }, required: true },
      snapshot: { type: 'string', required: true },
      notes: { type: 'string', required: true },
      tags: { type: 'array', items: { type: 'string' } },
      enabled: { type: 'boolean' },
    },
      output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
      execute: async () => ({ ok: true }) },
    { name: 'memory_set_enabled', description: 'd', parameters: { id: { type: 'string', required: true }, enabled: { type: 'boolean', required: true } },
      output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
      isConcurrencySafe: () => true, execute: async () => ({ ok: true }) },
    { name: 'session_inject', description: 'd', parameters: { id: { type: 'string', required: true }, inject: { type: 'boolean', required: true } },
      output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
      execute: async () => ({ ok: true }) },
    { name: 'memory_pin', description: 'd', parameters: { content: { type: 'string', required: true }, label: { type: 'string', required: true } },
      output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
      execute: async () => ({ ok: true }) },
  ]
  let accepted = 0
  let firstError = ''
  for (const options of optionSets) {
    try {
      ctx2.tools.register(defineToolLocal(options))
      accepted++
    } catch (error) { if (!firstError) firstError = `${options.name}: ${String((error && error.message) || error)}` }
  }
  check('兜底 defineToolLocal 形状被 0.2.0 真实注册表接受（6/6）', accepted === 6, firstError)
  check('兜底路径的 schemas() 也正常投影', ctx2.tools.schemas().length === 6, String(ctx2.tools.schemas().length))
}

// ================= 5. 官方 0.2.0 defineTool 接受同样的选项形状 =================
{
  try {
    const def = checkoutDefineTool({
      name: 'memory_probe',
      description: 'd',
      parameters: { query: { type: 'string', required: true, description: 'q' } },
      output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
      isConcurrencySafe: () => true,
      execute: async () => ({ ok: true }),
    })
    const ctx3 = await makeToolRuntime()
    ctx3.tools.register(def)
    check('官方 0.2.0 defineTool 接受插件的选项形状（parameters/output.render/isConcurrencySafe）',
      ctx3.tools.schemas().some((s) => s.name === 'memory_probe'))
  } catch (error) {
    check('官方 0.2.0 defineTool 接受插件的选项形状（parameters/output.render/isConcurrencySafe）', false,
      String((error && error.message) || error))
  }
}

// ================= 6. output 缺失/非法会被内核拒绝（确认测试真的有鉴别力） =================
{
  const ctx4 = await makeToolRuntime()
  let rejected = false
  try {
    ctx4.tools.register({ name: 'bad', description: 'd', parameters: { type: 'object', properties: {} }, execute: async () => 1 })
  } catch (error) { rejected = /must declare output/.test(String((error && error.message) || error)) }
  check('缺少 output 的定义确实被内核拒绝（测试有鉴别力）', rejected)
}

const failed = results.filter((ok) => !ok).length
console.log(failed ? `[test] FAILED: ${failed}/${results.length}` : `[test] ALL PASS (${results.length})`)
process.exit(failed ? 1 : 0)

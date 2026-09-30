// 回归测试：把客户端 bundle 的 6 条插槽注册喂给**真实 DSH 0.2.0 的 SlotCore**，
// 验证注册被接受、id/order/label 生效，并顺带校验 `dsh.client.inject` 的包名真实存在。
//
// 为什么需要它：smoke-client.mjs 用 mock 的 `slots`（`register` 直接返回 `() => {}`），
// 任何真实校验失败都会被 `apply` 的 try/catch 吞掉、只是「少注册几个槽位」。
// 0.2.0 的 SlotCore.register 有三条硬校验：
//   1) 目标槽位必须已被某个父条目的 children 表声明
//      （`slot "<name>" is not declared (a parent entry's children table must declare it)`）；
//   2) list 类槽位必须带 `id`；
//   3) 同一 id + 同一 priority 不能重复。
// 本测试用真实 SlotCore 声明一棵最小但同形的插槽树，然后跑 bundle 的 apply()。
//
// 用法：
//   node tests/test-client-slots-020.mjs <dsh-checkout-root>
//   DSH_ROOT=<dsh-checkout-root> node tests/test-client-slots-020.mjs
import { createRequire } from 'node:module'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

// bundle 里用到 structuredClone？不，但 DSH 0.2.0 的 ui-slots 构建产物可能用到；
// 同时本测试与其余 0.2.0 契约测试保持一致的 Node 要求。
if (typeof structuredClone !== 'function') {
  console.log(`[skip] 需要 Node ≥18（当前 ${process.version}）：DSH 0.2.0 构建产物使用 structuredClone。请用 nvm 切到 Node 22+（如 nvm use 22.23.2）后重跑。`)
  process.exit(0)
}

const rawRoot = process.argv[2] || process.env.DSH_ROOT || ''
if (!rawRoot) {
  console.log('[skip] 未提供 DSH 检出路径（参数或 DSH_ROOT）；跳过真实插槽注册测试')
  process.exit(0)
}
const root = String(rawRoot).replace(/\\/g, '/').replace(/\/+$/, '')

let SlotCore
try {
  ;({ SlotCore } = await import(`file:///${root}/packages/client/ui-slots/lib/index.js`))
  if (typeof SlotCore !== 'function') throw new Error('SlotCore 未导出')
} catch (error) {
  console.log(`[skip] 无法从 ${root} 载入 ui-slots 构建产物（先在该检出 pnpm run build）：${String((error && error.message) || error)}`)
  process.exit(0)
}
console.log(`[test] dsh 检出: ${root}`)

const results = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '[ok]  ' : '[FAIL]'} ${label}${detail ? '  — ' + detail : ''}`)
  results.push(ok)
}

// ---------- mock 浏览器环境（与 smoke-client.mjs 同形） ----------
let factory = null
global.window = {
  __ModuleLoader__: { load: (opts) => { factory = opts.factory } },
  __memErrCapInstalled: false,
  addEventListener: () => {},
  dispatchEvent: () => true,
}
global.document = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, style: {}, textContent: '', remove() {} }),
  head: { appendChild: () => {} },
}
global.fetch = async () => ({ json: async () => ({ ok: true, value: {} }) })
global.confirm = () => true

const requireDsh = createRequire(fileURLToPath(new URL('../package.json', import.meta.url)))
const clientPath = fileURLToPath(new URL('../lib/client.js', import.meta.url))
let src = fs.readFileSync(clientPath, 'utf8')
const injectPoint = 'return module.exports; } });'
if (!src.includes(injectPoint)) throw new Error('注入点未找到')
const bundleId = /__ModuleLoader__\.load\(\{\s*id:\s*"([^"]+)"/.exec(src)
check('bundle 仍使用 window.__ModuleLoader__.load({id, factory}) 且 id 为包名',
  Boolean(bundleId) && bundleId[1] === '@dsh-external/dsh-memory-manager', bundleId ? bundleId[1] : 'not found')
eval(src)
if (!factory) throw new Error('factory not captured')

// ---------- 真实 SlotCore + 最小同形插槽树 ----------
const core = new SlotCore()
// 真实客户端里这些声明来自 ui-layout / ui-settings-general / ui-conversation 的父条目；
// 这里用 registerFactory 的 children 表复刻同样的声明效果（SlotCore 的两条路径等价）。
const declared = [
  { name: 'test.app-frame', scope: 'root', children: { 'shell.overlay': { kind: 'list', scope: 'root' } } },
  { name: 'test.settings-shell', scope: 'root', children: { 'settings.section': { kind: 'list', scope: 'root' } } },
  { name: 'test.conversation', scope: 'session', children: {
    'conversation.input.left': { kind: 'list', scope: 'session' },
    'conversation.session.header.actions': { kind: 'list', scope: 'session' },
    'conversation.chat.assistant-actions': { kind: 'list', scope: 'session' },
  } },
]
for (const decl of declared) core.registerFactory(decl, () => null)
check('最小同形插槽树已声明（5 个目标槽位 spec 就位）',
  ['shell.overlay', 'settings.section', 'conversation.input.left', 'conversation.session.header.actions', 'conversation.chat.assistant-actions']
    .every((k) => core.spec(k) !== undefined))

// ---------- slots 服务 shim：inject 同步执行回调（已声明时内核行为） ----------
const injections = []
const injectionDisposers = []
const slots = {
  inject(key, callback) {
    injections.push(key)
    const effect = callback()
    const dispose = typeof effect === 'function' ? effect : () => {}
    injectionDisposers.push(dispose)
    return () => { dispose() }
  },
  register: (options, component) => core.register(options, component),
  entries: (key) => core.entries(key),
  spec: (key) => core.spec(key),
}

const registerErrors = []
const ctx = {
  get(name) { return name === 'slots' ? slots : undefined },
  effect(fn) { const r = fn(); return () => { if (typeof r === 'function') r() } },
  logger: { info: () => {}, warn: () => {}, error: (...a) => registerErrors.push(a.map(String).join(' ')) },
}

const originalError = console.error
console.error = (...args) => { registerErrors.push(args.map(String).join(' ')) }
const mod = factory(requireDsh)
const disposer = mod.apply(ctx)
console.error = originalError

check('exports.inject 声明了 slots（否则内核会扣留座位）',
  Array.isArray(mod.inject) && mod.inject.includes('slots'), JSON.stringify(mod.inject))
check('apply 返回 disposer', typeof disposer === 'function')
check('6 条插槽注册全部经过 slots.inject', injections.length === 6, JSON.stringify(injections))
check('apply 期间无注册错误（真实 SlotCore 未拒绝任何一条）',
  registerErrors.length === 0, registerErrors.slice(0, 3).join(' | '))

// ---------- 逐槽位断言真实 SlotCore 的账本 ----------
const ids = (key) => core.entries(key).map((e) => e.options.id)
check('conversation.input.left ← memory-panel-toggle', ids('conversation.input.left').includes('memory-panel-toggle'), JSON.stringify(ids('conversation.input.left')))
check('conversation.session.header.actions ← memory-manager-jump-receiver',
  ids('conversation.session.header.actions').includes('memory-manager-jump-receiver'), JSON.stringify(ids('conversation.session.header.actions')))
check('conversation.chat.assistant-actions ← memory-manager-message-actions',
  ids('conversation.chat.assistant-actions').includes('memory-manager-message-actions'), JSON.stringify(ids('conversation.chat.assistant-actions')))
check('shell.overlay ← 两条独立条目（面板 + 图谱），id 不冲突',
  ids('shell.overlay').includes('memory-panel') && ids('shell.overlay').includes('memory-graph')
  && ids('shell.overlay').length === 2, JSON.stringify(ids('shell.overlay')))
check('settings.section ← memory-manager', ids('settings.section').includes('memory-manager'), JSON.stringify(ids('settings.section')))

// list 类槽位按 order 排序（SlotCore 对 list 的稳定排序规则）
check('shell.overlay 按 order 排序（面板 30 在图谱 40 之前）',
  JSON.stringify(ids('shell.overlay')) === JSON.stringify(['memory-panel', 'memory-graph']), JSON.stringify(ids('shell.overlay')))

{
  const entry = core.entries('settings.section').find((e) => e.options.id === 'memory-manager')
  const label = entry && entry.options.label
  let resolved = null
  try { resolved = typeof label === 'function' ? label() : label } catch { /* ignore */ }
  check('settings.section 的 label 可解析为「记忆管理」', resolved === '记忆管理', String(resolved))
  check('settings.section 条目带 order:30', Boolean(entry) && entry.options.order === 30, entry ? String(entry.options.order) : 'missing')
}

// ---------- 反向断言：未声明的槽位确实会被真实 SlotCore 拒绝（证明测试有鉴别力） ----------
{
  let rejected = false
  try { core.register({ name: 'conversation.hero.workspace', id: 'x', order: 1 }, () => null) } catch (error) {
    rejected = /is not declared/.test(String((error && error.message) || error))
  }
  check('未声明的槽位确实被真实 SlotCore 拒绝（测试有鉴别力）', rejected)
}
{
  const empty = new SlotCore()
  empty.registerFactory({ name: 't', scope: 'root', children: { 'shell.overlay': { kind: 'list', scope: 'root' } } }, () => null)
  let rejected = false
  try { empty.register({ name: 'shell.overlay', order: 1 }, () => null) } catch (error) {
    rejected = /requires options\.id/.test(String((error && error.message) || error))
  }
  check('list 槽位缺 id 确实被拒绝（测试有鉴别力）', rejected)
}

// ---------- 幂等/释放：释放上一轮注册后可重新 apply（id 不冲突） ----------
{
  const before = ids('shell.overlay').length
  for (const dispose of injectionDisposers) { try { dispose() } catch { /* ignore */ } }
  const afterDispose = ids('shell.overlay').length
  const second = mod.apply(ctx)
  check('slots.inject 的 disposer 释放注册（真实 SlotCore 账本清空）', afterDispose === 0, `afterDispose=${afterDispose}`)
  check('释放后可重新 apply（id 不冲突，账本回到 2 条）',
    typeof second === 'function' && before === 2 && ids('shell.overlay').length === 2,
    `before=${before} after=${ids('shell.overlay').length}`)
}

// ---------- dsh.client.inject 的包名必须真实存在 ----------
{
  const manifest = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'))
  const declaredInject = manifest.dsh && manifest.dsh.client && manifest.dsh.client.inject
  check('package.json 有 dsh.client.platform=web 与 inject 列表',
    Boolean(manifest.dsh && manifest.dsh.client && manifest.dsh.client.platform === 'web' && Array.isArray(declaredInject)),
    JSON.stringify(manifest.dsh && manifest.dsh.client))
  // 包名 → 检出目录：@deepseek-ai/dsh-client-<rest> 在 packages/client/<rest>；
  //                       @deepseek-ai/dsh-api-<rest>    在 packages/api/<rest>
  const dirOf = (name) => {
    if (name.startsWith('@deepseek-ai/dsh-client-')) return `${root}/packages/client/${name.slice('@deepseek-ai/dsh-client-'.length)}`
    if (name.startsWith('@deepseek-ai/dsh-api-')) return `${root}/packages/api/${name.slice('@deepseek-ai/dsh-api-'.length)}`
    return null
  }
  const missing = []
  for (const name of declaredInject || []) {
    const dir = dirOf(name)
    if (dir === null || !fs.existsSync(`${dir}/package.json`)) { missing.push(name); continue }
    const pkg = JSON.parse(fs.readFileSync(`${dir}/package.json`, 'utf8'))
    if (pkg.name !== name) missing.push(`${name}（该目录声明的是 ${pkg.name}）`)
    // 客户端包必须真的声明 dsh.client，否则不会成为 boot graph 的一行
    if (!(pkg.dsh && pkg.dsh.client && pkg.dsh.client.platform === 'web')) missing.push(`${name}（未声明 dsh.client）`)
  }
  check('dsh.client.inject 的每个包名在 0.2.0 检出中都真实存在且声明了 dsh.client',
    missing.length === 0, missing.join(', '))
}

const failed = results.filter((ok) => !ok).length
console.log(failed ? `[test] FAILED: ${failed}/${results.length}` : `[test] ALL PASS (${results.length})`)
process.exit(failed ? 1 : 0)

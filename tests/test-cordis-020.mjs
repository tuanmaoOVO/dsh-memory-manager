// 集成测试：在**真实 Cordis**（DSH 0.2.0 检出的 vendored cordis）里加载本插件，
// 走通「插件激活 → Config 解析 → volatile 就地提交 → loader/volatile-update 同步」全链路。
//
// 为什么需要它：其他测试要么用 mock ctx（test-apply），要么只测 schema 形状
// （test-settings-020）。这里用真实 `Context` / `plugin()` / `resolveConfig` /
// `volatileEntries` / `updateVolatile` 复刻内核的 `_commitVolatile()` 时序，
// 证明插件在真实运行时确实能被挂载、被解析成 volatile 引用、并在配置变更后
// 把新值反映到业务层（经 HTTP `state.get` 观察）。
//
// 用法：
//   node tests/test-cordis-020.mjs <dsh-checkout-root>
//   DSH_ROOT=<dsh-checkout-root> node tests/test-cordis-020.mjs
import { pathToFileURL } from 'node:url'

// DSH 0.2.0 的构建产物使用 structuredClone（Node ≥17），并且 DSH 本身要求 Node ^22.19 || >=24。
// 在旧 Node 上给出明确提示而不是让内核抛 ReferenceError。
if (typeof structuredClone !== 'function') {
  console.log(`[skip] 需要 Node ≥18（当前 ${process.version}）：DSH 0.2.0 构建产物使用 structuredClone。请用 nvm 切到 Node 22+（如 nvm use 22.23.2）后重跑。`)
  process.exit(0)
}

const rawRoot = process.argv[2] || process.env.DSH_ROOT || ''
if (!rawRoot) {
  console.log('[skip] 未提供 DSH 检出路径（参数或 DSH_ROOT）；跳过真实 Cordis 集成测试')
  process.exit(0)
}
const root = String(rawRoot).replace(/\\/g, '/').replace(/\/+$/, '')

let Context
let resolveConfig
let volatileEntries
let updateVolatile
try {
  const cordis = await import(`file:///${root}/vendor/cordis/lib/index.js`)
  ;({ Context, resolveConfig } = cordis)
  ;({ volatileEntries, updateVolatile } = await import(`file:///${root}/vendor/cosmokit/lib/index.js`))
} catch (error) {
  console.log(`[skip] 无法从 ${root} 载入 dsh 构建产物：${String((error && error.message) || error)}`)
  process.exit(0)
}
console.log(`[test] dsh 检出: ${root}`)

const results = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '[ ok ]' : '[FAIL]'} ${label}${detail ? '  — ' + detail : ''}`)
  results.push(ok)
}

const FIELDS = ['enabled', 'mode', 'view', 'modelTools', 'libraryPath', 'memoryChars', 'totalChars', 'pinChars', 'autoInjectConvention']
const ACTIVE = 2

// ---------- 1. 在真实 Cordis 里激活插件 ----------
const ctx = new Context()
const routes = []
const routeDisposals = []
const configureCalls = []
const settingsWrites = []
ctx.provide('tools', { register: () => () => {} })
ctx.provide('webServer', {
  register: (route) => { routes.push(route); return () => { routeDisposals.push(route.path) } },
})
// 0.2.0 的 SettingsForms 面：插件只用 configure（关掉自动表单）与 update（写回 profile）。
// 真实 SettingsForms 需要 configEditor + profileContext + Loader，这里用记录桩验证**调用形状**。
ctx.provide('settings', {
  configure: (presentation, owner) => { configureCalls.push({ presentation, owner }); return () => {} },
  update: async (ns, patch) => { settingsWrites.push({ ns, patch }) },
})

const mod = await import(new URL('../lib/index.js', import.meta.url).href)
const fiber = ctx.plugin(mod, {})
await fiber

check('插件在真实 Cordis 中激活（fiber ACTIVE）', fiber.state === ACTIVE, `state=${fiber.state}`)
check('运行时 Config 就是插件导出的 schema', fiber.runtime && fiber.runtime.Config === mod.Config)
check('fiber.config 解出 9 个 volatile 引用',
  fiber.config !== undefined && FIELDS.every((f) => fiber.config[f] !== undefined && typeof fiber.config[f].get === 'function'),
  fiber.config ? Object.keys(fiber.config).join(',') : 'undefined')
check('webServer 路由通过 ctx.inject 注册（真实 Cordis 依赖等待）',
  routes.some((r) => r.kind === 'exact' && r.path === '/_dsh/memory-manager/api'),
  routes.map((r) => r.path).join(','))
check('关闭自动设置表单：settings.configure({auto:false}, ctx.fiber) 被调用',
  configureCalls.length === 1 && configureCalls[0].presentation && configureCalls[0].presentation.auto === false
  // ctx.plugin() 返回的可能是 fiber 的可调用包装，用 runtime.Config 同一性判定「本插件自己的 fiber」
  && Boolean(configureCalls[0].owner && configureCalls[0].owner.runtime && configureCalls[0].owner.runtime.Config === mod.Config),
  JSON.stringify(configureCalls.map((c) => c.presentation)))

// 经真实路由读业务层状态
const handler = routes.find((r) => r.kind === 'exact')
const post = async (body) => {
  const req = { method: 'POST' }
  const chunks = [Buffer.from(JSON.stringify(body))]
  req[Symbol.asyncIterator] = async function* () { yield* chunks }
  const out = { headers: {}, setHeader(k, v) { this.headers[k] = v }, writeHead(s) { out.status = s }, end(t) { out.body = t } }
  await handler.handler(req, out)
  return JSON.parse(out.body)
}
let res = await post({ op: 'state.get' })
check('业务层可读（state.get 经真实路由）', Boolean(res && res.value && res.value.config), JSON.stringify(res).slice(0, 120))
check('初始配置等于 schema 默认值',
  res.value.config.mode === 'off' && res.value.config.view === 'full' && res.value.config.pinChars === 6000,
  JSON.stringify({ mode: res.value.config.mode, view: res.value.config.view, pinChars: res.value.config.pinChars }))

// ---------- 2. 复刻内核 _commitVolatile：候选解析 + 就地提交 ----------
{
  const candidate = resolveConfig(fiber.runtime, { mode: 'on', view: 'compact', pinChars: 4321, autoInjectConvention: false })
  const refs = volatileEntries(fiber.config)
  let updated = 0
  for (const { path, ref } of refs) {
    const source = path.reduce((value, key) => Reflect.get(value, key), candidate)
    if (source === undefined || typeof source.get !== 'function') continue
    updateVolatile(ref, source)
    updated++
  }
  check('resolveConfig + updateVolatile 就地提交 9 个字段', updated === 9, String(updated))
  check('fiber.config 读到新值（引用身份不变）',
    fiber.config.mode.get() === 'on' && fiber.config.view.get() === 'compact'
    && fiber.config.pinChars.get() === 4321 && fiber.config.autoInjectConvention.get() === false,
    JSON.stringify({ mode: fiber.config.mode.get(), view: fiber.config.view.get(), pinChars: fiber.config.pinChars.get() }))
}

// ---------- 3. loader/volatile-update 让业务层同步 ----------
{
  fiber.ctx.emit('loader/volatile-update', [['mode'], ['view'], ['pinChars'], ['autoInjectConvention']])
  res = await post({ op: 'state.get' })
  check('loader/volatile-update 后业务层读到新配置',
    res.value.config.mode === 'on' && res.value.config.view === 'compact'
    && res.value.config.pinChars === 4321 && res.value.config.autoInjectConvention === false,
    JSON.stringify({ mode: res.value.config.mode, view: res.value.config.view, pinChars: res.value.config.pinChars, auto: res.value.config.autoInjectConvention }))
}

// ---------- 4. 关闭总开关后 API 门控生效（配置真实驱动业务） ----------
{
  const candidate = resolveConfig(fiber.runtime, { enabled: false })
  for (const { path, ref } of volatileEntries(fiber.config)) {
    const source = path.reduce((value, key) => Reflect.get(value, key), candidate)
    if (source && typeof source.get === 'function') updateVolatile(ref, source)
  }
  fiber.ctx.emit('loader/volatile-update', [['enabled']])
  res = await post({ op: 'library.scan' })
  check('enabled=false 时业务 op 被门控拒绝', Boolean(res && res.value && typeof res.value.error === 'string' && res.value.error.includes('已禁用')), JSON.stringify(res))
  res = await post({ op: 'state.get' })
  check('enabled=false 时 state.get 仍放行（设置页可重新开启）', Boolean(res && res.value && res.value.config && res.value.config.enabled === false))
}

// ---------- 4b. 设置写回走 ctx.settings.update(profile 条目 id, patch) ----------
{
  // 先经总开关放行（enabled=false 时除 state.get / state.setEnabled / diag.log 外全部门控拒绝）
  const reenable = await post({ op: 'state.setEnabled', args: { v: true } })
  check('enabled=false 时 state.setEnabled 仍放行', Boolean(reenable && reenable.value && reenable.value.enabled === true), JSON.stringify(reenable))
  settingsWrites.length = 0
  await post({ op: 'state.setMode', args: { mode: 'on' } })
  await post({ op: 'state.setLibrary', args: { path: 'C:/tmp/mem-e2e-lib' } })
  check('设置写回调用 ctx.settings.update 且 namespace 为 profile 条目 id',
    settingsWrites.length >= 2 && settingsWrites.every((w) => w.ns === 'memory-manager'),
    JSON.stringify(settingsWrites.map((w) => w.ns)))
  check('写回内容是稀疏 patch（只含被改字段）',
    settingsWrites.some((w) => w.patch.mode === 'on') && settingsWrites.some((w) => typeof w.patch.libraryPath === 'string'),
    JSON.stringify(settingsWrites))
  // 乐观更新立即对业务层可见（未等内核回读）
  res = await post({ op: 'state.get' })
  check('写回后乐观值立即对业务层可见', res.value.config.mode === 'on', JSON.stringify(res.value.config))
}

// ---------- 4c. 写被拒绝时回滚到权威 volatile 值 ----------
{
  const ctx2 = new Context()
  const routes2 = []
  ctx2.provide('tools', { register: () => () => {} })
  ctx2.provide('webServer', { register: (route) => { routes2.push(route); return () => {} } })
  ctx2.provide('settings', {
    configure: () => () => {},
    update: async () => { throw new Error('SETTINGS_REJECTED') },
  })
  const mod2 = await import(new URL('../lib/index.js', import.meta.url).href)
  const fiber2 = ctx2.plugin(mod2, { mode: 'off' })
  await fiber2
  const handler2 = routes2.find((r) => r.kind === 'exact')
  const post2 = async (body) => {
    const req = { method: 'POST' }
    const chunks = [Buffer.from(JSON.stringify(body))]
    req[Symbol.asyncIterator] = async function* () { yield* chunks }
    const out = { headers: {}, setHeader(k, v) { this.headers[k] = v }, writeHead(s) { out.status = s }, end(t) { out.body = t } }
    await handler2.handler(req, out)
    return JSON.parse(out.body)
  }
  await post2({ op: 'state.setMode', args: { mode: 'on' } })
  const after = await post2({ op: 'state.get' })
  check('settings.update 抛错时乐观值回滚到 volatile 权威值（mode 仍为 off）',
    after && after.value && after.value.config.mode === 'off', JSON.stringify(after && after.value && after.value.config))
  await fiber2.dispose()
}

// ---------- 5. 卸载时监听器 / 路由随 fiber 释放 ----------
{
  await fiber.dispose()
  check('dispose 后 fiber 不再 ACTIVE', fiber.state !== ACTIVE, `state=${fiber.state}`)
  check('dispose 时 webServer 路由的 disposer 被调用（effect 随 fiber 回收）',
    routeDisposals.includes('/_dsh/memory-manager/api'), JSON.stringify(routeDisposals))
  let leaked = false
  try {
    fiber.ctx.emit('loader/volatile-update', [['mode']])
  } catch { leaked = true }
  check('dispose 后派发 volatile-update 不再抛错（监听器已随 fiber 释放）', leaked === false)
}

const failed = results.filter((ok) => !ok).length
console.log(failed ? `[test] FAILED: ${failed}/${results.length}` : `[test] ALL PASS (${results.length})`)
process.exit(failed ? 1 : 0)

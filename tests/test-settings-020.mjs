// 回归测试：插件导出的 Config 必须与 **DSH 0.2.0 的设置/volatile 机制**对齐。
//
// 为什么需要它：0.2.0 把 `ctx.settings.register(ns, Config, …)` 整个删除，设置页改为
// 「投影插件导出 Config 中带 `meta.volatile` 的字段」，运行中的插件读 apply() 收到的
// config 引用，内核把变更**就地**提交进 volatile 引用并派发 `loader/volatile-update`。
// 这条链路有三个硬约束，任一不满足都会静默降级（设置页消失 / 写入被拒 / 热更新失效）：
//   1) `isSchemastery(schema)`：`schema['~standard'].vendor === 'schemastery'`
//      （vendor/loder 的 equalExceptVolatile 用它决定是否按 volatile 比较）；
//   2) `volatileForm(schema)` 必须返回表单（字段必须有 `meta.volatile`），
//      否则 settings.write() 抛 `Plugin entry "…" has no volatile fields`；
//   3) `volatileEntries(fiber.config)` 必须能找到每个字段的 Volatile 引用，
//      且 `updateVolatile(ref, candidate)` 能就地改值（`Symbol.for('cosmokit.volatile.write')`）。
//
// 用法：
//   node tests/test-settings-020.mjs <dsh-checkout-root>
//   DSH_ROOT=<dsh-checkout-root> node tests/test-settings-020.mjs
// 未提供检出路径时打印 SKIP 并正常退出。
import { pathToFileURL } from 'node:url'

// DSH 0.2.0 的构建产物使用 structuredClone（Node ≥17），DSH 本身也要求 Node ^22.19 或 ≥24。
// 在旧 Node 上给出明确提示，而不是让内核抛 ReferenceError。
if (typeof structuredClone !== 'function') {
  console.log(`[skip] 需要 Node ≥18（当前 ${process.version}）：DSH 0.2.0 构建产物使用 structuredClone。请用 nvm 切到 Node 22+（如 nvm use 22.23.2）后重跑。`)
  process.exit(0)
}

const rawRoot = process.argv[2] || process.env.DSH_ROOT || ''
if (!rawRoot) {
  console.log('[skip] 未提供 DSH 检出路径（参数或 DSH_ROOT）；跳过设置/volatile 契约测试')
  process.exit(0)
}
const root = String(rawRoot).replace(/\\/g, '/').replace(/\/+$/, '')

let z
let volatileEntries
let updateVolatile
let isVolatile
try {
  const schemastery = await import(`file:///${root}/vendor/schemastery/lib/index.mjs`)
  z = schemastery.default ?? schemastery
  const cosmokit = await import(`file:///${root}/vendor/cosmokit/lib/index.js`)
  ;({ volatileEntries, updateVolatile, isVolatile } = cosmokit)
} catch (error) {
  console.log(`[skip] 无法从 ${root} 载入 dsh 构建产物（先在该检出执行 pnpm build）：${String((error && error.message) || error)}`)
  process.exit(0)
}
console.log(`[test] dsh 检出: ${root}`)

const results = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '[ ok ]' : '[FAIL]'} ${label}${detail ? '  — ' + detail : ''}`)
  results.push(ok)
}

const { Config } = await import(new URL('../lib/index.js', import.meta.url).href)

// ---------- 复刻 packages/settings/settings/src/schema.ts 的算法（未从包入口导出） ----------
function plainSchema(schema) {
  const result = new z(schema.toJSON())
  const walk = (node) => {
    if (node.meta) delete node.meta.volatile
    for (const child of Object.values(node.dict ?? {})) walk(child)
    if (node.inner) walk(node.inner)
    for (const child of node.list ?? []) walk(child)
  }
  walk(result)
  return result
}
function volatileForm(schema) {
  if (schema.meta.volatile) return plainSchema(schema)
  if (schema.type === 'object') {
    const dict = Object.fromEntries(Object.entries(schema.dict ?? {}).flatMap(([key, child]) => {
      const field = volatileForm(child)
      return field === undefined ? [] : [[key, field]]
    }))
    return Object.keys(dict).length === 0 ? undefined : z.object(dict)
  }
  return undefined
}
function isVolatilePath(schema, path) {
  if (schema.meta.volatile) return true
  const [key, ...rest] = path
  const child = key === undefined ? undefined : schema.dict?.[key]
  return child !== undefined && isVolatilePath(child, rest)
}
// vendor/loader 的 equalExceptVolatile 用它判定「按 volatile 逐字段比较」
const isSchemastery = (schema) => schema?.['~standard']?.vendor === 'schemastery'

const FIELDS = ['enabled', 'mode', 'view', 'modelTools', 'libraryPath', 'memoryChars', 'totalChars', 'pinChars', 'autoInjectConvention']

// ---------- 1. 内核识别为 schemastery schema ----------
check('内核 isSchemastery() 成立（~standard.vendor === "schemastery"）', isSchemastery(Config),
  String(Config && Config['~standard'] && Config['~standard'].vendor))

// ---------- 2. 每个字段都带 meta.volatile（设置页可写的前提） ----------
{
  const missing = FIELDS.filter((f) => !(Config.dict && Config.dict[f] && Config.dict[f].meta && Config.dict[f].meta.volatile))
  check('9 个配置字段全部带 meta.volatile', missing.length === 0, missing.join(', '))
}

// ---------- 3. volatileForm / isVolatilePath（settings.write 的两道闸门） ----------
{
  const form = volatileForm(Config)
  check('volatileForm(Config) 返回表单（否则写入抛 "has no volatile fields"）', form !== undefined)
  const formKeys = form ? Object.keys(form.dict ?? {}) : []
  check('表单覆盖全部 9 个字段', FIELDS.every((f) => formKeys.includes(f)), formKeys.join(','))
  const notVolatile = FIELDS.filter((f) => !isVolatilePath(Config, [f]))
  check('isVolatilePath 对每个字段成立（否则写入抛 "is not volatile"）', notVolatile.length === 0, notVolatile.join(', '))
}

// ---------- 4. 解析输出必须是 cosmokit 能识别的 Volatile 引用 ----------
{
  const resolved = Config({})
  const entries = volatileEntries(resolved)
  const paths = entries.map((e) => e.path.join('.'))
  const missing = FIELDS.filter((f) => !paths.includes(f))
  check('volatileEntries(config) 找到全部 9 个字段引用（内核就地提交的入口）', missing.length === 0, paths.join(','))
  check('引用通过 cosmokit isVolatile 判定', entries.length > 0 && entries.every((e) => isVolatile(e.ref)))
}

// ---------- 5. updateVolatile 能就地改值（模拟 0.2.0 的 _commitVolatile） ----------
{
  const live = Config({})
  const next = Config({ mode: 'on', view: 'compact', pinChars: 4321, autoInjectConvention: false })
  let updated = 0
  for (const { path, ref } of volatileEntries(live)) {
    const source = path.reduce((value, key) => Reflect.get(value, key), next)
    if (!isVolatile(source)) continue
    updateVolatile(ref, source)
    updated++
  }
  check('updateVolatile 就地提交 9 个字段', updated === 9, String(updated))
  check('提交后读到的就是新值（mode/view/pinChars/autoInjectConvention）',
    live.mode.get() === 'on' && live.view.get() === 'compact' && live.pinChars.get() === 4321
    && live.autoInjectConvention.get() === false,
    JSON.stringify({ mode: live.mode.get(), view: live.view.get(), pinChars: live.pinChars.get(), autoInject: live.autoInjectConvention.get() }))
  check('引用身份不变（内核依赖 stable reference）', isVolatile(live.mode))
}

// ---------- 6. defaults 与插件内部 CFG_DEFAULTS 一致 ----------
{
  const resolved = Config({})
  const defaults = {
    enabled: resolved.enabled.get(), mode: resolved.mode.get(), view: resolved.view.get(),
    modelTools: resolved.modelTools.get(), libraryPath: resolved.libraryPath.get(),
    memoryChars: resolved.memoryChars.get(), totalChars: resolved.totalChars.get(),
    pinChars: resolved.pinChars.get(), autoInjectConvention: resolved.autoInjectConvention.get(),
  }
  check('schema 默认值与插件进程内默认值一致',
    defaults.enabled === true && defaults.mode === 'off' && defaults.view === 'full'
    && defaults.modelTools === true && defaults.libraryPath === ''
    && defaults.memoryChars === 6000 && defaults.totalChars === 12000
    && defaults.pinChars === 6000 && defaults.autoInjectConvention === true,
    JSON.stringify(defaults))
}

// ---------- 7. 非法取值被 schema 拒绝（settings.write 会先 validate 整个 Config） ----------
{
  let rejected = false
  try { Config({ mode: 'maybe' }) } catch { rejected = true }
  check('未知 mode 值被 schema 拒绝', rejected)
}

// ---------- 8. toJSON 往返后 volatile 标记保留（settings 用 new z(toJSON()) 重建表单） ----------
{
  const round = new z(Config.toJSON())
  const kept = FIELDS.filter((f) => round.dict && round.dict[f] && round.dict[f].meta && round.dict[f].meta.volatile)
  check('toJSON → new z() 往返后 volatile 标记仍在', kept.length === FIELDS.length, kept.join(','))
}

const failed = results.filter((ok) => !ok).length
console.log(failed ? `[test] FAILED: ${failed}/${results.length}` : `[test] ALL PASS (${results.length})`)
process.exit(failed ? 1 : 0)

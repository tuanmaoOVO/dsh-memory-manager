// 回归测试：用真实 dsh Session 验证「排除 / 恢复轮次」的表面替换（SurfaceOp）兼容性。
//
// 为什么需要它：tests/test-apply.mjs 用 mock ctx 覆盖宿主装配与 HTTP 业务层，
// 但 plan.excludeTurn 走的是真实 Session.append 的表面校验，只有真实 Session 能验证：
//   1) dsh 0.1.5 起 SurfaceOp 位置替换字段由 { start, end } 改名为 { startSeq, endSeq }
//      （0.2.0 的 packages/core/session/src/surface.ts 里 isReplaceOp 按 Object.keys
//       精确匹配：恰好 3 个自有键 op / startSeq / endSeq）；
//   2) assistant/message 不能作为表面替换事件
//      （surface.ts 的 assertSourceEventReferences 不允许它携带 sourceEventSeqs），
//      恢复只能降级为 user 文本；
//   3) 0.2.0 新增：tool/result 替换「只能改 content」，且 sourceEventSeqs 必须覆盖
//      全部被遮蔽的表面节点；
//   4) 0.2.0 起 MessageSource 没有通用 'plugin' kind，标记用插件自己的
//      kind:'memory-manager'，同时仍要能识别 0.1.x 历史会话里的
//      { kind:'plugin', plugin:'memory-manager' } 标记。
// 插件通过 lib/sessions.js 的 m.appendReplace 自动探测字段名并缓存，本测试同时验证两条路径。
//
// 用法（需要目标 DSH 检出已构建 packages/core/session 与 packages/llm/llm 的 lib/）：
//   node tests/test-surface.mjs <dsh-checkout-root>
//   DSH_ROOT=<dsh-checkout-root> node tests/test-surface.mjs
// 未提供检出路径时打印 SKIP 并正常退出（该测试依赖机器上的 DSH 源码路径）。
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installPlan } from '../lib/plan.js'
import { installSessions } from '../lib/sessions.js'
import { preview, textOf, isOwnSource, PLUGIN_KIND, LEGACY_PLUGIN_KIND } from '../lib/util.js'

// DSH 0.2.0 的构建产物使用 structuredClone（Node ≥17），DSH 本身也要求 Node ^22.19 或 ≥24。
// 在旧 Node 上给出明确提示，而不是让内核抛 ReferenceError。
if (typeof structuredClone !== 'function') {
  console.log(`[skip] 需要 Node ≥18（当前 ${process.version}）：DSH 0.2.0 构建产物使用 structuredClone。请用 nvm 切到 Node 22+（如 nvm use 22.23.2）后重跑。`)
  process.exit(0)
}

const rawRoot = process.argv[2] || process.env.DSH_ROOT || ''
if (!rawRoot) {
  console.log('[skip] 未提供 DSH 检出路径（参数或 DSH_ROOT）；跳过真实 Session 表面替换测试')
  process.exit(0)
}
const root = String(rawRoot).replace(/\\/g, '/').replace(/\/+$/, '')

let Session
let SessionId
let createMessage
let createToolResultMessage
let createUserMessage
let ToolCallId
try {
  ({ Session, SessionId } = await import(`file:///${root}/packages/core/session/lib/index.js`))
  ;({ createMessage, createToolResultMessage, createUserMessage, ToolCallId } = await import(`file:///${root}/packages/llm/llm/lib/index.js`))
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

// ================= 最小 manager（形状照 lib/index.js） =================
const libDir = mkdtempSync(join(tmpdir(), 'mem-surface-'))
const m = {
  ctx: { get: () => undefined },
  logger: { info() {}, warn() {}, error() {} },
  pluginTag: 'memory-manager',
  pluginKind: PLUGIN_KIND,
  log: () => {},
  textOf,
  preview,
  libPath: () => libDir,
  planCache: new Map(),
  excludedCache: new Map(),
  onceCacheList: null,
  memoryIndex: new Map(),
  backlinkIndex: new Map(),
}
installPlan(m)
installSessions(m)

// ================= 0. 消息来源标识（0.2.0 契约） =================
check('新来源标识被识别（kind: memory-manager）', isOwnSource({ kind: PLUGIN_KIND }) === true)
check('0.1.x 历史来源标识仍被识别（kind: plugin + plugin: memory-manager）',
  isOwnSource({ kind: LEGACY_PLUGIN_KIND, plugin: 'memory-manager' }) === true)
check('他人来源不被误判', isOwnSource({ kind: 'user' }) === false && isOwnSource({ kind: 'plugin', plugin: 'other' }) === false)

// ================= 真实会话 =================
const session = Session.create(SessionId('memory-manager-surface-test'))
const user1 = createUserMessage({ content: [{ type: 'text', text: '第一轮问题' }], source: { kind: 'user' } })
const assistantData = (text, turn) => ({
  stream: [],
  turn,
  step: 1,
  message: createMessage({
    role: 'assistant',
    content: [{ type: 'text', text }],
    source: { kind: 'model', provider: 'mock', model: 'mock' },
  }),
})
session.append('turn/start', { turn: 1 })
session.append('user/message', user1, { surfaceOp: 'append' })
session.append('assistant/message', assistantData('第一轮回答', 1), { surfaceOp: 'append' })
session.append('tool/result', {
  turn: 1,
  step: 1,
  message: createToolResultMessage({ callId: ToolCallId('c1'), content: [{ type: 'text', text: '工具结果' }], isError: false }),
}, { surfaceOp: 'append' })
session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
session.append('turn/start', { turn: 2 })
session.append('user/message', createUserMessage({ content: [{ type: 'text', text: '第二轮问题' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
session.append('assistant/message', assistantData('第二轮回答', 2), { surfaceOp: 'append' })
session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })

/** 复刻 lib/sessions.js wrapLive 的视图：surface.nodes + 按 seq 索引的 events + append。 */
const makeView = () => {
  const nodes = Array.from(session.surface.nodes)
  const events = []
  for (const event of session.snapshotEvents()) events[event.seq] = event
  return { surface: { nodes }, events, append: (type, data, opts) => session.append(type, data, opts) }
}

// ================= 0. 内核接受哪种字段名 =================
const probeShape = (shape) => {
  const probe = Session.create(SessionId(`probe-${shape}`))
  probe.append('turn/start', { turn: 1 })
  const event = probe.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'p' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  const surfaceOp = shape === 'seq'
    ? { op: 'replace', startSeq: event.seq, endSeq: event.seq }
    : { op: 'replace', start: event.seq, end: event.seq }
  try {
    probe.append('user/message',
      createUserMessage({ content: [{ type: 'text', text: 'r' }], source: { kind: 'plugin', plugin: 'memory-manager' } }),
      { surfaceOp, sourceEventSeqs: [event.seq] })
    return true
  } catch { return false }
}
const seqAccepted = probeShape('seq')
const rangeAccepted = probeShape('range')
check('内核只接受一种 SurfaceOp 字段名', seqAccepted !== rangeAccepted,
  `startSeq/endSeq=${seqAccepted} start/end=${rangeAccepted}`)

// ================= 1. 排除轮次 =================
let view = makeView()
const turns = m.buildTurns(view, 'memory-manager-surface-test', null)
check('buildTurns 解析出 2 轮', turns.length === 2, `turns=${turns.length}`)

const excluded = await m.excludeTurn(view, 'memory-manager-surface-test', String(user1.id), true)
check('excludeTurn(排除) 返回 ok', Boolean(excluded) && excluded.ok === true, JSON.stringify(excluded))

view = makeView()
const afterExclude = m.buildTurns(view, 'memory-manager-surface-test', null)
const markerTurn = afterExclude.find((turn) => turn.turnId === String(user1.id))
check('排除后该轮出现标记且状态为已排除',
  Boolean(markerTurn) && markerTurn.marker === true && markerTurn.excluded === true,
  markerTurn ? `marker=${markerTurn.marker} excluded=${markerTurn.excluded}` : 'missing')

// ================= 2. 恢复轮次 =================
const restored = await m.excludeTurn(view, 'memory-manager-surface-test', String(user1.id), false)
check('excludeTurn(恢复) 返回 ok', Boolean(restored) && restored.ok === true, JSON.stringify(restored))

view = makeView()
const surfaceEvents = view.surface.nodes.map((seq) => view.events[seq]).filter(Boolean)
const hasUser = surfaceEvents.some((event) => event.type === 'user/message' && /第一轮问题/.test(JSON.stringify(event.data || {})))
const hasAssistant = surfaceEvents.some((event) => (event.type === 'user/message' || event.type === 'assistant/message')
  && /第一轮回答/.test(JSON.stringify(event.data || {})))
const hasTool = surfaceEvents.some((event) => event.type === 'tool/result' && /工具结果/.test(JSON.stringify(event.data || {})))
check('恢复后该轮内容回到表面（user/assistant/tool）', hasUser && hasAssistant && hasTool,
  `user=${hasUser} assistant=${hasAssistant} tool=${hasTool}`)
check('恢复后表面无残留标记', !view.surface.nodes.some((seq) => m.isMarkerEvent(view.events[seq])),
  view.surface.nodes.join(','))

// ================= 3. 插件写回字段名与内核一致 =================
const replacement = session.snapshotEvents().find((event) => event.type === 'user/message'
  && event.surfaceOp && event.surfaceOp !== 'append')
check('插件写回的 surfaceOp 字段名与内核一致',
  Boolean(replacement) && Object.hasOwn(replacement.surfaceOp, 'startSeq') === seqAccepted,
  JSON.stringify(replacement && replacement.surfaceOp))

// ================= 4. assistant 还原方式（版本差异） =================
const assistantAsAssistant = surfaceEvents.some((event) => event.type === 'assistant/message'
  && /第一轮回答/.test(JSON.stringify(event.data || {})))
if (seqAccepted) {
  check('0.1.5+ 下 assistant 降级为 user 文本还原（内核禁止 assistant 作为替换事件）',
    assistantAsAssistant === false, `assistant=${assistantAsAssistant}`)
} else {
  check('0.1.2 下 assistant 原样还原', assistantAsAssistant === true, `assistant=${assistantAsAssistant}`)
}

const failed = results.filter((ok) => !ok).length
console.log(failed ? `[test] FAILED: ${failed}/${results.length}` : `[test] ALL PASS (${results.length})`)
process.exit(failed ? 1 : 0)

// 端到端回归：在**真实 AgentLoop**（dsh-agent-loop-testkit 的 production harness）里跑一轮对话，
// 断言插件经 `agent/pre-step` 注入的记忆上下文确实进入了模型请求。
//
// 为什么需要它：其余测试要么直接调用监听器函数（test-apply），要么只验证契约形状。
// 这里走完整链路：真实 Session + 真实 AgentLoop + 真实 pre-step 瀑布 →
// 插件监听器 `await next()` 后追加消息 → 循环把决策里的消息写成 `user/message` 表面事件
// （`session.append('user/message', message, { surfaceOp: 'append' })`）→ 组装成模型请求。
// 只有这条链路走通，才能证明「注入消息的形状被 0.2.0 的 Session/循环接受」而不只是「函数返回了对象」。
//
// 用法：
//   node tests/test-pre-step-e2e-020.mjs <dsh-checkout-root>
//   DSH_ROOT=<dsh-checkout-root> node tests/test-pre-step-e2e-020.mjs
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (typeof structuredClone !== 'function') {
  console.log(`[skip] 需要 Node ≥18（当前 ${process.version}）：DSH 0.2.0 构建产物使用 structuredClone。请用 nvm 切到 Node 22+（如 nvm use 22.23.2）后重跑。`)
  process.exit(0)
}

const rawRoot = process.argv[2] || process.env.DSH_ROOT || ''
if (!rawRoot) {
  console.log('[skip] 未提供 DSH 检出路径（参数或 DSH_ROOT）；跳过 pre-step 端到端测试')
  process.exit(0)
}
const root = String(rawRoot).replace(/\\/g, '/').replace(/\/+$/, '')

let Context
let mountAgentLoopTestDependencies
let mountAgentLoopTestHarness
let LlmAdapter
let createUserMessage
let SessionId
try {
  ;({ Context } = await import(`file:///${root}/vendor/cordis/lib/index.js`))
  ;({ mountAgentLoopTestDependencies, mountAgentLoopTestHarness } = await import(`file:///${root}/packages/test-support/agent-loop-testkit/lib/index.js`))
  ;({ LlmAdapter, createUserMessage } = await import(`file:///${root}/packages/llm/llm/lib/index.js`))
  ;({ SessionId } = await import(`file:///${root}/packages/core/session/lib/index.js`))
} catch (error) {
  console.log(`[skip] 无法从 ${root} 载入 dsh 构建产物（先在该检出 pnpm run build）：${String((error && error.message) || error)}`)
  process.exit(0)
}
console.log(`[test] dsh 检出: ${root}`)

const results = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '[ok]  ' : '[FAIL]'} ${label}${detail ? '  — ' + detail : ''}`)
  results.push(ok)
}

// ---------- 记忆库：一条规约记忆 + 预置注入计划（避免与 loadPlan 的异步自动注入竞态） ----------
const lib = mkdtempSync(join(tmpdir(), 'mem-e2e-'))
mkdirSync(join(lib, 'memories'), { recursive: true })
mkdirSync(join(lib, 'pinned'), { recursive: true })
writeFileSync(join(lib, 'memories', 'm_conv_e2e.md'), [
  '---',
  'id: "m_conv_e2e"',
  'title: "端到端规约"',
  'impressions: ["规约","e2e"]',
  'tags: ["convention"]',
  'links: []',
  'composedOf: []',
  'sourceSession: null',
  'sourceSeqs: []',
  'createdAt: 1',
  'updatedAt: 1',
  'revision: 1',
  'enabled: true',
  '---',
  '',
  '## 快照',
  '',
  'E2E-CONVENTION-BODY 端到端规约正文',
  '',
  '<!-- mem:notes -->',
  '',
  'E2E-NOTES 标注层',
  '',
].join('\n'))
writeFileSync(join(lib, 'pinned', 'plan.json'), JSON.stringify({
  pinned: [{ id: 'pin-e2e', role: 'pin', text: 'E2E-PIN 固定消息', at: 1 }],
  memories: [{ id: 'm_conv_e2e', title: '端到端规约', impressions: ['规约'], tags: ['convention'] }],
  injectOnce: false,
}))

// ---------- 真实拓扑 + 插件 + mock LLM 适配器 ----------
const ctx = new Context()
await mountAgentLoopTestDependencies(ctx)

// 让插件的 HTTP 通道与 LLM 辅助链路都能跑：webServer 路由 + 默认模型选择
const routes = []
ctx.provide('webServer', { register: (route) => { routes.push(route); return () => {} } })
ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'mock', model: 'mock' }) })

const plugin = await import(new URL('../lib/index.js', import.meta.url).href)
ctx.plugin(plugin, {
  enabled: true,
  mode: 'on',
  view: 'full',
  modelTools: false,
  libraryPath: lib,
  memoryChars: 6000,
  totalChars: 12000,
  pinChars: 6000,
  autoInjectConvention: true,
})

const captured = []
class MockAdapter extends LlmAdapter {
  async *stream(options) {
    captured.push(options)
    yield { type: 'text-delta', index: 0, text: '收到。' }
    yield { type: 'finish', kind: 'stop' }
  }
}
ctx.llm.registerAdapter(['mock'], new MockAdapter())

// 等插件完成启动扫描（install 里的 scanLibrary 是 fire-and-forget）
await new Promise((resolve) => setTimeout(resolve, 300))

const harness = await mountAgentLoopTestHarness(ctx)
const agent = await harness.create(SessionId('mem-e2e'), { provider: 'mock', model: 'mock' })

agent.followup(createUserMessage({ content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } }))
if (typeof agent.whenIdle === 'function') await agent.whenIdle()
else await new Promise((resolve) => setTimeout(resolve, 500))
// whenIdle 之后请求已经发出；给捕获数组一个稳定点
for (let i = 0; i < 20 && captured.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 50))

check('真实 AgentLoop 发出了一次模型请求', captured.length >= 1, `count=${captured.length}`)

const request = captured[0]
const messages = (request && request.messages) || []
const injected = messages.find((m) => m && m.source && (m.source.kind === 'memory-manager'
  || (m.source.kind === 'plugin' && m.source.plugin === 'memory-manager')))
check('请求里存在本插件注入的消息（source.kind === memory-manager）', Boolean(injected),
  messages.map((m) => (m && m.source ? m.source.kind : '?')).join(','))

if (injected) {
  const text = Array.isArray(injected.content)
    ? injected.content.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n')
    : ''
  check('注入消息携带 form:snapshot 与 sections（0.2.0 契约）',
    injected.source.form === 'snapshot' && Array.isArray(injected.source.sections)
    && injected.source.sections[0] && injected.source.sections[0].name === 'memory-manager:context',
    JSON.stringify(injected.source).slice(0, 160))
  check('注入正文包含计划里的记忆与固定消息',
    text.includes('端到端规约') && text.includes('E2E-CONVENTION-BODY') && text.includes('E2E-PIN'),
    text.slice(0, 160))
  check('注入被包裹在记忆库上下文中',
    text.includes('=== 记忆库上下文') && text.includes('记忆库上下文结束'))
  check('注入消息的 role 为 user（0.2.0 表面要求可上表面事件携带 surfaceOp）', injected.role === 'user', String(injected.role))
}

// ---------- 注入消息已作为 user/message 表面事件落盘 ----------
{
  const events = agent.session.snapshotEvents ? agent.session.snapshotEvents() : []
  const injectedEvents = events.filter((e) => e.type === 'user/message'
    && e.data && e.data.source && e.data.source.kind === 'memory-manager')
    check('注入消息已写入会话日志（user/message + surfaceOp:append）',
      injectedEvents.length >= 1 && injectedEvents.every((e) => e.surfaceOp === 'append'),
      `events=${injectedEvents.length} op=${injectedEvents.map((e) => e.surfaceOp).join(',')}`)
    const human = events.filter((e) => e.type === 'user/message' && e.data && e.data.source && e.data.source.kind === 'user')
    check('人类消息与注入消息在日志中可区分', human.length === 1 && injectedEvents.length === 1,
      `human=${human.length} injected=${injectedEvents.length}`)
}

// ---------- 第二步（工具结果 step）不应重复注入 ----------
{
  const before = captured.length
  agent.followup(createUserMessage({ content: [{ type: 'text', text: '再来一次' }], source: { kind: 'user' } }))
  if (typeof agent.whenIdle === 'function') await agent.whenIdle()
  for (let i = 0; i < 20 && captured.length <= before; i++) await new Promise((resolve) => setTimeout(resolve, 50))
  const second = captured[captured.length - 1]
  const secondInjected = ((second && second.messages) || []).filter((m) => m && m.source && m.source.kind === 'memory-manager')
  check('第二轮请求同样注入（mode:on 每轮注入一次）', secondInjected.length >= 1, `count=${secondInjected.length}`)
}

// ---------- LLM 辅助链路：插件经真实 ctx.llm.stream 调用（记忆建议） ----------
{
  const route = routes.find((r) => r.kind === 'exact' && r.path === '/_dsh/memory-manager/api')
  check('webServer 路由在真实 Cordis 中注册', Boolean(route), routes.map((r) => r.path).join(','))
  const post = async (body) => {
    const req = { method: 'POST' }
    const chunks = [Buffer.from(JSON.stringify(body))]
    req[Symbol.asyncIterator] = async function* () { yield* chunks }
    const out = { headers: {}, setHeader(k, v) { this.headers[k] = v }, writeHead(s) { out.status = s }, end(t) { out.body = t } }
    await route.handler(req, out)
    return JSON.parse(out.body)
  }
  const before = captured.length
  const res = await post({ op: 'memory.suggest', args: { content: '这是一段用于生成印象的记忆内容' } })
  check('memory.suggest 经真实 ctx.llm.stream 完成（LLM 辅助链路可用）',
    Boolean(res && res.value && Array.isArray(res.value.impressions) && res.value.impressions.length >= 1),
    JSON.stringify(res))
  check('LLM 辅助调用确实打到了适配器', captured.length === before + 1, `before=${before} after=${captured.length}`)
  const llmRequest = captured[captured.length - 1]
  check('插件调用 ctx.llm.stream 时用 provider/model + system + maxTokens',
    Boolean(llmRequest) && llmRequest.provider === 'mock' && llmRequest.model === 'mock'
    && typeof llmRequest.system === 'string' && typeof llmRequest.maxTokens === 'number',
    JSON.stringify({ provider: llmRequest && llmRequest.provider, model: llmRequest && llmRequest.model, maxTokens: llmRequest && llmRequest.maxTokens }))
  check('LLM 辅助消息携带插件自己的 MessageSource.kind（0.2.0 无通用 plugin kind）',
    Boolean(llmRequest) && llmRequest.messages[0] && llmRequest.messages[0].source
    && llmRequest.messages[0].source.kind === 'memory-manager',
    JSON.stringify(llmRequest && llmRequest.messages[0] && llmRequest.messages[0].source))
}

await ctx.dispose?.()
const failed = results.filter((ok) => !ok).length
console.log(failed ? `[test] FAILED: ${failed}/${results.length}` : `[test] ALL PASS (${results.length})`)
process.exit(failed ? 1 : 0)

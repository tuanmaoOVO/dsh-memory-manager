// 客户端 bundle 冒烟测试：mock 浏览器环境执行 factory，并用 react-dom/server 渲染所有组件
// 验证：bundle 可加载、apply 可执行、每个组件 SSR 渲染无 hooks 违规/渲染异常
// 用法：node tests/smoke-client.mjs
//   环境变量 DSH_TEST_DEPS：指向含 react / react-dom 的 node_modules 目录（默认仓库自身 node_modules）
//   环境变量 DSH_TEST_CLIENT：指向要测试的 client bundle（默认本仓库 lib/client.js）
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const depsPkg = process.env.DSH_TEST_DEPS
  ? path.join(process.env.DSH_TEST_DEPS, 'react', 'package.json')
  : fileURLToPath(new URL('../node_modules/react/package.json', import.meta.url))
if (!fs.existsSync(depsPkg)) throw new Error('未找到 react 依赖：' + depsPkg + '（设置 DSH_TEST_DEPS 指向含 react 的 node_modules 目录）')
const requireDsh = createRequire(depsPkg)

const errors = []
const ok = (msg) => console.log('[ok] ' + msg)
const fail = (msg, e) => { errors.push(msg); console.error('[FAIL] ' + msg + (e ? ' :: ' + (e && e.message) : '')) }

// ---------- mock 浏览器环境 ----------
let factory = null
global.window = {
  __ModuleLoader__: { load: (opts) => { factory = opts.factory } },
  __memErrCapInstalled: false,
  addEventListener: () => {},
}
global.document = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, style: {}, textContent: '', remove() {} }),
  head: { appendChild: () => {} },
}
global.fetch = async () => ({ json: async () => ({ ok: true, value: {} }) })
global.confirm = () => true

// ---------- 注入测试导出并加载 ----------
const clientPath = process.env.DSH_TEST_CLIENT || fileURLToPath(new URL('../lib/client.js', import.meta.url))
let src = fs.readFileSync(clientPath, 'utf8')
const injectPoint = 'return module.exports; } });'
if (!src.includes(injectPoint)) throw new Error('注入点未找到')
src = src.replace(injectPoint,
  'module.exports.__test = { Panel, PlanTab, LibraryTab, MessagesTab, GraphTab, SaveDialog, ComposeDialog, EditDialog, InputButton, SettingsSection, Boundary, MessageActions, Switch, IconBtn };\n' + injectPoint)
eval(src)
if (!factory) throw new Error('factory not captured')
const mod = factory(requireDsh)
ok('bundle factory executed')
const T = mod.__test
if (!T || !T.Panel) throw new Error('测试导出缺失')
ok('test exports available')

// ---------- mock DSH client ctx ----------
const registered = []
const slots = {
  inject: (name, fn) => { const unreg = fn(); registered.push(name); if (typeof unreg === 'function') unreg() },
  register: () => () => {},
}
const ctx = {
  get(name) { if (name === 'slots') return slots; return undefined },
  effect: (fn) => { const r = fn(); if (typeof r === 'function') r() },
}
const disposer = mod.apply(ctx)
if (typeof disposer !== 'function') fail('apply 应返回 disposer 函数')
else ok('apply returned disposer; slots: ' + registered.join(', '))

// ---------- SSR 渲染所有组件 ----------
const React = requireDsh('react')
const { renderToString } = requireDsh('react-dom/server')
const h = React.createElement

const sampleMem = { id: 'm_test1', title: '测试记忆', impressions: ['标签', '测试'], links: ['m_test2'], composedOf: [], backlinks: ['m_test2'], sourceSession: 's1', createdAt: 0, updatedAt: 0, revision: 1 }
const sampleMem2 = { id: 'm_test2', title: '关联记忆', impressions: ['测试'], links: [], composedOf: [], backlinks: [], sourceSession: null, createdAt: 0, updatedAt: 0, revision: 1 }
const sampleTurn = { turnId: 'abc123', excluded: false, marker: false, nodes: [{ seq: 1, kind: 'user', id: 'n1', preview: '一条消息内容' }, { seq: 2, kind: 'assistant', id: 'n2', preview: '' }] }
const sampleCfg = { enabled: true, mode: 'off', view: 'full', modelTools: true, libraryPath: '/path/to/memory-library', ready: true, reason: '', memoryChars: 6000, totalChars: 12000, pinChars: 6000 }
const samplePlan = { pinned: [{ id: 'p1', role: 'user', text: '固定内容', at: 0 }], memories: [{ id: 'm_test1', title: '测试记忆', impressions: ['标签'] }], excluded: ['t9'], injectOnce: false }
const noop = async () => {}
const cases = [
  ['Panel(加载中)', h(T.Panel, { onClose: () => {} })],
  ['PlanTab', h(T.PlanTab, { config: sampleCfg, plan: samplePlan, refresh: noop })],
  ['LibraryTab', h(T.LibraryTab, { memories: [sampleMem, sampleMem2], refresh: noop })],
  ['MessagesTab', h(T.MessagesTab, { turns: [sampleTurn], planMemories: [sampleMem], refresh: noop })],
  ['GraphTab', h(T.GraphTab, { memories: [sampleMem, sampleMem2], refresh: noop })],
  ['SaveDialog', h(T.SaveDialog, { messageIds: ['n1'], planMemories: [sampleMem], onClose: () => {}, onDone: () => {} })],
  ['ComposeDialog', h(T.ComposeDialog, { ids: ['m_test1', 'm_test2'], onClose: () => {}, onDone: () => {} })],
  ['EditDialog', h(T.EditDialog, { meta: sampleMem, notes: '标注', snapshot: '快照内容', onClose: () => {}, onDone: () => {} })],
  ['SettingsSection(加载中)', h(T.SettingsSection, {})],
  ['InputButton', h(T.InputButton, { sessionId: 's1' })],
  ['MessageActions', h(T.MessageActions, { messageId: 'n1', sessionId: 's1' })],
  ['Switch(on)', h(T.Switch, { on: true, onChange: () => {}, label: '测试开关' })],
  ['Switch(off)', h(T.Switch, { on: false, onChange: () => {}, label: '测试开关' })],
  ['IconBtn', h(T.IconBtn, { title: '动作', onClick: () => {} }, '×')],
]
for (const [name, el] of cases) {
  try {
    const html = renderToString(el)
    if (typeof html !== 'string' || !html.length) fail(name + ' 渲染为空')
    else ok(name + ' 渲染 ' + html.length + ' 字符')
  } catch (e) {
    fail(name + ' 渲染异常', e)
  }
}

// ---------- 按钮文字断言（防「无 children」回归：Btn 必须经 h() 调用） ----------
const btnChecks = [
  ['SaveDialog', h(T.SaveDialog, { messageIds: ['n1'], planMemories: [], onClose: () => {}, onDone: () => {} }), ['取消', '保存', '生成印象建议']],
  ['EditDialog', h(T.EditDialog, { meta: sampleMem, notes: '', snapshot: 'x', onClose: () => {}, onDone: () => {} }), ['删除', '取消', '保存']],
  ['ComposeDialog', h(T.ComposeDialog, { ids: ['m_test1', 'm_test2'], onClose: () => {}, onDone: () => {} }), ['取消', '拼接并保存']],
  ['PlanTab', h(T.PlanTab, { config: sampleCfg, plan: samplePlan, refresh: noop }), ['取消固定', '移除', '恢复']],
  ['LibraryTab', h(T.LibraryTab, { memories: [sampleMem], refresh: noop }), ['刷新', '加入计划', '编辑']],
  ['MessagesTab', h(T.MessagesTab, { turns: [sampleTurn], planMemories: [], refresh: noop }), ['刷新']],
  ['GraphTab', h(T.GraphTab, { memories: [sampleMem], refresh: noop }), ['刷新']],
]
for (const [name, el, texts] of btnChecks) {
  try {
    const html = renderToString(el)
    const missing = texts.filter((t) => !html.includes(t))
    if (missing.length) fail(name + ' 按钮文字缺失: ' + missing.join(', '))
    else ok(name + ' 按钮文字齐全: ' + texts.join('/'))
  } catch (e) {
    fail(name + ' 按钮断言异常', e)
  }
}

// ---------- 结构性检查：无直接组件调用 ----------
const bad = /(?:^|\s)(PlanTab|LibraryTab|MessagesTab|GraphTab|SaveDialog|ComposeDialog|EditDialog|InputButton|SettingsSection|Panel|Boundary)\(\{/.exec(src)
if (bad) fail('存在直接组件调用: ' + bad[0].trim())
else ok('无直接组件调用（hooks 安全）')

disposer && disposer()
if (errors.length) { console.error('\n' + errors.length + ' FAILURE(S)'); process.exit(1) }
console.log('\nALL SMOKE CHECKS PASSED')

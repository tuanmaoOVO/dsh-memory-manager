// 本地集成测试：mock ctx 调用宿主插件 apply，验证安装路径
// 用法：node tests/test-apply.mjs [插件模块路径]
//   默认加载本仓库 lib/index.js；依赖解析见 docs/DEVELOPMENT.md（需 DSH 依赖可解析或设置 NODE_PATH）
import { pathToFileURL } from 'node:url'
const argPath = process.argv[2]
const modUrl = argPath
  ? (argPath.startsWith('file:') ? argPath : pathToFileURL(argPath).href)
  : new URL('../lib/index.js', import.meta.url).href
const mod = await import(modUrl)

let cfg = {}
const settingsService = {
  register(ns, schema, opts) {
    console.log('[mock] settings.register')
    return {
      get: () => ({ ...cfg }),
      watch: () => () => {},
      dispose: () => {},
    }
  },
  update: async (ns, patch) => { Object.assign(cfg, patch); return { ok: true } },
}
const httpServer = {
  register: (r) => { console.log('[mock] webServer.register:', r.path); return () => {} },
}
const registry = {
  settings: settingsService,
  tools: { register: (t) => { console.log('[mock] tool registered:', t && t.name); return () => {} } },
  systemPrompt: { section: (s) => { console.log('[mock] section registered:', s && s.name); return () => {} } },
  webServer: httpServer,
  sessionQuery: {
    readSession: async (id) => ({ session: { id }, events: [] }),
  },
}
const ctx = {
  get(name) {
    if (name === 'settings') return registry.settings
    if (name === 'tools') return registry.tools
    if (name === 'systemPrompt') return registry.systemPrompt
    if (name === 'sessionQuery') return registry.sessionQuery
    return undefined
  },
  inject(names, cb) {
    if (names.includes('webServer')) {
      const sub = {
        webServer: httpServer,
        effect: (fn) => { const r = fn(); return () => { if (typeof r === 'function') r() } },
      }
      cb(sub)
      return () => {}
    }
    return () => {}
  },
  on() { return () => {} },
  logger: { info() {}, warn() {}, error(...a) { console.error('[logger]', ...a) } },
  root: {},
}

const disposer = await mod.apply(ctx, {})
console.log('[test] apply completed, disposer:', typeof disposer)
await disposer()
console.log('[test] dispose OK')

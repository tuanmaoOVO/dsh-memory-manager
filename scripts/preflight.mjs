#!/usr/bin/env node
// @dsh-external/dsh-memory-manager — 安装前自检（preflight）
//
// 目的：把「装上这个插件不会影响 DSH 本体」变成**可机械验证**的检查，而不是一句承诺。
// 分三组：
//   A. 包自洽（离线）      —— 装上去能跑得起来，不会因为缺文件把宿主组合搞坏
//   B. 只增不改（离线）    —— bundle patch / peer 声明只影响自己这一行，不动 profile 其它行
//   C. 模块与 bundle 形状  —— 宿主侧模块可解析；客户端 bundle 抛错也不会波及同一批脚本里的其它包
//   D. 与检出对照（可选）  —— 需要 DSH 检出路径：插槽/工具/HTTP 路径都不与官方冲突
//
// 用法：
//   node scripts/preflight.mjs                       # 只跑离线组（A/B/C）
//   node scripts/preflight.mjs <dsh-checkout-root>   # 追加 D 组
//   DSH_ROOT=<dsh-checkout-root> node scripts/preflight.mjs
// 退出码：0 = 全部通过（含 skip），1 = 有 FAIL。
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const packageRoot = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
const read = (rel) => readFileSync(join(packageRoot, rel), 'utf8')
const has = (rel) => existsSync(join(packageRoot, rel))

const results = []
const fail = []
const section = (title) => console.log(`\n== ${title} ==`)
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '[ok]  ' : '[FAIL]'} ${label}${detail ? '  — ' + detail : ''}`)
  results.push(ok)
  if (!ok) fail.push(label)
}
const skip = (label, why) => console.log(`[skip] ${label}  — ${why}`)

// ================= A. 包自洽 =================
section('A. 包自洽（离线）')
let pkg
try {
  pkg = JSON.parse(read('package.json'))
  check('package.json 可解析', true)
} catch (error) {
  check('package.json 可解析', false, String(error.message))
  console.log('\n无法继续：package.json 损坏')
  process.exit(1)
}
check('包名在自有命名空间（不遮蔽官方 @deepseek-ai/* 包）',
  typeof pkg.name === 'string' && !pkg.name.startsWith('@deepseek-ai/'), String(pkg.name))
check('声明了 dsh.bundle.patch（bundle 的唯一识别方式）',
  Boolean(pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch), JSON.stringify(pkg.dsh && pkg.dsh.bundle))
{
  const patch = pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch
  const paths = Array.isArray(patch) ? patch : patch === undefined ? [] : [patch]
  check('bundle patch 文件存在', paths.length > 0 && paths.every((p) => has(p)), paths.join(', '))
}
check('未声明 dsh.profile（永远不能充当/替换 profile 组合）',
  !(pkg.dsh && pkg.dsh.profile), JSON.stringify(pkg.dsh && pkg.dsh.profile))
{
  const targets = []
  const walk = (value) => {
    if (typeof value === 'string') { targets.push(value); return }
    if (value && typeof value === 'object') for (const v of Object.values(value)) walk(v)
  }
  walk(pkg.exports ?? {})
  if (typeof pkg.main === 'string') targets.push(pkg.main)
  const missing = targets.filter((t) => t.startsWith('./') && !has(t))
  check('exports / main 指向的文件都存在（客户端 bundle 缺失会让宿主模块图整体失败）',
    missing.length === 0, missing.join(', '))
}
{
  // files 白名单必须覆盖所有被 exports / main / bundle patch 引用的路径
  const listed = Array.isArray(pkg.files) ? pkg.files : []
  const covered = (rel) => listed.some((entry) => rel === entry || rel.startsWith(entry.replace(/\/$/, '') + '/'))
  const needed = ['cordis.patch.yml']
  if (typeof pkg.main === 'string') needed.push(pkg.main)
  const clientExport = pkg.exports && pkg.exports['./client']
  if (typeof clientExport === 'string') needed.push(clientExport)
  else if (clientExport && typeof clientExport === 'object') for (const v of Object.values(clientExport)) if (typeof v === 'string') needed.push(v)
  const uncovered = needed.filter((rel) => !covered(rel.replace(/^\.\//, '')))
  check('files 白名单覆盖 patch / main / client（否则 npm 打包会漏文件）',
    uncovered.length === 0, uncovered.join(', '))
}
check('运行时依赖已声明（profile 安装会带上）',
  Boolean(pkg.dependencies && Object.keys(pkg.dependencies).length > 0), JSON.stringify(pkg.dependencies))

// ================= B. 只增不改 =================
section('B. 只增不改（离线）')
let patchText = ''
{
  const patch = pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch
  const path = Array.isArray(patch) ? patch[0] : patch
  patchText = path && has(path) ? read(path) : ''
}
check('bundle patch 只使用 insert（不 remove / 不覆盖既有行）',
  /^\s*-\s*insert:/m.test(patchText)
  && !/^\s*-\s*(remove|replace|update|override)\s*:/m.test(patchText),
  patchText.split('\n').filter((l) => l.trim().startsWith('-')).join(' | '))
{
  const idMatch = /^\s*-\s*id:\s*(\S+)\s*$/m.exec(patchText)
  const nameMatch = /^\s*name:\s*['"]?([^'"\n]+)['"]?\s*$/m.exec(patchText)
  check('插入行 id 与 name 正确（name 必须等于本包名）',
    Boolean(idMatch) && Boolean(nameMatch) && nameMatch[1].trim() === pkg.name,
    `id=${idMatch ? idMatch[1] : '?'} name=${nameMatch ? nameMatch[1].trim() : '?'}`)
  check('插入行未预设 disabled（安装即启用，可被插件页一键关闭）',
    !/^\s*disabled:\s*true\s*$/m.test(patchText))
  check('插入行不覆盖任何既有 id（id 为本插件专属）',
    Boolean(idMatch) && idMatch[1] === 'memory-manager', idMatch ? idMatch[1] : '?')
}
{
  const dshPeers = Object.entries(pkg.peerDependencies ?? {}).filter(([n]) => n === '@deepseek-ai/dsh' || n.startsWith('@deepseek-ai/dsh-'))
  const optionalMeta = pkg.peerDependenciesMeta ?? {}
  const notOptional = dshPeers.filter(([n]) => !(optionalMeta[n] && optionalMeta[n].optional === true)).map(([n]) => n)
  check('所有 DSH peer 都是 optional（不满足时只拒绝本 bundle，不影响其它行）',
    notOptional.length === 0, notOptional.join(', '))
  check('DSH peer 范围宽松（不会因版本区间过窄被宿主拒绝装载）',
    dshPeers.every(([, range]) => typeof range === 'string' && /[<>]=?|\^|~|\*|x/.test(range)),
    dshPeers.map(([n, r]) => `${n}@${r}`).join(', '))
}

// ================= C. 模块与 bundle 形状 =================
section('C. 模块与 bundle 形状（离线）')
{
  const entry = (pkg.exports && pkg.exports['.']) ?? pkg.main
  const mainRel = typeof entry === 'string' ? entry.replace(/^\.\//, '') : String(entry && entry.default).replace(/^\.\//, '')
  const mod = await import(pathToFileURL(join(packageRoot, mainRel)).href)
  check('宿主模块可被 import（Cordis 加载的前提）', typeof mod.apply === 'function')
  check('导出 name 等于包名', mod.name === pkg.name, String(mod.name))
  check('inject 只声明核心服务（缺失即降级，不阻断启动）',
    Array.isArray(mod.inject) && mod.inject.every((s) => ['tools', 'settings', 'webServer', 'sessionQuery', 'agents', 'llm'].includes(s)),
    JSON.stringify(mod.inject))
  check('导出 schemastery Config（DSH 0.2.0 设置页据此投影 volatile 字段）',
    Boolean(mod.Config) && typeof mod.Config.toJSON === 'function')
}
{
  const clientRel = pkg.exports && pkg.exports['./client']
  const rel = (typeof clientRel === 'string' ? clientRel : clientRel && clientRel.default).replace(/^\.\//, '')
  const src = read(rel)
  const head = new RegExp('^window\\.__ModuleLoader__\\.load\\(\\{\\s*id:\\s*"' + pkg.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '",\\s*factory:')
  check('客户端 bundle 是标准 load({id: <包名>, factory}) 注册（id 必须等于包名）',
    head.test(src), src.split('\n')[0].slice(0, 100))
  check('bundle 只有这一条顶层语句（工厂体抛错不会中断同批其它包）',
    /return module\.exports; \} \}\);?\s*$/.test(src))
  check('工厂体整体包在 try/catch 内且已装惰性 exports（最终兜底：插件静默不可用而非报错）',
    src.includes('exports.apply = function () { return () => {}; };') && /try \{[\s\S]*\} catch \(e\) \{/.test(src))
  check('exports.inject 声明 slots（否则内核扣留插槽座位）',
    /exports\.inject\s*=\s*\[[^\]]*"slots"/.test(src))
  check('每个注册都包在 slots.inject 内（注册进未声明槽位会在激活期抛错）',
    (src.match(/slots\.inject\(/g) || []).length >= 6)
}

// ================= D. 与检出对照（可选） =================
section('D. 与 DSH 检出对照（可选）')
const checkout = String(process.argv[2] || process.env.DSH_ROOT || '').replace(/\\/g, '/').replace(/\/+$/, '')
if (!checkout) {
  skip('插槽 / 工具 / 客户端包名对照', '未提供 DSH 检出路径（参数或 DSH_ROOT）')
} else if (!existsSync(checkout)) {
  check('DSH 检出路径存在', false, checkout)
} else {
  check('DSH 检出路径存在', true, checkout)

  // 用 DSH **自己的准入校验**（app-boot 的 evaluatePluginCompatibility）判定：
  // 它在装载 profile 时对每个 bundle 的 @deepseek-ai/dsh-* peer 调用的就是这一段。
  // 需要该检出已构建 packages/boot/app-boot/lib/index.js。
  const appBoot = `${checkout}/packages/boot/app-boot/lib/index.js`
  if (!existsSync(appBoot)) {
    skip('peer 兼容性（DSH 权威校验）', `${appBoot} 不存在（先在该检出 pnpm run build:lib:host）`)
  } else {
    try {
      const boot = await import(pathToFileURL(appBoot).href)
      const runtime = boot.getDshRuntimeVersion()
      const issue = boot.evaluatePluginCompatibility(pkg, {}, runtime)
      check(`DSH ${runtime} 的准入校验放行本插件（evaluatePluginCompatibility 返回 undefined）`,
        issue === undefined,
        issue ? `不满足的 peer: ${JSON.stringify(issue.peers)}` : '')
      console.log(`       运行版本：${runtime}（对照来源 ${checkout}）`)
    } catch (error) {
      check('DSH 权威准入校验可执行', false, String((error && error.message) || error))
    }
  }

  const pkgPathOf = (name) => {
    if (name.startsWith('@deepseek-ai/dsh-client-')) return `${checkout}/packages/client/${name.slice('@deepseek-ai/dsh-client-'.length)}`
    if (name.startsWith('@deepseek-ai/dsh-api-')) return `${checkout}/packages/api/${name.slice('@deepseek-ai/dsh-api-'.length)}`
    return null
  }
  const declared = (pkg.dsh && pkg.dsh.client && pkg.dsh.client.inject) || []
  const badInject = []
  for (const name of declared) {
    const dir = pkgPathOf(name)
    if (dir === null || !existsSync(`${dir}/package.json`)) { badInject.push(name); continue }
    const meta = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8'))
    if (meta.name !== name || !(meta.dsh && meta.dsh.client && meta.dsh.client.platform === 'web')) badInject.push(name)
  }
  check('dsh.client.inject 的每个包都存在且声明 dsh.client', badInject.length === 0, badInject.join(', '))

  // 生成的插槽目录：kind / replaceRisk / 已占用 id
  const catalogPath = `${checkout}/packages/extensions/cordis-client-runner/src/client/slot-catalog.ts`
  if (!existsSync(catalogPath)) {
    skip('插槽 kind / 占用对照', `${catalogPath} 不存在`)
  } else {
    const catalog = readFileSync(catalogPath, 'utf8')
    const entryOf = (key) => {
      const start = catalog.indexOf(`key: '${key}',`)
      if (start < 0) return null
      const rest = catalog.slice(start)
      const next = rest.indexOf("\n  {\n    key: '", 1)
      return next < 0 ? rest : rest.slice(0, next)
    }
    const ours = [
      ['conversation.input.left', 'memory-panel-toggle'],
      ['conversation.session.header.actions', 'memory-manager-jump-receiver'],
      ['shell.overlay', 'memory-panel'],
      ['settings.section', 'memory-manager'],
      ['conversation.chat.assistant-actions', 'memory-manager-message-actions'],
    ]
    const notList = []
    const shadowing = []
    const colliding = []
    for (const [key, id] of ours) {
      const block = entryOf(key)
      if (block === null) { notList.push(`${key}(未找到)`); continue }
      const kind = /kind: '([^']+)'/.exec(block)
      if (!kind || kind[1] !== 'list') notList.push(`${key}:${kind ? kind[1] : '?'}`)
      const risk = /replaceRisk: '([^']+)'/.exec(block)
      if (risk && risk[1] === 'shadows-shipped-ui') shadowing.push(key)
      const occ = /occupants: \[([^\]]*)\]/.exec(block)
      const occupied = occ ? occ[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean) : []
      if (occupied.includes(id)) colliding.push(`${key} <- ${id}`)
    }
    check('5 个目标槽位在 0.2.0 目录中都是 list 型（只增不替换）', notList.length === 0, notList.join(', '))
    check('目标槽位均非 shadows-shipped-ui（不遮蔽官方 UI）', shadowing.length === 0, shadowing.join(', '))
    check('我们的 entry id 未占用官方已注册的 id（不替换官方条目）', colliding.length === 0, colliding.join(', '))
  }

  // 工具目录：模型可见工具名不得与官方重名
  const toolCatalog = `${checkout}/docs/tool-catalog.md`
  if (!existsSync(toolCatalog)) {
    skip('工具名对照', `${toolCatalog} 不存在`)
  } else {
    const shipped = new Set([...readFileSync(toolCatalog, 'utf8').matchAll(/^### `([^`]+)`/gm)].map((m) => m[1]))
    const ours = ['memory_search', 'memory_recall', 'memory_save', 'memory_set_enabled', 'session_inject', 'memory_pin']
    const clash = ours.filter((n) => shipped.has(n))
    check('6 个模型工具名不与官方工具重名', clash.length === 0, clash.join(', '))
    check('工具目录可读（对照基准存在）', shipped.size > 0, `shipped=${shipped.size}`)
  }
}

// ================= 汇总 =================
const total = results.length
console.log(`\n${fail.length ? `[FAIL] ${fail.length}/${total} 项未通过：\n  - ` + fail.join('\n  - ') : `[OK] 全部通过（${total} 项）`}`)
if (!checkout) console.log('提示：附带 DSH 检出路径可追加插槽 / 工具 / 包名对照（node scripts/preflight.mjs <dsh-checkout-root>）')
process.exit(fail.length ? 1 : 0)

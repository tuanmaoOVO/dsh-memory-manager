// @dsh-external/dsh-memory-manager — 记忆库（纯文件层，零 DSH 服务依赖）
// 记忆库 = Markdown 文件 + front-matter（Obsidian 兼容）；「不可变快照 + 可编辑标注层」。
// DSH 仅用于解析「默认记忆库锚点」（workspaceRegistry → agents 会话 cwd），全部 ctx.get 可选读取。

import { readText, writeText, listDir, removeFile, norm } from './util.js'

/**
 * 在 manager 对象上安装记忆库能力。
 * @param m - 共享状态 { ctx, cfg, memoryIndex, backlinkIndex, log, logger }（见 lib/index.js）
 */
export function installMemory(m) {
  // ================= 记忆库路径 =================
  m.defaultLibraryPath = function defaultLibraryPath() {
    // 1) workspaceRegistry（0.1.2 起为 ctx.workspaceRegistry；旧版为 workspaceRegistry 服务，用法一致）
    const ws = m.ctx.get('workspaceRegistry') ?? m.ctx.get('workspaceRegistry', false)
    if (ws !== undefined) {
      try {
        const list = ws.list()
        if (list && list.length && list[0].path) return String(list[0].path).replace(/[\\/]+$/, '') + '/.dsh-memory'
      } catch { /* 降级到下一个锚点 */ }
    }
    // 2) 任一 agent 的会话 cwd（agent.session.header.cwd；旧版为 roots/list 的 session.header.cwd）
    const agents = m.ctx.get('agents') ?? m.ctx.get('agents', false)
    if (agents !== undefined) {
      try {
        const list = agents.list ? agents.list() : []
        for (const agent of list) {
          const cwd = agent && agent.session && agent.session.header ? agent.session.header.cwd : undefined
          if (cwd) return String(cwd).replace(/[\\/]+$/, '') + '/.dsh-memory'
        }
        const roots = agents.roots ? agents.roots() : []
        for (const root of roots) {
          const cwd = root && root.session && root.session.header && root.session.header.cwd
          if (cwd) return String(cwd).replace(/[\\/]+$/, '') + '/.dsh-memory'
        }
      } catch { /* 降级 */ }
    }
    return null
  }
  m.libPath = function libPath() {
    if (!m.cfg.libraryPath) {
      const d = m.defaultLibraryPath()
      if (d) m.cfg.libraryPath = d
    }
    return norm(m.cfg.libraryPath)
  }

  // ================= front-matter 解析 / 序列化 =================
  m.parseFrontMatter = function parseFrontMatter(text) {
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
    if (!match) return null
    const meta = {}
    for (const line of match[1].split(/\r?\n/)) {
      const i = line.indexOf(':')
      if (i <= 0) continue
      const k = line.slice(0, i).trim()
      if (!k) continue
      const v = line.slice(i + 1).trim()
      try { meta[k] = JSON.parse(v) } catch { meta[k] = v }
    }
    return { meta, body: match[2] }
  }
  m.parseMemory = function parseMemory(text) {
    const fm = m.parseFrontMatter(text)
    if (!fm || !fm.meta || typeof fm.meta.id !== 'string') return null
    const [snap = '', notes = ''] = fm.body.split('<!-- mem:notes -->')
    return { meta: fm.meta, snapshot: snap.replace(/^## 快照\s*\r?\n/, '').trim(), notes: notes.trim() }
  }
  m.serializeMemory = function serializeMemory(meta, snapshot, notes) {
    const order = ['id', 'title', 'impressions', 'tags', 'links', 'composedOf', 'sourceSession', 'sourceSeqs', 'createdAt', 'updatedAt', 'revision', 'enabled']
    const lines = ['---']
    for (const k of order) if (meta[k] !== undefined) lines.push(`${k}: ${JSON.stringify(meta[k])}`)
    lines.push('---', '', '## 快照', '', snapshot || '', '', '<!-- mem:notes -->', '', notes || '', '')
    return lines.join('\n')
  }

  // ================= 记忆库扫描 / 索引 =================
  m.rebuildBacklinks = function rebuildBacklinks() {
    m.backlinkIndex.clear()
    for (const mem of m.memoryIndex.values()) {
      for (const lid of Array.isArray(mem.meta.links) ? mem.meta.links : []) {
        if (typeof lid !== 'string') continue
        if (!m.backlinkIndex.has(lid)) m.backlinkIndex.set(lid, [])
        m.backlinkIndex.get(lid).push(mem.meta.id)
      }
    }
  }
  m.scanLibrary = async function scanLibrary() {
    m.memoryIndex.clear()
    const dir = m.libPath()
    if (!dir) return
    const entries = await listDir(dir + '/memories')
    for (const e of entries) {
      if (!e || e.type !== 'file' || !/\.md$/.test(String(e.name))) continue
      const text = await readText(dir + '/memories/' + e.name)
      if (text === null) continue
      const mem = m.parseMemory(text)
      if (!mem || !mem.meta || typeof mem.meta.id !== 'string') continue
      m.memoryIndex.set(mem.meta.id, { meta: mem.meta, snapshot: mem.snapshot, notes: mem.notes })
    }
    m.rebuildBacklinks()
  }

  m.writeMemory = async function writeMemory(meta, snapshot, notes) {
    const id = meta.id
    const dir = m.libPath()
    if (!dir) throw new Error('记忆库未配置')
    await writeText(dir + '/memories/' + id + '.md', m.serializeMemory(meta, snapshot, notes))
    m.memoryIndex.set(id, { meta, snapshot, notes })
    m.rebuildBacklinks()
  }
  m.deleteMemoryFile = async function deleteMemoryFile(id) {
    const dir = m.libPath()
    if (!dir) return false
    await removeFile(dir + '/memories/' + id + '.md')
    m.memoryIndex.delete(id)
    m.rebuildBacklinks()
    return true
  }

  // ================= 元数据视图 =================
  m.memoryMetaOf = function memoryMetaOf(mem) {
    const links = Array.isArray(mem.meta.links) ? mem.meta.links.map(String) : []
    const backlinks = (m.backlinkIndex.get(mem.meta.id) || []).map(String)
    return {
      id: String(mem.meta.id),
      title: String(mem.meta.title ?? ''),
      impressions: Array.isArray(mem.meta.impressions) ? mem.meta.impressions.map(String) : [],
      tags: Array.isArray(mem.meta.tags) ? mem.meta.tags.map(String) : [],
      enabled: mem.meta.enabled !== false,
      links,
      composedOf: Array.isArray(mem.meta.composedOf) ? mem.meta.composedOf.map(String) : [],
      sourceSession: mem.meta.sourceSession ?? null,
      sourceSeqs: Array.isArray(mem.meta.sourceSeqs) ? mem.meta.sourceSeqs.map(Number).filter(Number.isFinite) : [],
      createdAt: mem.meta.createdAt ?? null,
      updatedAt: mem.meta.updatedAt ?? null,
      revision: mem.meta.revision ?? 1,
      backlinks,
    }
  }

  // ================= 链式回忆（BFS，links + backlinks） =================
  m.relatedOf = function relatedOf(id, depth, limit) {
    const seen = new Set([id])
    const out = []
    let frontier = [id]
    for (let d = 1; d <= depth && frontier.length && out.length < limit; d++) {
      const next = []
      for (const cur of frontier) {
        const mem = m.memoryIndex.get(cur)
        if (!mem) continue
        const links = Array.isArray(mem.meta.links) ? mem.meta.links.map(String) : []
        const backs = m.backlinkIndex.get(cur) || []
        for (const lid of [...links, ...backs]) {
          if (seen.has(lid) || !m.memoryIndex.has(lid)) continue
          seen.add(lid)
          const t = m.memoryIndex.get(lid)
          out.push({
            id: lid,
            title: String(t.meta.title || lid),
            impressions: Array.isArray(t.meta.impressions) ? t.meta.impressions.map(String) : [],
            distance: d,
          })
          next.push(lid)
          if (out.length >= limit) break
        }
        if (out.length >= limit) break
      }
      frontier = next
    }
    return out
  }
}

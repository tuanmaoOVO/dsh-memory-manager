// @dsh-external/dsh-memory-manager — 通用工具（零 DSH 依赖，纯 Node/浏览器无关）
// 该模块刻意不 import 任何 @deepseek-ai/* 包：跨版本适配的前提是
// 「可移植逻辑」与「DSH 集成面」分离。DSH 版本升级时只需检查 lib/index.js 的装配层。

import { appendFileSync } from 'node:fs'
import { readFile, writeFile, readdir, mkdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

// ================= 日志（宿主落盘，不依赖任何 DSH 服务） =================
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
export const LOG_FILE = process.env.DSH_MEMORY_LOG_DIR
  ? join(process.env.DSH_MEMORY_LOG_DIR, 'memory-manager-boot.log')
  : join(DSH_HOME, 'memory-manager-boot.log')
export const CLIENT_LOG_FILE = process.env.DSH_MEMORY_LOG_DIR
  ? join(process.env.DSH_MEMORY_LOG_DIR, 'memory-manager-client.log')
  : join(DSH_HOME, 'memory-manager-client.log')

export function logLine(line) {
  try { appendFileSync(LOG_FILE, new Date().toISOString() + ' ' + line + '\n') } catch { /* 日志失败绝不抛出 */ }
}
export function logClientLine(line) {
  try { appendFileSync(CLIENT_LOG_FILE, line + '\n') } catch { /* ignore */ }
}
export function logError(error) {
  try {
    appendFileSync(LOG_FILE, new Date().toISOString() + ' ERROR '
      + (error instanceof Error ? (error.stack || error.message) : String(error)) + '\n')
  } catch { /* ignore */ }
}

// ================= 记忆 id 与基础工具 =================
export const MEM_ID_RE = /^[A-Za-z0-9_-]{3,64}$/

export const rand = (n = 8) => Math.random().toString(36).slice(2, 2 + n)
export const uid = (prefix) => `${prefix}_${rand(10)}`
export const now = () => Date.now()
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
export const textOf = (blocks) => (blocks || []).filter((b) => b && b.type === 'text').map((b) => b.text).join('\n').trim()
export const preview = (s, n = 120) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}
export const norm = (p) => (p ? String(p).replace(/[\\/]+$/, '') : null)

// ================= 文件系统（node 直读，不依赖 ctx.fs —— 隔离官方 fs 策略变化） =================
export async function readText(p) { try { return await readFile(p, 'utf8') } catch { return null } }
export async function readJson(p) { const t = await readText(p); if (t === null) return null; try { return JSON.parse(t) } catch { return null } }
export async function writeText(p, content) { await mkdir(join(p, '..'), { recursive: true }); await writeFile(p, content, 'utf8') }
export async function writeJson(p, obj) { await writeText(p, JSON.stringify(obj, null, 2)) }
export async function listDir(p) {
  try {
    const entries = await readdir(p, { withFileTypes: true })
    return entries.map((e) => ({ name: e.name, type: e.isDirectory() ? 'directory' : 'file' }))
  } catch { return [] }
}
export async function removeFile(p) { try { await rm(p, { force: true }) } catch { /* ignore */ } }

// ================= 字段清洗（记忆库数据契约，独立于 DSH） =================
export function sanitizeImpressions(v) {
  if (!Array.isArray(v)) return []
  return v.map((s) => String(s).trim()).filter((s) => s && s.length <= 40).slice(0, 12)
}
export function sanitizeIds(v) {
  if (!Array.isArray(v)) return []
  const out = []
  for (const s of v) {
    const t = String(s).trim()
    if (MEM_ID_RE.test(t) && !out.includes(t)) out.push(t)
  }
  return out
}

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

// ================= 消息来源标识（DSH 0.2.0 起不再有通用 'plugin' kind） =================
// 0.2.0 的 `MessageSource` 是 merge-extensible 判别联合，注释明确写着
// 「there is no shared catch-all `plugin` kind」——每个生产者声明自己的 kind
// （官方 time-context 即 `source: { kind: 'time-context', form: 'snapshot', … }`）。
// 本插件因此使用 `kind: 'memory-manager'` 作为自己的生产者标识。
/** 本插件在 MessageSource.kind 上声明的生产者标识 */
export const PLUGIN_KIND = 'memory-manager'
/** 0.1.x 的通用生产者 kind（历史会话里已写入的旧事件必须仍可识别） */
export const LEGACY_PLUGIN_KIND = 'plugin'
/**
 * 判断一个 MessageSource 是否由本插件产生。
 * 同时接受 0.2.0 的 `{kind:'memory-manager'}` 与 0.1.x 的
 * `{kind:'plugin', plugin:'memory-manager'}`：升级后旧会话日志里已落盘的
 * 排除标记 / 注入消息必须继续被识别，否则「恢复轮次」会失效。
 * @param source - 事件/消息的 source 字段
 * @returns 是否为本插件产生
 */
export function isOwnSource(source) {
  if (!source || typeof source !== 'object') return false
  if (source.kind === PLUGIN_KIND) return true
  return source.kind === LEGACY_PLUGIN_KIND && source.plugin === PLUGIN_KIND
}

// ================= 配置读取（DSH 0.2.0 的 volatile Config） =================
// 0.2.0 起 `ctx.settings.register(ns, Config, …)` 被移除：设置页直接从插件导出的
// Config schema 投影（只显示 `.volatile()` 标记的字段），运行中的插件读取
// `apply(ctx, config)` 收到的那个 config 引用本身——volatile 字段是
// `{ get(): value }` 引用对象（@deepseek-ai/cosmokit 的 `Volatile<T>`），
// 由内核在配置变更时就地更新并派发 `loader/volatile-update`。
/**
 * 判断一个值是否是 cosmokit 的 Volatile 引用（`Object.freeze({ get })`，唯一键为 `get`）。
 * @param value - 待判定值
 * @returns 是否为 Volatile 引用
 */
export function isVolatileRef(value) {
  if (!value || typeof value !== 'object' || typeof value.get !== 'function') return false
  const keys = Object.keys(value)
  return keys.length === 1 && keys[0] === 'get'
}
/**
 * 读取一个配置字段的当前值（自动解包 Volatile 引用）。
 * @param container - 配置对象（apply 收到的 config）
 * @param key - 字段名
 * @returns 当前值；字段缺失时返回 undefined
 */
export function readConfigValue(container, key) {
  if (!container || typeof container !== 'object') return undefined
  let raw
  try { raw = container[key] } catch { return undefined }
  if (isVolatileRef(raw)) { try { return raw.get() } catch { return undefined } }
  return raw
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

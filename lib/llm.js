// @dsh-external/dsh-memory-manager — LLM 辅助（印象建议 / 智能合并 / 会话总结）
// 仅依赖 ctx.llm.stream + ctx.agentDefaultModel.currentSelection()（均为 ctx.get 可选读取），
// 不依赖任何官方 LLM 插件（如 session-title-llm）：摘要逻辑完全自包含实现。
// 0.2.0 核对：`ctx.llm.stream(options: GenerateOptions)` 与
// `ctx.agentDefaultModel.currentSelection(): ModelSelection{provider,model,reasoningEffort?}` 均未变；
// 变化的是 MessageSource —— 不再有通用 'plugin' kind，改用插件自己的 kind。
// LLM 不可用/未配置默认模型时，相关功能明确报错，不落库任何数据。

import { rand, sanitizeImpressions, PLUGIN_KIND } from './util.js'
import { SUMMARY_TAG } from './plan.js'

/**
 * 在 manager 对象上安装 LLM 能力。
 * @param m - 共享状态 { ctx, cfg, log, logger, memoryIndex, ... }（见 lib/index.js）
 */
export function installLlm(m) {
  // ================= 低层 LLM 请求（返回文本；失败返回 null，绝不抛出） =================
  m.askLlm = async function askLlm(system, user, maxTokens) {
    const llm = m.ctx.get('llm') ?? m.ctx.get('llm', false)
    const adm = m.ctx.get('agentDefaultModel') ?? m.ctx.get('agentDefaultModel', false)
    if (!llm || !adm) return null
    let sel = null
    try { sel = adm.currentSelection() } catch { sel = null }
    if (!sel || !sel.provider || !sel.model) return null
    let text = ''
    try {
      const messages = [{
        id: 'mem-ask-' + rand(12),
        role: 'user',
        content: [{ type: 'text', text: String(user).slice(0, 12000) }],
        // 0.2.0：生产者声明自己的 MessageSource.kind
        source: { kind: PLUGIN_KIND, form: 'notice', summary: '记忆辅助请求' },
      }]
      const options = {
        provider: sel.provider,
        model: sel.model,
        system,
        maxTokens: maxTokens || 1000,
        messages,
      }
      const stream = typeof llm.stream === 'function' ? llm.stream(options) : null
      if (!stream) return null
      for await (const chunk of stream) {
        if (chunk && chunk.type === 'text-delta') text += chunk.text
      }
    } catch { return null }
    const out = text.trim()
    return out || null
  }

  // ================= 印象建议 =================
  m.suggestImpressions = async function suggestImpressions(content) {
    const out = await m.askLlm(
      '你是记忆整理助手。为下面的记忆内容生成 2-6 个简短印象标签（每个 2-10 个汉字或单词，用逗号分隔，只输出标签本身，不要编号和解释）。',
      content, 300)
    if (!out) return { error: 'LLM 不可用或生成失败' }
    const tags = out.split(/[,，、;；\n]+/).map((s) => s.trim()).filter((s) => s && s.length <= 30).slice(0, 6)
    if (!tags.length) return { error: '未能生成印象' }
    return { impressions: tags }
  }

  // ================= 会话总结（LLM 辅助，逻辑自包含） =================
  // 从 LLM 输出中稳健地抽取第一个 JSON 对象 / 数组（容忍前后缀与换行）
  m.extractJson = function extractJson(text, kind) {
    if (!text) return null
    const s = String(text)
    const open = kind === 'array' ? '[' : '{'
    const close = kind === 'array' ? ']' : '}'
    const start = s.indexOf(open)
    if (start < 0) return null
    let depth = 0
    for (let i = start; i < s.length; i++) {
      const c = s[i]
      if (c === open) depth++
      else if (c === close) { depth--; if (depth === 0) { try { return JSON.parse(s.slice(start, i + 1)) } catch { return null } } }
    }
    return null
  }
  // 把一个轮次的对话内容整理成供 LLM 总结的输入文本
  m.turnSummaryInput = function turnSummaryInput(turn, pos) {
    const rows = []
    for (const n of turn.nodes || []) {
      if (!n) continue
      const who = n.kind === 'user' ? '用户' : (n.kind === 'tool' ? '工具结果' : '助手')
      const t = String(n.text || n.preview || '').trim()
      rows.push('[' + who + '] ' + (t || '（无文本）'))
    }
    return '第 ' + pos + ' 轮（turnId=' + turn.turnId + '）\n' + rows.join('\n')
  }
  // 让 LLM 判断哪些连续轮次在处理同一事务（merge=true 时调用）；返回分组数组或 null
  m.groupSameTransactions = async function groupSameTransactions(scope) {
    if (scope.length <= 1) return scope.map((t, i) => [i])
    const idxInput = scope.map((t) => t._brief.replace(/\n+/g, ' ')).join('\n')
    const sys = '你是对话轮次分组助手。给定按顺序编号（1..N）的对话轮次，判断哪些【连续轮次】在处理"同一事务"（例如同一问题的多轮追问与答复、同一任务的连续步骤），把同事务的连续轮次合并为一组；其余各自成组。\n'
      + '严格输出一个 JSON 二维数组，每个元素是若干连续轮次编号的数组（编号升序且组内连续），如 [[1],[2,3],[4]]，覆盖全部 1..N 轮次，不可缺漏、不可重叠。只输出数组，不要任何解释。'
    const raw = await m.askLlm(sys, idxInput, 800)
    const arr = m.extractJson(raw, 'array')
    if (!Array.isArray(arr) || !arr.length) return null
    const seen = new Set()
    for (const g of arr) {
      if (!Array.isArray(g) || !g.length) return null
      const nums = g.map((x) => Number(x)).filter((x) => Number.isFinite(x)).sort((x, y) => x - y)
      if (!nums.length || nums[0] < 1 || nums[nums.length - 1] > scope.length) return null
      for (let i = 0; i < nums.length - 1; i++) if (nums[i] + 1 !== nums[i + 1]) return null
      for (const x of nums) { if (seen.has(x)) return null; seen.add(x) }
    }
    if (seen.size !== scope.length) return null
    return arr.map((g) => g.map((x) => Number(x)).filter((x) => Number.isFinite(x)).sort((x, y) => x - y).map((x) => scope[x - 1]))
  }
  // 把一组轮次总结成一条六要素会话总结（正文 body + 标注 notes + 覆盖源消息 seq）
  m.summarizeGroup = async function summarizeGroup(sessionId, group) {
    const posList = group.map((t) => t._pos)
    const firstPos = posList[0]
    const lastPos = posList[posList.length - 1]
    const ids = group.map((t) => String(t.turnId))
    const seqs = []
    for (const t of group) for (const n of t.nodes || []) { if (n && Number.isFinite(n.seq)) seqs.push(Number(n.seq)) }
    const sys = '你是会话总结助手。把给定对话轮次提炼为六要素 JSON 对象，字段：'
      + '"user"（用户请求）、"thinking"（思考/分析过程）、"processing"（处理/执行过程）、"result"（结果/结论）。'
      + '只输出 JSON 对象，不要 Markdown 代码块或解释。缺失的信息用空字符串。'
    const input = group.map((t) => t._full).join('\n\n')
    const raw = await m.askLlm(sys, input, 2000)
    let data = m.extractJson(raw, 'object')
    if (!data || typeof data !== 'object') {
      // 兜底：LLM 未输出 JSON 时按纯文本入库（不丢信息）
      data = { user: '', thinking: '', processing: '', result: String(raw || '') }
    }
    const body = '# 会话总结\n'
      + '- **会话**：' + String(sessionId) + '\n'
      + '- **覆盖轮次**：' + (posList.length > 1 ? firstPos + '-' + lastPos : String(firstPos)) + '\n\n'
      + '## 用户请求\n' + String(data.user || '').trim() + '\n\n'
      + '## 思考链\n' + String(data.thinking || '').trim() + '\n\n'
      + '## 处理链\n' + String(data.processing || '').trim() + '\n\n'
      + '## 结果\n' + String(data.result || '').trim()
    const notes = '来源会话: ' + String(sessionId) + '\n覆盖轮次: ' + (posList.length > 1 ? firstPos + '-' + lastPos : String(firstPos))
      + '\n源消息 seq: ' + seqs.join(',')
    return { body, notes, firstPos, lastPos, sourceSeqs: seqs, turnIds: ids }
  }

  /**
   * 会话总结主流程：整理轮次 → （可选）LLM 智能合并 → 逐组 LLM 提炼 → memory_save 入库。
   * @param sessionId - 被总结的会话 id
   * @param args - { recent?: number(0=全部), merge?: boolean }
   * @returns { summaries, count } 或 { error }
   */
  m.summarizeSession = async function summarizeSession(sessionId, args) {
    const view = await m.sessionView(sessionId)
    if (!view) return { error: '会话不存在或不在线' }
    const dir = m.libPath()
    if (!dir) return { error: '记忆库未配置' }
    const plan = await m.loadPlan(sessionId)
    const allTurns = m.buildTurns(view.view, sessionId, plan)
    // 已排除的轮次内容会被标记文本替代，无法总结，跳过
    const validTurns = allTurns.filter((t) => !t.excluded)
    if (!validTurns.length) return { error: '该会话没有可总结的轮次' }
    const recent = clampNum(Number(args && args.recent) || 0, 0, 100)
    // 规范化：附全会话 1-based 轮次位置（用于「覆盖轮次 X-Y」）、完整输入、用户请求回退
    const normalized = validTurns.map((t, i) => ({
      turnId: t.turnId,
      nodes: t.nodes || [],
      _pos: i + 1,
      _full: m.turnSummaryInput(t, i + 1),
      _brief: m.turnSummaryInput(t, i + 1),
      _user: (() => { const n = (t.nodes || []).find((x) => x && x.kind === 'user'); return n ? String(n.text || n.preview || '').trim() : '' })(),
    }))
    const startIdx = (recent > 0 && recent < normalized.length) ? normalized.length - recent : 0
    const scope = normalized.slice(startIdx)
    if (!scope.length) return { error: '该会话没有可总结的轮次' }
    // 预检 LLM 可用性：不可用则明确报错（不落库任何记忆）
    if (!(await m.llmAvailable())) return { error: 'LLM 不可用，无法生成会话总结（请确认已配置默认模型）' }
    const merge = args && args.merge === true
    let groups = null
    if (merge) {
      try { groups = await m.groupSameTransactions(scope) } catch (e) { m.log('session.summarize: group threw: ' + String((e && e.message) || e)); groups = null }
    }
    if (!groups || !Array.isArray(groups) || !groups.length) groups = scope.map((t) => [t])
    const saved = []
    for (const g of groups) {
      if (!Array.isArray(g) || !g.length) continue
      const gs = await m.summarizeGroup(sessionId, g)
      const rangeTitle = g.length > 1 ? ('覆盖轮次 ' + gs.firstPos + '-' + gs.lastPos) : ('轮次 ' + gs.firstPos)
      const meta = {
        id: 'm_' + rand(10),
        title: '会话总结（' + String(sessionId).slice(-8) + ' · ' + rangeTitle + '）',
        impressions: sanitizeImpressions([SUMMARY_TAG, '会话 ' + String(sessionId).slice(-8)]),
        tags: sanitizeImpressions([SUMMARY_TAG]),
        enabled: true,
        links: [], composedOf: [],
        sourceSession: sessionId,
        sourceSeqs: gs.sourceSeqs, // 数字 seq（供「消息位置」跳转）
        createdAt: Date.now(), updatedAt: Date.now(), revision: 1,
      }
      await m.writeMemory(meta, gs.body.slice(0, 40000), gs.notes.slice(0, 20000))
      const full = m.memoryMetaOf(m.memoryIndex.get(meta.id))
      saved.push(Object.assign(full, { notes: gs.notes, snapshot: gs.body }))
    }
    return { summaries: saved, count: saved.length }
  }

  m.llmAvailable = async function llmAvailable() {
    const llm = m.ctx.get('llm') ?? m.ctx.get('llm', false)
    const adm = m.ctx.get('agentDefaultModel') ?? m.ctx.get('agentDefaultModel', false)
    try {
      const sel = adm && adm.currentSelection ? adm.currentSelection() : null
      return !!(llm && sel && sel.provider && sel.model)
    } catch { return false }
  }
}

const clampNum = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

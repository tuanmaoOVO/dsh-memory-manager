# API 参考

本插件对外暴露三类接口：HTTP JSON API、Agent 模型工具、系统提示注入段。配置通过 DSH settings 命名空间管理。

---

## 1. HTTP API

### 端点与信封

- **端点**：`/_dsh/memory-manager/api`
- **GET**：探测服务是否在线。响应：

  ```json
  { "ok": true, "service": "memory-manager", "enabled": true }
  ```

- **POST**：调用具体操作。请求体为 JSON 信封：

  ```json
  { "op": "<op 名>", "sessionId": "<可选，当前会话 id>", "args": { ... } }
  ```

  响应统一为：

  ```json
  { "ok": true, "value": { ... } }
  ```

  业务错误时整个 `value.error` 携带说明且 `ok` 为 `false`；HTTP 400 = 坏 JSON、405 = 方法不支持、500 = 服务器异常。请求体上限 **256 KiB**。

- **总开关门控**：`enabled === false` 时，除 `state.get` / `state.setEnabled` / `diag.log` 外，所有 op 均返回 `{ error: '记忆管理已禁用（设置 → 记忆管理 中开启）' }`。

### op 全表（共 28 个）

> 以下清单与 `lib/index.js` 的 `handler` `switch` 逐一核对。`memory.save` 会生成 id `m_<随机>`；各写入 op 返回一条完整记忆元数据 `meta`。

#### state.* —— 状态查询与配置（8）

| op | args | 返回要点 |
|---|---|---|
| `state.get` | 可选 `sessionId` | `{ config, plan }`。`config`：`{ enabled, mode, view, modelTools, libraryPath, ready, reason, memoryChars, totalChars, pinChars, autoInjectConvention }`；有 `sessionId` 时额外返回该会话的 `plan`（`{ pinned, memories, excluded, once, injectOnce }`，pinned/memories 为摘要，`memories` 含 `tags`，`once` 为**全局**待一次性注入队列） |
| `state.setEnabled` | `{ v: boolean }` | `{ ok, enabled }`。写回设置，live 生效 |
| `state.setMode` | `{ mode: 'on'\|'off' }` | `{ ok, mode }`。`on` = 临时记忆模式（每次发送自动注入） |
| `state.setView` | `{ view: 'full'\|'compact' }` | `{ ok, view }`。注入视图（全文 / 紧凑） |
| `state.setModelTools` | `{ v: boolean }` | `{ ok }`。是否向 Agent 注册记忆工具 |
| `state.setAutoInject` | `{ v: boolean }` | `{ ok, autoInjectConvention }`。新会话自动注入规约 / 会话总结记忆开关 |
| `state.setLibrary` | `{ path: string }` | `{ ok, libraryPath }` 或错误。必须是绝对路径（盘符或 `/` 开头），非空；写回设置并重扫记忆库 |
| `state.setCaps` | `{ memoryChars?, totalChars?, pinChars? }`（number） | `{ ok }`。更新字符上限，各自钳制范围 `memoryChars:500–50000`、`totalChars:1000–100000`、`pinChars:500–50000` |

#### sessions.* —— 跨工作区会话列表（1）

| op | args | 返回要点 |
|---|---|---|
| `sessions.list` | 无 | `{ workspaces: [{ id, title, sessions: [{ id, title, updatedAt, archived }] }] }`。跨工作区枚举会话（`workspaceRegistry` + `sessionQuery.readTitle`，缺失时容错降级，标题回退到 id 尾部） |

#### library.* —— 记忆库（1）

| op | args | 返回要点 |
|---|---|---|
| `library.scan` | 无 | `{ memories: [...] }`。重扫 `memories/*.md`，返回全部记忆元数据（含 `tags` / `enabled`），按 `updatedAt` 降序 |

#### memory.* —— 记忆 CRUD 与推理（8）

| op | args | 返回要点 |
|---|---|---|
| `memory.read` | `{ id: string }` | `{ meta, snapshot, notes }` 或 `{ error }`。`meta` 含 `tags` / `enabled` |
| `memory.save` | `{ title?, impressions?, tags?, enabled?, snapshot?, notes?, links? }` | 返回新记忆 `meta`；title 留空自动为 `日期`；id 自动生成；`tags` 与 `enabled` 一同写入 |
| `memory.update` | `{ id, patch: { title?, impressions?, tags?, enabled?, links?, notes? } }` | 返回更新后 `meta`；`revision` 递增；links 自动排除自身；快照不可变 |
| `memory.setEnabled` | `{ id: string, enabled: boolean }` | 返回更新后 `meta`。启用 / 禁用记忆级开关，`revision` 递增 |
| `memory.delete` | `{ id: string }` | `{ ok }`。删除对应 md 文件并重建 backlink 索引 |
| `memory.compose` | `{ ids: string[], mode: 'concat'\|'llm'\|'manual', title?, impressions?, body? }` | 返回新组合记忆 `meta`。`concat` 原文拼接；`llm` 用 LLM 综合生成正文；`manual` 需提供 `body`。组合记忆 `composedOf` 记录了源 id |
| `memory.related` | `{ id, depth?(默认2,1–4), limit?(默认30,1–100) }` | `{ related: [{ id, title, impressions, distance }] }`。BFS 链式回忆（links + backlinks） |
| `memory.suggest` | `{ content: string }`（≤8000 字） | `{ impressions: string[] }` 或 `{ error }`。LLM 生成 2–6 个印象建议 |

#### session.* —— 会话相关（5）

| op | args | 返回要点 |
|---|---|---|
| `session.messages` | `{ limit?(默认30,5–200) }`，需 `sessionId` | `{ turns: [{ turnId, excluded, marker, nodes:[{seq,kind,id,preview,time}] }] }`。把最近轮次整理为轨迹；`excluded` 标识是否被排除 |
| `session.summarize` | `{ recent?(默认0=全部,0–100), merge? }`，需 `sessionId` | `{ summaries: [...], count }`。把所选会话轮次交给 LLM 提炼为「会话id / 轮次 / 用户请求 / 思考链 / 处理链 / 结果」六要素记忆，**逐条自动入库**（`tags` 含 `会话总结`，新会话默认自动注入最近 8 条）。`merge=true` 时 LLM 判断同一事务的连续轮次合并为一条；`recent=N` 仅总结最近 N 轮。LLM 不可用时明确报错，不落库 |
| `session.saveAsMemory` | `{ messageIds: string[], title?, impressions?, tags?, notes?, links? }`，需 `sessionId` | 返回新记忆 `meta`。把所选消息（用户/助手/工具结果）组合为记忆正文 |
| `session.pin` | `{ messageIds: string[], pin: boolean }`，需 `sessionId` | `{ ok, pinned: [...] }`。`pin=false` 取消固定；`pin=true` 追加固定消息（去重） |
| `session.injectNow` | `{ id: string }`，需 `sessionId` | `{ ok }` 或错误。把记忆注入**当前所在会话**的模型上下文（`Agent.inject`，不显示为对话消息），并立即唤醒模型基于它继续响应 |

#### plan.* —— 注入计划（5）

| op | args | 返回要点 |
|---|---|---|
| `plan.addMemory` | `{ id: string }`，需 `sessionId` | `{ ok }`。把一条记忆加入会话注入计划（去重；已禁用的记忆会拒绝） |
| `plan.removeMemory` | `{ id: string }`，需 `sessionId` | `{ ok }`。从计划移除记忆 |
| `plan.injectOnce` | `{ v: boolean }`，需 `sessionId` | `{ ok }`。开启后下一次发送注入一次，随后自动关闭 |
| `plan.injectOnceMemory` | `{ id: string, cancel?: boolean }`，`sessionId` 可选 | `{ ok, onceCount }`。把一条记忆加入**全局一次性注入队列**（不入全局计划；**任何会话**的第一次请求渲染后自动清除，跟随「下一次发送」而非点击时会话）。`cancel=true` 时从队列移除（不校验记忆是否存在） |
| `plan.excludeTurn` | `{ turnId: string, exclude?: boolean(默认true) }`，需 `sessionId` | `{ ok }` 或错误。`exclude=true` 排除该轮次（非破坏）；`exclude=false` 恢复。**需要可写 live 会话**；不能排除当前最新一轮 |

#### diag.* —— 诊断（1）

| op | args | 返回要点 |
|---|---|---|
| `diag.log` | `{ level?, tag?, msg?, stack? }` | `{ ok }`。把前端日志写入 `<DSH_MEMORY_LOG_DIR>/memory-manager-client.log`（时间戳 + level + tag + msg + stack） |

---

## 2. Agent 记忆工具

以下 6 个工具通过 `ctx.get('tools')` 的 `defineTool` 注册，受 `enabled` 与 `modelTools` 双重门控。输出统一为 JSON（`schema: { type: 'json' }`）。

| 工具 | 参数 schema | 行为 |
|---|---|---|
| `memory_search` | `query: string`（required） | 按关键词匹配标题 / 印象 / 正文（正文取前 8000 字）；返回 `{ count, memories: [{ id, title, impressions, preview }] }`（最多 20 条，按印象数降序） |
| `memory_recall` | `id: string`（required） | 返回 `{ id, title, impressions, tags, enabled, links, composedOf, sourceSession, sourceSeqs, createdAt, updatedAt, revision, backlinks, snapshot, notes }`；快照截取前 20000 字 |
| `memory_save` | `title, impressions(数组), snapshot, notes`（均 required），`tags(数组), enabled(boolean)`（可选） | 保存新记忆到记忆库，返回其 `meta`；`sourceSession` 取调用代理的会话。`tags` 填 `convention` 即规约记忆、填 `会话总结` 即会话总结记忆（两者新会话默认自动注入）；`enabled` 默认 `true` |
| `memory_set_enabled` | `id: string`（required）、`enabled: boolean`（required） | 启用或禁用一条记忆。禁用后不参与新会话自动注入、不能加入注入计划（已在计划中的也不再注入），直到重新启用 |
| `session_inject` | `id: string`（required）、`inject: boolean`（required） | 把一条记忆加入（`inject=true`）或移出（`inject=false`）当前会话的注入计划；返回 `{ ok, memories: [id...] }`。需能确定当前会话 |
| `memory_pin` | `content: string`（required）、`label: string`（required，可为空） | 把文本固定为当前会话临时记忆（前缀 `[label]`），返回 `{ ok, pinnedCount }`；需能确定当前会话 |

---

## 3. 系统提示注入段

| 属性 | 值 |
|---|---|
| `name` | `memory-manager:context` |
| `order` | `300` |
| `text` | 按组装时 agent id 取会话计划渲染；会话激活（`mode==='on'` 或 `injectOnce`）时输出注入段，否则返回空字符串 |

注入段包裹格式：

```
=== 记忆库上下文（用户指定，供参考；非当前对话的实时内容） ===
[固定消息 ·<role>] ...
【记忆·<标题>】正文...
【会话总结·自动注入】...（会话总结记忆自动注入时的独立标注）
=== 记忆库上下文结束 ===
```

字符上限按 `memoryChars` / `totalChars` / `pinChars` 分配；预算归零追加 `[记忆库上下文已截断]`；`compact` 视图仅注入标题 + 印象 + 300 字预览（模型可 `memory_recall` 读全文，提示语仅在 `modelTools` 开启时追加）。

**自动注入行为（新会话）**：`agent/created` 预载计划时，若会话尚无任何对话消息（仅系统策略事件不算「有历史」），且 `cfg.enabled`、`cfg.autoInjectConvention !== false`，则把**全部启用中的规约记忆**（`tags` 含 `convention`）与**最近 `SUMMARY_AUTO_INJECT_MAX`（8）条会话总结记忆**（`tags` 含 `会话总结`，按 `updatedAt` 降序）并入该会话计划。旧会话不自动注入，可手动加入。

---

## 4. settings 配置 schema

命名空间 `memory-manager`，通过 `settingsNamespace('memory-manager')` 注册，`applies: 'live'`：

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 总开关 |
| `mode` | `'on' \| 'off'` | `'off'` | 临时记忆模式 |
| `view` | `'full' \| 'compact'` | `'full'` | 注入视图 |
| `modelTools` | boolean | `true` | Agent 工具开关 |
| `libraryPath` | string | `''` | 记忆库路径（空 = 自动锚定） |
| `memoryChars` | number | `6000` | 单条记忆字符上限 |
| `totalChars` | number | `12000` | 计划总字数上限 |
| `pinChars` | number | `6000` | 固定消息合计上限 |
| `autoInjectConvention` | boolean | `true` | 新会话自动注入规约 / 会话总结记忆开关 |

校验：`libraryPath` 非空时长度不得超过 4096（超长抛错）。旧 `config.json` 首次运行自动迁移为 `base`。

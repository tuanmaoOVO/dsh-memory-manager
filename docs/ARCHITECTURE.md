# 架构设计

本插件是 **宿主级（Host）插件**，通过 Cordis 以 bundle 形式挂载进 DSH profile，为所有会话提供跨会话记忆能力。整体上由 **Host 半区**（`lib/index.js`，Node 进程内 ESM）与 **Client 半区**（`lib/client.js`，浏览器 bundle）组成，两者经 HTTP JSON API 通信。

## 架构总览（ASCII）

```
 ┌──────────────────────────────────────────────────────────────────────┐
 │                         DSH 宿主进程 (Node)                          │
 │                                                                      │
 │  lib/index.js  (Host 半区, ESM)                                       │
 │  ┌────────────────────────────────────────────────────────────────┐  │
 │  │ settings (memory-manager 命名空间, applies:live)               │  │
 │  │   启用/模式/视图/工具/路径/字符上限/新会话自动注入  config.json 迁移 │  │
 │  ├────────────────────────────────────────────────────────────────┤  │
 │  │ agents / sessions / sessionQuery + foldSurface                │  │
 │  │   └ 会话读取：live 优先，否则只读 surface 视图                 │  │
 │  ├────────────────────────────────────────────────────────────────┤  │
 │  │ 记忆库 (node:fs/promises 直读)                                 │  │
 │  │   memories/*.md      MRU memoryIndex + backlinkIndex           │  │
 │  │                      tags / enabled 元数据                     │  │
 │  │   pinned/<sid>.json  per-session 注入计划 (planCache)          │  │
 │  ├────────────────────────────────────────────────────────────────┤  │
 │  │ 6 个 Agent 工具: search/recall/save/set_enabled/inject/pin     │  │
 │  │ 注入: agent/pre-step 消息注入 (memory-manager:context, snapshot) │  │
 │  │ 会话总结: session.summarize → summaryMemories → 自动注入       │  │
 │  │ 事件: agent/created 预载计划 + 新会话判定(自动注入规约/总结)     │  │
 │  │ 启动即 scanLibrary()                                          │  │
 │  └────────────────────────────────────────────────────────────────┘  │
 │                    ▲                             │                    │
 │   HTTP POST {op,sessionId,args}                  │ GET /_dsh/.../api │
 │   /_dsh/memory-manager/api   ◄─── HTTP ───►  JSON 探测 (ok/service)  │
 └──────────────────────────────────────────────────────────────────────┘
                    ▲
        fetch(API)  │  ────────────────
                    │
 ┌──────────────────────────────────────────────────────────────────────┐
 │                        浏览器 (Client 半区)                          │
 │  lib/client.js (window.__ModuleLoader__.load 包裹的 CJS bundle)      │
 │   插槽 (6 个):                                                        │
 │     conversation.input.left              → 「记忆」按钮             │
 │     conversation.session.header.actions  → JumpReceiver (消息跳转)   │
 │     shell.overlay (×2)                   → 右侧面板 + 左侧图谱浮层   │
 │     settings.section                     → 设置页「记忆管理」        │
 │     conversation.chat.assistant-actions  → 消息动作条(保存/固定)     │
 │   右侧面板 3 tab: 计划 / 记忆库 / 消息                                  │
 │   左侧图谱浮层: GraphPanel (全景/焦点双视图) + SummarizeDialog        │
 │   错误边界 Boundary × N + 崩溃自愈 + 全局错误捕获(diag.log)          │
 └──────────────────────────────────────────────────────────────────────┘
```

## 数据模型

### 记忆 = 不可变快照 + 可编辑标注层

一条记忆由三部分构成：

- **快照（snapshot）**：不可变正文（`## 快照` 之后、`<!-- mem:notes -->` 之前）。用于记录事实、决定、待办等历史内容。
- **标注层（notes）**：`<!-- mem:notes -->` 之后的文本，是可编辑的补充注释层，可随时修改而不污染快照。
- **元数据（front-matter meta）**：标题、印象、分类标签、启用开关、链接、组合来源、来源会话等，是检索与图谱的依据。

### 印象（impressions）

每条记忆最多 12 个、每个不超过 40 字符的简短标签（`sanitizeImpressions`）。印象同时充当：

- **检索主键**：`memory_search` 按标题 / 印象 / 正文匹配。
- **图谱节点**：在左侧图谱浮层中以节点展示。
- **注入摘要**：`compact` 视图下，印象会以 `印象: a、b` 形式注入。

印象可由 LLM `memory.suggest` 生成建议（2–6 个），也可手动编辑。

### 记忆标签（tags）与启用开关（enabled）

- **`tags`（分类标签）**：每条记忆可带若干分类标签。`tags` 含 `convention` 即**规约记忆**、含 `会话总结` 即**会话总结记忆**。规约记忆在**新会话自动常驻注入**；会话总结记忆在**新会话默认自动注入**最近 8 条（按 `updatedAt` 降序）。面板中 `convention` 徽标为蓝色「规约」、会话总结徽标为绿色「自动」。
- **`enabled`（记忆级开关）**：`false` 的记忆不参与新会话自动注入、不能被加入注入计划（已在计划中的也不再注入），直到重新启用。`memory.setEnabled` / `memory_save` 的 `enabled` 字段维护。

### 组合（composedOf）与双向链接（backlink）

- **`composedOf`**：记录「本条由哪些记忆组成」，非破坏性聚合。组合记忆保留原文来源引用，不复制全文；用 `memory_recall` 读原记忆。
- **`links`**：显式关联（可被编辑）；扫描时自动建立反向索引 `backlinkIndex`（即「被引用」）。`relatedOf` 用 BFS 沿 `links` + `backlinks` 做「链式回忆」，返回按距离组织的相关记忆。

### 会话注入计划（plan）

每个会话一份计划，持久化在 `pinned/<sessionId>.json`，内存中复用于 `planCache` 与 `injectOnce`：

```jsonc
{
  "pinned":   [ { "id", "role", "text", "at" } ],  // 固定消息
  "memories": [ { "id", "title", "impressions", "tags" } ], // 勾选记忆（引用）
  "excluded": [ "turnId", ... ],                    // 已排除的轮次
  "injectOnce": false                               // 仅单次注入标记
}
```

## 记忆文件格式

记忆存放在记忆库的 `memories/<id>.md`。`<id>` 必须匹配 `^[A-Za-z0-9_-]{3,64}$`。front-matter 使用 YAML 风格键值（值以 JSON 解析，失败则按字符串）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 必填，记忆唯一 id |
| `title` | string | 标题 |
| `impressions` | string[] | 印象标签 |
| `tags` | string[] | 分类标签（`convention` = 规约、`会话总结` = 会话总结） |
| `links` | string[] | 显式关联（双向索引自动建立） |
| `composedOf` | string[] | 组合来源记忆 id |
| `sourceSession` | string \| null | 创建来源会话 |
| `sourceSeqs` | number[] | 来源消息的 surface seq（供「消息位置」跳转定位） |
| `createdAt` / `updatedAt` | number | 毫秒时间戳 |
| `revision` | number | 更新版本号（每次 `memory.update` 递增） |
| `enabled` | boolean | 记忆级启用开关（默认 `true`） |

> 序列化字段顺序（`serializeMemory`）：`id, title, impressions, tags, links, composedOf, sourceSession, sourceSeqs, createdAt, updatedAt, revision, enabled`。

正文结构：

```
---
<front-matter 键值>
---

## 快照

<不可变快照正文>

<!-- mem:notes -->

<可编辑标注层>
```

解析规则：`parseFrontMatter` 剥离首尾 `---`，`parseMemory` 以 `<!-- mem:notes -->` 切分快照与标注，并去掉快照段开头的 `## 快照` 标题。序列化时按固定字段顺序写出。

**Obsidian 兼容**：文件是标准 Markdown + front-matter，可直接用 Obsidian 打开做图谱；`links`/`composedOf` 命中的 id 在面板详情页可点击跳转。

## 配置与迁移

- **settings 命名空间**：插件注册 `settingsNamespace('memory-manager')`，字段与默认值见 [docs/API.md#settings 配置 schema](docs/API.md)。`applies:'live'`，改动即时生效（`watch` 同步进内存 `cfg`）。含 `autoInjectConvention`（新会话自动注入开关）。
- **总开关 `enabled`**：`false` 时不注入、Agent 工具拒绝执行、HTTP API 仅放行 `state.get` / `state.setEnabled` / `diag.log`（供设置页重新开启）。
- **旧 `config.json` 自动迁移**：首次运行若默认记忆库（见下）下存在旧版 `config.json`，会将其中的 `mode/view/modelTools/libraryPath/memoryChars/totalChars/pinChars` 合并进 `base`，作为设置初始值，并写入 DSH settings（持久化）。
- **默认记忆库锚点**：`libraryPath` 为空时，依次尝试（`defaultLibraryPath()`）：
  1. `workspaceRegistry.list()` 的第一个工作区路径 → 追加 `.dsh-memory`
  2. `agents.roots[0]` / `agents.list[0]` 的会话 `cwd` → 追加 `.dsh-memory`
  3. 均不可得则返回 `null`（视为「记忆库未配置」）

  实测锚点为「工作区下一个 `.dsh-memory` 文件夹」。

## 注入机制

- **注入消息（agent/pre-step）**：注册 `agent/pre-step` 监听（`prepend: true`），在每个请求 step 组装后向 `decision.messages` 末尾追加一条 `form: 'snapshot'` 的 plugin 消息（`source: { kind: 'plugin', plugin: 'dsh-memory-manager' }`，UI 折叠显示同 time-context，模型可见）。`renderContextFor(sessionId)` 按请求会话 id 渲染内容；无内容则跳过（不污染请求）。
  - **为什么不用 `systemPrompt.section`**：极简模式（persona `complete: true`）会让 `assemble()` 仅保留 complete section、丢弃所有其他 sections，注入内容从未进入模型请求（2026-08-15 实测：`injectOnce consumed` 有日志但 `request/header` 的 system 无内容）。消息注入与 complete section、`includeRuntimeContext` 均无关，任何会话形态都生效。
- **按会话 plan**：仅渲染 `cfg.mode === 'on'` 或 `plan.injectOnce === true` 时激活。`injectOnce` 单次注入后自动置回 `false` 并持久化。
- **预算分配（字符上限）**：
  1. 先分配固定消息，上限 `min(pinChars, totalChars)`；每条 `[固定消息 ·role] <text>`，超长截断。
  2. 剩余预算给勾选记忆：每条上限 `memoryChars`，整体受 `totalChars` 约束；会跳过 `enabled === false` 的记忆。
  3. 预算归零时追加 `[记忆库上下文已截断]`。
- **会话总结记忆的独立标注**：注入时会话总结记忆（`tags` 含 `会话总结`）用 `【会话总结·自动注入】` 前缀，普通 / 规约记忆用 `【记忆·<标题>】`。
- **紧凑视图**：`view === 'compact'` 时每条只注入 `标题「…」印象: … 预览: <300字>`，并追加提示（`modelTools` 开启时）「需要完整内容时可调用 memory_recall 读取」。
- **包裹格式**：整段以 `=== 记忆库上下文（用户指定，供参考；非当前对话的实时内容） ===` 开头、`=== 记忆库上下文结束 ===` 结尾。
- **注入顺序**：`order: 300` 决定了该段相对其他提示段的位置。

### 自动注入机制（新会话常驻规约 / 会话总结）

- **触发**：`agent/created` 事件（`global:true`）与启动时对已有 agent 调用 `loadPlan`。每个会话的计划文件首次创建（`pinned/<sid>.json` 尚不存在）时才尝试自动注入。
- **新会话判定（`isNewSession`）**：会话 `log` / `events` 中没有任何 `user/message` / `assistant/message` 事件才算「新会话」——系统策略事件（`permission/preset`、`sandbox/mode`、`approval/policy` 等）不算「有历史」。最优先使用 `agent/created` 提供的 live session。
- **注入内容**：`autoInjectConventions(sessionId, plan, hint)` 在 `cfg.enabled && cfg.autoInjectConvention !== false && isNewSession` 时，把**全部启用中的规约记忆**（`conventionMemories`：`tags` 含 `convention` 且 `enabled !== false`）与**最近 `SUMMARY_AUTO_INJECT_MAX`（8）条会话总结记忆**（`summaryMemories` 按 `updatedAt` 降序）并入计划并持久化。会话总结记忆数量多，全部注入会超出 `totalChars` 预算，故只取最近 N 条。
- **旧会话**：不自动注入，可手动加入（面板 / `session_inject` / `plan.addMemory`）。

## 会话总结链路（session.summarize）

```
用户选会话(可选最近N轮/智能合并)
   → session.summarize op
   → buildTurns 整理轨迹，跳过已排除轮次
   → (merge=true) 先由 LLM 判断同一事务的连续轮次 → 分组
   → summarizeGroup: 每轮/每组交给 LLM → 六要素 JSON
       { "user", "thinking", "processing", "result" } + notes(源会话/覆盖轮次/seq)
   → 逐条 memory.save 入库:
       title "会话总结（<sid> · 轮次 X-Y）"
       impressions ["会话总结", "会话 <sid>"]，tags ["会话总结"]
       sourceSeqs = 覆盖的 surface seq（供消息跳转定位）
   → 返回 { summaries, count }
```

- 结果自动成为**会话总结记忆**（`tags` 含 `会话总结`），随后按上述自动注入机制在新会话中默认注入最近 8 条。
- LLM 不可用（未配置默认模型）时明确报错，不落库任何记忆。

## 排除 / 恢复机制

- **排除（非破坏）**：`plan.excludeTurn(turn, exclude=true)` 在会话表面（surface）里，对被排除轮次的每个节点插入一条 `source.kind='plugin'`、plugin=`memory-manager` 的**标记消息**（文本 `[记忆管理] 该轮已被排除 | turn=<turnId>`，经 `surfaceOp:{op:'replace'}` 原地替换原节点），并把 turn 写入计划的 `excluded`。工具节点用深度相等镜像的标记（仅替换 content 文本子块，满足 surface 契约）；异常 shape 整体拒绝。不删除任何数据，模型不消费该轮内容。
- **恢复**：`exclude=false` 根据标记消息的 `sourceEventSeqs` 找到原始事件，把原始节点重新写回表面，并从 `excluded` 移除；自愈门槛不依赖 `excluded` 列表，只要 surface 存在该轮标记就执行恢复。
- **依赖会话 surface**：排除 / 恢复需要**可写会话视图**（live session，`session.append`）；只读 surface（宿主模式只读会话）下返回提示「排除/恢复需要 live 会话（宿主模式暂不支持）」。排除「当前最新一轮」会被拒绝，避免把正在进行的对话排除掉（其后需至少保留一条真实用户消息作锚点）。

## HTTP API 设计

- **端点**：`/_dsh/memory-manager/api`，由 `webServer` 服务注册（`ctx.inject(['webServer'], webCtx => webCtx.webServer.register({ kind:'exact', path, handler }))`）。
- **GET**：探测 —— `{ ok:true, service:'memory-manager', enabled }`。
- **POST**：请求体为 JSON 信封 `{ op, sessionId?, args? }`；响应统一为 `{ ok, value }`（业务错误时 `ok:false`，`value.error` 为错误说明），HTTP 400 为坏 JSON、405 为方法不支持、500 为服务器异常。请求体上限 256 KiB。
- **op 清单（共 27 个）**：完整参考见 [docs/API.md](docs/API.md)。按域名归类：`state.*`（8，含 `state.setAutoInject`）、`sessions.list`（1）、`library.*`（1）、`memory.*`（8，含 `memory.setEnabled`）、`session.*`（4，含 `session.summarize`）、`plan.*`（4）、`diag.log`（1）。

## Client 插槽与面板结构

6 个插槽注册（`slots.inject`）：

- **`conversation.session.header.actions`**（order 1000，`memory-manager-jump-receiver`）：隐藏的**消息跳转接收器（JumpReceiver）**，只在当前显示会话上渲染，监听 `dsh:memory:jump` 事件，按 `anchorSeq` 匹配节点 key，滚动 `[data-conversation-scroll]` 容器到对应 `[data-chat-anchor-key]` 行并高亮；目标在更早窗口时代码自动点击「加载更早」逐页前移。
- **`conversation.input.left`**（order 10）：输入栏左侧「记忆」按钮，点击开关侧栏面板；显示当前模式「已开启/已关闭」；检测到上次崩溃则自动回落到计划页。
- **`shell.overlay`**（order 30，`memory-panel`）：**右侧固定侧栏面板**容器（560px、`--dsw-alias-*` 主题变量自适应深浅色）；头部左侧为「✕」关闭按钮，随后依次是标题、模式状态、会话 id、记忆库设置与「图谱」开关按钮。
- **`shell.overlay`**（order 40，`memory-graph`）：**左侧记忆图谱浮层**容器（`mem-wrap-left`，560px），独立于右侧面板开关（`graph.open`），可并存互不干扰；头部也有「✕」关闭按钮。
- **`settings.section`**（order 30，label「记忆管理」）：设置页区块，含总开关 / 注入与工具开关 / 新会话自动注入开关 / 记忆库路径 / 三字符数输入。
- **`conversation.chat.assistant-actions`**（order 15）：每条助手消息动作条新增「💾 保存为记忆」与「📌 固定 / 取消固定」两个图标按钮，直接在对话界面操作。

### 右侧面板（3 tab）

面板内部为模块级状态 `panel = { open, sessionId, tab, crashed }`，三个标签页（图谱已移出为左侧浮层）：

| tab | 内容 |
|---|---|
| 计划 | 临时记忆模式开关、单次注入开关、注入视图开关、Agent 工具开关；固定消息 / 勾选记忆（规约 / 会话总结徽标）/ 已排除轮次列表管理 |
| 记忆库 | 按印象 / 标题 / id 搜索、多选组合、查看 / 编辑 / 加入计划、记忆标签与启用开关、消息位置追溯 |
| 消息 | 跨工作区会话选择器（`sessions.list`）+ 轨迹风格轮次 / 步骤行；消息级勾选 → 保存为记忆 / 固定；轮次级排除 / 恢复；会话总结入口（SummarizeDialog）；行级「在对话中定位」（jumpTo） |

### 消息界面的两个对话框

- **SummarizeDialog**：会话总结入口。选择会话（跨工作区）→ 范围（全部 / 最近 N 轮）→ 智能合并开关 → 生成（`session.summarize`）→ 预览，生成即自动入库，提示默认参与新会话自动注入（按更新时间最近 8 条）。
- **SaveDialog**：保存为记忆（面板 / 消息动作条共用），可填标题 / 印象 / 分类标签（convention=规约）/ 标注，可用 `memory.suggest` 生成印象建议，自动关联计划中的记忆为 `links`。

### 左侧力导向图谱（GraphPanel）

独立于右侧面板的**左侧浮层面板**，自带数据加载（`library.scan` + `state.get`），模块级状态 `graph = { open }`：

- **双视图**：
  - **全景（full）**：语义分层全景 —— 取最新 N 条（默认 60），按标签着色（`convention` 蓝 / `会话总结` 绿 / `复盘` 橙 / 其他 灰），力导向模拟 160 迭代。
  - **焦点（focus）**：焦点探索 —— 以焦点记忆为中心做 1–2 跳邻域（`links` + `composedOf` + `backlinks`），径向确定性布局（焦点居中、1 跳内圈、2 跳外圈，位置可复现），点邻域节点切换焦点、点焦点本身看详情。
- **三类边**：`links`（主动关联）、`composedOf`（组合来源，更紧弹簧 + 短划线）、`backlinks`（被引用）。
- **交互**：搜索定位（命中高亮 / 未命中提示）、滚轮缩放、空白拖拽平移、节点 tooltip、详情弹窗（含相关记忆链式跳转、加入计划）。
- 组件：`mg-toolbar` / `mg-canvas` / `mg-legend` / `radialLayout` / `graphLayout` 等 `mg-*` 样式与 `GraphPanel` / `GraphDetail` 组件。

## 消息跳转（JumpReceiver + jumpTo）

- **跳转入口**：消息页每行有「在对话中定位」图标（`jumpTo`），记忆详情有「消息位置」（把 `sourceSession` + `sourceSeqs[0]` 交给消息页切会话 + 滚动）。
- **jumpTo**：切换目标会话（`sessions.open`）、关闭右侧面板，再向 `window` 派发 `dsh:memory:jump` 事件（`{ sessionId, turnId, seq }`），并通过 `jumpFeedback` 回显结果到面板。
- **JumpReceiver**（挂在 `conversation.session.header.actions`）：渲染期用 `useSession` 缓存最新 chat 快照，事件回调只读 ref 从不调 hook。按 `anchorSeq` 精确匹配目标 seq，兜底取最近的上界非 turn-tail 节点 key；目标更早时代码循环点「加载更早」并把窗口前移，轮询定位后 `scrollIntoView` + `mem-jump-hl` 高亮（30s 上限）。

## 错误边界 / 崩溃自愈

Client 采用「三级 Error Boundary + 自愈」策略，源自一次真实前端崩溃事故（直接函数调用组件导致 hooks 挂错链）的经验总结：

- 全部组件均以 `h(Component, props)` 调用（杜绝直接函数调用，保证 hooks 归位到组件自身 hook 链）。
- **三级边界**：`overlay-root`（面板最外层）→ `panel-root`（面板内容）→ 各 tab 与所有对话框。任一崩溃都不再整面板白屏，而是在面板内显示错误卡片 + 「重试 / 返回计划页」。
- **崩溃自愈**：边界 `onCrash` 置 `panel.crashed`；下次打开面板（或 `InputButton` 检测到 crash）自动把 tab 回落为 `plan` 并清除标志。图谱浮层崩溃则关闭自身浮层。
- **数据防御**：Panel `refresh` 用自增序号丢弃过期响应竞态；各 tab 渲染前对数据做空值防护。

## 日志链路

- **Host boot log**：启动即写 `appendFileSync` 到 `<DSH_MEMORY_LOG_DIR>/memory-manager-boot.log`（默认「用户主目录/.dsh/」，可用 `DSH_MEMORY_LOG_DIR` 重定向），记录 `apply()` / `install()` / settings 注册 / 路由注册 / `loadPlan`/`autoInject` 等关键链路与错误堆栈。
- **Client diag.log**：前端 `log()` 与 `window error / unhandledrejection` 全局捕获把客户端日志经 `diag.log` op POST 到 Host，Host 追加到 `<DSH_MEMORY_LOG_DIR>/memory-manager-client.log`（时间戳 + level + tag + msg + stack；错误 3s 节流去重，仅采集与插件相关堆栈）。日志本身失败绝不抛出。

这一「Host 落盘 + Client 上报」双链路使远程 / 生产排错不依赖浏览器开发者工具。

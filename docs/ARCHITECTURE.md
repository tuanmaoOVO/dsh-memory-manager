# 架构设计

本插件是 **宿主级（Host）插件**，通过 Cordis 以 bundle 形式挂载进 DSH profile，为所有会话提供跨会话记忆能力。整体上由 **Host 半区**（`lib/`，Node 进程内 ESM，按职责分模块）与 **Client 半区**（`lib/client.js`，浏览器 bundle）组成，两者经 HTTP JSON API 通信。

**设计原则（0.5.0 起）**：只依赖 DSH 最稳定的核心扩展点（volatile `Config` / `ctx.settings.update` / `tools` / `agent` 事件 / `webServer` / `sessionQuery`），功能全部自包含实现，官方插件包一律不依赖；官方升级的影响面被压缩为「个别能力降级」，而不是「加载失败」。

> **版本基线**：实现按 **0.2.0-rc.1** 逐条核对，并在 **0.2.0-rc.2** 上复验 —— 两版之间本文件列出的集成面（见下表）**逐文件 diff 无源码变更**，通过的准入校验为 DSH 自带的 `evaluatePluginCompatibility`（对照运行版本 `0.2.0-rc.2`）。

## 架构总览（ASCII）

```
 ┌──────────────────────────────────────────────────────────────────────┐
 │                         DSH 宿主进程 (Node)                          │
 │                                                                      │
 │  lib/index.js  (插件装配：name/inject/Config/apply)                  │
 │   ├─ volatile Config (schemastery, 9 字段全部 .volatile())           │
 │   │    DSH 设置页投影 → ctx.settings.update(profile entry id, patch)  │
 │   │    内核就地提交 volatile 引用 → loader/volatile-update → m.cfg   │
 │   ├─ lib/memory.js    记忆库 (node:fs 直读，零 DSH 依赖)             │
 │   │    memories/*.md  MRU memoryIndex + backlinkIndex                │
 │   │    pinned/plan.json · excluded.json · once.json                  │
 │   ├─ lib/sessions.js  会话视图（live 优先/只读回退）                  │
 │   │    ctx.sessions → surface.nodes + snapshotEvents                 │
 │   │    ctx.sessionQuery.readSurface / readTitle / listSessions       │
 │   ├─ lib/llm.js       ctx.llm.stream + agentDefaultModel             │
 │   ├─ lib/tools.js     6 个 Agent 工具（defineTool，官方不可用兜底内置）│
 │   ├─ lib/api.js       webServer 兼容通道 + connection.rpc 标准通道   │
 │   └─ 事件: agent/pre-step 注入 · agent/created 预载自动注入          │
 │                                                                      │
 │   POST {op,sessionId,args}                    GET /_dsh/.../api      │
 │   /_dsh/memory-manager/api  ◄─── HTTP ───►  探测 (ok/service)        │
 │   /api/memory-manager/<op>   ◄── connection.rpc（标准通道，鉴权）    │
 └──────────────────────────────────────────────────────────────────────┘
                     ▲
        同源 fetch  │  ────────────────
                     │
 ┌──────────────────────────────────────────────────────────────────────┐
 │                        浏览器 (Client 半区)                          │
 │  lib/client.js (window.__ModuleLoader__.load({id, factory}) 包裹)     │
 │   exports.inject = ['slots'] · exports.apply(ctx)                    │
 │   插槽 (6 条, 0.2.0 SlotMap 逐名核对):                                 │
 │     conversation.input.left              → 「记忆」按钮             │
 │     conversation.session.header.actions  → JumpReceiver (消息跳转)   │
 │     shell.overlay (×2)                   → 右侧面板 + 左侧图谱浮层   │
 │     settings.section                     → 设置页「记忆管理」        │
 │     conversation.chat.assistant-actions  → 消息动作条(保存/固定)     │
 │   右侧面板 3 tab: 计划 / 记忆库 / 消息                                  │
 │   左侧图谱浮层: GraphPanel (全景/焦点双视图) + SummarizeDialog        │
 │   会话导航: ctx.uiWorkspace.openSession(id)（旧内核回退 sessions.open）│
 │   主列复位: ctx.layout.selectPanel(null)                             │
 │   错误边界 Boundary × N + 崩溃自愈 + 全局错误捕获(diag.log)          │
 └──────────────────────────────────────────────────────────────────────┘
```

## 与 DSH 的集成面（适配层）

| 能力 | 实现（0.2.0） | 缺失时降级 |
|---|---|---|
| 配置 | 导出 schemastery `Config`（字段全 `.volatile()`）；DSH 设置页投影表单；写回 `ctx.settings.update(profile entry id, patch)`（ns 取 `ctx.fiber.entry.options.id`） | 无 settings 服务时仅进程内配置；无 `.volatile()` 时无设置页 |
| 配置热更新 | `ctx.on('loader/volatile-update')` → `m.syncCfg()` 重新解包 volatile 引用 | 仍然每次写前读一次引用，不依赖事件也会生效 |
| 记忆面板 / 浮层 | `ctx.slots.inject(name, () => ctx.slots.register({name,id,order,label}, Component))` | 客户端不注册插槽 |
| Agent 工具 | `ctx.tools.register(defineTool({ name, description, parameters, output:{schema,render}, execute }))` | 不注册工具 |
| 上下文注入 | `agent/pre-step` 瀑布返回 `{kind:'enter', messages:[..., snapshot]}`（`source.kind:'memory-manager'`, `form:'snapshot'`, `sections`） | 不注入 |
| 新会话判定/预载 | `agent/created`（`global:true`）+ `ctx.sessions` / `sessionQuery` | 手动加入计划 |
| 会话读取 | live `ctx.sessions.get(id)`；只读 `ctx.sessionQuery.readSurface()` | 对应功能报「会话不存在或不在线」 |
| 会话列表 | `ctx.workspaceRegistry`（list/archivedSessionIds）+ `ctx.sessionQuery.readTitle`；无工作区服务时回退 `sessionQuery.listSessions()` | 仅返回空结构 |
| LLM | `ctx.llm.stream` + `ctx.agentDefaultModel.currentSelection()` | 明确报错，不落库 |
| HTTP | `ctx.webServer.register({kind:'exact', path:'/_dsh/memory-manager/api'})` + `ctx.connection.rpc.intercept('/api', ...)` | 客户端 API 不可用 |
| 会话导航（Client） | `ctx.uiWorkspace.openSession(target)` | 回退旧内核 `ctx.sessions.open(id)`；都没有则只派发跳转事件 |
| 主列面板（Client） | `ctx.layout.selectPanel(null)` | 静默跳过 |
| 记忆库 / 计划 / 排除 | `node:fs` 纯文件层（`.dsh-memory`），与 DSH 存储完全隔离 | — |

> 全部经 `ctx.get(name)` / `ctx.get(name, false)` 可选探测。硬依赖只有 `inject = ['tools']`；`settings` 改为可选注入 + 懒读取。
> 记忆库、注入计划、轮次排除等数据层完全自包含（`node:fs`），与 DSH 存储无耦合。

## 数据模型

### 记忆 = 不可变快照 + 可编辑标注层

一条记忆由三部分构成：

- **快照（snapshot）**：不可变正文（`## 快照` 之后、`<!-- mem:notes -->` 之前）。用于记录事实、决定、待办等历史内容。
- **标注层（notes）**：`<!-- mem:notes -->` 之后的文本，是可编辑的补充注释层，可随时修改而不污染快照。
- **元数据（front-matter meta）**：标题、印象、分类标签、启用开关、链接、组合来源、来源会话等，是检索与图谱的依据。

### 印象（impressions）

每条记忆最多 12 个、每个不超过 40 字符的简短标签（`sanitizeImpressions`）。印象同时充当检索主键、图谱节点与注入摘要（`compact` 视图）。

### 记忆标签（tags）与启用开关（enabled）

- **`tags`（分类标签）**：`tags` 含 `convention` 即**规约记忆**、含 `会话总结` 即**会话总结记忆**。规约记忆在新会话**自动常驻注入**；会话总结记忆自动注入**最近 8 条**（按 `updatedAt` 降序）。
- **`enabled`（记忆级开关）**：`false` 的记忆不参与新会话自动注入、不能被加入注入计划（已在计划中的也不再注入）。

### 组合（composedOf）与双向链接（backlink）

- **`composedOf`**：非破坏性聚合来源记忆 id；`memory_recall` 可读原记忆。
- **`links`**：显式关联（可编辑）；扫描时自动建立反向索引 `backlinkIndex`。`relatedOf` 用 BFS 沿 `links` + `backlinks` 做「链式回忆」。

### 注入计划（plan）

- **全局计划** `pinned/plan.json`：`{ pinned: [{id, role, text, at}], memories: [{id, title, impressions, tags}], injectOnce }` —— 所有会话共享（与 0.3.x 行为一致）。
- **轮次排除** `pinned/excluded.json`：按会话 id 分键的 turnId 数组。
- **一次性注入** `pinned/once.json`：全局队列，任何会话的下一次请求注入后自动清除。

## 记忆文件格式

记忆存放在记忆库的 `memories/<id>.md`，`<id>` 匹配 `^[A-Za-z0-9_-]{3,64}$`。front-matter 使用 YAML 风格键值（值以 JSON 解析，失败则按字符串）。字段与正文结构（`## 快照` / `<!-- mem:notes -->`）与 0.3.x 完全一致，详见 [API.md](API.md#记忆文件格式示例)。

**Obsidian 兼容**：标准 Markdown + front-matter，可直接用 Obsidian 打开做图谱；`links`/`composedOf` 命中的 id 在面板详情页可点击跳转。

## 配置与迁移

- **volatile `Config`**：字段与默认值见 [API.md](API.md#4-配置-schemavolatile-config)。9 个字段全部 `.volatile()`，DSH 设置页据此投影表单；内核把变更**就地**提交进 volatile 引用（`@deepseek-ai/cosmokit` 的 `Volatile<T>`）并派发 `loader/volatile-update`，插件无需重挂即可生效。
- **写入路径**：`ctx.settings.update(<profile entry id>, patch)`，落盘到 profile 的 `cordis.patch.yml`。`ns` 取 `ctx.fiber.entry.options.id`（本插件是 `memory-manager`），取不到时回退同名常量。写入前先乐观更新进程内快照 `m.cfg`（UI 立即可见），**不**在成功后立即回读（落盘 → 重组 → 提交 volatile 是异步链路，立刻回读会把乐观值打回旧值），只有写失败才用权威配置回滚。
- **设置页形态**：插件自带设置区块（客户端 `settings.section`），因此 `ctx.settings.configure({ auto: false }, ctx.fiber)` 关闭内核自动生成表单（在可选 `ctx.inject(['settings'], …)` 子作用域里绑定，设置服务缺失或晚到时插件照常加载）。
- **总开关 `enabled`**：`false` 时不注入、Agent 工具拒绝执行、API 仅放行 `state.get` / `state.setEnabled` / `diag.log`。
- **旧 `config.json` 自动迁移**：升级后首次运行若记忆库目录下存在 0.1.x 的 `config.json`，把 `mode`/`view`/`modelTools`/`libraryPath`/`memoryChars`/`totalChars`/`pinChars` 一次性写回 profile 设置，并落 `pinned/.config-imported` 标记（幂等）。
- **默认记忆库锚点**：`libraryPath` 为空时依次尝试 `workspaceRegistry.list()[0].path` → 任一 agent 会话 `header.cwd`，追加 `.dsh-memory`。

## 注入机制

- **注入消息（agent/pre-step）**：注册 `agent/pre-step` 瀑布（`prepend: true`）。监听器 `await next()` 得到 `{kind:'enter', messages}` 决策；仅当**用户消息触发**（`payload.messages` 含 `source.kind==='user'`）时，先 `await m.ensureInjectionReady(sessionId)` 补齐懒加载的计划与记忆索引，再向消息末尾追加一条 user 消息（`source: { kind: 'memory-manager', form: 'snapshot', sections: [{ name: 'memory-manager:context', text }] }`），模型可见、UI 折叠显示、随会话日志持久化（满足「模型可见即已记录」不变式）。
  - **懒加载竞态**：`loadPlan()`（由 `agent/created` 预载或 HTTP 触发）与 `scanLibrary()`（install 里后台跑）都是异步的，首个用户请求可能早于它们完成 —— 不补齐就会**第一轮静默不注入**。`ensureInjectionReady` 在渲染前 await 两者（都带缓存，命中后 O(1)），由 `tests/test-pre-step-e2e-020.mjs` 的真实 AgentLoop 端到端回归守护。
  - **0.2.0 契约**：`MessageSource` 是 merge-extensible 判别联合，明确没有通用 `'plugin'` kind —— 生产者声明自己的 `kind`（官方 `time-context` 即 `kind:'time-context'`）。`form:'snapshot'` 必须携带 `sections`。历史会话里 0.1.x 写入的 `{ kind:'plugin', plugin:'memory-manager' }` 仍被 `lib/util.js` 的 `isOwnSource` 识别。
  - 不依赖 `systemPrompt`（极简 complete 模式也生效）；不依赖 `includeRuntimeContext` 门控。
- **按需激活**：`cfg.mode === 'on'` 或 `plan.injectOnce === true` 或 once 队列非空时渲染。
- **预算分配**：先固定消息（上限 `min(pinChars, totalChars)`），再勾选记忆（单条 `memoryChars`、总量 `totalChars`），再一次性队列；紧凑视图只注入标题 + 印象 + 300 字预览。
- **包装格式**：`=== 记忆库上下文（用户指定，供参考；非当前对话的实时内容） ===` … `=== 记忆库上下文结束 ===`。

### 自动注入机制（新会话常驻规约 / 会话总结）

- **触发**：`agent/created`（`global:true`）与启动时对已有 agent 预载；全局计划文件**首次创建**时才尝试自动注入（幂等）。
- **新会话判定**：会话日志中没有任何 `user/message` / `assistant/message` 事件才算新会话（系统策略事件不算历史）。
- **注入内容**：全部启用中的规约记忆（`tags` 含 `convention`）+ 最近 `SUMMARY_AUTO_INJECT_MAX`（8）条会话总结记忆（`tags` 含 `会话总结`，`updatedAt` 降序）。

## 会话总结链路（session.summarize）

```
用户选会话(可选最近N轮/智能合并)
   → session.summarize op (HTTP)
   → buildTurns 整理轮次（跳过已排除）
   → (merge=true) LLM 判断同一事务的连续轮次 → 分组
   → 每组交给 ctx.llm.stream → 六要素 JSON {user, thinking, processing, result}
   → memory.save 入库: title "会话总结（<sid> · 轮次 X-Y）",
     impressions ["会话总结", "会话 <sid>"], tags ["会话总结"], sourceSeqs = 覆盖的 seq
   → 返回 { summaries, count }
```

- LLM 不可用（未配置默认模型）时明确报错，不落库任何记忆。

## 排除 / 恢复机制

- **排除（非破坏）**：对目标轮次每个表面节点插入标记消息（`[记忆管理] 该轮已被排除 | turn=<turnId>`，`surfaceOp:{op:'replace'}`），turn 写入计划的 `excluded`；不删除任何数据。工具节点用深度相等镜像标记（满足 surface 契约）。
- **恢复**：根据标记的 `sourceEventSeqs` 找到原始事件，把原始节点写回表面并从 `excluded` 移除；自愈门槛不依赖 `excluded` 列表。
- **依赖可写 live 会话**：只读视图（宿主模式只读会话）下返回提示「排除/恢复需要 live 会话」。（live 视图经 `ctx.sessions.get`，只读经 `sessionQuery.readSurface`，写入仅接受 live。）
- **跨版本写入适配（0.4.1 起，`m.appendReplace`）**：
  - DSH 0.1.5 起 `SurfaceOp` 位置替换字段由 `{ start, end }` 改名为 `{ startSeq, endSeq }`；**0.2.0 的 `isReplaceOp`（`packages/core/session/src/surface.ts`）仍按 `Object.keys(op).length === 3` + `Object.hasOwn` 精确匹配**，旧字段抛 `... carries an invalid replace surfaceOp`。首次调用探测并缓存内核字段名（新形状优先，失败回退旧形状），`Session.append` 在校验失败时于写日志之前抛出（`validateNext` 在 `log.push` 之前），因此回退重试不会写入脏日志；0.1.2 到 0.2.0 都可写。
  - **0.2.0 新增约束（插件均已满足）**：
    - 可上表面的事件（`system/message`、`developer/message`、`user/message`、`assistant/message`、`tool/result`）**必须**携带 `surfaceOp`，否则抛 `session event "<type>" is surface-eligible and requires a surfaceOp marker`；
    - `sourceEventSeqs` 必须非空、无重复、全部引用更早的事件，且**完整覆盖被遮蔽的表面节点**（插件单节点替换即 `[seq]`）；
    - `tool/result` 的位置替换**只能改写 `content`**（其余字段须与原事件深度相等），且必须命中一个当前表面的 `tool/result`；
    - 表面节点 0 若是 `system/message`，只能被“覆盖该单节点的 `system/message`”改写（轮次 span 从目标 user 消息开始，不会触及节点 0）。
  - `assistant/message` 不能作为表面替换事件：`assertSourceEventReferences` 禁止它携带 `sourceEventSeqs`，而替换必须携带被遮蔽节点的 seq。恢复轮次时先尝试原样还原，捕获该错误后降级为 user 文本还原（前缀 `[已恢复的助手回复]`）；user / tool 节点仍原样还原。降级消息刻意使用 `source.kind: 'user'`，**不能**用插件自己的 kind，否则会被 `isMarkerEvent` 当成新的排除标记。
  - 回归测试：`tests/test-surface.mjs` 用真实 `Session` 覆盖以上各条，可在任意 DSH 检出上运行。

## HTTP API 设计

- **双通道**（同一 `handler`）：
  - 兼容通道：`/_dsh/memory-manager/api`（`ctx.webServer.register({kind:'exact', path, handler})`；0.2.0 的 `WebRoute` 仍是 `{kind:'exact'|'prefix', path, handler(req,res)}`）。  - 标准通道：`ctx.connection.rpc.intercept('/api', endpoint => endpoint.startsWith('memory-manager/'), handler)`。注意 0.2.0 的首个参数是**保留频道字面量** `'/api'`（不是任意前缀），归属由第二参数 `matches` 判定；`/api` 由 Typert Gateway 拥有，插件的 `memory-manager/*` 谓词与它不冲突。0.2.0 更「官方」的做法是 `TypertRemoteService` + `@Remote`（见 `docs/cookbook/adding-a-remote-api.md`），本插件为保持跨版本兼容仍走 `intercept`。
- **GET**：探测 `{ ok:true, service:'memory-manager', enabled }`。
- **POST**：JSON 信封 `{ op, sessionId?, args? }`；响应 `{ ok, value }`（业务错误 `ok:false` + `value.error`）。请求体上限 256 KiB。
- **op 清单（共 29 个）**：见 [docs/API.md](API.md)。

## Client 插槽与面板结构

6 条插槽注册（`slots.inject(name, () => slots.register(def, Component))`，0.2.0 `SlotMap` 逐名核对；注册必须包在 `inject` 里，注册进未声明的槽位会在激活期抛错）：

- **`conversation.session.header.actions`**（order 1000，`memory-manager-jump-receiver`，list / session）：隐藏的消息跳转接收器，按 `anchorSeq` 匹配对话行并滚动 `[data-conversation-scroll]` 容器、高亮。
- **`conversation.input.left`**（order 10，list / session）：输入栏左侧「记忆」按钮，显示当前模式。
- **`shell.overlay`**（order 30，`memory-panel`，list / root）：右侧固定侧栏面板（560px，`--dsw-*` 主题变量自适应深浅色）。
- **`shell.overlay`**（order 40，`memory-graph`，list / root）：左侧记忆图谱浮层，独立开关。
- **`settings.section`**（order 30，label 记忆管理，list / root）：设置页区块。
- **`conversation.chat.assistant-actions`**（order 15，list / session）：每条助手消息动作条「💾 保存为记忆」与「📌 固定 / 取消固定」。

标准 props（0.2.0）：`sessionId` / `useSession` / `useProjection` 是 **session 作用域**标准 props；`useSessions` 是**全局**标准 props（每个槽位都有）；Chat 目标数据由 ui-chat 通过 `useChat`（`ChatSnapshot{ order, nodes(ChatNodeStore), locations, navigation, timeline, legacy }`）注入 —— 0.2.0 起 `SessionSnapshot` 明确「excluding Conversation target data」，已无 `s.chat`。

会话导航（记忆库 / 消息页的「在对话中定位」）在 0.2.0 用 `ctx.uiWorkspace.openSession(target)` —— 客户端 `ctx.sessions` 已移除 `open(id)`（其契约注释写明「navigation belongs to view owners」），只保留 `retain` / `using` / `binding` / `fork` / `search` 等数据面方法；插件保留旧内核的 `ctx.sessions.open(id)` 回退。之后仍调 `ctx.layout.selectPanel(null)` 复位主列（官方 `ui-workspace` 的 `openSession` 也这样做）。

对话行的锚点：0.2.0 的 `ChatNodeSeat` 同时输出 `data-chat-node-key={node.key}` 与 `data-chat-anchor-key={flowKey}`（分组内成员的 flowKey 是 `JSON.stringify([key, groupPart])`）。插件**优先按 `data-chat-node-key` 精确匹配**，再回退 `data-chat-anchor-key`（含分组前缀匹配）。

### 右侧面板（3 tab）

计划（临时记忆模式 / 单次注入 / 注入视图 / Agent 工具开关；固定消息 / 勾选记忆 / 已排除轮次）· 记忆库（搜索、多选组合、查看 / 编辑 / 加入计划、标签与启用开关、消息位置追溯）· 消息（跨工作区会话选择器 + 轨迹风格轮次 / 步骤行；消息级勾选 → 保存为记忆 / 固定；轮次级排除 / 恢复；会话总结入口；行级「在对话中定位」）。

### 左侧力导向图谱（GraphPanel）

- **全景**：语义分层全景（最新 N 条，按标签着色：规约蓝 / 会话总结绿 / 复盘橙 / 其他灰，力导向 160 迭代）。
- **焦点**：以焦点记忆为中心 1–2 跳邻域（`links` + `composedOf` + `backlinks`），径向确定性布局。
- **三类边**：`links`（主动关联）、`composedOf`（组合来源，短划线）、`backlinks`（被引用）。

## 错误边界 / 崩溃自愈

Client 采用「三级 Error Boundary + 自愈」策略：全部组件以 `h(Component, props)` 调用（杜绝直接函数调用，保证 hooks 归位）；任一崩溃显示错误卡片 + 「重试 / 返回计划页」；图谱浮层崩溃则关闭自身浮层；Panel `refresh` 用自增序号丢弃过期响应竞态。

## 日志链路

- **Host boot log**：`<DSH_MEMORY_LOG_DIR>/memory-manager-boot.log`（默认 DSH 主目录，可用 `DSH_MEMORY_LOG_DIR` 重定向），记录 apply / install / settings / 工具 / 路由 / 注入链路与错误堆栈。
- **Client diag.log**：前端日志经 `diag.log` op POST 上报 Host 落盘（`memory-manager-client.log`），错误 3s 节流去重。日志本身失败绝不抛出。

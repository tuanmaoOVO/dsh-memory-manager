# 架构设计

本插件是 **宿主级（Host）插件**，通过 Cordis 以 bundle 形式挂载进 DSH profile，为所有会话提供跨会话记忆能力。整体上由 **Host 半区**（`lib/`，Node 进程内 ESM，按职责分模块）与 **Client 半区**（`lib/client.js`，浏览器 bundle）组成，两者经 HTTP JSON API 通信。

**设计原则（0.4.0 起）**：只依赖 DSH 最稳定的核心扩展点（settings / tools / agent 事件 / webServer），功能全部自包含实现，官方插件包一律不依赖；官方升级的影响面被压缩为「个别能力降级」，而不是「加载失败」。

## 架构总览（ASCII）

```
 ┌──────────────────────────────────────────────────────────────────────┐
 │                         DSH 宿主进程 (Node)                          │
 │                                                                      │
 │  lib/index.js  (插件装配：name/inject/Config/apply)                  │
 │   ├─ lib/settings: memory-manager 命名空间 (applies:live)            │
 │   │    启用/模式/视图/工具/路径/字符上限/新会话自动注入 config.json 迁移│
 │   ├─ lib/memory.js    记忆库 (node:fs 直读，零 DSH 依赖)             │
 │   │    memories/*.md  MRU memoryIndex + backlinkIndex                │
 │   │    pinned/plan.json · excluded.json · once.json                  │
 │   ├─ lib/sessions.js  会话视图（live 优先/只读回退）                  │
 │   │    ctx.sessions → surface.nodes + snapshotEvents                 │
 │   │    ctx.sessionQuery.readSurface（只读）                          │
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
 │  lib/client.js (window.__ModuleLoader__.load 包裹的 CJS bundle)      │
 │   插槽 (6 个, 0.1.2 SlotMap 已验证):                                   │
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

## 与 DSH 的集成面（适配层）

| 能力 | 实现 | 缺失时降级 |
|---|---|---|
| 配置 | `ctx.settings.register('memory-manager', Config, { applies:'live' })` | 使用内存配置 |
| 记忆面板 / 浮层 | `ctx.slots.inject(name, () => ctx.slots.register({name,id,order,label}, Component))` | 客户端不注册插槽 |
| Agent 工具 | `ctx.tools.register(defineTool({...}))` | 不注册工具 |
| 上下文注入 | `agent/pre-step` 瀑布返回 `{kind:'enter', messages:[..., snapshot]}` | 不注入 |
| 新会话判定/预载 | `agent/created`（`global:true`）+ `ctx.sessions` / `sessionQuery` | 手动加入计划 |
| 会话读取 | live `ctx.sessions.get(id)`；只读 `ctx.sessionQuery.readSurface()` | 对应功能报「会话不存在或不在线」 |
| 会话列表 | `ctx.workspaceRegistry`（list/archivedSessionIds）+ `ctx.sessionQuery.readTitle` | 仅返回空结构 |
| LLM | `ctx.llm.stream` + `ctx.agentDefaultModel.currentSelection()` | 明确报错，不落库 |
| HTTP | `ctx.webServer.register({kind:'exact', path:'/_dsh/memory-manager/api'})` + `ctx.connection.rpc.intercept('/api', ...)` | 客户端 API 不可用 |

> 全部经 `ctx.get(name)` / `ctx.get(name, false)` 可选探测；旧版 DSH 的 loose 读取语义被保留。
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

- **settings 命名空间**：`memory-manager`，字段与默认值见 [API.md](API.md)。`applies:'live'`，改动即时生效（`scope.watch` 同步进内存 `cfg`）。
- **总开关 `enabled`**：`false` 时不注入、Agent 工具拒绝执行、API 仅放行 `state.get` / `state.setEnabled` / `diag.log`。
- **旧 `config.json` 自动迁移**：首次运行若默认记忆库下存在旧版 `config.json`，合并进 `base` 作为设置初始值。
- **默认记忆库锚点**：`libraryPath` 为空时依次尝试 `workspaceRegistry.list()[0].path` → 任一 agent 会话 `header.cwd`，追加 `.dsh-memory`。

## 注入机制

- **注入消息（agent/pre-step）**：注册 `agent/pre-step` 瀑布（`prepend: true`）。监听器 `await next()` 得到 `{kind:'enter', messages}` 决策；仅当**用户消息触发**（`payload.messages` 含 `source.kind==='user'`）时，向消息末尾追加一条 `form: 'snapshot'` 的 plugin 消息（`source: { kind: 'plugin', plugin: 'memory-manager', form: 'snapshot', sections: [{ name: 'memory-manager:context', text }] }`），模型可见、UI 折叠显示、随会话日志持久化（满足「模型可见即已记录」不变式）。
  - 不依赖 `systemPrompt.section`（极简 complete 模式也生效）；不依赖 `includeRuntimeContext` 门控。
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
- **依赖可写 live 会话**：只读视图（宿主模式只读会话）下返回提示「排除/恢复需要 live 会话」。（0.4.0 起：live 视图经 `ctx.sessions.get`，只读经 `sessionQuery.readSurface`，写入仅接受 live。）

## HTTP API 设计

- **双通道**（同一 `handler`）：
  - 兼容通道：`/_dsh/memory-manager/api`（`ctx.webServer.register({kind:'exact', path, handler})`）。
  - 标准通道：`ctx.connection.rpc.intercept('/api', endpoint => endpoint.startsWith('memory-manager/'), handler)`（存在连接层时的鉴权通道）。
- **GET**：探测 `{ ok:true, service:'memory-manager', enabled }`。
- **POST**：JSON 信封 `{ op, sessionId?, args? }`；响应 `{ ok, value }`（业务错误 `ok:false` + `value.error`）。请求体上限 256 KiB。
- **op 清单（共 29 个）**：见 [docs/API.md](API.md)。

## Client 插槽与面板结构

6 个插槽注册（`slots.inject(name, () => slots.register(def, Component))`，0.1.2 `SlotMap` 逐名验证）：

- **`conversation.session.header.actions`**（order 1000，`memory-manager-jump-receiver`）：隐藏的消息跳转接收器，按 `anchorSeq` 匹配 `[data-chat-anchor-key]` 滚动 `[data-conversation-scroll]` 容器并高亮。
- **`conversation.input.left`**（order 10）：输入栏左侧「记忆」按钮，显示当前模式。
- **`shell.overlay`**（order 30，`memory-panel`）：右侧固定侧栏面板（560px，`--dsw-*` 主题变量自适应深浅色）。
- **`shell.overlay`**（order 40，`memory-graph`）：左侧记忆图谱浮层，独立开关。
- **`settings.section`**（order 30，label 记忆管理）：设置页区块。
- **`conversation.chat.assistant-actions`**（order 15）：每条助手消息动作条「💾 保存为记忆」与「📌 固定 / 取消固定」。

会话标准 props（session 作用域插槽自动注入）：`sessionId` / `useSession` / `useSessions` / `useProjection`；会话切换用 `ctx.sessions.open(id)`。

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

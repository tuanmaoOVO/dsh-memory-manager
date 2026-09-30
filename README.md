# 记忆管理插件（dsh-memory-manager）

> 为 DSH（DeepSeek Harness）打造的记忆管理插件：跨会话记忆库、规约记忆自动注入、会话总结、上下文计划注入、Agent 记忆工具、力导向图谱与完整的对话侧栏面板。
> **Memory Manager for DSH — cross-session memory library, conventions auto-injection, session summaries, context planning & Agent memory tools.**

---

## 功能特性

- **文件夹记忆库**：以「文件夹 + Markdown」形式存放记忆（`memories/*.md`），front-matter 元数据，**Obsidian 兼容**，可直接用任意编辑器或图谱工具打开。
- **记忆 = 不可变快照 + 可编辑标注层**：快照保存历史事实，`<!-- mem:notes -->` 标注层可随时补充说明，互不污染。
- **记忆标签（tags）与启用开关（enabled）**：每条记忆可带分类标签与记忆级启用开关；`tags` 含 `convention` 即规约记忆、含 `会话总结` 即会话总结记忆，`enabled=false` 的记忆不参与自动注入、不能加入注入计划。
- **规约记忆自动注入（autoInjectConvention）**：开启后，**每个新会话默认常驻**所有启用中的规约记忆（`tags` 含 `convention`）与最近 8 条会话总结记忆（`tags` 含 `会话总结`）；旧会话不自动注入，可在「记忆库」页手动加入。
- **会话总结（session.summarize）**：把所选会话的对话轮次交给 LLM 提炼为「会话id / 轮次 / 用户请求 / 思考链 / 处理链 / 结果」六要素记忆；支持「最近 N 轮」范围与「智能合并」（LLM 判断哪些连续轮次处理同一事务并合并为一条）。生成即自动入库，并默认参与新会话自动注入。
- **印象（impressions）**：每记忆可带少量简短标签，作为检索主键与图谱节点；支持 LLM 生成印象建议。
- **组合（composedOf）与双向链接（backlink）**：可把多条记忆**非破坏性**聚合成一条组合记忆；`links` 自动建立反向引用索引。
- **上下文计划注入（agent/pre-step 消息注入）**：按会话维护一份注入计划（固定消息 + 勾选记忆），记忆模式开启后每次发送自动注入到模型请求（`source.form: 'snapshot'` 的插件消息，UI 折叠显示、模型可见），带单条 / 总量 / 固定消息三级字符上限与紧凑视图；对极简模式（persona `complete: true`）等任何会话形态都生效。
- **6 个 Agent 记忆工具**：`memory_search` / `memory_recall` / `memory_save` / `memory_set_enabled` / `session_inject` / `memory_pin`，可整体开关，模型可直接读写记忆库、按需管理会话注入计划。
- **完整对话侧栏面板**：三个标签页 —— 计划 / 记忆库 / 消息；从浏览器输入栏的「记忆」按钮、消息动作条或面板直接操作。
- **力导向图谱（左侧浮层）**：独立于右侧面板的**左侧浮层面板**，含**语义分层全景**与**焦点探索**双视图（`mg-*` 组件）；按标签着色（规约 / 会话总结 / 复盘 / 其他），支持搜索定位、聚焦邻域、缩放 / 平移与详情 / 相关记忆跳转。
- **消息跳转（JumpReceiver）**：在消息页 / 记忆详情可一键**在对话中定位**到来源消息——`conversation.session.header.actions` 插槽内的隐藏接收器按 `anchorSeq` 匹配并滚动高亮，跨会话自动切换。
- **跨工作区会话列表（sessions.list）**：可在面板消息页 / 会话总结中浏览并选择全部工作区的会话（含归档标记）。
- **跨会话共享**：宿主级插件，记忆库数据跨会话共享，不受进程重启影响（存于磁盘）。
- **设置页自由开关**：宿主启用后可在 DSH 设置页独立控制启用、注入模式、注入视图、新会话自动注入规约/会话总结、Agent 工具开关、记忆库路径与字符上限。
- **非破坏性轮次排除 / 恢复**：可把某轮对话排除出注入（不删除），随时恢复参与。

## 架构一句话

插件是宿主级（Host）插件：`lib/` 按职责分模块（`index` 装配 / `memory` 记忆库 / `plan` 计划 / `sessions` 会话 / `llm` 摘要 / `tools` 工具 / `api` 接口 / `util` 工具），只依赖 DSH 核心扩展点（volatile `Config` + `ctx.settings.update` / `tools.register` / `agent/pre-step`、`agent/created` / `webServer` / `sessionQuery`），记忆库、注入计划、轮次排除、会话总结与图谱数据全部自实现，**不依赖任何官方插件包**。客户端 `lib/client.js` 为标准 `window.__ModuleLoader__.load({ id, factory })` 浏览器 bundle，经 `dsh.client` 声明由 DSH 客户端模块系统自动发现；两端通过 `/_dsh/memory-manager/api`（JSON 信封 `{op, sessionId, args}`）通信，存在 `ctx.connection` 时同时注册 `/api/memory-manager/<op>` 标准通道。

## 兼容性（跨版本适配策略）

0.5.0 面向 **DSH 0.2.0-rc 系列**——在 **0.2.0-rc.1** 上逐条核对实现，并在 **0.2.0-rc.2** 上复验（对两版做逐文件 diff：插件用到的 12 个集成点包全部无源码变更，唯一相关差异是客户端插槽目录新增了一个官方槽位 `sidebar.right.tab.files.actions`，与插件无关；DSH 自带准入校验 `evaluatePluginCompatibility(0.2.0-rc.2)` 放行）。同时保留对 **0.1.2-rc.1 → 0.1.7-rc.2** 的降级兼容：

| 集成面 | 策略 |
|---|---|
| **配置** | 0.2.0 移除了 `ctx.settings.register(ns, Config, opts)`（连同 `get/watch/update/dispose` 作用域一并删除，无兼容层）。插件改为导出 schemastery `Config`（9 字段全 `.volatile()`）由 DSH 设置页投影表单；读取 `apply()` 收到的 volatile 引用（`{get()}`），写回 `ctx.settings.update(<profile entry id>, patch)`；`ctx.settings.configure({auto:false})` 关闭自动表单（插件自带设置区块）。schema 优先取 `@deepseek-ai/schemastery`（DSH vendored 同名包），缺失或旧版无 `.volatile()` 时降级为「无设置页」，插件其余能力不受影响 |
| **消息来源** | 0.2.0 的 `MessageSource` 不再有通用 `'plugin'` kind，改为 `kind: 'memory-manager'`；`form:'snapshot'` 必须携带 `sections`；历史会话里 0.1.x 的 `{kind:'plugin', plugin:'memory-manager'}` 仍被识别（排除标记恢复依赖它） |
| 事件 / 工具 / 注入 / `webServer` | 只用核心服务与事件，`ctx.get` 可选探测，缺失即降级（如工具不注册、注入不激活），不阻断启动；硬依赖仅 `inject: ['tools']` |
| 会话读取 | 优先 live `ctx.sessions.get(id)`（`surface.nodes` + `snapshotEvents()`；该读法在 0.2.0 已标 deprecated，失败即回退 `ctx.sessionQuery.readSurface()`） |
| 会话表面写入（排除 / 恢复） | `m.appendReplace` 首次调用探测内核 `SurfaceOp` 字段名并缓存（0.2.0 为 `{op:'replace', startSeq, endSeq}`，恰好 3 个自有键；0.1.2 为 `{op:'replace', start, end}`），两版都可写；0.2.0 额外要求 surfaceOp 必填、`sourceEventSeqs` 完整覆盖被遮蔽节点、`tool/result` 只能改 `content`；`assistant/message` 不能作为替换事件，恢复时降级为 user 文本（内容不丢） |
| 会话列表 | `ctx.workspaceRegistry`（list / archivedSessionIds）+ `ctx.sessionQuery.readTitle`（0.2.0 返回 `SessionTitleSnapshot`）；无工作区服务时回退 0.2.0 的 `sessionQuery.listSessions()` |
| LLM | 直接调 `ctx.llm.stream` + `ctx.agentDefaultModel.currentSelection()` —— 会话总结 / 印象建议自包含 |
| 记忆库 / 计划 / 排除 | `node:fs` 纯文件层（`.dsh-memory`），与 DSH 存储完全隔离 |
| 客户端 bundle | `window.__ModuleLoader__.load({id, factory})` 与 `dsh.client` 声明在 0.2.0 未变；`exports.inject = ['slots']`；只用 0.2.0 `SlotMap` 中仍在的插槽（`conversation.input.left` / `session.header.actions` / `shell.overlay` / `settings.section` / `chat.assistant-actions`） |
| 客户端会话导航 | 0.2.0 移除了客户端 `ctx.sessions.open(id)`，改用 `ctx.uiWorkspace.openSession(target)`；插件保留旧内核的 `sessions.open` 回退，主列复位仍是 `ctx.layout.selectPanel(null)` |
| 客户端 Chat 数据 | 0.2.0 的 `SessionSnapshot` 不再含 `s.chat`（Chat 目标数据由 ui-chat 的 `useChat` 提供）；跳转接收器优先 `useChat`、回退旧字段 |
| 工具定义 | 优先 `defineTool`（`@deepseek-ai/dsh-tools`），不可用时回退内置等价实现（形状一致，均通过真实内核 `ctx.tools.register()` 校验） |

> 目标：官方 DSH 升级到下一个小版本时，插件最坏情况是「个别能力降级」，而不是「页面无法启动 / 插件加载失败」。

## 安装与挂载

请参阅 [docs/INSTALL.md](docs/INSTALL.md)。三条路径任选：

1. **Web 插件页**：填写绝对路径 `file:D:/dshTools/dsh-memory-manager` → 安装（默认启用）→ 重启（非 HMR profile）→ 刷新页面。
2. **命令行**：`dsh plugin --profile web add file:D:/dshTools/dsh-memory-manager`（开发迭代用 `link:` 前缀）。
3. **手动**：把包内 `cordis.patch.yml` 的 `insert` 段抄进 profile 层栈，并把包名加进 `dsh.profile.bundles`。

**安装前建议先自检**：`node scripts/preflight.mjs <DSH 检出路径>`（30 项，见 INSTALL.md）。

### 安全边界（装上不影响 DSH 本体）

- **只增不改**：bundle patch 只用 `insert`，插入行 `id: memory-manager` 为插件专属，不 `remove` / 不覆盖任何既有行；未声明 `dsh.profile`，永远不能充当或替换 profile 组合。
- **失败只损失自己**：所有 DSH peer 都是 optional（版本不匹配时只拒绝本 bundle）；客户端 bundle 是单条顶层 `load({id, factory})` 语句，工厂体整体包在 try/catch 内并预装惰性 `exports` —— 模块体抛错只会让插件静默失效，不会中断同一批脚本里的其它插件包。
- **只占自己的一格**：5 个目标插槽在 0.2.0 目录中都是 **list 型**（只增不替换）、非 `shadows-shipped-ui`，entry id 未占用任何官方 id；6 个模型工具名不与官方 65 个工具重名；HTTP 路由在 `/_dsh/memory-manager/api` 专属路径下。
- **三档开关**：业务软关闭（设置页总开关）→ 行级 `disabled: true`（等同于不存在，数据保留）→ 卸载（顺序为摘 bundle → 卸载运行时贡献 → pnpm remove）。
- **数据不在 DSH 里**：记忆库是你自己的 Markdown 目录，卸载不会删除；只有 `<DSH_HOME>/memory-manager-*.log` 两份日志可随手删。

以上每一条都由 `scripts/preflight.mjs` 机械校验，也是 `npm test` 的第一步。带上 DSH 检出路径时，它会额外用 **DSH 自己的准入校验**（`evaluatePluginCompatibility`）判定并打印对照到的运行版本（本次：`0.2.0-rc.2`，31 项全过）。

## 快速开始

1. 按 [docs/INSTALL.md](docs/INSTALL.md) 完成安装并重启 DSH。
2. 在浏览器打开对话，输入栏左侧出现「记忆 · 已关闭」按钮；DSH 设置页出现「记忆管理」区块。
3. 点击「记忆 · 已关闭」按钮打开侧栏面板；如记忆库为空，可先用示例库或「消息」页把某条消息保存为记忆。
4. 在「记忆库」页把记忆「加入计划」，或在「计划」页打开「临时记忆模式」（或将某条消息「固定」）。
5. 若记忆库中存在规约记忆或会话总结记忆，新会话会自动常驻注入；下一次发送消息时，模型请求即携带「=== 记忆库上下文 ===」注入内容（UI 折叠显示，模型可见）。
6. 点面板头部的「图谱」按钮可打开**左侧力导向图谱浮层**；消息页 / 记忆详情可一键跳转到对话中的来源消息。

> 提示：也可直接用 `examples/memory-library/` 作为记忆库路径，快速体验图谱与检索。

## 使用规约记忆（委派-验证-复盘闭环规约）

仓库根目录 [CONVENTIONS.md](CONVENTIONS.md) 是一份可直接使用的**规约详情文件**（委派-验证-复盘闭环规约 v4：打包 → 委派 → 验证 → 复盘 → 并入 的五阶段闭环）。把它作为**规约记忆**接入插件后，DSH 会在每个新会话中自动注入规约内容，让主 agent 按规约处理问题。

### 接入流程

1. **添加规约记忆**：在「记忆库」页保存一条规约记忆——
   - 标题：`委派-验证-复盘闭环规约 (v4)`（示例）
   - 快照：规约要点（可参考 CONVENTIONS.md 的「目的 / 五阶段流程 / 边界规则」章节）
   - 标签：`tags` 填入 `convention`（规约记忆标记；也可以直接对 agent 说"把 CONVENTIONS.md 保存为规约记忆"，由模型用 `memory_save` 完成）
   - 保持「启用注入」开启（默认开启）
2. **加入计划**：在「记忆库」页点该记忆的「加入计划」；或直接说"把规约加入会话计划"（`session_inject`）。
   - **新会话**：无需手动操作——`autoInjectConvention` 开启时，所有启用中的规约记忆**自动常驻**每个新会话。
   - **旧会话**：手动「加入计划」一次，之后该会话每轮自动注入。
3. **生效**：开启「临时记忆模式」（计划页开关）后，你每次发送消息，模型请求都会携带规约内容（UI 折叠显示、模型可见），主 agent 即按「打包 → 委派 → 验证 → 复盘 → 并入」流程处理问题。

### 配套机制

- **自动注入**：`tags` 含 `convention` 且启用中的记忆 → 每个新会话自动常驻（设置页「新会话自动注入规约/会话总结记忆」可整体关闭）。
- **记忆即经验库**：每次复盘由 agent `memory_save` 入库（impressions 含 `复盘` 与领域关键词），打包前 `memory_search` 检索历史经验——规约闭环中的「检索先行」要求记忆库持续沉淀、不断成长。
- **备用**：记忆库未开启时，直接读取仓库根目录 `CONVENTIONS.md` 执行即可。

## 配置项（插件 volatile `Config`，9 个字段）

0.2.0 起配置由插件自己声明的 `Config` 承载（不再有 `ctx.settings.register` 命名空间）：DSH 设置页投影带 `.volatile()` 的字段，写回经 `ctx.settings.update(<profile 条目 id>, patch)` 落到 profile 的 `cordis.patch.yml`，内核就地提交后派发 `loader/volatile-update`，插件即时生效且**无需重挂**。插件自带「记忆管理」设置区块，因此关闭了内核自动生成的表单。

| 字段 | 类型 | 默认值 | 含义 |
|---|---|---|---|
| `enabled` | boolean | `true` | 总开关。关闭后不注入、Agent 工具拒绝执行、API 仅返回状态（供设置页重新开启） |
| `mode` | `'on' \| 'off'` | `'off'` | 临时记忆模式。`on` = 每次发送自动注入固定消息与勾选记忆；`off` = 不自动注入，可用 `plan.injectOnce` 做单次注入 |
| `view` | `'full' \| 'compact'` | `'full'` | 记忆注入视图。`full` = 注入完整快照；`compact` = 仅标题 + 印象 + 预览（模型可 `memory_recall` 读全文） |
| `modelTools` | boolean | `true` | 是否向 Agent 注册 6 个记忆工具 |
| `libraryPath` | string | `''` | 记忆库文件夹绝对路径；为空时自动锚定到默认记忆库（工作区下的 `.dsh-memory`） |
| `memoryChars` | number | `6000` | 单条记忆注入字符上限 |
| `totalChars` | number | `12000` | 单次计划注入的总字符上限 |
| `pinChars` | number | `6000` | 固定消息合计字符上限 |
| `autoInjectConvention` | boolean | `true` | 新会话自动注入开关。开启后新会话默认常驻启用中的规约记忆（`tags` 含 `convention`）与最近 8 条会话总结记忆（`tags` 含 `会话总结`）；旧会话不自动注入，可手动加入 |

> 从 0.1.x 升级：记忆库目录下的旧 `config.json` 会在首次启动时**一次性迁移**进上述设置（并落 `pinned/.config-imported` 标记，幂等）。

## Agent 工具

| 工具 | 参数 | 行为 |
|---|---|---|
| `memory_search` | `query: string`（必填） | 按关键词匹配记忆标题、印象与正文，返回 id / 标题 / 印象 / 预览（最多 20 条） |
| `memory_recall` | `id: string`（必填） | 读取一条记忆的完整快照与标注，及其链接、组合来源、被引用关系 |
| `memory_save` | `title` / `impressions`（数组，必填）/ `snapshot`（必填）/ `notes`（必填）/ `tags`（数组）/ `enabled` | 保存一条新记忆到记忆库，返回记忆元数据；`tags` 填 `convention` 即规约记忆、填 `会话总结` 即会话总结记忆（两者新会话默认自动注入）；`enabled` 默认 `true` |
| `memory_set_enabled` | `id`（必填）/ `enabled`（必填） | 启用或禁用一条记忆。禁用后不参与新会话自动注入、不能加入注入计划（已在计划中的也不再注入），直到重新启用 |
| `session_inject` | `id`（必填）/ `inject`（必填） | 把一条记忆加入或移出当前会话的注入计划；记忆模式开启时每轮自动注入 |
| `memory_pin` | `content: string`（必填）、`label: string`（必填，可为空） | 把一段文本固定为当前会话的临时记忆（记忆模式开启时每次发送自动注入） |

> 行为受 `modelTools` 与 `enabled` 双重门控；`memory_pin` / `session_inject` 需要能确定当前会话。

## 记忆文件格式示例

记忆存放在记忆库的 `memories/<id>.md`，`<id>` 为 3–64 位字母 / 数字 / `_` / `-`：

````markdown
---
id: "m_example_planning"
title: "示例：季度产品规划"
impressions: ["产品规划", "路线图", "示例"]
tags: []
composedOf: []
links: []
sourceSession: null
sourceSeqs: []
createdAt: 1750000000000
updatedAt: 1750000000000
revision: 1
enabled: true
---

## 快照

此处为不可变的记忆正文快照。

<!-- mem:notes -->

此为可编辑的标注层，随时可补充说明。
````

完整字段说明见 [docs/ARCHITECTURE.md#记忆文件格式](docs/ARCHITECTURE.md)。

## 示例记忆库

`examples/memory-library/` 是一个开箱即用的示例记忆库：

- `memories/m_example_planning.md` —— 基础记忆，演示 front-matter 与标注层
- `memories/m_example_meeting.md` —— 演示 `links` 关联与自动反向链接
- `memories/m_example_composite.md` —— 演示 `composedOf` 非破坏组合
- `pinned/example-session.json` —— 演示某会话的注入计划文件（固定消息 + 勾选记忆）
- `config.json` —— 兼容旧版的迁移配置形态

把 `libraryPath` 指向该目录即可体验图谱与检索。

## 开发与测试

参见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。要点：

- `lib/client.js` 是浏览器 bundle 构建产物格式（factory 内为 CJS），修改后需保持 `window.__ModuleLoader__.load({ id, factory })` 包裹格式与 `exports.inject = ['slots']`。
- 回归测试分两组：
  - **不依赖 DSH 检出**：`npm test` → `tests/test-apply.mjs`（Host apply 回归：volatile 配置、注册、注入、全部 op、旧配置迁移）+ `tests/smoke-client.mjs`（mock 浏览器 + SSR 渲染各组件 + 导航 / 按钮断言）。
  - **需要 DSH 检出路径**：`DSH_ROOT=<DSH 检出> npm run test:dsh020` → 6 个契约测试：`test-cordis-020.mjs`（真实 Cordis 激活 + volatile 就地提交）、`test-settings-020.mjs`（Config 对 volatile/settings 机制）、`test-tools-020.mjs`（6 个工具进真实 `ctx.tools`）、`test-client-slots-020.mjs`（6 条插槽注册进真实 `SlotCore` + 包名校验）、`test-surface.mjs`（真实 `Session` 跑排除 / 恢复）、`test-pre-step-e2e-020.mjs`（真实 AgentLoop 端到端跑一轮，断言注入进入模型请求）。
- 需要 Node ≥18（DSH 0.2.0 要求 ^22.19 或 ≥24；测试用到 `structuredClone`）。

## 许可证

[MIT](LICENSE)

---

## English Summary

**dsh-memory-manager** is a host-level plugin for the DeepSeek Harness (targeting DSH 0.2.0-rc.1, with graceful fallbacks down to 0.1.2-rc.1) that gives agents a durable, cross-session memory. Memories are plain Markdown files with front-matter metadata (Obsidian-compatible), each composed of an immutable snapshot plus an editable annotations layer. Memories carry short "impression" tags plus a classification `tags` field and a per-memory `enabled` switch; a memory tagged `convention` is a convention memory, and one tagged `会话总结` is a session summary. With `autoInjectConvention` on, every new session automatically receives all enabled convention memories plus the latest 8 session-summary memories. A per-session context plan — pinned messages plus checked memories — is injected into each request via an `agent/pre-step` message carrying `source: { kind: 'memory-manager', form: 'snapshot', sections }`, with per-memory and total character caps and a compact view. Six model tools (`memory_search`, `memory_recall`, `memory_save`, `memory_set_enabled`, `session_inject`, `memory_pin`) give the agent direct read / write / plan control. Configuration lives on the plugin's own schemastery `Config` (every field `.volatile()`), surfaced by the host settings page and written back through `ctx.settings.update(profileEntryId, patch)`. The browser side provides a right-side panel (plan / library / messages tabs), a separate left-side force-directed knowledge graph overlay with semantic-panorama and focus-exploration views, a session-summarize dialog (`session.summarize`), cross-workspace session listing (`sessions.list`), and message jump-to-conversation (via `ctx.uiWorkspace.openSession`), plus settings switches. The Host half exposes an HTTP JSON-RPC-style endpoint (`/_dsh/memory-manager/api`) that the browser Client calls. It is MIT-licensed and published to open source.

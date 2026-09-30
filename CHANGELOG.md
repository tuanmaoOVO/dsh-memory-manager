# 更新日志（Changelog）

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/) 的语义化版本格式。

## [Unreleased]

## [0.5.0] - 2026-09-30

### 宿主安全与装卸体验

- **新增 `scripts/preflight.mjs`（安装前自检，30 项）**：把「装上后不影响 DSH 本体」变成机械结论，并作为 `npm test` 的第一步。四组检查 ——
  - **A 包自洽**：`dsh.bundle.patch` 与 `exports["."]` / `exports["./client"]` 指向的文件都存在（客户端 bundle 缺失会让宿主 `clientModules` 纤维整体失败，这是唯一能波及本体的失败模式，已被前置拦下）；`files` 白名单覆盖这些文件；运行时依赖已声明；**未声明 `dsh.profile`**（永远不能充当或替换 profile 组合）。
  - **B 只增不改**：bundle patch 只用 `insert`（无 `remove`/`replace`）；插入行 `id: memory-manager` + `name` 等于包名、不覆盖既有 id、未预设 `disabled`；所有 DSH peer 都是 optional（版本不匹配只拒绝本 bundle）。
  - **C 模块与 bundle 形状**：宿主模块可 import、`inject` 只声明核心服务；客户端 bundle 是单条顶层 `load({id, factory})` 语句、`exports.inject` 含 `slots`、6 条注册都包在 `slots.inject` 内。
  - **D 与检出对照**：`dsh.client.inject` 的包真实存在且声明 `dsh.client`；5 个目标插槽在 0.2.0 目录中都是 list 型且非 `shadows-shipped-ui`；我们的 entry id 未占用官方已注册 id；6 个工具名不与官方 65 个工具重名。
- **客户端 bundle 增加最终兜底**：工厂体整体包进 `try/catch`，并在进入之前预装惰性 `exports.apply`。模块体一旦抛错，插件**静默不可用**并把原因写到控制台，而不是让这一条目报错或影响同一 combo 脚本里的其它插件包。冒烟测试的注入点随之改为 bundle 内显式标记 `// __MEM_TEST_INJECT__`（必须在模块体词法作用域内）。
- **文档**：`docs/INSTALL.md` 重写 —— 三条安装路径（Web 插件页 / CLI / 手动 patch）、**三档开关**（业务软关闭 → 行级 `disabled: true` → 卸载）、卸载后残留说明（只有你自己的记忆库目录与两份日志）、安装后验证清单、回滚手册（含插件页进不去时直接改 profile patch 的步骤）。README 补「安全边界」小节。
- `files` 白名单加入 `scripts`，`package.json` 增加 `npm run preflight`，`npm test` 先跑自检。

### 适配 DSH 0.2.0-rc.1（对照检出 `deepseek-harness@dsh-v0.2.0-rc.1` 逐条核对）

结论：**两处破坏性变更必须改（设置模型、消息来源标识），三处增强可顺带用上（会话导航 / Chat 数据 / 会话列表），其余集成面未变**。全部改动都用真实内核回归测试验证（`tests/test-settings-020.mjs`、`tests/test-tools-020.mjs`、`tests/test-surface.mjs`）。

#### 破坏性变更 1：`ctx.settings.register(...)` 被整体移除

DSH 0.2.0 删除了整条设置作用域 API（`register` / `get` / `watch` / `update` / `dispose`，以及 `applies` / `validate` / `base` 选项），**没有兼容层**。取而代之：设置页直接投影「插件导出的 `Config` 中带 `.volatile()` 的字段」，`ns` 变成 **profile 条目 id**（`SettingsNamespace`），写入走 `ctx.settings.update(ns, patch)`，内核把新值**就地提交**进 volatile 引用（`@deepseek-ai/cosmokit` 的 `Volatile<T>`，经 `Symbol.for('cosmokit.volatile.write')` 跨包识别）并派发 `loader/volatile-update`。

- `lib/index.js` 重写配置层：`Config` 的 9 个字段全部 `.volatile()`；`m.cfg` 保留为进程内快照，由 `m.syncCfg()` 从 `apply()` 收到的 config 引用解包（`lib/util.js` 新增 `readConfigValue` / `isVolatileRef`）；订阅 `ctx.on('loader/volatile-update')` 同步快照。
- 写回改为 `m.settingsUpdate(patch)` → `ctx.settings.update(<profile entry id>, patch)`，其中 `ns` 从 `ctx.fiber.entry.options.id` 读取（本插件为 `memory-manager`），取不到时回退同名常量。**先乐观更新进程内快照，成功后不立即回读**——落盘 → 重组 → 提交 volatile 是异步链路，立刻回读会把乐观值打回旧值（旧配置迁移、设置页开关都会因此失效）；只有写失败才用权威配置回滚。
- 硬依赖收窄：`inject` 从 `['settings','tools']` 改为 `['tools']`；`settings` 改为可选注入 + 懒读取，缺失时退化为进程内配置。
- `ctx.settings.configure({ auto: false }, ctx.fiber)` 关闭内核自动生成的表单（插件自带 `settings.section` 设置区块），放在可选 `ctx.inject(['settings'], …)` 子作用域里，设置服务晚到或被替换时策略仍生效。
- 依赖：`schemastery` → **`@deepseek-ai/schemastery@^3.18.4`**（DSH vendored 的同名包，npm 已发布，提供 `.volatile()`；npm 上的裸 `schemastery@3.18.x` **没有** `.volatile()`，用它会让插件在模块加载期抛 `TypeError`）。解析顺序为 `@deepseek-ai/schemastery` → 裸 `schemastery` → 都没有时 `Config = undefined`（内核原样透传 profile 配置），逐级降级而不是加载失败。

#### 破坏性变更 2：`MessageSource` 不再有通用 `'plugin'` kind

0.2.0 的 `MessageSource` 是 merge-extensible 判别联合，注释明确「there is no shared catch-all `plugin` kind」——每个生产者声明自己的 `kind`（官方 `time-context` 即 `kind:'time-context'`）；`form:'snapshot'` 按契约**必须**携带 `sections`。

- 注入消息与排除标记的 `source` 改为 `{ kind: 'memory-manager' }`（`prompt` 注入另带 `form:'snapshot'` + `sections`）。
- `lib/util.js` 新增 `isOwnSource()`：**同时**识别 0.2.0 的 `kind:'memory-manager'` 与 0.1.x 已落盘历史里的 `{kind:'plugin', plugin:'memory-manager'}`——否则升级后旧会话里的排除标记无法被识别，「恢复轮次」会失效。
- 恢复助手回复时的**降级消息刻意保持 `source.kind: 'user'`**，不能用插件自己的 kind（否则会被 `isMarkerEvent` 当成新的排除标记，轮次被拆开）。
- `agent/pre-step` 的注入触发判定仍按 `payload.messages.some(m => m.source.kind === 'user')`（该字段在 0.2.0 未变）；工具结果 step 不注入的行为经真实内核语义复核仍成立。

#### 顺带用上的 0.2.0 能力（同时保留旧版回退）

- **客户端会话导航**：客户端 `ctx.sessions.open(id)` 已移除（契约注释写明「navigation belongs to owner」），改用 `ctx.uiWorkspace.openSession(target)`；插件保留旧内核的 `ctx.sessions.open` 回退，两者都缺失时只派发跳转事件。主列复位仍是 `ctx.layout.selectPanel(null)`。
- **Chat 数据**：`SessionSnapshot` 已不含 Conversation 目标数据（无 `s.chat`），跳转接收器改用 ui-chat 的会话级标准钩子 `useChat`（`ChatSnapshot{order, nodes}`），`hasMore`/`loadingOlder` 仍来自 `useSession`；保留旧字段回退。
- **对话行锚点**：0.2.0 的 `ChatNodeSeat` 同时输出 `data-chat-node-key={node.key}` 与 `data-chat-anchor-key={flowKey}`（分组内成员 flowKey 是 `JSON.stringify([key, groupPart])`）。插件优先按 node key 精确匹配，再回退 anchor key（含分组前缀匹配），定位更稳。
- **跨工作区会话列表**：无 `workspaceRegistry` 时回退 0.2.0 新增的 `ctx.sessionQuery.listSessions()`（完整逻辑语料，live + persisted），在无 workspace 服务的组合里仍可用。
- **客户端服务声明**：`exports.inject = ["slots"]`（0.2.0 的槽位契约要求先声明再注册）；`dsh.client.inject` 增补 `-ui-session` / `-ui-workspace`；`package.json` 的 `dsh` 块补 `manifestVersion: 1`，移除已无必要的 `react` peer（React 是 9 个 platform seed word 之一，由 shell 注入唯一实例）。

#### 复核确认「未变」的集成面

`agent/pre-step`（仍为 waterfall，payload `{agent, messages, turn, step, signal}`，无 `session` 字段）、`agent/created`（payload `{agent, source, signal}`，`{global:true}` 仍是 Cordis 的过滤器旁路）、`ctx.tools.register(definition)` + `defineTool({name, description, parameters, output:{schema,render}, execute, isConcurrencySafe})`、`ctx.sessions.get(id)`、`ctx.sessionQuery`（`readSurface` / `readTitle` / `readSession` 全在）、`ctx.llm.stream` + `ctx.agentDefaultModel.currentSelection()`、`ctx.webServer.register({kind, path, handler})`、`ctx.connection.rpc.intercept('/api', matches, handler)`、`ctx.workspaceRegistry`（`list` / `archivedSessionIds` / `.path` / `.id`）、`window.__ModuleLoader__.load({id, factory})` 与 `dsh.client` 声明、5 个插槽的名字与 kind/scope、`[data-conversation-scroll]`。

#### 其他修复与加固

- **修复：首轮注入静默落空（真实缺陷，由端到端测试抓出）**。注入计划（`loadPlan`，由 `agent/created` 预载或 HTTP 触发）与记忆索引（`scanLibrary`，install 里后台跑）都是懒加载的，首个用户请求完全可能早于它们完成 —— 此时 `renderContextFor` 看到空 `planCache` / 空 `memoryIndex`，直接返回空串，**第一轮不注入且没有任何报错**。新增 `lib/plan.js` 的 `m.ensureInjectionReady(sessionId)`（在渲染前 await 两者，均带缓存、命中后 O(1)），由 `agent/pre-step` 监听器在渲染前调用。
- **`Session.append` 新增约束全部满足并加注**：可上表面的事件必须携带 `surfaceOp`（`session event "…" is surface-eligible and requires a surfaceOp marker`）；`sourceEventSeqs` 必须非空、无重复、引用更早事件、且完整覆盖被遮蔽节点；`tool/result` 的位置替换只能改写 `content`。`lib/sessions.js` 的 `m.appendReplace` 与 `makeToolMarker` 经真实 `Session` 回归验证。
- `lib/sessions.js` 的 live 读取增加了 `sessionQuery.readSurface()` 回退（`snapshotEvents()` 在 0.2.0 已标 `@deprecated`，失败时回退并明确降级为只读），轮次构建显式跳过 0.2.0 新增的 `developer/message` / `system/message` 表面类型。
- `lib/tools.js` 导出 `defineToolLocal` 以便把兜底形状直接喂给真实注册表做回归。
- 旧版 `config.json` 迁移改为**一次性写回 profile 设置**并落 `pinned/.config-imported` 标记（幂等），不再只是当初始值。

#### 测试

- 新增 `tests/test-cordis-020.mjs`：在**真实 Cordis** 里 `ctx.plugin()` 加载插件，复刻内核 `_commitVolatile()` 的完整时序（激活 → `resolveConfig` → `fiber.config` 的 9 个 volatile 引用 → `updateVolatile` 就地提交 → 派发 `loader/volatile-update` → 业务层 `state.get` 读到新值 → `enabled=false` 门控 → `settings.configure({auto:false})` → 设置写回 `settings.update(profile 条目 id, 稀疏 patch)` 与失败回滚 → dispose 后路由 disposer 被调用），20 项断言。
- 新增 `tests/test-settings-020.mjs`：复刻 `packages/settings/settings/src/schema.ts` 的 `volatileForm` / `isVolatilePath` / `plainSchema` 与 `vendor/loader` 的 `isSchemastery` 判定，并用真实 `@deepseek-ai/cosmokit` 的 `volatileEntries` / `updateVolatile` 模拟内核的 `_commitVolatile`（13 项断言）。
- 新增 `tests/test-tools-020.mjs`：用真实 `@deepseek-ai/cordis` + `packages/core/tools` 构造可用 `ToolRuntime`，把 6 个工具真正注册进去，断言 `schemas()` 白名单投影、参数 DSL 编译、兜底形状可接受、官方 `defineTool` 接受同一形状，并反向断言语义（缺 `output` 必被拒），11 项断言。
- 新增 `tests/test-client-slots-020.mjs`：把 bundle 的 6 条插槽注册喂给**真实 `SlotCore`**（用 `registerFactory` 的 children 表声明同形插槽树），断言一条都没被拒绝、id/order/label 生效、`shell.overlay` 两条独立条目按 order 排序、disposer 释放后账本清空、未声明槽位/缺 `id` 确实被拒（有鉴别力），并校验 `dsh.client.inject` 的每个包名真实存在且声明了 `dsh.client`，20 项断言。
- 新增 `tests/test-pre-step-e2e-020.mjs`：用 `dsh-agent-loop-testkit` 的 production harness 起**真实 AgentLoop** + mock `LlmAdapter`，跑两轮对话，断言注入消息进入模型请求（`role:user` / `kind:memory-manager` / `form:snapshot` / `sections`）、正文含固定消息与记忆快照、并作为 `user/message` + `surfaceOp:append` 落进会话日志且与人类消息可区分；另经真实路由 POST `memory.suggest` 验证 `ctx.llm.stream` 辅助链路（provider/model/system/maxTokens + 插件自己的消息来源），14 项断言。**该测试抓出了「首轮注入静默落空」的真实缺陷。**
- `tests/test-apply.mjs` 重写为 0.2.0 语义：传入 volatile 引用形态的 config、断言 `settings.update` 的 namespace 是 profile 条目 id、`loader/volatile-update` 同步、注入消息来源标识与 `sections`、`agent/created` 的 `global:true`、旧配置一次性迁移与幂等。
- `tests/smoke-client.mjs` 改为断言 `uiWorkspace.openSession` 优先、`sessions.open` 回退、两者皆无时静默跳过。
- `tests/test-surface.mjs` 补充来源标识兼容断言，并在 0.2.0 检出上实跑通过。
- 需要 DSH 0.2.0 构建产物的 5 个脚本统一加了 Node 版本守卫（旧 Node 缺 `structuredClone` 时打印 `[skip]` 而不是抛 `ReferenceError`）。
- 新增 `npm test` / `npm run test:dsh020` 脚本；`package.json` 补 `devDependencies`（`@deepseek-ai/dsh-tools`、`react`、`react-dom`）使本地测试可复现。

#### 文档

- README「兼容性」重写为 0.2.0 对照表；「配置项」改为 volatile `Config` + `ctx.settings.update` 说明；English Summary 同步。
- `docs/ARCHITECTURE.md` 更新集成面表、配置与迁移、注入机制、表面写入的 0.2.0 约束、HTTP 双通道、客户端插槽与导航。
- `docs/INSTALL.md` 前置条件（Node ≥22.19）、依赖说明、`id: memory-manager` 与设置命名空间的关系、常见问题（`incompatible-version` / 无设置页 / 写入未生效 / 升级后旧设置）。
- `docs/API.md` 注入来源标识与 `form/sections` 契约、volatile `Config` 读写与迁移说明。
- `docs/DEVELOPMENT.md` 全面更新（依赖安装、5 个测试脚本、发布清单）。

## [0.4.2] - 2026-09-10

### 适配 DSH 0.1.5-rc.1（0.1.5-alpha.1 → 0.1.5-rc.1 共 288 次提交）

结论：**宿主端零破坏性变更，客户端一处语义补齐**。

- **宿主端无需改动**：逐目录 diff 显示 `packages/core/{agent,agent-loop,tools}/src`、`packages/settings/settings/src`、`packages/host/webserver/src`、`packages/client/connection/src`、`packages/session-query/session-query/src`、`packages/workspace/workspace/src`、`packages/client/modules/src`、`packages/boot/app-boot/src`、`vendor/` 在本区间**无改动**；`packages/core/session/src` 仅新增两个已知事件类型（`deliverables/presented`、`subagent/catalog`）。0.4.1 的两条修复（`SurfaceOp` 字段名自适应、`assistant/message` 恢复降级）继续有效，`session/src/surface.ts` 未变。
- **客户端插槽全部仍在**：`conversation.session.header.actions` / `conversation.input.left` / `conversation.chat.assistant-actions` / `settings.section` / `shell.overlay` 在 0.1.5-rc.1 仍被官方包声明并渲染；`main`（keyed 根槽）与 `sidebar.panellist` 是**新增**的面板注册入口，不替代 `shell.overlay`，只往上述 5 个子插槽注册的插件不受影响。
- **修复（跳转复位主列面板）**：0.1.5-rc.1 起主列改为 keyed 槽 `main`，官方跳转路径变为 `sessions.open(id)` **+ `layout.selectPanel(null)`**（`ui-workspace` `navigation.openSession`）。插件「在对话中定位」此前只做了前半句，主列停留在其它面板时会看不到对话。现在 `lib/client.js` 在 `apply` 时取 `ctx.get('layout')`，跳转后调用 `LAYOUT_SERVICE?.selectPanel?.(null)`；旧版没有该服务，可选链静默跳过，行为不变。

### 测试

- `tests/smoke-client.mjs` 新增两条断言：跳转必须同时调用 `sessions.open(id)` 与 `layout.selectPanel(null)`（次数一致）；无 `layout` 服务的旧版必须静默跳过而不抛错。

### 文档

- README「兼容性」、`docs/DEVELOPMENT.md` 版本区间更新为 0.1.2-rc.1 → 0.1.5-rc.1；`docs/ARCHITECTURE.md` 补充跳转复位主列的说明。

## [0.4.1] - 2026-09-08

### 修复：适配 DSH 0.1.5-alpha.1（会话表面自 0.1.3-alpha.1 起的两处内核变更）

- **`SurfaceOp` 位置替换字段改名（阻断）**：DSH 0.1.5 起 `{ op: 'replace', start, end }` 改名为 `{ op: 'replace', startSeq, endSeq }`（`packages/core/session/src/surface.ts` 的 `isReplaceOp` 按 `Object.keys` 精确匹配）。旧写法会让「排除 / 恢复轮次」在 `Session.append()` 处抛 `carries an invalid replace surfaceOp`，整条功能失效。`lib/sessions.js` 新增 `m.appendReplace`：首次调用探测内核字段名并缓存（新形状优先，失败回退旧形状），**0.1.2-rc.1 与 0.1.5-alpha.1 都可写**；`Session.append` 在校验失败时于写入日志之前抛出，故回退重试不会产生脏日志。
- **`assistant/message` 不能作为表面替换事件**：DSH 0.1.5 起内核禁止 `assistant/message` 携带 `sourceEventSeqs`（`assertProvenance`），而替换必须携带被遮蔽节点的 seq，因此助手消息无法原样还原。恢复轮次时先尝试原样还原，捕获该错误后**降级为 user 文本还原**（前缀 `[已恢复的助手回复]`），内容不丢；`user` / `tool/result` 节点仍原样还原，0.1.2 下助手消息也仍原样还原。
- 影响范围：仅「排除 / 恢复轮次」需要改动。其余集成面（settings 注册、6 个工具、`agent/pre-step` 注入、`agent/created` 预载、`webServer` 路由、`connection.rpc`、`sessionQuery` / `workspaceRegistry` 读取、客户端 6 个插槽与 bundle 加载契约）经源码比对与实机运行确认在 0.1.5 下未变。

### 测试

- 新增 `tests/test-surface.mjs`：用**真实 dsh `Session`** 跑排除 / 恢复，断言字段名探测与助手消息还原方式，可在 0.1.2 与 0.1.5 两个检出上分别运行（`node tests/test-surface.mjs <DSH 检出路径>` 或 `DSH_ROOT=...`），未提供路径时跳过。
- `docs/DEVELOPMENT.md` 更新测试清单，并补充 `smoke-client.mjs` 的 `DSH_TEST_DEPS` 失效链接兜底用法。

### 文档

- README「兼容性」、`docs/ARCHITECTURE.md`「排除 / 恢复机制」补充跨版本表面写入适配说明。

## [0.4.0] - 2026

### 重要：适配新版本 DSH（0.1.2-rc.1+）的标准化重写

- **解决与新版 DSH 的冲突**：旧版 `dsh.client.inject` 引用的 `@deepseek-ai/dsh-client-runtime` 已在新版 DSH 中移除，导致浏览器模块图扫描失败、页面无法启动；旧 Host 侧依赖的若干服务名 / 事件载荷也已演进。0.4.0 按新版 DSH 实际代码（`packages/**`）与官方文档思想重写全部集成面。
- **Host 半区模块化**：`lib/index.js` 拆为职责单一模块 —— `util`（零 DSH 依赖）/ `memory`（记忆库文件层）/ `plan`（计划 / 自动注入 / 注入渲染）/ `sessions`（会话读取 / 轮次构建 / 排除恢复）/ `llm`（印象建议 / 智能合并 / 会话总结）/ `tools`（6 个记忆工具）/ `api`（HTTP + RPC 双通道）。
- **只依赖核心扩展点，其余全部自实现**：不再依赖任何官方插件包（`session-title-llm`、`session-query-sqlite`、`storage`、`fs` 等一律不依赖）。
  - 会话读取：优先 live `ctx.sessions`，只读回退 `ctx.sessionQuery.readSurface`；两者皆缺失时相关能力降级。
  - 会话总结：直接调用 `ctx.llm.stream` + `ctx.agentDefaultModel.currentSelection()`，逻辑自包含。
  - 记忆库 / 计划 / 排除：`node:fs` 直接读写，与 DSH 会话存储完全隔离。
- **工具定义容错**：优先使用官方 `@deepseek-ai/dsh-tools` 的 `defineTool`；若未来该导出不可用，回退到内置等价实现（产出 JSON-Schema 形状一致），工具注册永不因官方升级而阻断。
- **client 模块图修复**：`dsh.client.inject` 改为新版行名（`dsh-client-ui-renderer` / `-conversation` / `-chat` / `-layout` / `-settings-general` / `dsh-api-session-controller`），保证插槽声明先于注册到达与 `ctx.sessions` 可用；`lib/client.js` 自身与新版插槽系统（SlotMap / `ctx.slots.inject` + `register`）完全兼容，未改动。
- **API 双通道**：除 `/_dsh/memory-manager/api` 兼容路径外，新增 `ctx.connection.rpc.intercept('/api', 'memory-manager/<op>', ...)` 标准通道（存在时自动注册，带连接层鉴权）。
- **peer 依赖收窄**：仅保留实际 import 的 `@deepseek-ai/dsh-tools` 与 `react`（均 optional），删除全部不再使用的 `@deepseek-ai/dsh-*` peer 声明；`schemastery` 仍为运行时依赖。
- 配置字段、记忆文件格式、HTTP op 协议与 0.3.x 完全兼容（记忆库 / 计划数据可直接沿用）。

### 文档

- `docs/ARCHITECTURE.md` 重写为新版模块结构与双通道架构；`docs/API.md` / `docs/INSTALL.md` / `docs/DEVELOPMENT.md` 同步新版 DSH 依赖与测试指引；README 新增「兼容性」章节。

## [0.3.1] - 2026

### 修复

- **跨平台调试日志路径**：boot / client 日志不再硬编码 `C:/Users/...`，改为写入 DSH 主目录（`$DSH_HOME` 或 `~/.dsh`），Windows / Linux / WSL 均可用。

### 变更（安装体验）

- **`schemastery` 移入 `dependencies`**：插件运行时直接 import 的 `schemastery` 此前仅声明为 peer，导致每个 profile 安装后还需手动补装；现作为运行时依赖随插件自动安装，`dsh plugin --profile <name> add file:<路径>` 一次完成。
- **peer 依赖全部标记 optional**：`@deepseek-ai/dsh-*`、`cordis`、`react` 由 DSH 宿主提供，标记 optional 后 pnpm 安装不再产生 "Issues with peer dependencies" 警告。
- 新增 `packageManager: pnpm@11.7.0` 字段，便于 corepack 自动选用。

### 文档

- 新增 `docs/INSTALL.md`（此前 README 引用但文件缺失）：Windows / WSL 安装、更新、卸载与验证命令。

## [0.3.0] - 2026

### 修复

- **注入机制重构：`systemPrompt.section` → `agent/pre-step` 消息注入（关键修复）**：极简模式（persona `complete: true`）会让 `assemble()` 丢弃所有其他 sections——此前「注入一次」/记忆注入的内容从未进入该类会话的模型请求（实测：`injectOnce consumed` 有日志，但 `request/header` 的 system 无内容）。现改为在每个请求 step 向 `decision.messages` 末尾追加一条 `form: 'snapshot'` 的 plugin 消息（同 DSH time-context 机制，UI 折叠显示、模型可见），与 complete section / `includeRuntimeContext` 均无关，任何会话形态都生效。
- **一次性注入改为全局队列（跟随「下一次发送」）**：`plan.injectOnceMemory` 不再绑定点击时的会话——队列全局存储，**任何会话**的第一次请求都会注入并自动清除（旧版按会话分键的 once.json 自动迁移合并）。修复：点击后切换到其他会话发送时注入不生效的问题。
- **注入与用户发送绑定**：仅真实用户消息触发的请求才注入一次，避免注入被内部 / 工具请求消耗。
- **pre-step 注入内容去重**：恢复 / 多 step 请求仅注入首次，避免同一内容在单次请求中重复注入。
- **UI 反馈修复**：记忆库页点「注入一次」后立即刷新（计划页马上可见队列）；切换到计划页时也刷新数据，不再需要来回切换页面。
- **once 队列移除按钮修复**：待一次性注入队列的「移除」按钮 `h(Btn)` 笔误修复（原为字符串 `Btn` 被渲染成无样式的自定义元素）。

### 变更

- **记忆库卡片三行布局**：条目卡片改为「标题 / 印象+标签 / 操作按钮居右」三行布局，信息更清晰。
- **移除「打标签」按钮**：与「编辑」重复（编辑对话框已含标签编辑），不再单列打标签入口。
- **标签对比度**：「一次性」/「自动」标签改为实心绿底白字，浅色背景下清晰可辨。
- **注入可验证**：boot log 新增 `injectOnce consumed: session=... chars=... parts=...` 行，便于确认注入内容确实进入请求上下文。
- 文档同步：HTTP op 全表 27 → 29（新增 `plan.injectOnceMemory` / `session.injectNow`）；注入机制章节更新为 `agent/pre-step`。

## [0.2.0] - 2026

### 新增 / 变更

- **规约记忆（tags）自动注入**：记忆新增 `tags`（分类标签）字段；`tags` 含 `convention` 即规约记忆、含 `会话总结` 即会话总结记忆。配置新增 `autoInjectConvention`（默认 `true`）——开启后每个**新会话默认常驻**启用中的规约记忆与最近 8 条会话总结记忆（`agent/created` 预载计划时按「无对话消息」判定新会话）。
- **会话总结（session.summarize）**：把所选会话轮次交给 LLM 提炼为「会话id / 轮次 / 用户请求 / 思考链 / 处理链 / 结果」六要素记忆并自动入库；支持「最近 N 轮」范围与「智能合并」（LLM 判断同一事务的连续轮次合并为一条）；消息页 `SummarizeDialog` 提供完整 UI。
- **记忆级启用开关（enabled 字段）**：记忆可独立启用 / 禁用；`memory.setEnabled` op 与 `memory_set_enabled` 工具维护，禁用后不参与新会话自动注入、不能加入注入计划。
- **跨工作区会话列表（sessions.list）**：`workspaceRegistry` + `sessionQuery` 枚举全部工作区的会话（含归档标记），供消息页会话选择器与会话总结用。
- **`session_inject` 工具**：把记忆加入 / 移出当前会话注入计划，会话内按需管理注入内容。
- **力导向图谱（左侧浮层面板）**：图谱由右侧面板 tab 迁出为**左侧独立浮层**，含**语义分层全景**（按标签着色 + 力导向 160 迭代）与**焦点探索**（径向 1–2 跳邻域）双视图，支持搜索定位 / 缩放 / 平移 / 详情与相关记忆跳转。
- **消息跳转（JumpReceiver）**：`conversation.session.header.actions` 隐藏接收器，按 `anchorSeq` 在对话中滚动高亮来源消息；跨会话自动切换，最早窗口自动「加载更早」。
- Agent 记忆工具扩展至 **6 个**（`memory_search` / `memory_recall` / `memory_save` / `memory_set_enabled` / `session_inject` / `memory_pin`），`memory_save` 支持 `tags` / `enabled`。
- HTTP API op 扩展至 **27 个**（新增 `state.setAutoInject`、`memory.setEnabled`、`session.summarize`、`sessions.list`）。
- 前端体验：消息动作条（保存为记忆 / 固定）；设置页自由开关（含新会话自动注入开关）；面板头部在图谱浮层打开时可通过「✕」关闭；右侧面板关闭按钮在头部左侧；错误边界与崩溃自愈（含图谱浮层独立兜底）；日志链路（Host boot log + client `diag.log` 上报落盘）。

## [0.1.0] - 2026

### 新增 —— 初版能力

- **跨会话记忆库**：文件夹 Markdown 记忆库（`memories/*.md`，front-matter 格式，Obsidian 兼容），支持标题、印象、正文快照、标注层。
- **记忆 = 不可变快照 + 可编辑标注层**：快照保存事实，标注层可后续补充，互不污染。
- **印象（impressions）**：每记忆可带简短标签，作为检索主键；支持 LLM 生成印象建议。
- **组合记忆**：把多条记忆**非破坏性**聚合（`composedOf`），保留来源引用。
- **双向链接**：`links` 显式关联 + 扫描时自动建立 backlink 反向索引。
- **上下文计划注入**：按会话维护注入计划（固定消息 + 勾选记忆），经 `systemPrompt.section`（`memory-manager:context`）在记忆模式开启时注入到系统提示，带单条 / 总量 / 固定消息三级字符上限与紧凑视图。
- **Agent 记忆工具**：注册 `memory_search` / `memory_recall` / `memory_save` / `memory_pin`，可整体开关。
- **非破坏性轮次排除 / 恢复**：可把某轮对话排除出注入，随时恢复。
- **浏览器侧栏面板**：计划 / 记忆库 / 消息三个标签页；输入栏「记忆」按钮；设置页「记忆管理」区块。
- **HTTP JSON API**：`/_dsh/memory-manager/api` 信封式调用（当前 23 个 op）。
- **宿主导航**：`webServer` 路由、settings 命名空间、`node:fs` 直读记忆库、启动即扫描。

# 开发指南

面向想要修改、测试或发布本插件的开发者。**0.5.0 起本插件面向 DSH 0.2.0-rc.1**（实测检出：`D:\deepseekagent\version0.2.0-rc.1\deepseek-harness`），同时保留对 0.1.2-rc.1 → 0.1.7-rc.2 的降级兼容；设计原则与迁移要点见 `README.md`「兼容性」章节。Node 需 ≥18（DSH 0.2.0 要求 ^22.19 或 ≥24，测试脚本用到 `structuredClone`）。

## 目录结构

```
dsh-memory-manager/
├── lib/
│   ├── index.js        # 插件装配：name/inject/Config(volatile)/apply、settings 读写、事件、agent/pre-step 注入、旧配置迁移
│   ├── util.js         # 通用工具（日志 / fs / 字段清洗 / 消息来源判定 / volatile 配置读取；零 DSH 依赖）
│   ├── memory.js       # 记忆库（Markdown + front-matter，扫描 / 解析 / 序列化 / backlink）
│   ├── plan.js         # 注入计划 / once 队列 / 轮次排除存储 / 自动注入 / 注入渲染
│   ├── sessions.js     # 会话视图（live + sessionQuery）、轮次构建、排除 / 恢复、跨工作区列表
│   ├── llm.js          # LLM 辅助（ctx.llm.stream）：印象建议 / 智能合并 / 会话总结
│   ├── tools.js        # 6 个 Agent 记忆工具（官方 defineTool 或内置等价实现，均导出可测）
│   ├── api.js          # HTTP 路由（webServer 兼容通道 + connection.rpc 标准通道）+ RPC 分发
│   └── client.js       # Client 半区（浏览器 bundle）。插槽、面板、错误边界、日志上报
├── cordis.patch.yml    # DSH bundle 挂载补丁（insert 行 id: memory-manager）
├── scripts/
│   └── preflight.mjs   # 安装前自检：包自洽 / 只增不改 / bundle 形状 / 与检出对照（也可当回归门）
├── tests/
│   ├── test-apply.mjs          # Host 集成回归：mock ctx 调用 apply()，断言 volatile 配置 / 注册 / 注入 / 各 op
│   ├── test-cordis-020.mjs     # 真实 Cordis 集成：激活 + volatile 就地提交 + live 更新 + 卸载（需 DSH 检出路径）
│   ├── test-settings-020.mjs   # 设置契约回归：Config 对 DSH 0.2.0 volatile/settings 机制（需 DSH 检出路径）
│   ├── test-tools-020.mjs      # 工具契约回归：把 6 个工具注册进真实 ctx.tools（需 DSH 检出路径）
│   ├── test-client-slots-020.mjs # Client 插槽契约：6 条注册喂给真实 SlotCore + 包名校验（需 DSH 检出路径）
│   ├── test-surface.mjs        # 真实会话表面回归：用真实 dsh Session 跑排除 / 恢复（需 DSH 检出路径）
│   ├── test-pre-step-e2e-020.mjs # 端到端：真实 AgentLoop 跑一轮，断言注入进入模型请求（需 DSH 检出路径）
│   └── smoke-client.mjs        # Client 冒烟：mock 浏览器 + SSR 渲染各组件 + 导航 / 按钮断言
├── examples/
│   └── memory-library/ # 示例记忆库（memories / pinned / config.json）
├── docs/               # 开源文档（本目录）
├── package.json        # 包元数据、dsh.bundle / dsh.client 声明、依赖
├── CHANGELOG.md
├── LICENSE             # MIT
└── README.md
```

## Host 半区（lib/*.js）

- 入口导出 `name` / `inject` / `apply` / `Config`。`inject = ['tools']` 声明唯一硬依赖；`settings` 改为**懒读取 + 可选注入**（0.2.0 起 `ctx.settings.register` 已被移除），其余服务一律 `ctx.get('name')` 可选读取。
- `Config` 用 **`@deepseek-ai/schemastery`**（DSH 自己 vendored 的那份，含 `.volatile()`）构造，9 个字段全部 `volatile`。解析顺序：`@deepseek-ai/schemastery` → 裸 `schemastery`（无 `.volatile()`，降级为「无设置页」）→ 都不在时 `Config = undefined`（内核原样透传 profile 配置）。模块顶层使用 **top-level await**，Cordis Loader 用 `await import()` 加载插件，因此可用。
- `apply` 构建统一共享状态对象 `m`，依次安装：`installMemory` → `installPlan` → `installSessions` → `installLlm` → 配置同步 + `settings.configure({auto:false})` → `installTools`（await，动态 import）→ `installApi` → `agent/pre-step` 注入段 → `agent/created` 预载 → 启动扫描 + 旧 `config.json` 迁移。所有副作用挂 disposers，统一回滚。
- **关键实现**：
  - **配置（0.2.0 模型）**：`m.cfg` 是进程内快照；`m.syncCfg()` 从 `apply()` 收到的 config 引用读取（`volatile` 字段是 `{get()}` 引用对象，见 `lib/util.js` 的 `readConfigValue`）。内核提交 volatile 变更后派发 `loader/volatile-update`，监听器把快照同步回权威值。
  - **配置写入**：`m.settingsUpdate(patch)` 先乐观写 `m.cfg`（UI 立即可见），再 `ctx.settings.update(<profile entry id>, patch)`；**不在成功后立即 `syncCfg()`**（落盘 → 重组 → 提交 volatile 是异步链路，立刻回读会把乐观值打回旧值），失败时才回滚。
  - **settings namespace**：0.2.0 的 `ns` 不再是插件自选字符串，而是 profile 条目 id —— 从 `ctx.fiber.entry.options.id` 读取，取不到时回退到与 `cordis.patch.yml` 一致的 `memory-manager`。
  - **注入**：`agent/pre-step` 瀑布（payload `{agent, messages, turn, step, signal}`，返回 `{kind:'enter', messages}`）。仅用户消息触发的请求注入一条 `form:'snapshot'` 的 user 消息（UI 折叠、模型可见、随会话日志持久化），`source.kind` 为插件自己的 `'memory-manager'`（0.2.0 已无通用 `'plugin'` kind），`form:'snapshot'` 必须携带 `sections`。不依赖 `systemPrompt`（极简 complete 模式也生效）。
  - **会话读取**：live `ctx.sessions.get(id)` 优先（`session.surface.nodes` + `snapshotEvents()`；该读法在 0.2.0 已标 `@deprecated`，失败时回退 `ctx.sessionQuery.readSurface()`），只读回退 `readSurface()`；`excludeTurn` 需要可写 live 会话（`session.append(type, data, { surfaceOp:{op:'replace',startSeq,endSeq}, sourceEventSeqs })`）。**`surfaceOp` 自身**在 0.2.0 是强制的（`session event "user/message" is surface-eligible and requires a surfaceOp marker`）。
  - **规约记忆自动注入**：`agent/created`（`global:true`）预载计划；`isNewSession` 以「无 `user/message` / `assistant/message` 事件」判定，把启用中的规约记忆与最近 8 条会话总结记忆并入计划。
  - **会话总结**：`session.summarize` 直接调 `ctx.llm.stream`（`agentDefaultModel.currentSelection()` 选择路由），`extractJson` 稳健抽取 JSON，`merge` 时先 `groupSameTransactions` 分组；结果自动入库。
  - 6 个 Agent 工具：`memory_search` / `memory_recall` / `memory_save` / `memory_set_enabled` / `session_inject` / `memory_pin`。工具定义必须带 `output: { schema, render }`（0.2.0 的 `register()` 强制），`parameters` 用 `{ key: { type, required: true } }` 的隐式开放对象根 DSL。
  - **API 双通道**：`/_dsh/memory-manager/api`（兼容，始终注册）+ `ctx.connection.rpc.intercept('/api', 'memory-manager/*')`（标准，存在才注册；首个参数是保留频道字面量 `'/api'`，归属由 `matches` 判定）。

## Client bundle（lib/client.js）

`lib/client.js` 是**浏览器 bundle 构建产物格式**，而非源码 TS/JSX：

- 最外层为 `window.__ModuleLoader__.load({ id: "@dsh-external/dsh-memory-manager", factory: (require) => { ... } })` —— 0.2.0 的 `ClientBundleRegistration` 仍是 `{ id, chunk?, factory }`，**不要加 `platform` / `version`**；`id` 必须与包名完全一致。
- factory 内是 **CJS**（`const React = require("react")`；React 是 9 个 platform seed word 之一，由 shell 注入唯一实例，插件不自带副本），使用 `React.createElement`（`const h = React.createElement`），**不得出现 `<Component />` JSX**。
- `exports` 即 Cordis 插件对象：`exports.inject = ["slots"]` + `exports.apply(ctx)`。客户端注册**6 个插槽条目**（`conversation.session.header.actions` / `conversation.input.left` / `shell.overlay` ×2 / `settings.section` / `conversation.chat.assistant-actions`）—— 槽名与 kind/scope 在 0.2.0 的 `SlotMap` 中逐名核对仍存在；注册必须包在 `ctx.slots.inject(name, () => ctx.slots.register(...))` 里（注册进未声明的槽位会在激活期抛错）。
- 会话标准 props：`sessionId` / `useSession` / `useProjection` 是 session 作用域标准 props，`useSessions` 是**全局**标准 props；Chat 目标数据由 ui-chat 通过 `useChat` 提供（0.2.0 起 `SessionSnapshot` 明确不含 Conversation 目标数据，已无 `s.chat`）。
- **会话导航**：0.2.0 起 `ctx.sessions.open(id)` 已移除，改用 `ctx.uiWorkspace.openSession(target)`；插件保留旧内核的 `ctx.sessions.open` 回退。主列面板复位仍是 `ctx.layout.selectPanel(null)`。
- **消息定位**：行 DOM 带 `data-chat-node-key`（精确节点键）与 `data-chat-anchor-key`（flowKey，分组内是 `JSON([key, groupPart])`），滚动容器为 `[data-conversation-scroll]`；插件优先按 node key 精确匹配、再回退 anchor key。
- **任何修改后必须保持 `window.__ModuleLoader__.load({ id, factory })` 包裹格式**；否则无法注入浏览器运行时。

主要组件：`Panel`（右侧面板，计划 / 记忆库 / 消息三 tab）、`GraphPanel` / `GraphDetail`（左侧图谱浮层，`mg-*` 样式 + `graphLayout` 力导向 / `radialLayout` 焦点径向布局）、`SummarizeDialog`（会话总结）、`SaveDialog` / `ComposeDialog` / `EditDialog`、`InputButton`、`MessageActions`、`JumpReceiver`（消息跳转接收器）、`SettingsSection`、`Boundary`。面板 / 图谱浮层 / 跳转接收的模块级状态为 `panel = { open, sessionId, tab, crashed }` 与 `graph = { open }`。

> 修改 client 后刷新页面即生效；若涉及新增 Host 能力（如新 op），需重启 DSH。

## 测试

### 语法检查

```bash
node --check lib/index.js
node --check lib/sessions.js
node --check lib/tools.js
node --check tests/test-apply.mjs
```

### 依赖解析（本地跑测试）

仓库自身安装 `@deepseek-ai/schemastery`（运行时依赖）与 `react` / `react-dom` / `@deepseek-ai/dsh-tools`（devDependencies，仅供测试）。`npm install` 即可：

```bash
npm install
```

`@deepseek-ai/dsh-tools` 的 devDependency 只用于让 `test-apply.mjs` / `test-tools-020.mjs` 能解析官方 `defineTool`；插件运行时不依赖它（缺失即回退内置等价实现）。

`test-settings-020.mjs` / `test-tools-020.mjs` / `test-surface.mjs` 不需要额外 node_modules：它们直接按绝对路径 import 目标 DSH 检出的构建产物（`vendor/schemastery`、`vendor/cosmokit`、`vendor/cordis`、`packages/core/tools`、`packages/core/session`、`packages/llm/llm`），只要求该检出已构建（`pnpm run build`，本仓库验证用检出已就绪）。

### 一键运行

```bash
npm run preflight                            # 安装前自检（离线 23 项）
node scripts/preflight.mjs <DSH 检出路径>     # 追加插槽 / 工具 / 包名对照（30 项）
npm test                                     # preflight + Host 集成 + Client 冒烟（无需 DSH 检出）
DSH_ROOT=<DSH 检出路径> npm run test:dsh020   # 0.2.0 契约六件套
```

> `scripts/preflight.mjs` 是「装上不影响 DSH 本体」的机械门禁：它校验 bundle patch 只 `insert`、未声明 `dsh.profile`、所有 DSH peer 都是 optional、客户端 bundle 的单条顶层语句与 try/catch 兜底形状，并在给定检出时对照插槽 kind/占用、工具重名与客户端包名。改 `package.json` / `cordis.patch.yml` / `lib/client.js` 头部之后**务必重跑**。

### 1) Host 集成回归 —— `tests/test-apply.mjs`

```bash
node tests/test-apply.mjs [插件模块路径] [临时记忆库路径]
```

- 默认加载本仓库 `lib/index.js`。
- 用 **mock ctx**（settings / tools / agents / sessionQuery / sessions / workspaceRegistry / llm / agentDefaultModel / webServer）调用 `apply(ctx, liveConfig)`（`liveConfig` 的字段是 `{get()}` volatile 引用，复刻 0.2.0 的 Config 输出），断言：
  1. `Config` 是 schemastery schema 且可 `toJSON`；`inject` 不再硬依赖 `settings`；
  2. 6 个工具注册；`webServer.register` 路由注册；订阅 `loader/volatile-update`；
  3. 经路由 handler 走一遍业务层（`state.setLibrary` → `memory.save` → `memory.read` → `state.get` → `library.scan` → `plan.addMemory` → `state.setMode`），验证「规约记忆新会话自动注入」；
  4. 设置写回使用 profile 条目 id（`memory-manager`）作为 namespace；
  5. `loader/volatile-update` 后进程内 `m.cfg` 快照同步；
  6. `agent/pre-step` 监听存在（`prepend`）、注入 `source.kind==='memory-manager'` + `form:'snapshot'` + `sections`，且工具结果 step 不注入；
  7. `agent/created` 监听带 `global:true`；
  8. 旧版 `config.json` 一次性迁移进设置、写标记、幂等；
  9. dispose 成功。

### 2) Client 冒烟 + SSR —— `tests/smoke-client.mjs`

```bash
DSH_TEST_DEPS=/path/to/deps node tests/smoke-client.mjs
```

| 环境变量 | 默认 | 含义 |
|---|---|---|
| `DSH_TEST_DEPS` | 仓库自身 `node_modules` | 指向含 `react` / `react-dom` 的目录，用于解析依赖 |
| `DSH_TEST_CLIENT` | 本仓库 `lib/client.js` | 指向要测试的 client bundle 路径 |

该脚本：
1. mock 浏览器环境（`window.__ModuleLoader__`、`document`、`fetch`），读取 client bundle **注入测试导出**（`module.exports.__test = { ... }`），再 `eval` 执行。
2. 调用 `mod.apply(ctx)`，断言返回 disposer，并校验插槽注册（6 个）。
3. 断言**跳转路径**：`jumpTo()` 必须优先调用 `uiWorkspace.openSession(id)` 且随后 `layout.selectPanel(null)`；无 `uiWorkspace` 时回退 `sessions.open`；两者都没有时静默跳过。
4. 用 `react-dom/server` 的 `renderToString` 对每个组件进行 SSR 渲染（含 hooks 违规 / 渲染异常检测）。
5. 按钮文字断言：确保按钮经 `h()` 调用、children 未丢失。
6. 结构性检查：禁止直接组件调用（`PlanTab({...})` 这类写法），防止 hooks 挂错链回归。

### 3) 真实 Cordis 集成 —— `tests/test-cordis-020.mjs`

```bash
DSH_ROOT=<DSH 检出路径> node tests/test-cordis-020.mjs
```

在**真实 Cordis**（`<检出>/vendor/cordis`）里 `ctx.plugin()` 加载本插件，复刻内核 `_commitVolatile()` 的完整时序：

1. 插件在真实 Cordis 中激活（fiber `ACTIVE`），`runtime.Config` 就是插件导出的 schema，`fiber.config` 解出 9 个 volatile 引用；
2. `webServer` 路由经 `ctx.inject(['webServer'], …)` 在真实依赖等待下注册，业务层可经路由读状态；`settings.configure({auto:false}, ctx.fiber)` 被调用（关掉内核自动表单）；
3. `resolveConfig(runtime, {…})` + `volatileEntries(fiber.config)` + `updateVolatile` 就地提交 9 个字段，引用身份不变；
4. 派发 `loader/volatile-update` 后业务层 `state.get` 读到新配置（这是设置页改动生效的真实路径）；
5. `enabled=false` 时业务 op 被门控拒绝、`state.get` / `state.setEnabled` 仍放行；
6. 设置写回经 `ctx.settings.update(<profile 条目 id>, patch)`，patch 是稀疏的、落盘后乐观值立即可见；`settings.update` 抛错时乐观值回滚到 volatile 权威值；
7. `fiber.dispose()` 后 fiber 卸载、路由 disposer 被调用、监听器不再抛错。

### 4) 设置 / volatile 契约 —— `tests/test-settings-020.mjs`

```bash
DSH_ROOT=<DSH 检出路径> node tests/test-settings-020.mjs
```

复刻 `packages/settings/settings/src/schema.ts` 的 `volatileForm` / `isVolatilePath` / `plainSchema` 与 `vendor/loader` 的 `isSchemastery` 判定，并用真实 `@deepseek-ai/cosmokit` 的 `volatileEntries` / `updateVolatile` 模拟内核的 `_commitVolatile`：

1. `Config['~standard'].vendor === 'schemastery'`（否则内核按普通字段比较，volatile-only 变更会触发整插件重挂）；
2. 9 个字段全部带 `meta.volatile`，`volatileForm(Config)` 返回表单、`isVolatilePath` 全部成立（否则 `settings.write()` 抛 `has no volatile fields` / `is not volatile`）；
3. `volatileEntries(Config({}))` 找到 9 个引用且通过 `isVolatile` 判定，`updateVolatile` 能就地改值且引用身份不变；
4. schema 默认值与插件进程内默认值一致；非法取值被拒；`toJSON → new z()` 往返后 volatile 标记仍在。

### 5) 工具注册契约 —— `tests/test-tools-020.mjs`

```bash
DSH_ROOT=<DSH 检出路径> node tests/test-tools-020.mjs
```

用真实的 `@deepseek-ai/cordis` + `packages/core/tools` 构造一个可用 `ToolRuntime`（只 `static inject ['systemPrompt']`，测试里用桩满足），然后把插件的 6 个工具真正注册进去：

1. `ctx.tools.register()` 接纳全部 6 个定义、返回 6 个 disposer；
2. `schemas()` 只投影 `name/description/parameters`（`output` / `execute` 不泄漏到模型请求）；
3. 必填参数编译为 `required` 数组、可选参数不进入、数组参数编译为 `{type:'array',items}`；
4. `defineToolLocal` 兜底形状同样被真实注册表接纳（6/6）；
5. 官方 0.2.0 `defineTool` 接受插件的选项形状；
6. 反向断言：缺 `output` 的定义确实被内核拒绝（证明测试有鉴别力）。

### 5) Client 插槽契约 —— `tests/test-client-slots-020.mjs`

```bash
DSH_ROOT=<DSH 检出路径> node tests/test-client-slots-020.mjs
```

`smoke-client.mjs` 用的是 mock `slots`（`register` 直接返回 `() => {}`），任何真实校验失败都会被 `apply` 的 try/catch 吞成「少注册几个槽位」。本测试改用**真实 SlotCore**（`<检出>/packages/client/ui-slots`）：

1. 用 `registerFactory` 的 `children` 表声明一棵与官方同形的最小插槽树（`shell.overlay` / `settings.section` / `conversation.input.left` / `conversation.session.header.actions` / `conversation.chat.assistant-actions`）；
2. 跑 bundle 的 `mod.apply(ctx)`，断言 `exports.inject` 含 `slots`、6 条注册全部经过 `slots.inject`、**真实 SlotCore 一条都没拒绝**；
3. 逐槽位核对账本：id 正确、`shell.overlay` 两条独立条目并按 `order` 排序（30 → 40）、`settings.section` 的 `label()` 解析为「记忆管理」；
4. 反向断言测试有鉴别力：未声明的槽位、list 槽位缺 `id` 都被真实 SlotCore 拒绝；
5. 释放 `slots.inject` 的 disposer 后账本清空、可重新 `apply` 而不撞 id；
6. 校验 `dsh.client.inject` 的每个包名在检出中真实存在且确实声明了 `dsh.client`。

### 6) 真实会话表面回归 —— `tests/test-surface.mjs`

```bash
node tests/test-surface.mjs <DSH 检出路径>     # 或 DSH_ROOT=<DSH 检出路径> node tests/test-surface.mjs
```

用**真实 `Session`**（`<检出>/packages/core/session/lib/index.js`）跑 `plan.excludeTurn` 的排除 / 恢复，覆盖 mock ctx 覆盖不到的内核契约：

1. **来源标识**：`kind:'memory-manager'` 与历史 `kind:'plugin', plugin:'memory-manager'` 都被识别，他人来源不被误判；
2. **`SurfaceOp` 字段名**：0.2.0 只接受 `{op:'replace', startSeq, endSeq}`（恰好 3 个自有键），`{start,end}` 被拒；
3. **排除 / 恢复全链路**：真实 `Session.append` 的表面校验（surfaceOp 必填、`sourceEventSeqs` 覆盖被遮蔽节点、`tool/result` 只能改 `content`、`assistant/message` 不能携带 `sourceEventSeqs`）；
4. **`assistant/message` 还原方式**：内核禁止它作为替换事件 → 插件降级为 user 文本还原。

未提供检出路径时打印 `[skip]` 并正常退出。

### 7) pre-step 端到端 —— `tests/test-pre-step-e2e-020.mjs`

```bash
DSH_ROOT=<DSH 检出路径> node tests/test-pre-step-e2e-020.mjs
```

用 `dsh-agent-loop-testkit` 的 production harness 起**真实 AgentLoop**，注册插件与一个 mock `LlmAdapter`，发一条用户消息后断言：

1. 循环确实发出了模型请求，且请求消息里出现 `source.kind === 'memory-manager'` 的注入消息（`role: 'user'`、`form: 'snapshot'`、`sections[0].name === 'memory-manager:context'`）；
2. 注入正文含计划里的固定消息与记忆快照/标注，并被「=== 记忆库上下文 ===」包裹；
3. 注入消息同时作为 `user/message` + `surfaceOp: 'append'` 落进会话日志，且与人类消息可区分；
4. 第二轮请求同样注入（`mode: 'on'` 每轮一次）；
5. LLM 辅助链路：经真实路由 POST `memory.suggest`，断言它打到 mock 适配器、带 `provider/model/system/maxTokens`，且消息来源为插件自己的 `kind`（`form: 'notice'` + `summary`）。

这条链路是「注入消息形状被 0.2.0 的 Session/循环接受」的最终证据——只直接调用监听器函数是证明不了这一点的。

> **它抓到的真实缺陷**：计划（`loadPlan`）与记忆索引（`scanLibrary`）都是懒加载的，首个请求可能早于它们完成，导致**第一轮注入静默落空**。修复见 `lib/plan.js` 的 `m.ensureInjectionReady()`（在渲染前补齐并复用两者的缓存），由 `agent/pre-step` 监听器调用。

> **回归防护要点**（历史事故教训）：凡是带 children 的组件一律用 `h(Component, props)` 调用 —— 直接函数调用虽不报错但会**丢失 children**（按钮渲染为空）并可能引发 hooks 链错乱导致面板崩溃。`smoke-client.mjs` 专门守护这两点。

## 发布清单

1. **版本号**：更新 `package.json` 的 `version`（语义化版本）。
2. **CHANGELOG**：在 `CHANGELOG.md` 顶部新增新版本小节（描述新增 / 修复 / 破坏性变更），旧的正式版本归档，「Unreleased」段保持留空供下一次迭代填写。
3. **校验 `files` 字段**：确认 `lib`、`cordis.patch.yml`、`docs`、`examples`、`README.md`、`LICENSE` 均在发布清单内。
4. **回归测试**：跑语法检查 + 全部 8 个测试脚本（含 `DSH_ROOT` 六件套），全部通过。
5. **构建产物**：确保 `lib/client.js` 仍是 `window.__ModuleLoader__.load` 包裹的 CJS bundle 格式，`exports.inject` 存在，且 `package.json` 的 `dsh.client.inject` 为当前 DSH 的真实包名。
6. **提交**：更新 README（如需）、CHANGELOG、版本号一并提交。

## 环境与落盘

- Host 启动日志：`<DSH_MEMORY_LOG_DIR>/memory-manager-boot.log`（默认「用户主目录/.dsh/」，可用 `DSH_MEMORY_LOG_DIR` 重定向）。
- 前端日志：`<DSH_MEMORY_LOG_DIR>/memory-manager-client.log`（经 `diag.log` op 上报落盘）。


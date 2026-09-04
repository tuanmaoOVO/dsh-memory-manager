# 开发指南

面向想要修改、测试或发布本插件的开发者。**0.4.0 起本插件面向 DSH 0.1.2-rc.1+**，设计原则见 `README.md`「兼容性」章节。

## 目录结构

```
dsh-memory-manager/
├── lib/
│   ├── index.js        # 插件装配：name/inject/Config/apply、settings、事件、agent/pre-step 注入、启动预载
│   ├── util.js         # 通用工具（日志 / fs / 字段清洗；零 DSH 依赖）
│   ├── memory.js       # 记忆库（Markdown + front-matter，扫描 / 解析 / 序列化 / backlink）
│   ├── plan.js         # 注入计划 / once 队列 / 轮次排除存储 / 自动注入 / 注入渲染
│   ├── sessions.js     # 会话视图（live + sessionQuery）、轮次构建、排除 / 恢复、跨工作区列表
│   ├── llm.js          # LLM 辅助（ctx.llm.stream）：印象建议 / 智能合并 / 会话总结
│   ├── tools.js        # 6 个 Agent 记忆工具（defineTool 或内置等价实现）
│   ├── api.js          # HTTP 路由（webServer 兼容通道 + connection.rpc 标准通道）+ RPC 分发
│   └── client.js       # Client 半区（浏览器 bundle）。插槽、面板、错误边界、日志上报
├── cordis.patch.yml    # DSH bundle 挂载补丁（insert 行 id: memory-manager）
├── tests/
│   ├── test-apply.mjs  # Host 集成回归：mock ctx 调用 apply()，断言注册 / 注入 / 各 op
│   └── smoke-client.mjs# Client 冒烟：mock 浏览器 + SSR 渲染各组件 + 按钮断言
├── examples/
│   └── memory-library/ # 示例记忆库（memories / pinned / config.json）
├── docs/               # 开源文档（本目录）
├── package.json        # 包元数据、bundle/client 声明、peerDependencies
├── CHANGELOG.md
├── LICENSE             # MIT
└── README.md
```

## Host 半区（lib/*.js）

- 入口导出 `name` / `inject` / `apply` / `Config`。`inject = ['settings', 'tools']` 声明硬依赖（均为 dsh-base root 级服务）；其余服务一律 `ctx.get('name')` 可选读取（支持 `ctx.get(name, false)` loose 模式兜底旧版行为）。
- `apply` 构建统一共享状态对象 `m`，依次安装：`installMemory` → `installPlan` → `installSessions` → `installLlm` → settings 注册 → `installTools`（await，动态 import）→ `installApi` → `agent/pre-step` 注入段 → `agent/created` 预载 → 启动扫描。所有副作用挂 disposers，统一回滚。
- **关键实现**：
  - settings 命名空间 `memory-manager`，`applies:'live'`（`scope.get()` / `scope.watch()` / `scope.update()`）；旧版 `config.json` 自动迁移。
  - **注入**：`agent/pre-step` 瀑布（payload `{agent, messages, turn, step, signal}`，返回 `{kind:'enter', messages}`）。仅用户消息触发的请求注入一条 `form:'snapshot'` 的 plugin 消息（UI 折叠、模型可见、随会话日志持久化），不依赖 `systemPrompt.section`（极简 complete 模式也生效）。
  - **会话读取**：live `ctx.sessions.get(id)` 优先（`session.surface.nodes` + `snapshotEvents()`），只读回退 `ctx.sessionQuery.readSurface()`；`excludeTurn` 需要可写 live 会话（`session.append(type, data, { surfaceOp, sourceEventSeqs })`）。
  - **规约记忆自动注入**：`agent/created`（`global:true`）预载计划；`isNewSession` 以「无 `user/message` / `assistant/message` 事件」判定，把启用中的规约记忆与最近 8 条会话总结记忆并入计划。
  - **会话总结**：`session.summarize` 直接调 `ctx.llm.stream`（`agentDefaultModel.currentSelection()` 选择路由），`extractJson` 稳健抽取 JSON，`merge` 时先 `groupSameTransactions` 分组；结果自动入库。
  - 6 个 Agent 工具：`memory_search` / `memory_recall` / `memory_save` / `memory_set_enabled` / `session_inject` / `memory_pin`。
  - **API 双通道**：`/_dsh/memory-manager/api`（兼容，始终注册）+ `ctx.connection.rpc.intercept('/api', 'memory-manager/*')`（标准，存在才注册）。

## Client bundle（lib/client.js）

`lib/client.js` 是**浏览器 bundle 构建产物格式**，而非源码 TS/JSX：

- 最外层为 `window.__ModuleLoader__.load({ id: "...", factory: (require) => { ... } })`（0.1.2 客户端模块系统仍使用该注册契约；bundle 由 DSH 按 `dsh.client` 声明自动扫描并服务）。
- factory 内是 **CJS**（`const React = require("react")`），使用 `React.createElement`（`const h = React.createElement`），**不得出现 `<Component />` JSX**。
- `exports.apply(ctx)` 在浏览器端注册**6 个插槽**（`conversation.input.left` / `conversation.session.header.actions` / `shell.overlay` ×2 / `settings.section` / `conversation.chat.assistant-actions`）—— 这些槽名与租约在 0.1.2 的 `SlotMap` 中逐一验证仍存在。
- 会话标准 props：session 作用域槽位组件收到 `sessionId` / `useSession` / `useSessions` / `useProjection`；`ctx.sessions.open(id)` 切换会话；`[data-chat-anchor-key]` + `[data-conversation-scroll]` 用于消息定位。
- **任何修改后必须保持 `window.__ModuleLoader__.load({ id, factory })` 包裹格式**；否则无法注入浏览器运行时。

主要组件：`Panel`（右侧面板，计划 / 记忆库 / 消息三 tab）、`GraphPanel` / `GraphDetail`（左侧图谱浮层，`mg-*` 样式 + `graphLayout` 力导向 / `radialLayout` 焦点径向布局）、`SummarizeDialog`（会话总结）、`SaveDialog` / `ComposeDialog` / `EditDialog`、`InputButton`、`MessageActions`、`JumpReceiver`（消息跳转接收器）、`SettingsSection`、`Boundary`。面板 / 图谱浮层 / 跳转接收的模块级状态为 `panel = { open, sessionId, tab, crashed }` 与 `graph = { open }`。

> 修改 client 后刷新页面即生效；若涉及新增 Host 能力（如新 op），需重启 DSH。

## 测试

### 语法检查

```bash
node --check lib/index.js
node --check lib/client.js
node --check tests/test-apply.mjs
node --check tests/smoke-client.mjs
```

### 依赖解析（本地跑测试）

两个测试脚本需要 `schemastery`、`@deepseek-ai/dsh-tools`（测试时可解析）、`react` / `react-dom`。仓库自身不安装这些依赖，可按以下方式链接到 DSH 检出：

```bash
# 在仓库根创建 node_modules 链接（node_modules 已 gitignore）：
#   node_modules/@deepseek-ai/dsh-tools → <DSH 检出>/packages/core/tools
#   node_modules/schemastery            → <DSH 检出>/vendor/schemastery（与 npm schemastery API 兼容）
#   tests/.deps/node_modules/{react,react-dom} → <DSH 检出> pnpm store 中的 react@18.3.1 与 react-dom@18.3.1
```

`smoke-client.mjs` 通过 `DSH_TEST_DEPS` 环境变量指向包含 `react` / `react-dom` 的目录（**必须是真实目录而非符号链接**，createRequire 按 realpath 解析）。

### 1) Host 集成回归 —— `tests/test-apply.mjs`

```bash
node tests/test-apply.mjs [插件模块路径] [临时记忆库路径]
```

- 默认加载本仓库 `lib/index.js`。
- 用 **mock ctx**（settings / tools / agents / sessionQuery / sessions / workspaceRegistry / llm / agentDefaultModel / webServer）调用 `apply(ctx, {})`，断言：
  1. settings 注册 `memory-manager`；
  2. 6 个工具注册；
  3. `webServer.register` 路由注册；
  4. 经路由 handler 走一遍业务层（`state.setLibrary` → `memory.save` → `state.get` → `library.scan` → `plan.addMemory` → `sessions.list`），验证「规约记忆新会话自动注入」；
  5. `agent/pre-step` 监听存在且注入快照消息（`source.kind==='plugin'`、`form` 含 sections）；
  6. dispose 成功。

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
3. 用 `react-dom/server` 的 `renderToString` 对每个组件进行 SSR 渲染（含 hooks 违规 / 渲染异常检测）。
4. 按钮文字断言：确保按钮经 `h()` 调用、children 未丢失。
5. 结构性检查：禁止直接组件调用（`PlanTab({...})` 这类写法），防止 hooks 挂错链回归。

任一断言失败即 `process.exit(1)`。

> **回归防护要点**（历史事故教训）：凡是带 children 的组件一律用 `h(Component, props)` 调用 —— 直接函数调用虽不报错但会**丢失 children**（按钮渲染为空）并可能引发 hooks 链错乱导致面板崩溃。`smoke-client.mjs` 专门守护这两点。

## 发布清单

1. **版本号**：更新 `package.json` 的 `version`（语义化版本）。
2. **CHANGELOG**：在 `CHANGELOG.md` 顶部新增新版本小节（描述新增 / 修复 / 破坏性变更），旧的正式版本归档，「Unreleased」段保持留空供下一次迭代填写。
3. **校验 `files` 字段**：确认 `lib`、`cordis.patch.yml`、`docs`、`examples`、`README.md`、`LICENSE` 均在发布清单内。
4. **回归测试**：跑 `node --check` + 两个测试脚本，全部通过。
5. **构建产物**：确保 `lib/client.js` 仍是 `window.__ModuleLoader__.load` 包裹的 CJS bundle 格式，且 `package.json` 的 `dsh.client.inject` 为当前 DSH 的行名。
6. **提交**：更新 README（如需）、CHANGELOG、版本号一并提交。

## 环境与落盘

- Host 启动日志：`<DSH_MEMORY_LOG_DIR>/memory-manager-boot.log`（默认「用户主目录/.dsh/」，可用 `DSH_MEMORY_LOG_DIR` 重定向）。
- 前端日志：`<DSH_MEMORY_LOG_DIR>/memory-manager-client.log`（经 `diag.log` op 上报落盘）。

# 开发指南

面向想要修改、测试或发布本插件的开发者。

## 目录结构

```
dsh-memory-manager/
├── lib/
│   ├── index.js        # Host 半区（ESM）。settings、HTTP API、工具、注入段、事件
│   └── client.js       # Client 半区（浏览器 bundle）。插槽、面板、错误边界、日志上报
├── cordis.patch.yml    # DSH bundle 挂载补丁（insert 行 id: memory-manager）
├── tests/
│   ├── test-apply.mjs  # Host 集成回归：mock ctx 调用 apply()
│   └── smoke-client.mjs# Client 冒烟：mock 浏览器 + SSR 渲染各组件 + 按钮断言
├── examples/
│   └── memory-library/ # 示例记忆库（memories / pinned / config.json）
├── docs/               # 开源文档（本目录）
├── package.json        # 包元数据、bundle 声明、peerDependencies
├── CHANGELOG.md
├── LICENSE             # MIT
└── README.md
```

## Host 半区（lib/index.js）

- 入口导出 `name` / `inject` / `apply` / `Config`。`inject = ['settings', 'tools', 'systemPrompt']` 声明硬依赖（属性访问必须 inject 声明，否则 Cordis 抛 `cannot get property ... without inject`）。
- **关键实现**：
  - settings 命名空间 `memory-manager`，`applies:'live'`；`node:fs/promises` 直读记忆库（不依赖 `ctx.fs`，宿主根下 fs 服务不可见）。
  - HTTP 路由 `/_dsh/memory-manager/api` 走 `webServer` 服务（`ctx.inject(['webServer'], cb)` + `webCtx.effect`，服务出现才注册）。**服务名是 `webServer`，不是 httpServer**。
  - 会话读取：`liveSession`（`ctx.get('sessions')`）优先，否则用 `sessionQuery.readSession` + `foldSurface` 只读 surface。
  - 工具、注入段、`agent/created` 预载计划、启动 `scanLibrary` 全部按需注册，disposer 统一回滚。

## Client bundle（lib/client.js）

`lib/client.js` 是**浏览器 bundle 构建产物格式**，而非源码 TS/JSX：

- 最外层为 `window.__ModuleLoader__.load({ id: "...", factory: (require) => { ... } })`。
- factory 内是 **CJS**（`const React = require("react")`），使用 `React.createElement`（`const h = React.createElement`），**不得出现 `<Component />` JSX**。
- `exports.apply(ctx)` 在浏览器端注册插槽。
- **任何修改后必须保持 `window.__ModuleLoader__.load({ id, factory })` 包裹格式**；否则无法注入浏览器运行时。

> 修改 client 后刷新页面即生效；若涉及新增 Host 能力（如新 op），需重启 DSH。

## 测试

### 语法检查

所有 JS/ESM/CJS 文件先过语法检查：

```bash
node --check lib/index.js
node --check lib/client.js
node --check tests/test-apply.mjs
node --check tests/smoke-client.mjs
```

### 依赖解析

两个测试脚本都依赖 `schemastery`、`@deepseek-ai/*` 等 peer 依赖。仓库自身不必然安装这些依赖，测试通过 **`DSH_TEST_DEPS`** 环境变量指向**包含 react / react-dom 的 node_modules 目录**来解析依赖（也可用 `NODE_PATH`；见 test-apply.mjs 注释）。

### 1) Host 集成回归 —— `tests/test-apply.mjs`

```bash
node tests/test-apply.mjs [插件模块路径]
```

- 默认加载本仓库 `lib/index.js`；可用第二个参数指定其他模块路径。
- 用一个 **mock ctx**（settings / tools / systemPrompt / webServer / sessionQuery）调用 `apply(ctx, {})`，断言：settings 注册、`webServer.register` 路由注册、工具 / section 注册，随后 dispose 成功。
- 用于验证安装路径（install → dispose）不抛错。

### 2) Client 冒烟 + SSR —— `tests/smoke-client.mjs`

```bash
DSH_TEST_DEPS=/path/to/deps node tests/smoke-client.mjs
```

| 环境变量 | 默认 | 含义 |
|---|---|---|
| `DSH_TEST_DEPS` | 仓库自身 `node_modules` | 指向含 `react` / `react-dom` 的目录，用于解析依赖 |
| `DSH_TEST_CLIENT` | 本仓库 `lib/client.js` | 指向要测试的 client bundle 路径 |

该脚本：

1. mock 浏览器环境（`window.__ModuleLoader__`、`document`、`fetch`），读取 client bundle **注入测试导出**（`module.exports.__test = { Panel, PlanTab, LibraryTab, MessagesTab, GraphTab, SaveDialog, ComposeDialog, EditDialog, InputButton, SettingsSection, Boundary, MessageActions, Switch, IconBtn }`），再 `eval` 执行。
2. 调用 `mod.apply(ctx)`，断言返回 disposer，并校验 4 个插槽注册（`input-left / overlay / settings / assistant-actions`）。
3. 用 `react-dom/server` 的 `renderToString` 对每个组件进行 SSR 渲染（15 项，含 hooks 违规 / 渲染异常检测）。
4. 按钮文字断言（7 组）：确保按钮经 `h()` 调用、children 未丢失。
5. 结构性检查：禁止直接组件调用（`PlanTab({...})` 这类写法），防止 hooks 挂错链回归。

任一断言失败即 `process.exit(1)`。

> **回归防护要点**（历史事故教训）：凡是带 children 的组件一律用 `h(Component, props)` 调用 —— 直接函数调用虽不报错但会**丢失 children**（按钮渲染为空）并可能引发 hooks 链错乱导致面板崩溃。`smoke-client.mjs` 专门守护这两点。

## 发布清单

1. **版本号**：更新 `package.json` 的 `version`（语义化版本）。
2. **CHANGELOG**：在 `CHANGELOG.md` 顶部新增新版本小节（描述新增 / 修复 / 破坏性变更），旧的正式版本归档，「Unreleased」段保持留空供下一次迭代填写。
3. **校验 `files` 字段**：确认 `lib`、`cordis.patch.yml`、`docs`、`examples`、`README.md`、`LICENSE` 均在发布清单内。
4. **回归测试**：跑 `node --check` + 两个测试脚本，全部通过。
5. **构建产物**：确保 `lib/client.js` 仍是 `window.__ModuleLoader__.load` 包裹的 CJS bundle 格式。
6. **提交**：更新 README（如需）、CHANGELOG、版本号一并提交。

## 环境与落盘

- Host 启动日志：`<DSH_MEMORY_LOG_DIR>/memory-manager-boot.log`（默认「用户主目录/.dsh/」，可用 `DSH_MEMORY_LOG_DIR` 重定向）。
- 前端日志：`<DSH_MEMORY_LOG_DIR>/memory-manager-client.log`（经 `diag.log` op 上报落盘）。

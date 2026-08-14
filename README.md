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
- **上下文计划注入（systemPrompt section）**：按会话维护一份注入计划（固定消息 + 勾选记忆），记忆模式开启后每次发送自动注入到模型的系统提示中，带单条 / 总量 / 固定消息三级字符上限与紧凑视图。
- **6 个 Agent 记忆工具**：`memory_search` / `memory_recall` / `memory_save` / `memory_set_enabled` / `session_inject` / `memory_pin`，可整体开关，模型可直接读写记忆库、按需管理会话注入计划。
- **完整对话侧栏面板**：三个标签页 —— 计划 / 记忆库 / 消息；从浏览器输入栏的「记忆」按钮、消息动作条或面板直接操作。
- **力导向图谱（左侧浮层）**：独立于右侧面板的**左侧浮层面板**，含**语义分层全景**与**焦点探索**双视图（`mg-*` 组件）；按标签着色（规约 / 会话总结 / 复盘 / 其他），支持搜索定位、聚焦邻域、缩放 / 平移与详情 / 相关记忆跳转。
- **消息跳转（JumpReceiver）**：在消息页 / 记忆详情可一键**在对话中定位**到来源消息——`conversation.session.header.actions` 插槽内的隐藏接收器按 `anchorSeq` 匹配并滚动高亮，跨会话自动切换。
- **跨工作区会话列表（sessions.list）**：可在面板消息页 / 会话总结中浏览并选择全部工作区的会话（含归档标记）。
- **跨会话共享**：宿主级插件，记忆库数据跨会话共享，不受进程重启影响（存于磁盘）。
- **设置页自由开关**：宿主启用后可在 DSH 设置页独立控制启用、注入模式、注入视图、新会话自动注入规约/会话总结、Agent 工具开关、记忆库路径与字符上限。
- **非破坏性轮次排除 / 恢复**：可把某轮对话排除出注入（不删除），随时恢复参与。

## 架构一句话

插件是宿主级（Host）插件：`lib/index.js` 为 Host 半区（ESM，注册 settings / 工具 / 注入段 / HTTP API / 事件），`lib/client.js` 为浏览器 Client 半区 bundle（`window.__ModuleLoader__.load` 包裹的 CJS），两者通过 HTTP 端点 `/_dsh/memory-manager/api`，以 `{op, sessionId, args}` JSON 信封通信；Host 端 `agent/created` 预载计划并对新会话自动注入规约 / 会话总结记忆，Client 端 6 个插槽驱动右侧面板、左侧图谱浮层、消息跳转与设置页。

## 安装与挂载

请参阅 [docs/INSTALL.md](docs/INSTALL.md) —— 简要而言，把本包放入 DSH profile 的 `node_modules`，在 profile 的 `package.json` 的 `dsh.profile.bundles` 中登记 bundle（通过包内 `cordis.patch.yml` 以 `insert` 方式挂载进 profile 层栈），重启 DSH 即可。

## 快速开始

1. 按 [docs/INSTALL.md](docs/INSTALL.md) 完成安装并重启 DSH。
2. 在浏览器打开对话，输入栏左侧出现「记忆 · 已关闭」按钮；DSH 设置页出现「记忆管理」区块。
3. 点击「记忆 · 已关闭」按钮打开侧栏面板；如记忆库为空，可先用示例库或「消息」页把某条消息保存为记忆。
4. 在「记忆库」页把记忆「加入计划」，或在「计划」页打开「临时记忆模式」（或将某条消息「固定」）。
5. 若记忆库中存在规约记忆或会话总结记忆，新会话会自动常驻注入；下一次发送消息时，模型系统提示即包含「=== 记忆库上下文 ===」注入段。
6. 点面板头部的「图谱」按钮可打开**左侧力导向图谱浮层**；消息页 / 记忆详情可一键跳转到对话中的来源消息。

> 提示：也可直接用 `examples/memory-library/` 作为记忆库路径，快速体验图谱与检索。

## 配置项（settings 命名空间 `memory-manager`）

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

参见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。要点：`lib/client.js` 是浏览器 bundle 构建产物格式（factory 内为 CJS），修改后需保持 `window.__ModuleLoader__.load({ id, factory })` 包裹格式；回归测试有两套 —— `tests/test-apply.mjs`（Host apply 回归）与 `tests/smoke-client.mjs`（mock 浏览器 + SSR 渲染各组件 + 按钮断言）。

## 许可证

[MIT](LICENSE)

---

## English Summary

**dsh-memory-manager** is a host-level plugin for the DeepSeek Harness that gives agents a durable, cross-session memory. Memories are plain Markdown files with front-matter metadata (Obsidian-compatible), each composed of an immutable snapshot plus an editable annotations layer. Memories carry short "impression" tags plus a classification `tags` field and a per-memory `enabled` switch; a memory tagged `convention` is a convention memory, and one tagged `会话总结` is a session summary. With `autoInjectConvention` on, every new session automatically receives all enabled convention memories plus the latest 8 session-summary memories. A per-session context plan — pinned messages plus checked memories — is injected into the model's system prompt on each send, with per-memory and total character caps and a compact view. Six model tools (`memory_search`, `memory_recall`, `memory_save`, `memory_set_enabled`, `session_inject`, `memory_pin`) give the agent direct read / write / plan control. The browser side provides a right-side panel (plan / library / messages tabs), a separate left-side force-directed knowledge graph overlay with semantic-panorama and focus-exploration views, a session-summarize dialog (`session.summarize`), cross-workspace session listing (`sessions.list`), and message jump-to-conversation, plus settings switches. The Host half exposes an HTTP JSON-RPC-style endpoint (`/_dsh/memory-manager/api`) that the browser Client calls. It is MIT-licensed and published to open source.

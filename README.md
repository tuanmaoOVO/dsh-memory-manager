# 记忆管理插件（dsh-memory-manager）

> 为 DSH（DeepSeek Harness）打造的记忆管理插件：跨会话记忆库、上下文计划注入、Agent 记忆工具与完整的对话侧栏面板。
> **Memory Manager for DSH — cross-session memory library, context planning & Agent memory tools.**

---

## 功能特性

- **文件夹记忆库**：以「文件夹 + Markdown」形式存放记忆（`memories/*.md`），front-matter 元数据，**Obsidian 兼容**，可直接用任意编辑器或图谱工具打开。
- **记忆 = 不可变快照 + 可编辑标注层**：快照保存历史事实，`<!-- mem:notes -->` 标注层可随时补充说明，互不污染。
- **印象（impressions）**：每记忆可带少量简短标签，作为检索主键与图谱节点；支持 LLM 生成印象建议。
- **组合（composedOf）与双向链接（backlink）**：可把多条记忆**非破坏性**聚合成一条组合记忆；`links` 自动建立反向引用索引。
- **上下文计划注入（systemPrompt section）**：按会话维护一份注入计划（固定消息 + 勾选记忆），记忆模式开启后每次发送自动注入到模型的系统提示中，带单条 / 总量 / 固定消息三级字符上限。
- **4 个 Agent 记忆工具**：`memory_search` / `memory_recall` / `memory_save` / `memory_pin`，可整体开关，模型可直接读写记忆库。
- **对话侧栏面板**：四个标签页 —— 计划 / 记忆库 / 消息 / 图谱；从浏览器输入栏的「记忆」按钮或消息动作条直接操作。
- **跨会话共享**：宿主级插件，记忆库数据跨会话共享，不受进程重启影响（存于磁盘）。
- **设置页自由开关**：宿主启用后可在 DSH 设置页独立控制启用、注入模式、注入视图、工具开关、记忆库路径与字符上限。
- **非破坏性轮次排除 / 恢复**：可把某轮对话排除出注入（不删除），随时恢复参与。

## 架构一句话

插件是宿主级（Host）插件：`lib/index.js` 为 Host 半区（ESM，注册 settings / 工具 / 注入段 / HTTP API / 事件），`lib/client.js` 为浏览器 Client 半区 bundle（`window.__ModuleLoader__.load` 包裹的 CJS），两者通过 HTTP 端点 `/_dsh/memory-manager/api`，以 `{op, sessionId, args}` JSON 信封通信。

## 安装与挂载

请参阅 [docs/INSTALL.md](docs/INSTALL.md) —— 简要而言，把本包放入 DSH profile 的 `node_modules`，在 profile 的 `package.json` 的 `dsh.profile.bundles` 中登记 bundle（通过包内 `cordis.patch.yml` 以 `insert` 方式挂载进 profile 层栈），重启 DSH 即可。

## 快速开始

1. 按 [docs/INSTALL.md](docs/INSTALL.md) 完成安装并重启 DSH。
2. 在浏览器打开对话，输入栏左侧出现「记忆 · 已关闭」按钮；DSH 设置页出现「记忆管理」区块。
3. 点击「记忆 · 已关闭」按钮打开侧栏面板；如记忆库为空，可先用示例库或「消息」页把某条消息保存为记忆。
4. 在「记忆库」页把记忆「加入计划」，或在「计划」页打开「临时记忆模式」（或将某条消息「固定」）。
5. 下一次发送消息时，模型系统提示即包含「=== 记忆库上下文 ===」注入段。

> 提示：也可直接用 `examples/memory-library/` 作为记忆库路径，快速体验图谱与检索。

## 配置项（settings 命名空间 `memory-manager`）

| 字段 | 类型 | 默认值 | 含义 |
|---|---|---|---|
| `enabled` | boolean | `true` | 总开关。关闭后不注入、Agent 工具拒绝执行、API 仅返回状态（供设置页重新开启） |
| `mode` | `'on' \| 'off'` | `'off'` | 临时记忆模式。`on` = 每次发送自动注入固定消息与勾选记忆；`off` = 不自动注入，可用 `plan.injectOnce` 做单次注入 |
| `view` | `'full' \| 'compact'` | `'full'` | 记忆注入视图。`full` = 注入完整快照；`compact` = 仅标题 + 印象 + 预览（模型可 `memory_recall` 读全文） |
| `modelTools` | boolean | `true` | 是否向 Agent 注册 4 个记忆工具 |
| `libraryPath` | string | `''` | 记忆库文件夹绝对路径；为空时自动锚定到默认记忆库（工作区下的 `.dsh-memory`） |
| `memoryChars` | number | `6000` | 单条记忆注入字符上限 |
| `totalChars` | number | `12000` | 单次计划注入的总字符上限 |
| `pinChars` | number | `6000` | 固定消息合计字符上限 |

## Agent 工具

| 工具 | 参数 | 行为 |
|---|---|---|
| `memory_search` | `query: string`（必填） | 按关键词匹配记忆标题、印象与正文，返回 id / 标题 / 印象 / 预览（最多 20 条） |
| `memory_recall` | `id: string`（必填） | 读取一条记忆的完整快照与标注，及其链接、组合来源、被引用关系 |
| `memory_save` | `title` / `impressions` / `snapshot` / `notes` | 保存一条新记忆到记忆库，返回记忆元数据 |
| `memory_pin` | `content: string`（必填）、`label: string` | 把一段文本固定为当前会话的临时记忆（记忆模式开启时每次发送自动注入） |

> 行为受 `modelTools` 与 `enabled` 双重门控；`memory_pin` 需要能确定当前会话。

## 记忆文件格式示例

记忆存放在记忆库的 `memories/<id>.md`，`<id>` 为 3–64 位字母 / 数字 / `_` / `-`：

````markdown
---
id: "m_example_planning"
title: "示例：季度产品规划"
impressions: ["产品规划", "路线图", "示例"]
links: []
composedOf: []
sourceSession: null
createdAt: 1750000000000
updatedAt: 1750000000000
revision: 1
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

**dsh-memory-manager** is a host-level plugin for the DeepSeek Harness that gives agents a durable, cross-session memory. Memories are plain Markdown files with front-matter metadata (Obsidian-compatible), each composed of an immutable snapshot plus an editable annotations layer. Memories carry short "impression" tags, support non-destructive composition (`composedOf`), and build automatic bidirectional `links`/backlink indexes. A per-session context plan — pinned messages plus checked memories — is injected into the model's system prompt on each send, with per-memory and total character caps and a compact view. Four model tools (`memory_search`, `memory_recall`, `memory_save`, `memory_pin`) let the agent read and write the library directly, and a browser side panel with plan / library / messages / knowledge-graph tabs plus settings switches provides full manual control. The Host half exposes an HTTP JSON-RPC-style endpoint (`/_dsh/memory-manager/api`) that the browser Client calls. It is MIT-licensed and published to open source.

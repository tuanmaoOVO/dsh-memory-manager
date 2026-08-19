# 更新日志（Changelog）

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/) 的语义化版本格式。

## [Unreleased]

### 文档

- 仓库新增 `CONVENTIONS.md`（委派-验证-复盘闭环规约 v4 详情）；README 新增「使用规约记忆」章节，说明把规约保存为规约记忆（`tags` 含 `convention`）并「加入计划」后的自动注入流程。

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

# 更新日志（Changelog）

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/) 的语义化版本格式。

## [Unreleased]

（留空，供下一次迭代填写。）

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

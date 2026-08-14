# 更新日志（Changelog）

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/) 的语义化版本格式。

## [Unreleased]

（留空，供下一次迭代填写。）

## [0.2.0] - 2026

### 新增 / 变更

- **规约记忆**：记忆可带标注属性，规约类记忆在新会话中**默认自动常驻注入**（`convention` / `会话总结` 类别记忆自动注入；记忆面板可管理注入计划）。
- 完善「注入式」上下文体系：固定消息 + 勾选记忆 + 单次注入（`injectOnce`）三种方式，记忆模式开启时每次发送自动注入。
- 前端体验：消息动作条（保存为记忆 / 固定）；设置页自由开关；面板加入「图谱」标签页；错误边界与崩溃自愈；日志链路（Host boot log + client `diag.log` 上报落盘）。
- Agent 记忆工具（`memory_search` / `memory_recall` / `memory_save` / `memory_pin`）全链路可用，受总开关与工具开关双重门控。

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

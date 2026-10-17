# dsh-memory-manager · 记忆管理插件

> **我的记忆产生于我过去的记忆和当前世界环境和我的个人意志。它记录着我的过去，融合着我的现在，指向了一部分我的未来。**

这是我对记忆的理解，也是这个插件的设计原点。

它是一个 [DSH（DeepSeek Harness）](https://github.com/deepseek-ai/deepseek-harness) 的**宿主级插件**：给你的 Agent 一个跨会话的经验库——不是又一个检索索引，也不是聊天记录的备份，而是**你自己会生长的记忆**。

---

## 愿景：记忆如何生长

**记录过去。** 每一段经验落成一条记忆：一份不可变的**快照**记录当时的事实，一层可编辑的**标注**承接今天的修正。同一段经历可以同时拥有「当初的结论」和「后来的理解」，谁也不会覆盖谁。

**融合现在。** 记忆不该等人来搜。规约记忆与会话总结在每个**新会话开始时自动在场**；会话进行中可以随时固定一段话、勾选几条记忆，让它们跟着每一次思考走。需要旧经验时，先检索，再动手。

**指向未来。** 记忆会**生长**：多条记忆可以非破坏地组合成新记忆，可以互相链接成一张网络（图谱），过时的会被标注、禁用、替代。它不追求「记住一切」，而追求**下一次做得更好**。

**记忆属于你。** 每条记忆就是你磁盘上的一个 Markdown 文件（front-matter + 正文），Obsidian 兼容。可以直接编辑、diff、git、同步。卸载插件不会带走它们。

## 它做了什么

- **跨会话记忆库** —— 文件夹 + Markdown，快照/标注双层结构，可打标签、可单独禁用。
- **自动在场** —— 新会话默认注入所有启用中的规约记忆（`tags: [convention]`）与最近 8 条会话总结；旧会话不受打扰。
- **注入计划** —— 每个会话一份「固定消息 + 勾选记忆」的清单，开启模式后每轮自动注入，带单条 / 总量 / 固定消息三级字符上限与紧凑视图。
- **会话总结** —— 把一段对话交给模型提炼成「会话 id / 轮次 / 用户请求 / 思考链 / 处理链 / 结果」六要素记忆，支持智能合并同一事务的连续轮次。
- **可生长的图谱** —— 左侧力导向浮层，语义全景与聚焦探索双视图，按标签着色，双向链接可跳转。
- **模型自己的记忆工具** —— `memory_search` / `memory_recall` / `memory_save` / `memory_set_enabled` / `session_inject` / `memory_pin`，让 Agent 自己检索、沉淀、管理计划。
- **回到现场** —— 记忆与对话消息双向定位，支持跨工作区会话列表。
- **克制** —— 轮次排除是非破坏的（随时恢复）；三档开关（软关闭 / 行级禁用 / 卸载），任何一档都不会影响 DSH 本体和其它插件。

## 安装

**走官方插件页，三步：**

1. 把本项目克隆或下载到本地，记住它的**绝对路径**（例如 `D:/dshTools/dsh-memory-manager`）。
2. 打开 DSH → **插件**页 → **添加插件** → 填入上面的绝对路径。
3. 重启 DSH（未开启热重载时）→ 刷新页面。输入栏左侧出现「记忆」按钮，设置页出现「记忆管理」区块。

命令行等价形式：`dsh plugin --profile web add file:<绝对路径>`。

> 三档开关、卸载残留、常见问题与版本兼容矩阵见 **[docs/INSTALL.md](docs/INSTALL.md)**。

## 五分钟上手

1. 点输入栏左侧的「记忆 · 已关闭」，打开右侧面板。
2. 记忆库为空？把 `examples/memory-library/` 设为记忆库，或直接把某条消息「保存为记忆」。
3. 在「记忆库」页把记忆**加入计划**，或在「计划」页把某段话**固定**下来。
4. 打开「临时记忆模式」——下一次发送，模型请求里就带着这份上下文（UI 折叠显示，模型可见）。
5. 点面板头部的「图谱」，看这些记忆如何连成一张网。

## 记忆放在哪

```
<记忆库>/
├── memories/*.md        # 每条记忆 = front-matter + 快照 + 标注
└── pinned/
    ├── plan.json        # 当前注入计划（固定消息 + 勾选记忆）
    └── excluded.json    # 轮次排除记录（非破坏，可恢复）
```

未指定时自动锚定到工作区下的 `.dsh-memory`；也可以在设置里填任意绝对路径（可直接粘贴工作区根目录）。自动锚点会**优先选择已有记忆的候选库**，新增工作区不会让旧记忆「消失」。设置页会显示当前生效路径、条数以及它是手动设置还是自动解析。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/INSTALL.md](docs/INSTALL.md) | 安装与卸载、三档开关、验证清单、排错、版本兼容 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 架构、记忆文件格式、与 DSH 的集成面、跨版本适配 |
| [docs/API.md](docs/API.md) | HTTP API、Agent 工具、注入段格式 |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | 目录结构、测试与验证方法 |
| [CONVENTIONS.md](CONVENTIONS.md) | 一份可直接使用的「委派-验证-复盘闭环」规约示例（接入为规约记忆后新会话自动注入） |

**兼容性**：面向 DSH `0.2.1-rc.2`，同时兼容 `0.1.2-rc.1 → 0.2.1-rc.2`；只依赖 DSH 核心扩展点，官方包一律不依赖。细节见 [INSTALL.md 的版本兼容](docs/INSTALL.md#版本兼容)。

## English Summary

**dsh-memory-manager** is a host-level memory plugin for the DeepSeek Harness. Its premise: memory is born of past memories, the present world, and one's own will — it records the past, fuses the present, and points toward part of the future.

So memories here are plain Markdown files with an **immutable snapshot plus an editable annotation layer**, auto-present in every new session (conventions + recent session summaries), plannable per session, composable into new memories, and linkable into a graph. Six model tools let the agent search, save and manage its own memory. Data lives on your disk, Obsidian-compatible, and survives uninstalling the plugin.

Install: clone the repo, then **DSH → Plugins → Add plugin → enter the local absolute path**.

## License

[MIT](LICENSE)

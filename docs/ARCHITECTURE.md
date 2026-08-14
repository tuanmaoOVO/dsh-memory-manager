# 架构设计

本插件是 **宿主级（Host）插件**，通过 Cordis 以 bundle 形式挂载进 DSH profile，为所有会话提供跨会话记忆能力。整体上由 **Host 半区**（`lib/index.js`，Node 进程内 ESM）与 **Client 半区**（`lib/client.js`，浏览器 bundle）组成，两者经 HTTP JSON API 通信。

## 架构总览（ASCII）

```
 ┌──────────────────────────────────────────────────────────────────────┐
 │                         DSH 宿主进程 (Node)                          │
 │                                                                      │
 │  lib/index.js  (Host 半区, ESM)                                       │
 │  ┌────────────────────────────────────────────────────────────────┐  │
 │  │ settings (memory-manager 命名空间, applies:live)               │  │
 │  │   启用/模式/视图/工具/路径/字符上限           旧 config.json 迁移  │  │
 │  ├────────────────────────────────────────────────────────────────┤  │
 │  │ agents / sessions / sessionQuery + foldSurface                │  │
 │  │   └ 会话读取：live 优先，否则只读 surface 视图                 │  │
 │  ├────────────────────────────────────────────────────────────────┤  │
 │  │ 记忆库 (node:fs/promises 直读)                                 │  │
 │  │   memories/*.md      MRU memoryIndex + backlinkIndex           │  │
 │  │   pinned/<sid>.json  per-session 注入计划 (planCache)          │  │
 │  ├────────────────────────────────────────────────────────────────┤  │
 │  │ 4 个 Agent 工具: memory_search / recall / save / pin           │  │
 │  │ 注入段: systemPrompt.section (memory-manager:context, order300)│  │
 │  │ 事件: agent/created 预载计划；启动即 scanLibrary()             │  │
 │  └────────────────────────────────────────────────────────────────┘  │
 │                    ▲                             │                    │
 │   HTTP POST {op,sessionId,args}                  │ GET /_dsh/.../api │
 │   /_dsh/memory-manager/api   ◄─── HTTP ───►  JSON 探测 (ok/service)  │
 └──────────────────────────────────────────────────────────────────────┘
                    ▲
        fetch(API)  │  ────────────────
                    │
 ┌──────────────────────────────────────────────────────────────────────┐
 │                        浏览器 (Client 半区)                          │
 │  lib/client.js (window.__ModuleLoader__.load 包裹的 CJS bundle)      │
 │   插槽:                                                               │
 │     conversation.input.left              → 「记忆」按钮             │
 │     shell.overlay                        → 侧栏面板                 │
 │     settings.section                     → 设置页「记忆管理」       │
 │     conversation.chat.assistant-actions  → 消息动作条(保存/固定)    │
 │   面板 4 tab: 计划 / 记忆库 / 消息 / 图谱                              │
 │   错误边界 Boundary × N + 崩溃自愈 + 全局错误捕获(diag.log)          │
 └──────────────────────────────────────────────────────────────────────┘
```

## 数据模型

### 记忆 = 不可变快照 + 可编辑标注层

一条记忆由三部分构成：

- **快照（snapshot）**：不可变正文（`## 快照` 之后、`<!-- mem:notes -->` 之前）。用于记录事实、决定、待办等历史内容。
- **标注层（notes）**：`<!-- mem:notes -->` 之后的文本，是可编辑的补充注释层，可随时修改而不污染快照。
- **元数据（front-matter meta）**：标题、印象、链接、组合来源、来源会话等，是检索与图谱的依据。

### 印象（impressions）

每条记忆最多 12 个、每个不超过 40 字符的简短标签（`sanitizeImpressions`）。印象同时充当：

- **检索主键**：`memory_search` 按标题 / 印象 / 正文匹配。
- **图谱节点**：在「图谱」页以节点展示。
- **注入摘要**：`compact` 视图下，印象会以 `印象: a、b` 形式注入。

印象可由 LLM `memory.suggest` 生成建议（2–6 个），也可手动编辑。

### 组合（composedOf）与双向链接（backlink）

- **`composedOf`**：记录「本条由哪些记忆组成」，非破坏性聚合。组合记忆保留原文来源引用，不复制全文；用 `memory_recall` 读原记忆。
- **`links`**：显式关联（可被编辑）；扫描时自动建立反向索引 `backlinkIndex`（即「被引用」）。`relatedOf` 用 BFS 沿 `links` + `backlinks` 做「链式回忆」，返回按距离组织的相关记忆。

### 会话注入计划（plan）

每个会话一份计划，持久化在 `pinned/<sessionId>.json`，内存中复用于 `planCache` 与 `injectOnce`：

```jsonc
{
  "pinned":   [ { "id", "role", "text", "at" } ],  // 固定消息
  "memories": [ { "id", "title", "impressions" } ], // 勾选记忆（引用）
  "excluded": [ "turnId", ... ],                    // 已排除的轮次
  "injectOnce": false                               // 仅单次注入标记
}
```

## 记忆文件格式

记忆存放在记忆库的 `memories/<id>.md`。`<id>` 必须匹配 `^[A-Za-z0-9_-]{3,64}$`。front-matter 使用 YAML 风格键值（值以 JSON 解析，失败则按字符串）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 必填，记忆唯一 id |
| `title` | string | 标题 |
| `impressions` | string[] | 印象标签 |
| `links` | string[] | 显式关联（双向索引自动建立） |
| `composedOf` | string[] | 组合来源记忆 id |
| `sourceSession` | string \| null | 创建来源会话 |
| `createdAt` / `updatedAt` | number | 毫秒时间戳 |
| `revision` | number | 更新版本号（每次 `memory.update` 递增） |

正文结构：

```
---
<front-matter 键值>
---

## 快照

<不可变快照正文>

<!-- mem:notes -->

<可编辑标注层>
```

解析规则：`parseFrontMatter` 剥离首尾 `---`，`parseMemory` 以 `<!-- mem:notes -->` 切分快照与标注，并去掉快照段开头的 `## 快照` 标题。序列化时按固定字段顺序写出。

**Obsidian 兼容**：文件是标准 Markdown + front-matter，可直接用 Obsidian 打开做图谱；`links`/`composedOf` 命中的 id 在面板详情页可点击跳转。

## 配置与迁移

- **settings 命名空间**：插件注册 `settingsNamespace('memory-manager')`，字段与默认值见 [docs/API.md#settings 配置 schema](docs/API.md)。`applies:'live'`，改动即时生效（`watch` 同步进内存 `cfg`）。
- **总开关 `enabled`**：`false` 时不注入、Agent 工具拒绝执行、HTTP API 仅放行 `state.get` / `state.setEnabled` / `diag.log`（供设置页重新开启）。
- **旧 `config.json` 自动迁移**：首次运行若默认记忆库（见下）下存在旧版 `config.json`，会将其中的 `mode/view/modelTools/libraryPath/memoryChars/totalChars/pinChars` 合并进 `base`，作为设置初始值，并写入 DSH settings（持久化）。
- **默认记忆库锚点**：`libraryPath` 为空时，依次尝试（`defaultLibraryPath()`）：
  1. `workspaceRegistry.list()` 的第一个工作区路径 → 追加 `.dsh-memory`
  2. `agents.roots[0]` / `agents.list[0]` 的会话 `cwd` → 追加 `.dsh-memory`
  3. 均不可得则返回 `null`（视为「记忆库未配置」）

  实测锚点为「工作区下一个 `.dsh-memory` 文件夹」。

## 注入机制

- **注入段**：注册 `systemPrompt.section({ name: 'memory-manager:context', order: 300, text })`。组装系统提示时，`text()` 按当前组装上下文的 agent id 取该会话计划并渲染内容；不加记忆则以空字符串跳过（不污染提示）。
- **按会话 plan**：仅渲染 `cfg.mode === 'on'` 或 `plan.injectOnce === true` 时激活。`injectOnce` 单次注入后自动置回 `false` 并持久化。
- **预算分配（字符上限）**：
  1. 先分配固定消息，上限 `min(pinChars, totalChars)`；每条 `[固定消息 ·role] <text>`，超长截断。
  2. 剩余预算给勾选记忆：每条上限 `memoryChars`，整体受 `totalChars` 约束。
  3. 预算归零时追加 `[记忆库上下文已截断]`。
- **紧凑视图**：`view === 'compact'` 时每条只注入 `标题「…」印象: … 预览: <300字>`，并追加提示（`modelTools` 开启时）「需要完整内容时可调用 memory_recall 读取」。
- **包裹格式**：整段以 `=== 记忆库上下文（用户指定，供参考；非当前对话的实时内容） ===` 开头、`=== 记忆库上下文结束 ===` 结尾。
- **注入顺序**：`order: 300` 决定了该段相对其他提示段的位置。

## 排除 / 恢复机制

- **排除（非破坏）**：`plan.excludeTurn(turn, exclude=true)` 在会话表面（surface）里，对被排除轮次的每个节点插入一条 `source.kind='plugin'`、plugin=`memory-manager` 的**标记消息**（文本 `[记忆管理] 该轮已被排除 | turn=<turnId>`，经 `surfaceOp:{op:'replace'}` 原地替换原节点），并把 turn 写入计划的 `excluded`。不删除任何数据，模型不消费该轮内容。
- **恢复**：`exclude=false` 根据标记消息的 `sourceEventSeqs` 找到原始事件，把原始节点重新写回表面，并从 `excluded` 移除。
- **依赖会话 surface**：排除 / 恢复需要**可写会话视图**（live session，`session.append`）；只读 surface（宿主模式只读会话）下返回提示「排除/恢复需要 live 会话（宿主模式暂不支持）」。排除「当前最新一轮」会被拒绝，避免把正在进行的对话排除掉。

## HTTP API 设计

- **端点**：`/_dsh/memory-manager/api`，由 `webServer` 服务注册（`ctx.inject(['webServer'], webCtx => webCtx.webServer.register({ kind:'exact', path, handler }))`）。
- **GET**：探测 —— `{ ok:true, service:'memory-manager', enabled }`。
- **POST**：请求体为 JSON 信封 `{ op, sessionId?, args? }`；响应统一为 `{ ok, value }`（业务错误时 `ok:false`，`value.error` 为错误说明），HTTP 400 为坏 JSON、405 为方法不支持、500 为服务器异常。请求体上限 256 KiB。
- **op 清单（共 23 个）**：完整参考见 [docs/API.md](docs/API.md)。按域名归类：`state.*`（7）、`library.*`（1）、`memory.*`（7）、`session.*`（3）、`plan.*`（4）、`diag.log`（1）。

## Client 插槽与面板结构

- **`conversation.input.left`**（order 10）：输入栏左侧「记忆」按钮，点击开关侧栏面板；显示当前模式「已开启/已关闭」；检测到上次崩溃则自动回落到计划页。
- **`shell.overlay`**（order 30）：右侧固定侧栏面板容器（560px、`--dsw-alias-*` 主题变量自适应深浅色）。
- **`settings.section`**（order 30，label「记忆管理」）：设置页区块，含总开关 / 注入与工具开关 / 记忆库路径 / 注入上限（三字符数输入）。
- **`conversation.chat.assistant-actions`**（order 15）：每条助手消息动作条新增「💾 保存为记忆」与「📌 固定 / 取消固定」两个图标按钮，直接在对话界面操作。

面板内部为模块级状态 `panel = { open, sessionId, tab, crashed }`，四个标签页：

| tab | 内容 |
|---|---|
| 计划 | 临时记忆模式开关、单次注入开关、注入视图开关、Agent 工具开关；固定消息 / 勾选记忆 / 已排除轮次列表管理 |
| 记忆库 | 按印象 / 标题 / id 搜索、多选组合、查看 / 编辑 / 加入计划 |
| 消息 | 轨迹风格轮次 + 步骤行；消息级勾选 → 保存为记忆 / 固定；轮次级排除 / 恢复 |
| 图谱 | 力导向 SVG（模拟 160 迭代），节点点击查看详情与相关记忆 |

## 错误边界 / 崩溃自愈

Client 采用「三级 Error Boundary + 自愈」策略，源自一次真实前端崩溃事故（直接函数调用组件导致 hooks 挂错链）的经验总结：

- 全部组件均以 `h(Component, props)` 调用（杜绝直接函数调用，保证 hooks 归位到组件自身 hook 链）。
- **三级边界**：`overlay-root`（面板最外层）→ `panel-root`（面板内容）→ 各 tab 与所有对话框。任一崩溃都不再整面板白屏，而是在面板内显示错误卡片 + 「重试 / 返回计划页」。
- **崩溃自愈**：边界 `onCrash` 置 `panel.crashed`；下次打开面板（或 `InputButton` 检测到 crash）自动把 tab 回落为 `plan` 并清除标志。
- **数据防御**：Panel `refresh` 用自增序号丢弃过期响应竞态；各 tab 渲染前对数据做空值防护。

## 日志链路

- **Host boot log**：启动即写 `appendFileSync` 到 `<DSH_MEMORY_LOG_DIR>/memory-manager-boot.log`（默认「用户主目录/.dsh/」，可用 `DSH_MEMORY_LOG_DIR` 重定向），记录 `apply()` / `install()` / settings 注册 / 路由注册 / 服务可见性探针 / 错误堆栈。
- **Client diag.log**：前端 `log()` 与 `window error / unhandledrejection` 全局捕获把客户端日志经 `diag.log` op POST 到 Host，Host 追加到 `<DSH_MEMORY_LOG_DIR>/memory-manager-client.log`（时间戳 + level + tag + msg + stack；错误 3s 节流去重，仅采集与插件相关堆栈）。日志本身失败绝不抛出。

这一「Host 落盘 + Client 上报」双链路使远程 / 生产排错不依赖浏览器开发者工具。

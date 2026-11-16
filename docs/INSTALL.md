# 安装指南（INSTALL）

本插件是 **宿主级（Host）插件**：以 **bundle** 形式挂载进某个 DSH profile 的层栈中，宿主启动时才会加载其 Host 半区（`lib/index.js`）与浏览器 Client 半区（`lib/client.js`）。profile 目录位于 DSH 主目录下：`$DSH_HOME/profiles/<profile>`（如 `web`）。

## 前置条件

- Node.js ≥ 22.19（DSH 0.2.x 要求 `^22.19.0 || >=24.0.0`）
- [pnpm](https://pnpm.io/zh/installation) —— `dsh plugin` 命令依赖 pnpm。未安装时先执行 `npm install -g pnpm`（或启用 corepack：`corepack enable`）
- DSH CLI：`npx @deepseek-ai/dsh`（或全局安装 `@deepseek-ai/dsh`），本插件面向 **0.2.1-rc.2**（同时兼容 0.2.0-rc.1 / 0.2.0-rc.2）

## 安装前自检（建议先跑一次）

```bash
node scripts/preflight.mjs "D:/deepseekagent/LatestVersion/deepseek-harness"
# 或：DSH_ROOT=<DSH 检出路径> npm run preflight
```

**36 项**检查，把「装上后不影响 DSH 本体」变成机械结论（下面是它的检查面，也是本插件的安全边界）。带上检出路径时，它会用 **DSH 自己的准入校验**（`packages/boot/app-boot` 的 `evaluatePluginCompatibility`）跑一遍，并打印对照到的运行版本（例如 `0.2.2-rc.3`）——与 DSH 装载 profile 时对每个 bundle 做的是同一段判定；还会验证「声明了 `engines.dsh` 后 peer 不再参与准入」这一 0.2.1 新规则，以及用 `vendor/include` 的 `parseEntryYaml + applyEntryPatches` 实机验证 `cordis.patch.yml` 能被内核挂载：

| 组 | 保证 | 检查项 |
|---|---|---|
| A 包自洽 | 装上去能跑，不会因为缺文件把宿主的客户端模块图整体搞坏 | `dsh.bundle.patch` 存在；`exports["."]` / `exports["./client"]` 指向的文件都存在；`files` 白名单覆盖这些文件；运行时依赖已声明；**未声明 `dsh.profile`**（永远不能充当或替换 profile 组合） |
| B 只增不改 | 只影响自己这一行，不动 profile 里的其它行 | bundle patch **只用 `insert`**（无 `remove` / `replace`）；插入行 `id: memory-manager` + `name` 等于本包名，不覆盖任何既有 id；未预设 `disabled`；**声明 `engines.dsh`（0.2.1+ 的首选兼容性声明，一旦声明即单独决定准入）**、非 `workspace:` 范围、上界排除未验证的 0.3.0；旧内核按 peer 判定时所有 DSH peer 仍为 optional |
| C 模块与 bundle 形状 | 插件自己的代码出问题，只让插件不可用 | 宿主模块可 import、`inject` 只声明核心服务（缺失即降级）；客户端 bundle 是标准的 `load({id, factory})` 单条顶层语句，工厂体整体包在 try/catch 内且预装惰性 `exports` —— **即使模块体抛错，也只会让这一个条目静默失效，不会中断同一批脚本里的其它插件包** |
| D 与检出对照 | 不占用、不遮蔽官方的东西，且能被当前版本接纳 | **DSH 权威准入校验放行**（`evaluatePluginCompatibility` 返回 undefined）；**内核确实按 `engines.dsh` 判定**（把 peer 改成不可满足后仍放行）；**`cordis.patch.yml` 经 DSH 自己的 `parseEntryYaml + applyEntryPatches` 实机插入成功**（能抓住官方改动 patch DSL）；`dsh.client.inject` 的每个包真实存在且声明 `dsh.client`；5 个目标插槽都是 **list 型**（只增不替换）且非 `shadows-shipped-ui`；我们的 entry id 未占用官方已注册 id；6 个模型工具名不与官方工具重名（对照 68 个已发布工具） |

> 不带检出路径时只跑 A/B/C（26 项）。退出码 0 = 通过。

## 方式一：Web 插件页（推荐，最省事）

1. 启动 DSH（`dsh web` 或你自构建的入口），打开侧栏 **插件 / Plugins** 页。
2. 在安装入口填入**绝对路径**（相对路径会被拒绝）：

   ```
   file:D:/dshTools/dsh-memory-manager
   ```

   或直接 `D:/dshTools/dsh-memory-manager`（安装器把绝对路径与 `file:` / `link:` 前缀都视为本地路径）。
3. 确认安装。安装器会：跑 pnpm 装入 profile → 校验包元信息 → 把本 bundle 追加到 profile 的 `dsh.profile.bundles` → **默认启用**。
4. 若当前 profile 打开了 HMR，配置变更即时生效；否则**重启 DSH**。
5. 浏览器**刷新页面**（客户端半区由 DSH 客户端模块系统按 `dsh.client` 声明自动发现，无需手动注册任何 client 包）。

> 卸载同样在插件页做「移除」：插件页走的是与 CLI 相同的包操作，会按顺序 **先把 bundle 从 `dsh.profile.bundles` 摘掉 → 卸载运行时贡献 → 再执行 pnpm remove**，不会留下悬空条目。

## 方式二：命令行

```bash
# Windows（本仓库位于 D:\dshTools\dsh-memory-manager）
dsh plugin --profile web add file:D:/dshTools/dsh-memory-manager

# WSL（Windows 盘挂载于 /mnt/d）
dsh plugin --profile web add file:/mnt/d/dshTools/dsh-memory-manager
```

`dsh plugin` 把参数转发给 profile 目录里的 pnpm，并在运行结束后**对账 `dsh.profile.bundles`**：新增的 bundle 会被追加，被移除的依赖会从列表里摘掉。安装后同样需要重启 DSH 并刷新页面。

**开发迭代推荐 `link:`**（改动即时生效，不必重装）：

```bash
dsh plugin --profile web add link:D:/dshTools/dsh-memory-manager
```

`file:` 会把包拷进依赖树（改代码需重新 `add`）；`link:` 直接软链到本仓库。

## 方式三：手动挂进 profile 层栈

插件通过包内 `cordis.patch.yml` 以 `insert` 方式挂载（也可以把这一段直接抄进 profile 自己的 `cordis.patch.yml`）：

```yaml
# dsh-memory-manager bundle patch: mounts the plugin into a profile layer stack.
- insert:
    - id: memory-manager
      name: '@dsh-external/dsh-memory-manager'
```

并把包名加进 profile `package.json` 的 `dsh.profile.bundles` 列表。

> **`id: memory-manager` 很重要**：0.2.0 的设置命名空间（`SettingsNamespace`）就是 profile 条目 id。插件从 `ctx.fiber.entry.options.id` 读取它作为 `ctx.settings.update()` 的第一个参数；把这一行改成别的 id 也能工作（插件会自动跟随），但文档与设置页里显示的命名空间会随之变化。

## 三档开关：不用卸载也能「完全安静」

| 档位 | 操作 | 效果 |
|---|---|---|
| **1. 业务软关闭** | 设置页「记忆管理 → 启用记忆管理」关掉（或面板上的总开关） | 不注入、Agent 工具拒绝执行、API 只保留状态查询。**插件仍在加载**，行/插槽/路由都还在 |
| **2. 行级禁用** | 插件页把该行 toggle 关掉（等价于在 profile 的 `cordis.patch.yml` 里给这一行加 `disabled: true`） | Host 半区不加载、Client 半区不注册 —— 等同于插件不存在，但依赖与数据都保留，随时可再打开。**无需重启即可在 HMR profile 生效；非 HMR profile 需重启** |
| **3. 卸载** | 插件页「移除」或 `dsh plugin --profile web remove @dsh-external/dsh-memory-manager` | 从 bundles 列表摘除 → 卸载运行时贡献 → pnpm remove。**记忆库数据不在 DSH 里，不会被删除**（见下） |

### 卸载后残留什么？

只有你自己的**记忆库目录**（默认锚定到工作区下的 `.dsh-memory`，或你在设置里指定的绝对路径），以及一份启动日志：

- `<DSH_HOME>/memory-manager-boot.log`（Host 启动链路）
- `<DSH_HOME>/memory-manager-client.log`（前端日志）

两者都可以随时删除。DSH 自身的会话、设置、profile 配置不会被插件改写。

## 安装后验证清单

1. **Host 起来了**：`GET /_dsh/memory-manager/api` 应返回
   ```json
   { "ok": true, "service": "memory-manager", "enabled": true }
   ```
   404 / 405 说明 Host 路由没注册（未挂载成功或没重启）。
2. **启动日志**：`<DSH_HOME>/memory-manager-boot.log` 里应有
   `apply() called` → `install() begin dsh>=0.2 (volatile Config)` → `config snapshot: {...}` → `settings service: ok ns=memory-manager` → `http route registered (webServer)` → `install() complete`。
   若出现 `schemastery: 不可用`，说明 `@deepseek-ai/schemastery` 没解析到：插件其余能力正常，但没有设置页（见常见问题）。
3. **设置页**：DSH 设置页出现「记忆管理」区块（`settings.section` 插槽）。
4. **输入栏**：对话输入栏左侧出现「记忆 · 已关闭」按钮（`conversation.input.left` 插槽），点开是右侧面板。
5. **图谱**：面板头部「图谱」按钮打开左侧力导向图谱浮层。
6. **Agent 工具**：模型侧应能看到 `memory_search` / `memory_recall` / `memory_save` / `memory_set_enabled` / `session_inject` / `memory_pin` 六个工具。

## 回滚 / 出问题怎么办

| 症状 | 处理 |
|---|---|
| 页面白屏或插件区域报错 | 先按「档位 2」把该行 `disabled: true`。插件页进不去时，直接编辑 `$DSH_HOME/profiles/<profile>/cordis.patch.yml`，在 `- id: memory-manager` 那一行下加 `disabled: true`，重启 DSH。本项目**不注册任何单例插槽 / 不覆盖任何官方条目**，因此即使客户端半区完全失效，也只会少一个插件，用户界面其余部分不受影响 |
| 浏览器控制台出现 `client bundle factory failed; plugin disabled` | 这是最终兜底：模块体抛错时插件静默失效而不影响宿主页面。把该行禁用后提 issue，并附上控制台堆栈 |
| 模块图报错含 `@dsh-external/dsh-memory-manager` | 包没装完整（例如安装中断）。按「方式一/二」重新 add；必要时先 `remove` 再 `add` |
| `incompatible-version` 被拒 | 插件声明的 DSH peer 与运行版本不匹配。确认插件版本与 DSH 版本，或用 `dsh plugin --profile web allow-version <pkg>@<ver> --dsh-version <runtime> --accept-risk` 临时放行（会打印风险提示） |
| 改了设置没生效 | 设置写入 profile 的 `cordis.patch.yml`：HMR profile 即时生效，启动型 profile 需重启。日志里 `settings.update unavailable — 配置仅作用于本进程` 表示当前组合没有 `ctx.settings` 服务 |
| 升级后旧设置丢了 | 0.1.x 的 `mode` / `view` / `caps` 等写在记忆库目录的 `config.json` 里，0.5.0 首次启动会一次性导入 profile 设置并在记忆库 `pinned/.config-imported` 落标记（幂等）。文件已删或标记已存在时，到设置页重设即可 |

## 常见问题

- **`cannot resolve profile bundle "@dsh-external/dsh-memory-manager"`**：profile 里只有 bundles 声明、依赖没装进去（安装过程被中断）。重新 `add` 即可。
- **`Cannot find package '@deepseek-ai/schemastery'`**：0.5.0 起它是插件的运行时依赖，`add` 会自动带上。从 0.4.x 升级后出现时，执行 `dsh plugin --profile web install` 刷新依赖树。
- **peer 依赖警告（"Issues with peer dependencies found"）**：提示性警告；`@deepseek-ai/dsh-tools` 标记为可选 peer，其余 DSH 包由宿主提供，无需处理。
- **`dsh: pnpm not found on PATH`**：先安装 pnpm（见前置条件），再重试。
- **`dsh: a local path must be absolute`**：安装 spec 必须用绝对路径（或 `file:` / `link:` + 绝对路径），相对路径会被拒绝。
- **工具不可用（`记忆管理已禁用`）**：`enabled` 为 `false`，到设置页打开；或 `modelTools` 为 `false`。
- **记忆库为空**：`libraryPath` 未指向含 `memories/*.md` 的目录。到「设置 → 记忆管理 → 记忆库」看那一行诊断：**当前生效路径 · 条数 · 手动/自动**。
  - 0.5.2 起自动锚点会**优先选择已有记忆的候选库**（不再盲取工作区列表第一个），所以「新增工作区后记忆消失」这类漂移已修复。
  - 若路径显示为「自动锚点」但目录不存在，点「恢复自动锚点」重新解析；仍不对就手动填绝对路径（可直接粘贴工作区根目录，或 `.dsh-memory` 目录本身）。
  - 也可用仓库里的 `examples/memory-library/` 快速体验。

## 版本兼容

面向 **DSH 0.2.2-rc.3**（当前最新，检出实为 tag 之后 608 个提交的 master），并在 0.2.1-rc.4 / 0.2.1-rc.2 / 0.2.0-rc 系列上复验过；同时保留 **0.1.2-rc.1 → 0.2.2** 的降级兼容（客户端会话导航、Chat 数据、消息来源标识、`SurfaceOp` 字段名都有双路径适配，逐条见 [ARCHITECTURE.md「与 DSH 的集成面」](ARCHITECTURE.md#与-dsh-的集成面适配层)）。

**准入规则（0.2.1 起有变化）**：

- **0.2.1+**：插件 `package.json` 的 `engines.dsh` **一旦声明就单独决定准入**，`peerDependencies` 被内核忽略。本插件声明 `engines.dsh: ">=0.1.2-rc.1 <0.3.0"`（覆盖 0.2.1 全系与 0.2.2-rc.3）。
- **0.2.0 及更早**：内核只看 `@deepseek-ai/dsh*` peer。本插件只声明可选的 `@deepseek-ai/dsh-tools`（`>=0.1.0 <0.3.0`）。
- 两条都声明 → 新旧内核行为一致；不满足时**只会拒绝本 bundle**，不会影响同一 profile 里的其它插件。
- 可用 `node scripts/preflight.mjs <检出>` 自带确认（它会调用 DSH 自己的 `evaluatePluginCompatibility`）。

### 0.2.2 的破坏式变更（0.5.4 起已适配）

**唯一影响插件作者的一处：cordis 4.1.0 改了 `fiber.config` 的语义。**

- 4.0.x：`fiber.config` 就是**解析后**的配置（含 `~standard.validate` 产出的 volatile 引用）。
- 4.1.0：`fiber.config` 变成**原始输入**，解析结果移到 **`fiber.effectiveConfig`**；内核自己的 volatile 提交也同步改为 `volatileEntries(fiber.effectiveConfig)`（`vendor/loader/src/config/entry.ts`）。
- 影响面：**直接读 `fiber.config` 的代码会拿到未经校验的原始值**（通常是 `{}` 或写死的 patch），volatile 引用一个都取不到；表现为「配置读出来全是默认值 / 设置改不动」。
- 本插件**不读** `fiber.config`（只用 `apply(ctx, config)` 的入参，内核传的就是解析结果），所以业务代码零改动；只有 `tests/test-cordis-020.mjs` 里的断言需要跟着改（现在用 `fiber.effectiveConfig ?? fiber.config` 双向兼容）。
- `ctx.fiber.entry` 仍然可用（由 `vendor/loader` 的声明合并提供），因此设置命名空间仍取 profile 条目 id。

**其余 0.2.2 变更与本插件无关或为纯增量**：

- 版本连带升级：cordis 4.0.5→**4.1.0**、loader 1.0.6→**1.1.0**、include 重写（新增 `patch.ts` / `journal.ts`）、schemastery 3.18.5→**3.19.0**、cosmokit 1.8.6→**1.9.0**。
- `dsh.bundle` 清单新增可选 `platforms`（声明后按 `process.platform` 准入，省略=全平台）与 `listedByDefault`（省略=true）。本插件两者都不声明，行为不变。
- `dsh.client` 清单仍是 `{ platform, inject?, immediately?, external? }`；`ClientBundleRegistration` = `DshClientModuleManifest { id, chunk?, factory, meta? }`，我们的 `load({ id, factory })` 仍然合法；`react` 仍在平台 seed 模块表里（新增 `zod`、`@tanstack/react-virtual`、`ui-dockkit`）。
- 未变：`SESSION_FORMAT_VERSION` 仍为 **4**、`SurfaceOp` 替换规则、`defineTool` / `ctx.tools.register`、`agent/pre-step` 与 `agent/created`、`Agent.inject/steer`、`WebRoute` 与 `webServer.register`、`ctx.settings.update`、`GenerateOptions`（含 `maxTokens`）、`sessionQuery.readSurface/readTitle/readSession/listSessions`、`workspaceRegistry.list`、`ChatSnapshot`、`data-chat-node-key` / `data-chat-anchor-key` 锚点、`openSession` / `selectPanel`、5 个目标插槽、`settings.section` 仍由 `ui-settings-general` 声明。
- **共享 RPC 通道 `/api` 归官方 gateway 独占**：`packages/api/gateway` 会调用 `connection.rpc.intercept('/api', …)`，而 `rpc-host.ts` 对同一通道的第二个 interceptor 直接抛 `shared RPC channel "/api" already has an interceptor`。本插件的「标准通道」因此在 0.2.2+ 会被跳过（启动日志写明「`/api` 已归官方 gateway 所有，仅使用专属路由，无需处理」），主通道 `/_dsh/memory-manager/api` 不受影响，客户端也只用它。
- 工具目录仍是 68 个已发布工具，无重名。

> **本地检出说明**：`D:\deepseekagent\LatestVersion\deepseek-harness` 的 `package.json` 版本是 `0.2.2-rc.3`，但 `git describe` 显示它领先 `dsh-v0.2.2-rc.3` 标签 **608 个提交**（即 master）。上述结论是对 HEAD 做的，因此同时覆盖 rc.3 与之后的 master。

### 0.2.1-rc.3 / rc.4 的注意

- **rc.3 新增的「更多」菜单是纯增量**：新增根作用域插槽 `conversation.session.header.views.actions`（View 标签行的 More 菜单）、`sidebar.panellist.actions`、`sidebar.right.tab.guide.actions`。本插件不占用它们，`conversation.session.header.actions` 仍渲染在 `ConversationSession.tsx` 头部（View 行与 utilities 之间），`conversation.input.left` 仍渲染在 `InputBar.tsx`。
- **rc.3 的草稿修复只动客户端输入层**：`ui-conversation` 的 `contract/input.ts` 新增 `whenDraftExists: 'replace' | 'append' | 'keep'`，`ui-workspace` 的 `openSession()` **签名未变**（`openSession(target: SessionTarget): void`），内部改为按草稿策略复用空白会话。本插件只传会话 id，不受影响。
- **rc.4 的 ACP 诊断修复在 CLI/宿主层**，与插件集成面无关；其余集成点（`core/{session,tools,agent,agent-loop}`、`settings`、`host/webserver`、`llm`、`client/{ui-slots,modules,web,connection}`、`session-query`、`workspace`）两版之间**无源码变更**。
- **0.2.2 已适配**：见上「0.2.2 的破坏式变更」；cordis 4.1 的 `fiber.config` 语义变化不会影响本插件。

### 0.2.1-rc.2 的三点注意

- **`engines.dsh` 优先于 peer**（见上）。这是 0.2.1 唯一一处需要插件作者主动跟进的声明变更，官方更新记录明确写了「插件作者需检查声明是否覆盖支持的 DSH 版本」。
- **`runtime-context` 成为保留的上下文 kind**：循环会在 append 前把该 kind 的消息替换成瀑布之后重新投影的运行时上下文。插件注入必须用自己的 kind（本插件用 `memory-manager`），否则会被静默吞掉。`lib/util.js` 里有静态断言防止复用。
- **其余集成面未变**：`packages/core/session/src/surface.ts` 只改注释（`SurfaceOp` 替换规则、`sourceEventSeqs` 覆盖要求、`tool/result` 只能改 `content` 全部照旧）；`defineTool` 只改注释；`agent/pre-step` / `agent/created` 的声明只改文档链接；`webserver` 只新增 TLS 监听（`register({kind,path,handler})` 不变）；`ui-slots` 只新增可选 `inline`；客户端 seed word 新增 `zod` 与 `@tanstack/react-virtual`（`react` 仍在）；会话格式仍是 **v4**；`tool-session-query` 整包被删除，但本插件不使用它。
- **`desktop` 是保留 profile**（0.2.0-rc.2 起）：`dsh plugin --profile desktop …` 要求该 profile 已被应用初始化（先打开一次 DeepSeek Harness Desktop 并完全退出），否则会提示 `Open DeepSeek Harness Desktop once to initialize its profile`。装到 Web 的 `web` profile 不受影响。

# 安装指南（INSTALL）

本插件是 **宿主级（Host）插件**：以 **bundle** 形式挂载进某个 DSH profile 的层栈中，宿主启动时才会加载其 Host 半区（`lib/index.js`）与浏览器 Client 半区（`lib/client.js`）。profile 目录位于 DSH 主目录下：`~/.dsh/profiles/<profile>`（如 `web`）。

## 前置条件

- Node.js ≥ 18（推荐 22+，与 DSH 一致）
- [pnpm](https://pnpm.io/zh/installation) —— `dsh plugin` 命令依赖 pnpm。未安装时先执行 `npm install -g pnpm`（或启用 corepack：`corepack enable`）
- DSH CLI：`npx @deepseek-ai/dsh`（或全局安装 `@deepseek-ai/dsh`）

## 快速安装（推荐）

在 DSH 所在环境执行（`<profile>` 换成目标 profile 名，通常为 `web`）：

```bash
# Windows（本仓库位于 D:\dshTools\dsh-memory-manager）
dsh plugin --profile web add file:D:/dshTools/dsh-memory-manager

# WSL（Windows 盘挂载于 /mnt/d）
dsh plugin --profile web add file:/mnt/d/dshTools/dsh-memory-manager
```

该命令等价于：在 profile 目录执行 `pnpm add file:<路径>`（写入 `dependencies`、安装依赖），再按安装结果对账 `dsh.profile.bundles` 层列表。插件通过包内 `cordis.patch.yml` 以 `insert` 方式挂载进 profile 层栈：

```yaml
# dsh-memory-manager bundle patch: mounts the plugin into a profile layer stack.
- insert:
    - id: memory-manager
      name: '@dsh-external/dsh-memory-manager'
```

> **依赖说明**：`schemastery` 是插件的**运行时依赖**（v0.3.1 起），会随插件自动安装，无需手动补装；`@deepseek-ai/dsh-*`、`react`、`cordis` 由 DSH 宿主提供，插件不重复安装。

安装完成后 **重启 DSH**（`dsh web`）即可生效。

## 更新

`file:` 目录依赖下，插件代码改动**即时生效**（下次启动 DSH 即使用新代码）。仅当插件的 `package.json` 依赖声明发生变化时，需要在 profile 目录刷新锁文件：

```bash
dsh plugin --profile web install
```

## 卸载

```bash
dsh plugin --profile web remove @dsh-external/dsh-memory-manager
```

## 验证

### Host API 探测

在浏览器或命令行请求：

```
GET /_dsh/memory-manager/api
```

应返回 JSON：

```json
{ "ok": true, "service": "memory-manager", "enabled": true }
```

`service` 必须为 `memory-manager` 且 `ok` 为 `true`。返回 404 / 405 / 空响应，说明 Host 路由未注册（未挂载成功或未重启）。

### 浏览器 UI

- 打开任意对话，输入栏左侧应出现「记忆 · 已关闭」按钮（`conversation.input.left` 插槽），点击可打开侧栏面板。
- 进入 DSH 设置页，应出现「记忆管理」区块（`settings.section` 插槽），含「启用记忆管理」总开关及注入 / 工具 / 记忆库 / 注入上限等配置。

## 日志与诊断

Host 在启动与运行时会写诊断日志，默认落在 **DSH 主目录**下（跨平台），可用环境变量 **`DSH_HOME`** 重定向（未设置时为 `~/.dsh`）：

| 文件 | 内容 |
|---|---|
| `$DSH_HOME/memory-manager-boot.log` | Host 启动 / 注册链路（apply → settings registered → route registered），含服务可见性诊断与错误堆栈 |
| `$DSH_HOME/memory-manager-client.log` | 浏览器前端日志（经 `diag.log` op 上报到 Host 落盘），含时间戳 + level + tag + msg + stack |

启动后可用 `apply() called` / `install() begin` / `route registered` 等行确认插件正常挂载；若某段缺失，结合 `service probe` 诊断块排查对应服务是否在宿主根可见。

## 常见问题

- **`cannot resolve profile bundle "@dsh-external/dsh-memory-manager"`**：插件未真正安装（profile 配置里只有 bundles 声明、依赖没装进去——例如安装过程被中断）。执行「快速安装」的 `add` 命令补装即可；不需要插件时用 `remove` 移除。
- **`Cannot find package 'schemastery'`**：v0.3.1 之前的已知问题（schemastery 仅声明为 peer）。升级到 v0.3.1+ 后执行 `dsh plugin --profile web install` 会自动带上；或临时在 profile 手动补装 `dsh plugin --profile web add schemastery`。
- **peer 依赖警告（"Issues with peer dependencies found"）**：提示性警告，v0.3.1+ 已消除（peer 全部标记 optional）。`@deepseek-ai/dsh-*` 等由 DSH 提供，无需处理。
- **`dsh: pnpm not found on PATH`**：先安装 pnpm（见前置条件），再重试。
- **GET 返回 404 / `method not allowed`**：Host 未加载或 webServer 路由未注册。确认 bundle 已登记并已重启 DSH。
- **GET 返回但面板不显示**：确认浏览器已刷新；Client 半区尚未注入插槽。
- **工具不可用（`记忆管理已禁用`）**：`enabled` 为 `false`，到设置页打开；或 `modelTools` 为 `false`。
- **记忆库为空**：`libraryPath` 未指向含 `memories/*.md` 的目录。可用 `examples/memory-library/` 快速体验，或在面板设置实际路径。

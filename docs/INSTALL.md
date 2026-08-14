# 安装指南

本插件是 **宿主级（Host）插件**：需要把它作为 bundle 挂载进某个 DSH profile 的层栈中，宿主启动时才会加载其 Host 半区（`lib/index.js`）与浏览器 Client 半区（`lib/client.js`）。

下文以 `<profile>` 指代具体的 DSH profile 目录（例如位于「DSH 部署目录」下的 `profiles/web`）；所有路径请替换为你实际环境。

## 1. 把包放入 profile 的 node_modules

把本包（或其构建产物）整体放进 profile 的依赖目录：

```
<profile>/node_modules/@dsh-external/dsh-memory-manager/
├── lib/
│   ├── index.js      # Host 半区（ESM）
│   └── client.js     # Client 半区（浏览器 bundle）
├── cordis.patch.yml  # DSH 挂载补丁
├── package.json
└── ...
```

> 也可通过 npm 方式安装（`npm install --save @dsh-external/dsh-memory-manager`），效果相同。包名为 `@dsh-external/dsh-memory-manager`，入口 `lib/index.js`。

## 2. 在 profile 的 package.json 中登记 bundle

在 profile 的 `package.json` 中声明 `dsh.profile.bundles`，把本包加进去：

```jsonc
{
  "dsh": {
    "profile": {
      "bundles": [
        // ... 其他 bundle
        "@dsh-external/dsh-memory-manager"
      ]
    }
  }
}
```

> 具体字段名以你所用 DSH 版本的 profile 结构为准（README 与 `package.json` 中 `dsh.bundle` 字段描述）。登记后，DSH 会读取包内 `cordis.patch.yml` 完成占位。

### `cordis.patch.yml` 说明

包内随附的 `cordis.patch.yml` 内容如下：

```yaml
# dsh-memory-manager bundle patch: mounts the plugin into a profile layer stack.
- insert:
    - id: memory-manager
      name: '@dsh-external/dsh-memory-manager'
```

它向 profile 的 Cordis 层栈插入一个 id 为 `memory-manager` 的插件行（`name` 指向本包）。DSH 在装配 bundle 时会应用该补丁，从而在宿主运行时注册这个插件。

**注意**：`cordis.patch.yml` 属于构建/挂载产物的一部分，与 `lib/`、`docs/`、`examples/` 一同随包发布（见 `package.json` 的 `files` 字段）。请勿改动其 `id`；若与他人安装的同版本冲突，请改用不同 profile / 命名空间。

## 3. 重启 DSH

重新启动 DSH（或重启你使用的 profile 应用）。宿主插件是模块级注册：重启后 Host 半区才会应用、HTTP 路由才会注册；Client 半区（浏览器 bundle）修复后**刷新页面即生效**，但 `diag.log` 之类依赖新 Host 的能力需重启后可用。

## 4. 验证

### 4.1 Host API 探测

在浏览器或命令行请求：

```
GET /_dsh/memory-manager/api
```

应返回 JSON：

```json
{ "ok": true, "service": "memory-manager", "enabled": true }
```

`service` 必须为 `memory-manager` 且 `ok` 为 `true`。返回 404 / 405 / 空响应，说明 Host 路由未注册（未挂载成功或未重启）。

### 4.2 浏览器输入栏出现「记忆」按钮

打开任意对话，输入栏左侧应出现「记忆 · 已关闭」按钮（`conversation.input.left` 插槽）。点击可打开侧栏面板。

### 4.3 设置页出现「记忆管理」

进入 DSH 设置页，应出现「记忆管理」区块（`settings.section` 插槽），其中含「启用记忆管理」总开关及注入 / 工具 / 记忆库 / 注入上限等配置。

## 日志与诊断

Host 在启动与运行时会写诊断日志；默认落在「用户主目录」下，**可用环境变量 `DSH_MEMORY_LOG_DIR` 重定向目录**：

| 文件 | 内容 |
|---|---|
| `<DSH_MEMORY_LOG_DIR>/memory-manager-boot.log` | Host 启动 / 注册链路（apply → settings registered → route registered），含服务可见性诊断与错误堆栈 |
| `<DSH_MEMORY_LOG_DIR>/memory-manager-client.log` | 浏览器前端日志（经 `diag.log` op 上报到 Host 落盘），含时间戳 + level + tag + msg + stack |

默认（未设置 `DSH_MEMORY_LOG_DIR`）日志落在 **`用户主目录/.dsh/`** 下。启动后可用 `apply() called` / `install() begin` / `route registered` 等行确认插件正常挂载；若某段缺失，结合 `service probe` 诊断块排查对应服务是否在宿主根可见。

## 常见问题

- **GET 返回 404 / `method not allowed`**：Host 未加载或 webServer 路由未注册。确认 bundle 已登记并已重启 DSH。
- **GET 返回但面板不显示**：确认浏览器已刷新；Client 半区尚未注入插槽。
- **工具不可用（`记忆管理已禁用`）**：`enabled` 为 `false`，到设置页打开；或 `modelTools` 为 `false`。
- **记忆库为空**：`libraryPath` 未指向含 `memories/*.md` 的目录。可用 `examples/memory-library/` 快速体验，或在面板设置实际路径。

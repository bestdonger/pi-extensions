# GPT Fast Mode

用 `/fast` 切换 GPT 的优先处理档位，不改变模型或思考等级。无额外运行依赖，已在 **Pi 1.5.1** 验证。

## 安装

从 GitHub 安装仓库根包，会同时加载 Fast Mode 和其他插件：

```sh
pi install git:github.com/bestdonger/pi-extensions
```

已安装根包时使用 `pi update git:github.com/bestdonger/pi-extensions`。随后在 Pi 中执行 `/reload` 或重新开启会话。

只加载 Fast Mode 时，在个人 `settings.json` 的 `packages` 中使用资源过滤：

```json
{
  "source": "git:github.com/bestdonger/pi-extensions",
  "extensions": ["packages/fast-mode/src/index.ts"]
}
```

本地开发可单独加载当前插件：

```sh
pi install /absolute/path/pi-extensions/packages/fast-mode
```

不要同时加载本地副本和 GitHub 根包中的 Fast Mode。若已安装本地开发包，GitHub 根包应使用 `"extensions": ["!packages/fast-mode/src/index.ts"]` 排除此插件。迁移前通过 `~/.pi/agent/extensions/fast-mode/` 加载的独立副本，也需先移出自动发现目录，避免重复注册 `/fast`。

## 使用

| 命令 | 作用 |
| --- | --- |
| `/fast` | 切换开启/关闭 |
| `/fast on` | 开启 |
| `/fast off` | 关闭 |
| `/fast status` | 查看当前状态，不切换 |

- 状态栏显示 `fast: on` / `fast: off`。
- 新会话默认关闭；开关保存在当前会话分支，支持恢复会话、重新加载和树导航。
- 对 GPT 模型的 `openai-responses`、`openai-codex-responses`、`openai-completions` 请求生效，包括使用这些协议的兼容网关。
- 开启发送 `service_tier: "priority"`，关闭显式发送 `service_tier: "default"`。此扩展接管适用请求的 `service_tier`，会覆盖 `models.json` 中的该字段，但不修改配置文件。
- 不修改模型、思考等级、工具或上下文。
- 切换到其他模型不改请求；开启状态显示为 `fast: on (GPT only)`，切回适用的 GPT 模型后继续生效。
- 切换只影响下一次发出的请求，不改变已经发送的请求。

插件使用本机 Pi 的模型费率和服务档位倍率修正费用估算，包括 Codex 默认档位回显、Chat Completions 的 chunk 档位，以及 Responses 缺失档位时的请求值回退。普通流式请求和后台缓存预热都适用，不会把已有 Priority 费用重复翻倍，也不覆盖上游实报的费用。该估算不等同于上游实际账单。

计费包装只作用于 provider 的请求流方法，不重新注册 provider，不改变原认证、模型级路由头或模型配置；退出或重新加载插件时恢复原方法。

Priority 的支持情况、实际速度、费用和订阅额度消耗由上游决定。开启后可能消耗更多费用或额度。插件状态表示请求的档位，不表示上游已确认使用 Priority。

## 测试

使用支持 `registerHooks` 和直接运行 TypeScript 的 Node.js（至少 22.19；本机使用 Node 26 验证）。测试通过 `PI_PACKAGE_ROOT` 定位已安装的 Pi，默认使用 Homebrew 安装路径；不额外安装或打包宿主依赖：

```sh
cd packages/fast-mode
npm test
```

仓库根包的加载测试：

```sh
npm run test:package
```

测试使用内存上下文和本机 Pi 加载器，不调用真实模型 API，不消耗模型费用。自动化测试不替代真实上游对 Priority 的支持验证。

## 停用

GitHub 根包中可通过 `pi config` 停用 Fast Mode，或使用资源过滤 `"extensions": ["!packages/fast-mode/src/index.ts"]`。本地单独安装时，执行 `pi remove /absolute/path/pi-extensions/packages/fast-mode`。然后在 Pi 中执行 `/reload`。

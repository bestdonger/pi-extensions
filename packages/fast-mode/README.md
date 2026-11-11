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
| `/fast status` | 查看开关、最近请求档位与上游回显，不切换 |

- 状态栏显示 `fast:on` / `fast:off`，不加空格。
- 开关保存为全局配置，跨项目、新会话、恢复会话和重启沿用；未配置时默认关闭。树导航不改变开关，不再读写会话分支中的旧开关记录。
- 对 GPT 模型的 `openai-responses`、`openai-codex-responses`、`openai-completions` 请求生效，包括使用这些协议的兼容网关。
- 开启发送 `service_tier: "priority"`，关闭显式发送 `service_tier: "default"`。此扩展接管适用请求的 `service_tier`，会覆盖 `models.json` 中的该字段，但不修改配置文件。
- 不修改模型、思考等级、工具或上下文。
- 切换到其他模型不改请求；开启状态显示为 `fast:on(GPT-only)`，切回适用的 GPT 模型后继续生效。
- 切换只影响下一次发出的请求，不改变已经发送的请求。

插件使用本机 Pi 的模型费率和服务档位倍率修正费用估算，包括旧版 Codex 和新版 OpenAI ChatGPT OAuth 的默认档位回显、Chat Completions 的 chunk 档位，以及 Responses 缺失档位时的请求值回退。订阅链路回显 `default` 或缺失时按请求档位估算；API key 与兼容网关仍优先采用上游回显，不能把明确的标准档位算成 Priority。普通流式请求和后台缓存预热都适用，不会重复翻倍，也不覆盖上游实报的费用。估算不等于实际账单、订阅额度消耗或已确认的处理档位。

计费包装只作用于 provider 的请求流方法，不重新注册 provider，不改变原认证、模型级路由头或模型配置；退出或重新加载插件时恢复原方法。

Priority 的支持情况、实际速度、费用和订阅额度消耗由上游决定。开启后可能消耗更多费用或额度。插件状态表示请求的档位，不表示上游已确认使用 Priority。

## 全局配置

`/fast`、`/fast on` 和 `/fast off` 保存到 `~/.pi/agent/fast-mode.json`，不修改 Pi 的 `settings.json`：

```json
{
  "enabled": true
}
```

设置 `PI_CODING_AGENT_DIR` 时，配置文件位于该目录下。没有项目级覆盖。已打开的其他会话会在下一次请求（含缓存预热）、执行 `/fast` 命令、切换模型或树导航时读取最新配置；不改变已经发送的请求。

升级前的会话开关不会自动迁移或覆盖全局配置。需要保持开启时，升级后执行一次 `/fast on`。

## 如何验证

`fast:on` 表示插件请求 Priority，不是服务端确认。`/fast status` 分开显示请求档位、原始上游回显及其解释，只保留当前加载周期内该模型最近一次请求的观测（含缓存预热）；重载和切换会话分支后清空。不记录凭据、提示词或原始响应。

OpenAI 已说明，[ChatGPT 认证的 Codex 模式](https://github.com/openai/codex/issues/14204#issuecomment-4033184620)由服务端路由处理 Fast，最终 `service_tier: "default"` 不能证明 Fast 被忽略。这个说明针对订阅链路，不应套用到普通 API key 请求。

2026-11-11 在新版 OpenAI ChatGPT OAuth 的公共 Responses 端点实测：账号模型目录为 `gpt-6.1-sol` 列出 `priority`，线上请求确实发送 `priority`，完成响应回显 `default`；改发原始 `fast` 则返回 HTTP 400 `Unsupported service_tier: fast`。因此保留 `priority`，不将该订阅回显或本机费用估算当作降级证据；也不宣称已确认实际加速。接口返回 HTTP 200 仅证明请求成功。

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

测试使用临时配置目录、内存上下文和本机 Pi 加载器，不调用真实模型 API，不消耗模型费用。自动化测试不替代真实上游对 Priority 的支持验证。

## 停用

GitHub 根包中可通过 `pi config` 停用 Fast Mode，或使用资源过滤 `"extensions": ["!packages/fast-mode/src/index.ts"]`。本地单独安装时，执行 `pi remove /absolute/path/pi-extensions/packages/fast-mode`。然后在 Pi 中执行 `/reload`。

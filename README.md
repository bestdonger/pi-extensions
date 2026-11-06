# Pi Extensions

为 Pi 定制的终端交互插件：结构化问答，以及更紧凑的思考与工具活动摘要。

## 插件

### Ask User Question

让模型在需要决策时直接提问，而不是猜测你的意图。

- 单次最多 **10 个问题**，每题 2–4 个选项，支持单选、多选和自由输入。
- 支持选项预览，用于对比代码、配置和界面草图。
- 多个问卷串行展示，支持取消与焦点等待，避免对话框互相抢占。
- 接入 Pi 的等待状态，由 Rex 处理原生通知，不另外发送桌面通知。

包名：`@bestdonger/pi-ask-user-question` · 版本：**0.1.0**

[使用说明](packages/ask-user-question/README.md)

### Activity Summary

在 **regular TUI** 中，将连续的 thinking 和工具调用折叠为活动摘要，正文仍立即流式显示。

```text
▸ 检查配置 | 10 steps | tools 7 (ok 5, err 1, open 1)
```

- `steps` 统计非空 thinking 块与顶层工具调用；工具分别统计成功、失败和未完成数量。
- 使用当前 Pi 主题的状态背景，摘要上下留白，不增加动画。
- 通过原生 **Ctrl+O** 全局展开或收起，保留工具和 Markdown 的原生渲染。
- 自动更新保护离屏历史，支持会话恢复，不改写原始消息或模型上下文。
- 不依赖 `pi-libtui`，不接管鼠标或切换到 fullscreen。

包名：`pi-activity-summary` · 版本：**0.1.0**

[使用说明](packages/activity-summary/README.md)

## 安装

当前通过本地源码加载，**尚未发布 npm 包**。已验证环境为 Pi **1.5.0**；Activity Summary 依赖该版本的内部布局，升级 Pi 后需重新验证。

```sh
git clone https://github.com/bestdonger/pi-extensions.git ~/Projects/pi-extensions
cd ~/Projects/pi-extensions/packages/ask-user-question
npm install --no-save --package-lock=false --legacy-peer-deps --ignore-scripts @juicesharp/rpiv-config@2.15.0
```

将需要的插件路径加入 `~/.pi/agent/settings.json` 的 `packages`，保留已有的其他配置。下面的 `/absolute/path` 请替换为实际绝对路径：

```json
{
  "packages": [
    "/absolute/path/pi-extensions/packages/ask-user-question",
    "/absolute/path/pi-extensions/packages/activity-summary"
  ]
}
```

执行 `/reload` 或重开 Pi。Activity Summary 需使用 regular 模式，且不应与其他 transcript 投影插件同时启用。只想保留安装而暂不启用时，可将对应条目写为：

```json
{
  "source": "/absolute/path/pi-extensions/packages/activity-summary",
  "extensions": []
}
```

## 开发

每个插件独立管理版本、依赖和测试，共用此 Git 仓库。源码修改后执行 `/reload`；Pi 的包更新不会覆盖本地路径包。

```sh
(cd packages/ask-user-question && npm test)
(cd packages/activity-summary && bun test)
```

测试需要支持直接运行 TypeScript 的 Node.js 和 Bun。Ask 集成测试通过 `PI_PACKAGE_ROOT` 指定宿主位置，默认使用 Homebrew 的 Pi 安装路径；Activity Summary 测试需将宿主模块链接到其 `node_modules`，详见插件文档。部分测试仍有本机路径假设，不是开箱即用的跨平台 CI。

`node_modules` 不入库，不将第二份 Pi 宿主打包进插件。功能改动、依赖升级与上游同步均手动评估；不自动发布。

## 来源与致谢

- **Ask User Question**：基于 [juicesharp/rpiv-mono / rpiv-ask-user-question](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-ask-user-question) 2.15.0 定制，保留原作者信息与 [MIT 许可证](packages/ask-user-question/LICENSE)。
- **Activity Summary**：参考 [luan/agents / pi-collapse-transcript](https://github.com/luan/agents/tree/main/harnesses/pi/agent/packages/pi-collapse-transcript) 的交互思路，为 regular TUI 独立实现。

# Ask User Question

`@bestdonger/pi-ask-user-question` · **0.1.0**

为 Pi 提供 `ask_user_question` 工具，以结构化问卷收集用户决策。

## 功能

- 每次 1–10 个问题，每题 2–4 个选项。
- 单选、多选、自由输入；单选支持 Markdown 选项预览。
- 支持逐题备注与全局备注，在提交页统一检查答案。
- 问卷按 FIFO 串行展示；等待已有浮层释放焦点，取消或关闭会话时清理状态。
- 通过 Pi 的 `blocked/question` 状态对接 Rex 原生通知。Rex 内不额外发送桌面通知或响铃；其他终端保留原有 BEL 行为。
- 支持终端交互和 RPC 宿主；非交互模式不向模型暴露问答工具。

## 安装与使用

按[仓库安装说明](../../README.md#安装)准备依赖，并将本目录的绝对路径加入 Pi 的 `packages` 配置，然后执行 `/reload` 或重开 Pi。此包尚未发布 npm；不要安装原上游 npm 包来替代本仓库版本。

模型需要澄清决策时可调用 `ask_user_question`：

- `↑` / `↓` 浏览选项，`Enter` 选择。
- `Tab` 切换问题，提交页统一确认。
- `Type something.` 输入自定义答案，`n` 添加备注。
- `Shift+Enter` 换行，`Ctrl+G` 打开外部编辑器。
- `Ctrl+]` 收起或恢复问卷；`Esc` 放弃整个问卷。

Rex 通知是否显示或发声由 Rex、macOS 通知设置和专注模式决定，本插件不修改这些设置。

## 配置与开发

为兼容已有设置，配置路径仍为 `~/.config/rpiv-ask-user-question/config.json`，已有 `rpiv` 事件标识也保持不变。包名变更不影响工具名 `ask_user_question`。

```sh
npm test
```

集成测试使用本机 Pi，默认路径为 `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent`；其他安装位置通过 `PI_PACKAGE_ROOT` 指定。测试不发送模型请求。

- [工具参数](docs/tool-schema.md)
- [快捷键与布局](docs/keyboard.md)
- [配置选项](docs/configuration.md)
- [宿主与运行行为](docs/hosts.md)
- [本地化](docs/localization.md)
- [补丁历史与验证记录](LOCAL-PATCH.md)

## 来源与许可证

基于 [juicesharp/rpiv-mono / rpiv-ask-user-question](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-ask-user-question) 2.15.0 定制，保留原作者信息与 [MIT 许可证](LICENSE)。本包从 0.1.0 开始独立版本管理。

# 开发指南

[返回首页](../README.md)

## 仓库结构

```text
pi-extensions/
├── packages/
│   ├── ask-user-question/     # 结构化问答
│   └── activity-summary/     # regular TUI 活动摘要
├── docs/
│   └── assets/               # 真实组件渲染预览
└── scripts/
    └── render-previews.mjs    # 离线生成预览
```

每个插件有独立的 `package.json`、依赖、测试和版本。Ask 使用 `@bestdonger/pi-ask-user-question`，从 `0.1.0` 开始独立版本管理；Activity Summary 使用 `pi-activity-summary`。当前均不发布 npm。

Pi 加载本地源码目录，修改后执行 `/reload` 或重开会话。`pi update --extensions` 不会覆盖本地路径包；同步本仓库使用 Git，拉取前先检查工作区。

## 环境与依赖

已验证宿主为 **Pi 1.5.0**。需要 Node.js（支持直接执行 TypeScript 的版本）和 Bun。Ask 的普通运行依赖安装方式见[快速开始](../README.md#快速开始)；Activity Summary 没有额外运行依赖。

Pi 的宿主模块通过 peer dependencies 提供，不要给插件打包另一份宿主。测试时 Activity Summary 需要能直接解析宿主模块。本机采用软链接：

```sh
# 在仓库根目录执行。非 npm 全局安装请自行指定实际 Pi 路径。
export PI_PACKAGE_ROOT="$(npm root -g)/@earendil-works/pi-coding-agent"
test -f "$PI_PACKAGE_ROOT/package.json" || exit 1

mkdir -p packages/activity-summary/node_modules/@earendil-works
mkdir -p packages/activity-summary/node_modules/@types

ln -s "$PI_PACKAGE_ROOT" \
  packages/activity-summary/node_modules/@earendil-works/pi-coding-agent

for package in pi-ai pi-tui pi-agent-core; do
  ln -s "$PI_PACKAGE_ROOT/node_modules/@earendil-works/$package" \
    "packages/activity-summary/node_modules/@earendil-works/$package"
done

ln -s "$PI_PACKAGE_ROOT/node_modules/@types/node" \
  packages/activity-summary/node_modules/@types/node
```

这些链接只需创建一次；目标已存在时先确认内容，不要强制覆盖。若宿主没有包含某个模块，请先检查实际安装布局。

## 测试

```sh
(cd packages/ask-user-question && npm test)
(cd packages/activity-summary && bun test)
```

Ask 集成测试读取 `PI_PACKAGE_ROOT`，默认是 Homebrew 的 Pi 路径。Activity Summary 部分测试仍依赖本机路径及已安装的参考插件；在其他机器运行前需检查 `test/loader.test.ts`。当前没有跨平台 CI，不将本机通过等同于所有环境均可用。

测试使用示例消息、虚拟工具和内存 provider，不调用真实模型。自动化组件测试不替代终端、通知及快捷键的人工验收。

## 生成首页预览

```sh
bun scripts/render-previews.mjs
```

脚本加载真实 Ask 工具及 Activity Summary 显示组件，以离线示例数据渲染 ANSI，再转换成 `docs/assets/*.svg`。不读取用户会话，不执行示例中的工具命令，不修改 Pi 设置，不发送模型请求。图片中的终端外框由脚本添加，不代表真实宿主窗口。

- `PI_PACKAGE_ROOT`：指定宿主安装位置；默认从 `npm root -g` 推导。
- `ACTIVITY_PACKAGE_ROOT`：可选，指定另一份 Activity Summary 源码，例如隔离的已提交版本，避免把其他任务的工作区改动带入预览。该目录仍需能够解析宿主依赖。
- 改变 UI 后重新生成预览，并在浏览器中检查文字、裁切和背景。SVG 是静态预览，不验证真实终端的通知、输入和滚动行为。
- 不使用上游截图冒充定制版，也不将用户对话或凭据放入图片。

预览脚本针对当前示例使用的 ANSI 样式转换，不是通用终端模拟器。

## 暂停加载插件

在 `~/.pi/agent/settings.json` 中，把对应 `packages` 条目改成：

```json
{
  "source": "/absolute/path/pi-extensions/packages/activity-summary",
  "extensions": []
}
```

执行 `/reload` 或重开会话后生效；去掉过滤即可重新启用。不要同时启用多个 transcript 投影插件。

## 维护边界

- 仅在本仓库修改代码，不修改 npm 托管目录或迁移前的备份副本。
- Ask 保留原始许可证和作者；详细历史见 [LOCAL-PATCH.md](../packages/ask-user-question/LOCAL-PATCH.md)。
- 配置路径与事件名为兼容已有集成而保留，不随包名自动改变。
- 依赖更新、上游同步和宿主升级分别评估，不整包覆盖定制代码。
- 不提交 `node_modules`、用户配置、凭据或会话记录。

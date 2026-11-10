# 开发指南

[返回首页](../README.md)

## 仓库结构

```text
pi-extensions/
├── packages/
│   ├── ask-user-question/     # 结构化问答
│   ├── activity-summary/     # regular/fullscreen TUI 活动摘要
│   ├── rex-prompt-navigation/ # Rex 用户消息导航
│   ├── fast-mode/             # GPT Fast 优先处理开关
│   └── token-speed/           # 状态栏会话累计 token 吞吐量
├── docs/
│   └── assets/               # 真实组件渲染预览
└── scripts/
    └── render-previews.mjs    # 离线生成预览
```

每个插件有独立的 `package.json`、依赖、测试和版本。Ask 使用 `@bestdonger/pi-ask-user-question`，从 `0.1.0` 开始独立版本管理；Activity Summary 使用 `pi-activity-summary`。当前均不发布 npm。

正常使用从 GitHub 安装根包，根 `package.json` 通过 workspaces 安装依赖并声明五个扩展入口。各插件继续独立维护；不要在 `~/.pi/agent/git/` 的托管副本中开发。

开发时移除 GitHub 包声明，改用 `pi install /absolute/path/pi-extensions` 加载工作区，修改后执行 `/reload` 或重开会话。不要同时加载 GitHub 和本地副本。`pi update --extensions` 不会覆盖本地路径包；同步开发仓库使用 Git，拉取前先检查工作区。

## 环境与依赖

Activity Summary 面向新版 Pi，**不设置版本白名单或上限**，宿主 peers 声明为 `*`；本次实际回归基线为 **Pi 1.5.1 regular/fullscreen**。兼容性按实际布局判断，不需随宿主版本号升级改代码。Rex Prompt Navigation 同样不按版本号限制，本次回归基线为 Pi 1.5.1 regular。需要 Node.js（支持直接执行 TypeScript 的版本）和 Bun。GitHub 安装会自动准备依赖；本地开发在根目录运行 `npm install --legacy-peer-deps --ignore-scripts`，使用已提交的锁文件，不自动安装宿主 peers。Activity Summary 和 Rex Prompt Navigation 没有额外运行依赖。

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
npm run test:package
(cd packages/ask-user-question && npm test)
(cd packages/activity-summary && bun test)
(cd packages/rex-prompt-navigation && bun test)
(cd packages/fast-mode && npm test)
(cd packages/token-speed && npm test)
```

Ask 集成测试读取 `PI_PACKAGE_ROOT`，默认是 Homebrew 的 Pi 路径。Activity Summary 部分测试仍依赖本机路径及已安装的参考插件；在其他机器运行前需检查 `test/loader.test.ts`。当前没有跨平台 CI，不将本机通过等同于所有环境均可用。

测试使用示例消息、虚拟工具和内存 provider，不调用真实模型。自动化组件测试不替代终端、通知及快捷键的人工验收。

Fast Mode 无额外运行依赖，单元测试直接使用 Node.js，不调用模型 API。已在 Pi 1.5.1 验证；支持 OpenAI Responses、Codex Responses 和 Chat Completions 的 GPT 请求。

Token Speed 使用 `message_start/update/end` 观察主会话：以首个非空文本/思考/工具参数 delta 或带名字的工具调用为首 token，使用单调时钟计算到响应结束的耗时。正常结算且输出用量大于 0 的响应写入不参与模型上下文的 `token-speed-sample-v1` custom entry，显示 Σusage.output / ΣdecodeMs；没有刷新 timer，不做内容估算，不计首 token 等待和工具执行。重载或分支切换仅累加 `getBranch()` 中的样本，旧消息不补造首 token 时间；无 UI 也记录计时，不操作界面。测试覆盖累计加权口径、首 token 识别、结果常驻、分支/磁盘恢复、Anthropic 初始用量和原生 footer，基线为 Pi 1.5.1。

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
  "source": "git:github.com/bestdonger/pi-extensions",
  "extensions": ["!packages/activity-summary/src/index.ts"]
}
```

执行 `/reload` 或重开会话后生效；去掉过滤即可重新启用。不要同时启用多个 transcript 投影插件。

## 维护边界

- 仅在本仓库修改代码，不修改 npm 托管目录或迁移前的备份副本。
- Ask 保留原始许可证和作者；详细历史见 [LOCAL-PATCH.md](../packages/ask-user-question/LOCAL-PATCH.md)。
- 配置路径与事件名为兼容已有集成而保留，不随包名自动改变。
- 依赖更新、上游同步和宿主升级分别评估，不整包覆盖定制代码。
- 不提交 `node_modules`、用户配置、凭据或会话记录。

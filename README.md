# pi-extensions

个人维护的 Pi 插件集合。每个插件独立组织，共用 Git 仓库；不是上游 monorepo 的 GitHub 原生 fork。

| 目录 | 用途 | 来源 |
| --- | --- | --- |
| `packages/ask-user-question` | 结构化问答、Rex 原生等待状态、串行问答、最多 10 个问题 | 从 `@juicesharp/rpiv-ask-user-question` 2.15.0 派生，保留 MIT 许可证；详见 `LOCAL-PATCH.md` |
| `packages/activity-summary` | Pi regular TUI 活动摘要 | 参考 `luan/agents` 的 `@luan.sh/pi-collapse-transcript`，面向 regular TUI 的独立实现；兼容目标 Pi 1.5.0 |

## 原版来源与我们的改动

### Ask User Question：从上游代码派生

- 原版仓库：[juicesharp/rpiv-mono](https://github.com/juicesharp/rpiv-mono)。
- 原版插件目录：[packages/rpiv-ask-user-question](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-ask-user-question)。
- 基础版本：`@juicesharp/rpiv-ask-user-question` **2.15.0**；当前定制版本：`2.15.0-local.rex.2`。
- 来源关系：复制上游插件代码后维护本地修改，保留原作者信息和 [MIT 许可证](packages/ask-user-question/LICENSE)；本仓库不是整个 `rpiv-mono` 的 GitHub 原生 Fork。

原版提供结构化选择问答、多选、自由输入和选项预览。我们在保留这些能力的基础上，主要做了以下定制：

1. **Rex 原生等待状态**：通过 Pi 的 `blocked/question` 状态表达“等待用户回答”，由 Rex 负责通知外观、声音、去重和点击跳转；不再自行发送桌面通知或维护额外状态。
2. **串行问答与取消处理**：使用 FIFO 队列，同一时间只展示一个问卷；有捕获焦点的浮层时等待，取消、会话关闭和异常时释放队列及监听器。
3. **每次最多 10 个问题**：问题上限提高到 10，每题仍为 2–4 个选项；同步参数 schema、运行时校验、模型提示和文档，并适配窄终端的标签栏。
4. **回归验证**：补充生命周期、真实 Pi 加载、问卷渲染、状态转换及问题数量边界测试；迁移时 **24 项测试通过**。

详细补丁与限制见 [LOCAL-PATCH.md](packages/ask-user-question/LOCAL-PATCH.md)。Rex/macOS 通知横幅的实际显示仍需用户在桌面环境验收。

### Activity Summary：参考社区插件，面向 regular TUI 独立实现

- 参考仓库：[luan/agents](https://github.com/luan/agents)。
- 参考插件目录：[harnesses/pi/agent/packages/pi-collapse-transcript](https://github.com/luan/agents/tree/main/harnesses/pi/agent/packages/pi-collapse-transcript)。
- 本机参考版本：`@luan.sh/pi-collapse-transcript` **0.3.5**。
- 来源关系：参考其“连续 thinking/tool 合并为可展开活动块”的交互与统计思路，重新实现适合 **Pi 1.5.0 regular TUI** 的插件；不是该包的直接改名，也不是保留其 Git 历史的 Fork。

参考版基于 `@luan.sh/pi-libtui`，在 **fullscreen** 下提供可点击展开的活动行；regular 模式保持原生渲染。我们的实现主要区别是：

| 方面 | 参考版 | 本仓库实现 |
| --- | --- | --- |
| 模式与依赖 | fullscreen，捆绑 `pi-libtui` | regular TUI，不依赖 `pi-libtui`；使用隔离并检查布局形状的 Pi 1.5 私有桥 |
| 展开操作 | 鼠标点击活动行 | 复用 Pi 原生 `Ctrl+O` 全局展开/收起，不接管鼠标 |
| 摘要统计 | steps 和失败数 | 非空 thinking 块 + 顶层工具调用计为 steps；另列工具 `ok / err / open`，排除嵌套调用及模型请求本身 |
| 外观 | 活动行及运行中动画 | 三行摘要块、左右留白；按成功、失败、进行中状态使用当前 Pi 主题背景，无动画 |
| 历史滚动 | fullscreen 的滚动与折叠控件 | 使用终端原生 scrollback；自动更新冻结离屏前缀，手动展开允许历史重排 |
| 恢复 | 加载会话时重建折叠区块 | 增量保存并校验 `pi-activity-summary/v2` 元数据，兼容旧 v1；证据不完整时保持未知 |

此外，助手正文始终立即流式显示；展开复用原生 thinking/tool 渲染，保留链接、自定义渲染器和图片协议。摘要元数据不进入模型上下文，也不改写原始消息或工具结果。

迁移时 **89 项测试通过**，覆盖统计、背景、离屏保护、会话恢复和模拟终端中的真实快捷键流程。当前只验证 Pi **1.5.0**；宿主升级需重新验证，自动化测试不代表所有终端均已人工验收。详见 [插件 README](packages/activity-summary/README.md) 与 [设计说明](packages/activity-summary/DESIGN.md)。

## 本机使用

工作副本：`~/Projects/pi-extensions`。`~/.pi/agent/settings.json` 的 `packages` 分别指向两个子目录的绝对路径；不要将整个仓库作为单个插件加载。已有 npm 插件声明保持不变。

修改、测试、提交均在本仓库进行。执行 `/reload` 或重开 Pi 后加载修改。Pi 的包更新不会覆盖本地路径包；本仓库更新使用 Git，并在拉取前检查未提交变更。

旧目录 `~/.pi/agent/local-packages/rpiv-ask-user-question` 和 `~/.pi/agent/packages/pi-activity-summary` 仅留作迁移前备份，不再是开发源。

## 依赖与测试

当前迁移保留了本机已有依赖，但 `node_modules` 不入 Git。新机器克隆后需单独准备依赖：

- 安装兼容的 Pi（当前验证版本 1.5.0）、Node.js（支持直接运行 TypeScript 的版本）和 Bun。
- Ask 运行时依赖 `@juicesharp/rpiv-config`，迁移时使用 2.15.0。可在该包目录运行 `npm install --no-save --package-lock=false --legacy-peer-deps --ignore-scripts @juicesharp/rpiv-config@2.15.0`；不自动安装另一份 Pi peer dependencies。
- Activity Summary 的本机测试通过 `node_modules/@earendil-works/` 下的软链接引用已安装宿主的 `pi-coding-agent`、`pi-ai`、`pi-agent-core` 和 `pi-tui`。新机器需按其 Pi 安装位置重建这些链接；类型检查还需要 `@types/node`。插件本身无额外 runtime dependencies。
- Ask 集成测试默认使用 Homebrew 的 Pi 路径，可通过 `PI_PACKAGE_ROOT` 指定其他安装位置。部分 Activity Summary 测试仍含本机路径假设，迁移其他机器时需检查。

```sh
(cd packages/ask-user-question && npm test)
(cd packages/activity-summary && bun test)
```

不将宿主模块复制或发布到插件包内。每个插件的详细行为、兼容限制见其 README。

## 上游同步与许可证

Ask 的代码上游为 `juicesharp/rpiv-mono`；Activity Summary 的交互参考为 `luan/agents` 中的 `pi-collapse-transcript`，链接及来源关系见上文。

Ask 按需比较上游版本、人工合并，并更新本地补丁说明与测试；Activity Summary 按需评估参考插件的新设计，不直接整包覆盖。不自动同步上游，不自动发布 npm。仓库名不改变原包的作者归属或许可证；Ask 的原始 MIT 许可证保留在插件目录。仓库不统一给其他代码授予新的开源许可证。

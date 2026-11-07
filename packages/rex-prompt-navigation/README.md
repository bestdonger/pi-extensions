# Rex Prompt Navigation

在 **Rex + Pi 1.5.0 的 regular TUI** 中恢复用户消息的原生 prompt 标记，使 Rex 的 `⌘↑ / ⌘↓`（Jump to Previous/Next Prompt）有用户消息可导航。

只增强显示，不改用户输入、会话文件、模型上下文或快捷键。不切 fullscreen，不修改 Pi 安装文件。

## 安装和使用

本仓库是唯一开发源。随根包从 GitHub 安装：

```sh
pi install git:github.com/bestdonger/pi-extensions
```

已通过全局扩展目录中的符号链接或本地路径加载时，先移除旧声明／链接，避免重复加载。开发可使用 `pi install /absolute/path/to/package`，但不要同时加载 GitHub 副本。

在当前 Pi 中执行 `/reload` 后再使用 `⌘↑ / ⌘↓`。新启动的会话自动加载。

```text
/rex-prompts          查看状态与标记输出计数
/rex-prompts status   同上
/rex-prompts off      当前扩展实例内停用，恢复原生渲染
/rex-prompts on       重新检查兼容性并启用
```

`off` 不是持久设置，`/reload` 和新会话会重新自动启用。进程级紧急禁用：

```sh
PI_REX_PROMPTS=0 pi --tui-mode regular
```

永久停用可用 `pi config` 关闭根包中的 `packages/rex-prompt-navigation/src/index.ts`，然后 `/reload`。旧版通过全局链接加载的用户，可确认链接目标后执行 `unlink "$HOME/.pi/agent/extensions/rex-prompt-navigation"`；只删除链接，不删除源码。

## 目标和边界

- 只在存在 `REX_SESSION`、`REX_BLOCK` 的直连 Rex TUI 中启用；tmux/screen、其他终端、RPC/print 不启用。
- 只恢复真实 `UserMessageComponent` 的标记，包含恢复历史、分支切换和新消息；不把助手消息、工具结果、编辑器草稿变成目标。
- “历史”是 Pi 实际显示的消息，不是已被压缩/从当前分支移除的内容，也不能突破终端自身的 scrollback 限额。
- fullscreen 使用 Pi 自己的导航，本插件不增强。运行时切换渲染器会禁用增强并提示；回到 regular 后使用 `/rex-prompts on` 或 `/reload`。
- 目前严格限定 **Pi 1.5.0**，升级后自动禁用并提示，不猜测内部 ABI 兼容性。
- 不修改 Rex 的键位，操作系统或 Rex 自定义绑定冲突仍需单独处理。

## 实现与稳定性保护

Pi 的用户和助手组件都会生成 `OSC 133;A/B/C`，regular 渲染器会删除行首的这些标记，因为 `133;A` 会让终端清除瞬态程序状态（`OSC 7501` 的 `working/blocked`，以及终端可选择清除的 `idle`）。`done/error` 则按协议跨 prompt 保留。

本插件分两层处理：

1. 使用零行 widget 获取 Pi 的稳定 TUI 引用，取得当前真实 renderer。只包装当前实例的 `render`，不替换编辑器、页脚、输入监听或全局原型。
2. 在一次同步渲染期间，临时包装真实用户组件的 `render`，在原有行首标记前添加零宽 SGR reset，避开 Pi 的行首过滤。`finally` 立即恢复组件方法。助手标记仍由 Pi 原样过滤；显示的行、列与文字不变。
3. 只包装当前终端实例的 `write`。每个完整 `133;A` 后，仅在当前真实状态为 `working/blocked/idle` 时立即补发状态，使用宿主的 `formatProgramStatus` 编码，在同一写入中发出。**不重放 `done/error`**，避免刷新完成时间或产生重复完成事件；`clear` 和不存在的记录也不重放。不建立另一套状态机，不强制开启不受支持的状态协议。
4. 处理跨 1 MiB 写入边界被拆开的标记。状态不参与渲染行的缓存比较，不因每次状态变化重绘所有历史消息。
5. 安装前检查版本、renderer 过滤逻辑、终端状态字段和编码接口。运行时检测 renderer 替换或接口变化，停止增强并通知。
6. `/reload`、会话替换和退出时幂等恢复原方法。清理不覆盖其他扩展后来安装的方法；已被其他扩展保留的包装器退化为透传。

原生滚动、差异渲染、重绘、缩放和 overlay 仍由 Pi 管理。没有文件补丁，没有后台轮询，没有 prompt 内容日志或网络请求。

瞬态状态重放仍会产生 Rex 状态事件：这是恢复被 prompt 清除的 `working/blocked/idle` 所需的行为，不承诺整个事件流完全不变。持久的 `done/error` 不应因重绘产生任何新状态事件。生命周期规则见 [OSC 7501 States](https://www.superlogical.com/rex/docs/build/program-status#states)。

当前与本仓库 Activity Summary 的原生容器/透明 `source` 投影兼容。未知的第三方渲染树不能宣称已验证；渲染错误和冲突请先 `/rex-prompts off` 对比原生行为。

## 验证

本机环境：Pi 1.5.0、Rex Beta 0.1.0 (1829)、Rex server `0.0.1793741575-g1b6654`。

```sh
cd packages/rex-prompt-navigation
bun test
```

测试使用 Bun 和本机 Pi peer 模块；`node_modules/@earendil-works/*` 仅链接宿主，不安装/打包第二份 Pi。宿主路径或版本不同时重新准备开发依赖；参见仓库开发指南。

本机结果：**28 项测试通过**，4 个测试文件分别独立运行也全部通过；安全测试显式初始化主题，不依赖集成测试的执行顺序。源码通过 TypeScript 6.0.3 strict 类型检查（`tsc --noEmit`，项目包含 `tsconfig.json`）。`npm run typecheck` 需要开发环境中已有 TypeScript CLI；不要为了测试安装第二份 Pi 宿主。

自动化覆盖：

- 原生过滤的负对照、仅用户消息增强、状态精确重放、BEL/ST 标记的所有拆分位置及大写入边界。
- 新/历史消息、流式正文、工具结果、中文/emoji、缩放、reload/resume。
- `working/blocked/idle` 精确重放，`done/error` 三条用户消息重复重绘不补发任何状态；不支持/clear 状态不伪造；真实 InteractiveMode 的工作和对话框状态。
- 与 Activity Summary 共存、overlay 可见布局、命令开关、渲染器切换、异常清理、冻结节点、版本/ABI 拒绝和重复挂载保护。
- 其他终端、fullscreen 和紧急禁用的负对照。

真实 Rex 离线 CLI 测试使用 `test/rex-fixture.ts`（非插件入口）：确认编译打包的 Pi 能加载扩展，写出用户标记，server 仍能查询到 `working` 和 `done`，并能 `/reload`。

Review 修正后另外在独立 Rex 测试会话验证：每轮重绘 3 条用户消息，连续重绘 3 轮，`done/error` 的 `updated_at` 保持不变，新增 `program_status_changed` 事件为 0；`working/blocked/idle` 在重绘后仍保持原状态。该测试订阅实际 server 事件，不只比较最终状态字符串。

**尚需人工确认的项目：实际按 `⌘↑ / ⌘↓` 的界面导航。** 本机 Rex 未开启 Settings → Rex Server → Remote Control，客户端动作自动化被拒绝；插件没有启用该设置或绕过限制。自动化标记/状态验证不冒充键盘验收。

## 源码

- `src/index.ts`：生命周期、环境门控与命令。
- `src/bridge.ts`：受保护的 Pi 1.5.0 运行时适配与状态重放。
- `test/`：回归测试和独立离线 QA provider，无真实模型调用。

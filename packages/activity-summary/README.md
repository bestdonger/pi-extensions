# pi-activity-summary

适用于本机 **Pi 1.5.0 / regular TUI** 的独立插件。连续 thinking / tool 活动合并成一个动态摘要块；所有助手正文，包括进度说明，仍立即流式显示，并分隔活动段。

折叠态为 **3 行高**，摘要上下各一行同色空白，左右各留 2 列：

```text
                                                        
  ▸ 检查配置 | 10 steps | tools 7 (ok 5, err 1, open 1)  
                                                        
```

每个活动块前另留 **1 行终端默认背景的空白**，对应原生工具组件的 `Spacer(1)`，把用户消息／前一色块与活动块隔开。此行在色块之外，不计入上面的 3 行高度；折叠和展开均保留，且每组只添加一次。

展开态的色块内部保留原有单行标题和原生内容间距，不额外增加上下留白。

## 行为

- `steps = 非空 thinking block 数 + 顶层工具调用数`，对齐 fullscreen 插件的活动条目口径。每个思考块只计一次；模型请求本身、纯正文、流式更新及工具结果均不额外增加 steps。模型重试只在实际产生新的非空思考块或顶层工具时增加 steps。空思考块不生成摘要行。
- `tools = ok + err + open`，仅统计顶层工具，按 `toolCallId` 去重。带 `parentToolCallId` 的嵌套事件不影响计数、主题或背景。没有终态结果的调用仍为 `open`，不猜测结果。codemode 内部失败若被捕获、外层成功，本行只按外层成功处理。
- 折叠块的 3 行背景都铺满聊天区宽度，复用当前 PI 主题的 `toolPendingBg` / `toolSuccessBg` / `toolErrorBg`，支持 `light/dark` 自动切换。顶层工具失败或模型最终失败用失败色，优先于未完成；活动进行中、有 open、状态未知、用户中断或输出截断用中性色；活动段正常结束且无失败/未完成调用用成功色，纯思考段正常结束也使用成功色。后台更新不修改此前已冻结的段。
- 主题优先取最新 thinking 标题，没有标题时取最新短段落；没有 thinking 时用工具名。不增加模型请求。默认收起 thinking、工具参数/结果和工具错误；按 `Ctrl+O` 可展开。
- 统计字段固定，结果数字隶属于 tools。折叠时在左右留白后的内容宽度内先截短主题，再缩写统计；极窄屏缩减左右留白，至少保留一列内容，最终保留 steps 或省略号。摘要文字仍是一行，折叠块整体为 3 行。主题清理 ANSI/OSC 等终端控制序列，使用 Pi 的 Unicode 列宽函数。
- 活动期间最多每 250ms 更新一次**字段与背景状态的共同快照**。按用户确认的规则，正文开始或任务结束时，可对仍能安全重绘的当前行补刷一次最新统计，再冻结；正文不等待。
- 自动更新不为补数字或补颜色回写已离开上一 regular viewport 的摘要；即使只有顶部空白行离屏，也冻结整个 3 行块，避免留白和文字的状态色不一致。展开正文也保留离屏前缀，允许不改变该前缀的可见尾部更新。若更新会改变已离屏部分，暂保留旧正文，直到手动切换或宿主重绘。内部状态仍继续更新，因此显示可能较早；手动展开/收起会读取最新值。主题变化可以重新应用新调色板，但不解冻统计或状态。
- 最终模型失败、输出长度上限或中断仍只保留一句简短状态。收起时工具失败只计入 `err`；明确展开后可查看原生工具错误正文。

## 展开与收起

按 **`Ctrl+O`** 全局切换所有活动段，历史段和随后新出现的段都跟随。标题前的 `▸` / `▾` 表示收起/展开。复用 Pi 原生 `app.tools.expand` 动作和状态，不抢占快捷键；若你重绑了该动作，就使用重绑后的键位，确认框等焦点行为仍由 Pi 决定。

展开时保留摘要，在其下显示原生思考 Markdown、工具参数和结果；普通回答在色块外。**摘要与展开的所有文本行、空白行使用同一个状态背景**，不再嵌套工具各自的背景。保留语法高亮、自定义工具渲染器和链接。图片沿用原生终端图像协议及占位行，不把图像协议当文本填色。长输出使用 regular 模式的终端滚动，不引入 fullscreen 的局部鼠标滚动控件；工具自身已截断且未保存的内容不能凭展开恢复。

**本次明确保留 regular，不加入鼠标单块切换。** Pi 1.5 的 regular 模式把鼠标和滚动历史交给终端；强制捕获会影响滚轮、复制和链接，且不能可靠命中终端滚动历史中的旧块。本插件不启用鼠标报告协议，也不切换到 fullscreen。

`Ctrl+O` 统一控制段内思考和工具显示，不修改全局 `hideThinkingBlock` 设置。展开状态只属于 UI：`/reload` 跟随当前状态，重开会话默认收起，历史内容仍可再次展开。

**主动切换会改变历史高度，并刷新显示快照，可能触发 Pi 清屏及重建当前会话滚动内容。** 这是全局展开的取舍；后续后台自动更新仍遵守离屏保护。不会改写原始消息、模型上下文或会话导出。

## 数据与兼容性

使用公共生命周期事件计数，在 `agent_settled` 增量写入 `pi-activity-summary/v2` 类型的 **custom session entries**，不是 `custom_message`。记录稳定的 session-entry ID、block index、思考块数、顶层工具状态、完成性、主题及简短终止提示；避免每轮重复保存全历史。

这些记录不进入模型上下文。原始消息、工具结果、会话正文和导出不变。恢复只读取活动分支：
- 新 v2 记录校验锚点、思考块数及顶层工具集合后恢复。
- 旧 v1 记录原始消息完整、锚点与工具状态校验通过时，从原始 thinking blocks 和 toolCall IDs 重算新口径，过滤嵌套结果，不把旧 models 数当作思考块数。仅内存迁移，不重写旧会话。
- 没有可信元数据、缺少锚点或未落盘的中断历史，计数保持 `—`；状态无法确认时背景保持中性。若原始顶层工具结果或最终模型消息能直接证实失败，即使计数未知也使用失败色。已恢复计数但缺少正常完成证据时也保持中性，不把文件结束或工具全部成功直接当作活动正常结束。
- 迁移 v1 时也从原始顶层活动重建标题，避免沿用旧版被嵌套工具覆盖的标题。元数据与已保存的工具终态冲突时，不信任该元数据。

Pi 1.5.0 没有公共的 transcript projection / viewport API，因此 `src/bridge.ts` 使用一个隔离且带形状检查的私有桥：读取 `[header, resources, chat]` 文档布局及 `previousViewportTop`，只替换显示入口；Pi 仍更新原 chat source。不修改 `InteractiveMode` 原型，不依赖 `pi-libtui`，不拦截 stdout，不接管输入、确认框或 Esc。

正文和展开的思考使用原生 `AssistantMessageComponent` 的显示副本，保留 theme、padding、Markdown transformers、messageId 和 timestamp。普通刷新不会对未改变的文本重复运行 transformers。展开工具直接复用原生 `ToolExecutionComponent`；`src/surface.ts` 统一文本背景，不改工具数据。

非 TUI 调用静默不介入。版本、模式或布局不兼容时提示一次并恢复原生显示，此时 thinking/tool 内容可能重新可见。**仅验证 Pi 1.5.0；升级后需要重新验证。**

不能保证宿主永不清屏：Pi 自身的 resize、主题/布局变化、reload 和会话切换仍可重建 UI。本插件避免的是为了更新离屏摘要而改写历史行。卸载/reload 的生命周期会释放旧桥并恢复原生组件，重新加载后再挂载新桥。

## 本机启用与关闭

包入口：`src/index.ts`，由 `package.json` 的 `pi.extensions` 声明。

当前全局配置：
- 本地包：`~/Projects/pi-extensions/packages/activity-summary`（配置使用绝对路径）。迁移完成时全局配置保留 `extensions: []`，插件暂时停用；本次迁移只修改加载路径，不改变启停状态。
- 默认模式：`regular`
- 原 `@luan.sh/pi-collapse-transcript` 保留安装，但设置 `extensions: []`，包括其捆绑的 libtui 扩展，避免两个投影同时生效。
- 其他设置不变，包括 `hideThinkingBlock`。

配置备份：
`/Users/bytedance/.pi/agent/settings.before-activity-summary.20261106-000742.json`

若曾设置 `extensions: []` 停用，需要恢复时移除该过滤，再执行 `/reload` 或重开 Pi。已运行的会话不会因磁盘设置改变而自动重载；若不重开，请先通过 `/settings` 把当前会话切到 regular，再执行 `/reload`；若先在 fullscreen 下 reload，插件会按兼容性规则暂不挂载，需要切换后再 reload。

关闭时从 `settings.json` 的 `packages` 中移除本地包声明，或改成对象并设置 `extensions: []`，然后重新打开 Pi。无需删除会话数据，原工具记录仍在。恢复整个备份会同时回退当时的其他配置，后续若有新设置请只改对应字段。

## 开发与验证

结构：`src/`、`test/`、`DESIGN.md`、`tsconfig.json`。没有额外 runtime dependencies；宿主 Pi 模块通过 peer dependencies 提供。

本机测试使用 `node_modules` 中指向已安装 Pi 的软链接，不打包第二份宿主。Bun 1.4.4 执行测试，TypeScript 7.0.2 检查 `src/`：

```sh
cd ~/Projects/pi-extensions/packages/activity-summary
bun test
bun run typecheck
```

本次验证：**89 tests passed，0 failed（10 个测试文件）；`bun run typecheck` 通过。**

计数/背景回归测试位于 `test/summary-v2.test.ts`，展开回归测试位于 `test/expansion.test.ts`，三行留白回归测试位于 `test/padding.test.ts`，真实快捷键验收位于 `test/interactive.test.ts`。

覆盖：
- 分组、非空思考块去重、空块隐藏、模型续调用/重试、并行顶层工具、嵌套排除、阻止调用、成功/失败/未完成计数。
- 明暗主题、逐列背景覆盖、ANSI/OSC、中文和 emoji 的窄屏单行格式；数字与颜色共同节流、结束补刷、离屏冻结和释放定时器。
- 活动块外默认背景间隔、相邻色块分隔、连续渲染不重复加行，以及仅外部间隔离屏时不冻结可见块；三行同色留白、左右 2 列缩进与极窄屏降级；顶部留白离屏时整块冻结；真实 header 高度参与正文离屏保护；展开态间距不变。
- 失败优先、纯思考完成、最终模型失败、中断、长度上限及未知状态颜色。
- v2 元数据增量保存、活动分支恢复、可信 v1 重算、缺失/不一致历史保持未知、不污染模型上下文。
- 真实 Pi `AssistantMessageComponent`、`ToolExecutionComponent`、`TuiMainScreen` 的捕获终端测试。
- **完整 `InteractiveMode` + `AgentSession` + 内存 fake provider**：流式正文、收起时隐藏工具失败、排队 follow-up、最终 retry 失败、`/reload` 和会话重开前后摘要一致；真实 `Ctrl+O` 全局切换、流式中切换、模态输入焦点、展开状态 reload 与重开后的历史展开。
- 展开内容的明暗主题逐列同色覆盖、ANSI 内嵌背景/重置/反色、窄屏、原生自定义渲染器及长结果；同一消息内交错顺序、后续消息复用调用 ID、无消息声明的孤立工具。
- 原生 Kitty/iTerm 图片经 `Image → ToolExecutionComponent → Projection → TuiMainScreen` 传输、占位行和折叠清理；离屏前缀保护、可见尾部更新、手动刷新冻结快照及自动更新不清除历史。

测试仅执行虚拟工具，不发送真实模型请求，不读取用户凭据或历史会话。这里的“完整交互测试”是自动化捕获终端，不代表已人工验收你当前终端的键盘、确认框和渲染效果。

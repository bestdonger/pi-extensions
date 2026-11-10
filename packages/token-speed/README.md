# Token Speed

按 DSH 口径在 Pi 状态栏显示**会话累计平均输出速度**，不替换原生 footer，可与 Fast Mode 同时使用：

```text
↯82tok/s
fast:on
```

速度图标使用单列宽的 `↯`，图标、数值和单位之间不加空格。没有有效统计时显示 `↯—tok/s`。

## 统计口径

```text
速度 = Σ 已结算响应的实际输出 tokens ÷ Σ（响应结束时间 − 首 token 时间）
```

- 只在模型响应正常结束后更新；生成中不估算、不启动刷新 timer，工具执行、等待下一轮和空闲期间原样保留已有结果，不显示 `(last)`。
- 使用 provider 的最终 `usage.output`，不按字符估算，不把中途用量快照当成实际输出。未报告输出用量、零输出、缺少首 token、耗时为零，以及中止或出错的响应不计入统计。
- 首个非空文本、思考或工具参数 delta，以及带名字的工具调用，视为首 token。文本/思考块的开始事件、空 delta 和用量事件不启动计时。
- 用单调时钟记录从首 token 到响应结束的耗时，**排除首 token 等待与工具执行**，但仍包含首 token 之后的思考输出和网络等待，不是纯 GPU 解码速度。上游未流式展示的隐藏 reasoning 可能影响这个口径与真实解码速度的对应关系。
- 同一会话当前分支内跨响应、跨模型累计；计算总 tokens / 总耗时，不是逐条速度的算术平均。≥ 10 tok/s 四舍五入显示整数，低于 10 时最多保留一位小数。
- 每个有效响应保存一条 `token-speed-sample-v1` custom entry；不进入模型上下文、不渲染聊天消息，也不修改请求、模型、消息或费用。重载、恢复会话和切换分支时，从 `getBranch()` 恢复累计值，历史分页和压缩不影响统计。
- **旧消息不回算**：Pi 的历史 assistant 消息只有总耗时，没有首 token 时间。新版从启用后的有效响应开始记录；首次启用后要等一次响应结束才有新口径的速度。
- 只统计主会话，不统计后台 cache warming 或独立子代理。无 UI 时仍保存计时，不操作界面。

## 安装

随仓库根包一起安装；本地开发也可以只装本插件：

```sh
pi install /absolute/path/pi-extensions/packages/token-speed
```

执行 `/reload` 后生效。不要同时从根包和本地路径加载此插件；根包已启用时无需再单独安装。本地包与 GitHub 根包共存时，在根包的资源过滤中加入 `!packages/token-speed/src/index.ts`。

无额外运行依赖，复用宿主 peer 模块。当前验证基线为 **Pi 1.5.1 / Node.js 26**；使用原生 `setStatus`，不区分 regular/fullscreen 布局。自定义 footer 若不渲染 extension statuses，则不会显示此状态。

## 测试

```sh
npm --workspace @bestdonger/pi-token-speed test
npm run test:package
```

测试使用可控时钟、离线 SDK/provider/Anthropic 适配器和原生 footer，不调用模型 API。覆盖累计加权口径、首 token 识别、无流式重绘、结果常驻、当前分支及磁盘恢复、真实模型上下文隔离。可用 `PI_PACKAGE_ROOT` 指定宿主安装路径。

停用时从个人 `settings.json` 的根包过滤中排除 `packages/token-speed/src/index.ts`，或 `pi remove <单独安装的本地路径>`，然后执行 `/reload`。

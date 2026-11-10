# Token Speed

在 Pi 状态栏实时显示当前响应的平均输出吞吐量，不替换原生 footer，可与 Fast Mode 同时使用。

```text
生成中：  ↑ ~42.6 tok/s
结束后：  ↑ 48.3 tok/s
```

## 统计口径

- 每 **250 ms** 刷新，流暂停时速度也会随时间更新；不是“一个 delta 算一个 token”。
- 生成中显示 **`~`**：使用 Pi 自带的内容估算，并以 provider 已返回的输出 token 数作为下限。中途用量可能只是初始快照（例如 Anthropic 的 `output_tokens: 1`），不会将它冒充当前精确计数。内容估算涵盖可见正文、思考文本和工具调用。
- 响应正常结束后使用 provider 的 `usage.output` 和 Pi 的 `durationMs`；上游未返回输出用量时继续保留 `~`。中止、出错或未收到终态时，也保持估算标记，因为它们的用量可能未更新。
- **速度 = 本次响应输出 tokens ÷ 从请求开始到当前/结束的耗时**。包含首 token 等待、思考和网络等待；不是排除这些时间后的纯解码速度。生成中用单调时钟持续计时，结束后优先采用宿主记录的单调耗时。
- 上游的输出用量可能包含未展示的 reasoning tokens，所以结束后的准确速度可能高于生成中的可见内容估算。字符估算对不同语言和模型的误差不同。
- 每次 assistant 响应独立统计，工具执行不计入生成耗时；工具运行期间保留上一响应结果。中止/出错分别显示 `(stopped)` / `(error)`。
- 新会话、切换分支、切换模型或下一轮请求时重置为 `↑ — tok/s`。不将统计写入会话。
- 只观察主会话消息，不统计后台 cache warming 或独立子代理；不修改请求、模型、消息或费用。无 UI 时不启动计时器。

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

测试使用可控时钟、示例消息、真实 Pi 估算函数及离线 SDK/Anthropic 适配器，不调用模型 API。可用 `PI_PACKAGE_ROOT` 指定宿主安装路径。

停用时从个人 `settings.json` 的根包过滤中排除 `packages/token-speed/src/index.ts`，或 `pi remove <单独安装的本地路径>`，然后执行 `/reload`。

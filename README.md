# pi-extensions

个人维护的 Pi 插件集合。每个插件独立组织，共用 Git 仓库；不是上游 monorepo 的 GitHub 原生 fork。

| 目录 | 用途 | 来源 |
| --- | --- | --- |
| `packages/ask-user-question` | 结构化问答、Rex 原生等待状态、串行问答、最多 10 个问题 | 从 `@juicesharp/rpiv-ask-user-question` 2.15.0 派生，保留 MIT 许可证；详见 `LOCAL-PATCH.md` |
| `packages/activity-summary` | Pi regular TUI 活动摘要 | 本地自定义插件；兼容目标 Pi 1.5.0 |

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

Ask 上游：https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-ask-user-question

按需比较上游版本、人工合并，并更新本地补丁说明与测试。不自动同步上游，不自动发布 npm。仓库名不改变原包的作者归属或许可证；Ask 的原始 MIT 许可证保留在插件目录。仓库不统一给其他代码授予新的开源许可证。

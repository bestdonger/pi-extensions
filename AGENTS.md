# Pi 插件维护约定

- 用中文交流；本仓库是自定义插件的唯一开发源，不修改 ~/.pi/agent 下的旧副本或 npm 托管副本。
- 插件分别位于 packages/，保留独立 package.json、依赖、测试和版本。
- 原样使用的社区插件继续走 npm，不复制进仓库。
- 修改 Pi 扩展前阅读本机已安装 Pi 的相关文档；宿主升级后重新验证兼容性。
- Ask 派生自 juicesharp/rpiv-mono 的 rpiv-ask-user-question 2.15.0，保留原 LICENSE、作者和来源；维护 LOCAL-PATCH.md。上游更新须人工评估并合并，不整包覆盖本地修改。
- 不提交 node_modules、凭据、用户配置或会话记录；不打包第二份 Pi 宿主依赖。
- 修改后运行对应插件测试，说明未验证项；提交前检查 git diff。提交和推送遵循当次用户授权，不自动发布 npm 包。
- 不运行全量依赖更新；依赖更新单独评估。现阶段不发布 npm；Ask 使用 @bestdonger/pi-ask-user-question，从 0.1.0 开始独立版本管理。保留上游作者及许可证；配置路径和事件名不随包名自动迁移。

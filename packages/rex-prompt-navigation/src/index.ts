import { VERSION, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { formatProgramStatus } from '@earendil-works/pi-tui';
import { isRex, mount, unwrapTui, type Bridge, type Host } from './bridge.ts';

const WIDGET = 'pi-rex-prompt-navigation/bridge';
export default function rexPrompts(pi: ExtensionAPI) {
  let bridge: Bridge | undefined;
  let tui: Host | undefined;
  let reference: object | undefined;
  let reason = '尚未启用';
  let alive = false, warned = false;
  const requestRender = () => {
    if (reference) unwrapTui(reference).requestRender();
  };
  const warn = (ctx: ExtensionContext, message: string) => {
    reason = message;
    if (alive && !warned) {
      warned = true;
      ctx.ui.notify(`rex-prompts：${message}；增强已禁用，Pi 原生功能不变。`, 'warning');
      requestRender();
    }
  };
  const enable = (ctx: ExtensionContext) => {
    if (bridge?.active) return;
    if (!reference) return;
    if (process.env.PI_REX_PROMPTS === '0') { reason = 'PI_REX_PROMPTS=0 禁用'; return; }
    try {
      tui = unwrapTui(reference);
      bridge = mount(tui, VERSION, formatProgramStatus, message => warn(ctx, message),
        () => unwrapTui(reference!));
      reason = '已启用';
    } catch (e) { warn(ctx, e instanceof Error ? e.message : '未知兼容性错误'); }
  };
  pi.on('session_start', (_event, ctx) => {
    alive = true;
    if (ctx.mode !== 'tui' || !isRex(process.env)) { reason = '非 Rex 直连 TUI，不启用'; return; }
    if (process.env.PI_REX_PROMPTS === '0') { reason = 'PI_REX_PROMPTS=0 禁用'; return; }
    // A zero-line widget is a public way to obtain the current TUI. It does not
    // replace the editor/footer or take ownership of keyboard/mouse input.
    ctx.ui.setWidget(WIDGET, host => {
      try {
        reference = host;
        tui = unwrapTui(host);
        if (tui.mode === 'regular') enable(ctx);
        else reason = 'fullscreen 模式，不启用';
      } catch (e) { warn(ctx, e instanceof Error ? e.message : '无法取得 Pi TUI'); }
      return { render: () => [], invalidate() {} };
    });
  });
  pi.registerCommand('rex-prompts', {
    description: 'Rex 用户消息跳转：status / on / off（仅 regular 模式）',
    getArgumentCompletions: prefix => ['status', 'on', 'off'].filter(v => v.startsWith(prefix))
      .map(value => ({ value, label: value })),
    handler: async (args, ctx) => {
      const action = args.trim() || 'status';
      if (action === 'off') {
        bridge?.dispose(); reason = '已手动停用（当前会话，reload 后自动启用）';
        requestRender();
      } else if (action === 'on') {
        warned = false; enable(ctx);
      } else if (action !== 'status') {
        ctx.ui.notify('用法：/rex-prompts [status|on|off]', 'info'); return;
      }
      ctx.ui.notify(`rex-prompts：${bridge?.active ? '已启用' : reason}；Pi ${VERSION}；` +
        `本次累计写出 ${bridge?.promptsWritten ?? 0} 个 prompt 标记（含重绘，不等于消息数）。`, 'info');
    },
  });
  pi.on('session_shutdown', (_event, ctx) => {
    alive = false;
    bridge?.dispose(); bridge = undefined; tui = undefined; reference = undefined;
    if (ctx.mode === 'tui') ctx.ui.setWidget(WIDGET, undefined);
  });
}

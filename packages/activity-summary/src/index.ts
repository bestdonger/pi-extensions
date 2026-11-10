import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { ActivityState } from './state.ts';
import { mount } from './bridge.ts';

export default function activitySummary(pi: ExtensionAPI) {
  let state = new ActivityState();
  let release: (() => void) | undefined;
  let enabled = false;
  let warned = false;
  let requestRender: (() => void) | undefined;
  const warn = (ctx: ExtensionContext) => {
    enabled = false;
    if (!warned) { warned = true; ctx.ui.notify('activity-summary：不兼容的 Pi 布局，已恢复原生显示。', 'warning'); }
  };
  const restore = (ctx: ExtensionContext) => {
    state = new ActivityState(); state.restore(ctx.sessionManager.getBranch());
  };
  pi.on('session_start', (_event, ctx) => {
    if (ctx.mode !== 'tui') return;
    restore(ctx);
    // A zero-line widget obtains the host TUI without replacing input, footer, or dialogs.
    ctx.ui.setWidget('pi-activity-summary/bridge', (tui, theme) => {
      release?.();
      requestRender = () => tui.requestRender();
      // Read Pi's native expansion state; its existing Ctrl+O handler owns the
      // keybinding and focus rules (no competing listener). Fullscreen clicks
      // add view-local overrides without changing this global host flag.
      try { release = mount(tui, () => state, s => ctx.ui.theme.fg('dim', s), () => warn(ctx),
        () => ctx.ui.theme, () => ctx.ui.getToolsExpanded?.() ?? false); }
      catch { release = undefined; }
      enabled = !!release;
      if (!release) warn(ctx);
      return { render: () => [], invalidate() {} };
    });
  });
  pi.on('message_start', (event) => {
    if (!enabled) return;
    if (event.message.role === 'assistant') state.start(event.message);
    else if (event.message.role !== 'toolResult' && event.message.role !== 'system') state.userBoundary();
  });
  pi.on('message_update', event => { if (enabled) state.observe(event.message); });
  pi.on('message_end', event => {
    if (!enabled) return;
    if (event.message.role === 'assistant') state.observe(event.message);
    else if (event.message.role === 'toolResult') state.result(event.message);
  });
  pi.on('tool_execution_start', e => { if (enabled) state.tool(e.toolCallId, e.toolName, e.parentToolCallId, undefined, e.args); });
  pi.on('tool_execution_end', e => {
    if (enabled) state.tool(e.toolCallId, e.toolName, e.parentToolCallId, e.isError ? 'err' : 'ok');
  });
  pi.on('turn_end', e => { if (enabled) state.bind(e.messageEntryId); });
  pi.on('agent_settled', (e, ctx) => {
    if (!enabled) return;
    const fallback = !state.message ? ctx.sessionManager.getBranch().findLast(entry => entry.type === 'message' && entry.message.role === 'user') : undefined;
    state.settle(e.aborted, fallback?.id);
    requestRender?.();
  });
  pi.on('session_tree', (_e, ctx) => { if (enabled) { restore(ctx); requestRender?.(); } });
  pi.on('session_shutdown', (_e, ctx) => {
    enabled = false; release?.(); release = undefined; requestRender = undefined;
    if (ctx.mode === 'tui') ctx.ui.setWidget('pi-activity-summary/bridge', undefined);
  });
}

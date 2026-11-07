import { test, expect } from 'bun:test';
import { TuiMainScreen, ProcessTerminal, formatProgramStatus, stripTerminalSequences } from '@earendil-works/pi-tui';
import { UserMessageComponent, AssistantMessageComponent, initTheme } from '@earendil-works/pi-coding-agent';
import { mount, unwrapTui, type Host } from '../src/bridge.ts';
// This file also runs by itself: never rely on InteractiveMode in another test
// file to initialize the shared theme. Disable its watcher to keep no resources.
initTheme('dark', false);
const A = '\x1b]133;A\x07';
class Terminal extends ProcessTerminal {
  output = '';
  get columns() { return 100; } get rows() { return 30; }
  write(data: string) { this.output += data; }
  hideCursor() {} showCursor() {}
}
function setup() {
  const terminal = new Terminal();
  Reflect.set(terminal, 'programStatusSupported', true);
  Reflect.set(terminal, 'programStatus', { state: 'working', app: 'pi' });
  const tui = new TuiMainScreen(terminal);
  tui.requestRender = () => {}; // unit tests flush explicitly, no leaked render timers
  const user = new UserMessageComponent('ACTUAL USER 中文😀');
  const assistant = new AssistantMessageComponent();
  assistant.updateContent({ role: 'assistant', content: [{ type: 'text', text: 'ACTUAL ASSISTANT' }],
    api: 'openai-completions', provider: 'fixture', model: 'fake', stopReason: 'stop', timestamp: 1,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  tui.addChild(user); tui.addChild(assistant);
  Reflect.set(tui, 'stopped', false);
  const flush = () => { terminal.output = ''; Reflect.get(tui, 'doRender').call(tui); return terminal.output; };
  return { tui, host: tui as unknown as Host, terminal, user, assistant, flush };
}
test('only real user nodes get markers; assistants and tool-like text do not', () => {
  const s = setup(); const original = s.user.render;
  const baseline = s.host.render(100).map(stripTerminalSequences);
  const bridge = mount(s.host, '1.5.0', formatProgramStatus, () => {});
  const output = s.flush();
  expect(output.match(/\x1b\]133;A\x07/g)).toHaveLength(1);
  expect(stripTerminalSequences(output)).toContain('ACTUAL ASSISTANT');
  expect(s.host.render(100).map(stripTerminalSequences)).toEqual(baseline);
  expect(s.user.render).toBe(original); expect(Object.hasOwn(s.user, 'render')).toBe(false);
  bridge.dispose();
});
test('temporary node hooks are restored even if the original renderer throws', () => {
  const s = setup(); const original = s.user.render;
  const component = { render() { throw new Error('original renderer failure'); }, invalidate() {} };
  s.tui.addChild(component);
  const bridge = mount(s.host, '1.5.0', formatProgramStatus, () => {});
  expect(() => s.host.render(100)).toThrow('original renderer failure');
  expect(s.user.render).toBe(original); expect(Object.hasOwn(s.user, 'render')).toBe(false);
  bridge.dispose();
});
test('immutable user component disables enhancement without damaging native output', async () => {
  const s = setup(); const warnings: string[] = [];
  Object.defineProperty(s.user, 'render', { configurable: false, writable: false, value: s.user.render });
  const bridge = mount(s.host, '1.5.0', formatProgramStatus, msg => warnings.push(msg));
  const output = s.flush(); expect(output).not.toContain(A);
  expect(stripTerminalSequences(output)).toContain('ACTUAL USER');
  expect(bridge.active).toBe(false); await Promise.resolve(); expect(warnings).toHaveLength(1);
});
test('real stable reference unwraps to the active renderer; mode replacement fails closed', async () => {
  const s = setup(); let current: object = s.tui;
  // Same forwarding semantics as Pi 1.5 createInteractiveTuiReference.
  const reference = new Proxy({}, {
    get: (_, key) => { const value = Reflect.get(current, key); return typeof value === 'function' ? (...args: any[]) => value.apply(current, args) : value; },
    set: (_, key, value) => Reflect.set(current, key, value),
  });
  expect(unwrapTui(reference)).toBe(s.tui);
  const warnings: string[] = [];
  const bridge = mount(unwrapTui(reference), '1.5.0', formatProgramStatus, msg => warnings.push(msg), () => unwrapTui(reference));
  expect(s.flush()).toContain(A);
  current = { mode: 'fullscreen' };
  s.terminal.output = ''; s.terminal.write('fullscreen frame');
  expect(bridge.active).toBe(false); expect(s.terminal.output).toBe('fullscreen frame');
  await Promise.resolve(); expect(warnings).toHaveLength(1);
});
test('overlays keep exact native visible output and user hooks never remain installed', () => {
  const s = setup();
  const overlay = { render: () => ['OVERLAY 中文😀'], invalidate() {} };
  s.tui.showOverlay(overlay, { anchor: 'top-left', width: 30 });
  const composite = () => Reflect.get(s.tui, 'compositeOverlays').call(s.tui, s.host.render(100), 100, 30).map(stripTerminalSequences);
  const baseline = composite();
  const bridge = mount(s.host, '1.5.0', formatProgramStatus, () => {});
  expect(baseline.join('\n')).toContain('OVERLAY');
  expect(composite()).toEqual(baseline);
  s.flush();
  expect(Object.hasOwn(s.user, 'render')).toBe(false);
  s.tui.hideOverlay();
  s.tui.invalidate(); s.flush();
  bridge.dispose();
});

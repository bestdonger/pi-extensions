import { test, expect } from 'bun:test';
import { Container, ProcessTerminal, TuiMainScreen, formatProgramStatus, stripTerminalSequences } from '@earendil-works/pi-tui';
import { UserMessageComponent } from '@earendil-works/pi-coding-agent';
import { isRex, mount, StatusReplay, unwrapTui, type Host } from '../src/bridge.ts';
const A = '\x1b]133;A\x07', B = '\x1b]133;B\x07', C = '\x1b]133;C\x07';
class MemoryTerminal extends ProcessTerminal {
  output = '';
  columnsValue = 80; rowsValue = 20;
  get columns() { return this.columnsValue; } get rows() { return this.rowsValue; }
  write(data: string) { this.output += data; }
  hideCursor() {} showCursor() {}
}
function fixture(lines = [A + 'user one', B + C + 'end', 'assistant', A + 'user two', B + C + 'end']) {
  const terminal = new MemoryTerminal();
  Reflect.set(terminal, 'programStatusSupported', true);
  Reflect.set(terminal, 'programStatus', { state: 'working', app: 'pi', message: 'fixture' });
  const tui = new TuiMainScreen(terminal);
  tui.requestRender = () => {}; // unit tests flush explicitly, no leaked render timers
  class FixtureUser extends UserMessageComponent {
    render() { return lines; }
  }
  const content = new FixtureUser('fixture');
  tui.addChild(content);
  const host = tui as unknown as Host;
  const frames = () => {
    terminal.output = '';
    Reflect.set(tui, 'stopped', false);
    Reflect.get(tui, 'doRender').call(tui);
    return terminal.output;
  };
  return { tui, host, terminal, lines, frames };
}
test('only direct Rex pane contexts are eligible', () => {
  expect(isRex({ REX_SESSION: 's', REX_BLOCK: 'b' })).toBe(true);
  for (const env of [{}, { TERM_PROGRAM: 'Rex' }, { REX_SESSION: 's' },
    { REX_SESSION: 's', REX_BLOCK: 'b', TMUX: 'x' }, { REX_SESSION: 's', REX_BLOCK: 'b', STY: 'x' }]) expect(isRex(env)).toBe(false);
});
test('real regular renderer strips native markers; adapter restores them with exact native status', () => {
  const f = fixture();
  expect(f.frames()).not.toContain(A);
  const raw = f.host.render(80);
  const bridge = mount(f.host, '1.5.0', formatProgramStatus, () => {});
  const rendered = f.host.render(80);
  expect(rendered.map(stripTerminalSequences)).toEqual(raw.map(stripTerminalSequences));
  const output = f.frames();
  expect(output.match(/\x1b\]133;A\x07/g)).toHaveLength(2);
  expect(output.split(A).slice(1).every(s => s.startsWith(formatProgramStatus(Reflect.get(f.terminal, 'programStatus'))))).toBe(true);
  expect(bridge.promptsWritten).toBe(2);
  const unchanged = f.frames();
  expect(unchanged).not.toContain(A); // no extra work on spinner/editor-only frames
  bridge.dispose();
  expect(f.frames()).not.toContain(A);
});
test('replay accepts every byte split for BEL/ST markers and never duplicates completions', () => {
  for (const marker of [A, '\x1b]133;A\x1b\\']) for (let at = 0; at <= marker.length; at++) {
    const replay = new StatusReplay();
    const output = replay.apply('prefix' + marker.slice(0, at), 'STATUS') + replay.apply(marker.slice(at) + 'suffix', 'STATUS');
    expect(output).toBe('prefix' + marker + 'STATUSsuffix'); expect(replay.prompts).toBe(1);
    expect(replay.apply('next', 'STATUS')).toBe('next'); expect(replay.prompts).toBe(1);
  }
  const replay = new StatusReplay();
  expect([...A].map(c => replay.apply(c, 'S')).join('')).toBe(A + 'S');
});
for (const state of ['done', 'error']) test(`redrawing three user prompts never re-reports persistent ${state}`, () => {
  const f = fixture([A + 'user one', B + C, A + 'user two', B + C, A + 'user three', B + C]);
  const status = { state, app: 'pi', message: 'result ready' };
  Reflect.set(f.terminal, 'programStatus', status);
  const bridge = mount(f.host, '1.5.0', formatProgramStatus, () => {});
  try {
    const output = f.frames();
    expect(output.match(/\x1b\]133;A\x07/g)).toHaveLength(3);
    expect(output).not.toContain('\x1b]7501;');
    f.terminal.columnsValue--;
    const resized = f.frames();
    expect(resized.match(/\x1b\]133;A\x07/g)).toHaveLength(3);
    expect(resized).not.toContain('\x1b]7501;');
    expect(Reflect.get(f.terminal, 'programStatus')).toBe(status);
    expect(bridge.promptsWritten).toBe(6);
  } finally { bridge.dispose(); }
});

test('only prompt-sensitive status transitions replay without changing render cache', () => {
  const f = fixture();
  const bridge = mount(f.host, '1.5.0', formatProgramStatus, () => {});
  const before = f.host.render(80);
  for (const state of ['working', 'blocked', 'done', 'error', 'idle', 'clear']) {
    const status = { state, app: 'pi', kind: 'question', message: 'safe session name' };
    Reflect.set(f.terminal, 'programStatus', status);
    expect(f.host.render(80)).toEqual(before);
    f.terminal.output = ''; f.terminal.write(A);
    const report = ['working', 'blocked', 'idle'].includes(state) ? formatProgramStatus(status as any) : '';
    expect(f.terminal.output).toBe(A + report);
  }
  // Negotiated support is not forced on, and cleared status is never recreated.
  Reflect.set(f.terminal, 'programStatusSupported', false);
  f.terminal.output = ''; f.terminal.write(A); expect(f.terminal.output).toBe(A);
  Reflect.set(f.terminal, 'programStatusSupported', true);
  Reflect.set(f.terminal, 'programStatus', undefined);
  f.terminal.output = ''; f.terminal.write(A); expect(f.terminal.output).toBe(A);
  bridge.dispose();
});
test('new messages, stream updates, tool rows and resizes keep original visible layout', () => {
  const f = fixture(); const bridge = mount(f.host, '1.5.0', formatProgramStatus, () => {});
  f.frames();
  f.lines.push('tool start', 'tool result', A + '中文😀 new prompt', B + C + '', 'stream token 1');
  const newOutput = f.frames(); expect(newOutput).toContain(A); expect(newOutput).toContain('tool result');
  f.lines[f.lines.length - 1] += ' token 2';
  expect(f.frames()).not.toContain(A);
  f.terminal.columnsValue = 40; f.terminal.rowsValue = 10;
  const resized = f.frames(); expect(resized).toContain('\x1b[3J'); expect(resized.match(/\x1b\]133;A\x07/g)).toHaveLength(3);
  bridge.dispose();
});
test('dispose is idempotent and restores original own descriptors; reload never nests wrappers', () => {
  const f = fixture(); const originalRender = f.host.render, originalWrite = f.terminal.write;
  for (let i = 0; i < 5; i++) {
    const bridge = mount(f.host, '1.5.0', formatProgramStatus, () => {});
    expect(() => mount(f.host, '1.5.0', formatProgramStatus, () => {})).toThrow('已挂载');
    bridge.dispose(); bridge.dispose();
    expect(f.host.render).toBe(originalRender); expect(f.terminal.write).toBe(originalWrite);
    expect(Object.hasOwn(f.host, 'render')).toBe(false); expect(Object.hasOwn(f.terminal, 'write')).toBe(false);
  }
});
test('later extensions are not overwritten by cleanup', () => {
  const f = fixture(); const bridge = mount(f.host, '1.5.0', formatProgramStatus, () => {});
  const priorRender = f.host.render, priorWrite = f.terminal.write;
  const nextRender = function (w: number) { return priorRender.call(f.host, w); };
  const nextWrite = function (data: string) { return priorWrite.call(f.terminal, data); };
  f.host.render = nextRender; f.terminal.write = nextWrite;
  bridge.dispose();
  expect(f.host.render).toBe(nextRender); expect(f.terminal.write).toBe(nextWrite);
  expect(f.host.render(80)[0]).toBe(A + 'user one');
  f.terminal.output = ''; f.terminal.write(A); expect(f.terminal.output).toBe(A);
});
test('unverified versions, renderer ABI changes and immutable hosts refuse installation', () => {
  const f = fixture(); const original = f.terminal.write;
  expect(() => mount(f.host, '1.6.0', formatProgramStatus, () => {})).toThrow('未验证');
  f.host.mode = 'fullscreen'; expect(() => mount(f.host, '1.5.0', formatProgramStatus, () => {})).toThrow('regular');
  f.host.mode = 'regular';
  Object.defineProperty(f.host, 'render', { value: f.host.render, configurable: false, writable: false });
  expect(() => mount(f.host, '1.5.0', formatProgramStatus, () => {})).toThrow();
  expect(f.terminal.write).toBe(original);
  const g = fixture(); g.host.doRender = () => {};
  expect(() => mount(g.host, '1.5.0', formatProgramStatus, () => {})).toThrow('渲染器已变化');
});
test('incompatible runtime disables once and leaves native rendering functional', async () => {
  const f = fixture(); const warnings: string[] = [];
  const bridge = mount(f.host, '1.5.0', formatProgramStatus, s => warnings.push(s));
  Reflect.set(f.terminal, 'programStatus', { state: 'unknown' });
  expect(f.host.render(80)[0]).toBe(A + 'user one');
  expect(bridge.active).toBe(false); await Promise.resolve(); expect(warnings).toHaveLength(1);
  expect(f.frames()).not.toContain(A);
});
test('unsupported status formatter fails closed, including after activation', async () => {
  const f = fixture(); let broken = false; const warnings: string[] = [];
  const encode = (s: any) => { if (broken) throw new Error('broken'); return formatProgramStatus(s); };
  const bridge = mount(f.host, '1.5.0', encode, s => warnings.push(s));
  broken = true; f.terminal.write(A + 'user' + B + C);
  expect(f.terminal.output).not.toContain(A); expect(f.terminal.output).toContain('user');
  expect(bridge.active).toBe(false); await Promise.resolve(); expect(warnings).toHaveLength(1);
});
test('large writes preserve all data and restore status at split marker boundaries', () => {
  const f = fixture(); const bridge = mount(f.host, '1.5.0', formatProgramStatus, () => {});
  const large = 'x'.repeat(1024 * 1024 - 4) + A + 'tail';
  const parts = [large.slice(0, 1024 * 1024), large.slice(1024 * 1024)];
  parts.forEach(p => f.terminal.write(p));
  expect(f.terminal.output).toBe(large.replace(A, A + formatProgramStatus(Reflect.get(f.terminal, 'programStatus'))));
  expect(bridge.promptsWritten).toBe(1); bridge.dispose();
});

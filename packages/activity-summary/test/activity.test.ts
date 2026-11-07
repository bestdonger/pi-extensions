import { test, expect, afterEach } from 'bun:test';
import { AssistantMessageComponent, ToolExecutionComponent, SessionManager, initTheme } from '@earendil-works/pi-coding-agent';
import { Container, TuiMainScreen, visibleWidth } from '@earendil-works/pi-tui';
import { ActivityState } from '../src/state.ts';
import { clean, format, snapshot } from '../src/text.ts';
import { mount, Projection } from '../src/bridge.ts';

initTheme('dark', false);
export function message(content: any[], stopReason = 'stop'): any {
  return { role: 'assistant', content, api: 'openai-completions', provider: 'fixture', model: 'fixture', timestamp: 1000,
    stopReason, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
const thought = (thinking = '检查配置') => ({ type: 'thinking', thinking });
const text = (text = 'Commentary') => ({ type: 'text', text });
const tool = (id: string) => ({ type: 'toolCall', id, name: 'probe', arguments: {} });
const releases: (() => void)[] = [];
afterEach(() => { for (const f of releases.splice(0)) f(); });
class Terminal {
  columns = 80; rows = 12; output = '';
  start() {} stop() {} write(s: string) { this.output += s; }
  hideCursor() {} showCursor() {} moveBy() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {}
}
class QuietTui extends TuiMainScreen {
  requests = 0;
  requestRender() { this.requests++; }
}
function fixture(state = new ActivityState()) {
  const terminal = new Terminal();
  const tui = new QuietTui(terminal as any);
  const document = new Container(), source = new Container();
  document.addChild(new Container()); document.addChild(new Container()); document.addChild(source); tui.addChild(document);
  let warnings = 0;
  const release = mount(tui, () => state, s => s, () => warnings++);
  expect(release).toBeFunction(); releases.push(release!);
  return { tui, terminal, document, source, state, release: release!, warnings: () => warnings,
    render: (width = 80) => document.render(width), plain: () => Bun.stripANSI(document.render(80).join('\n')) };
}
test('segmentation counts each nonempty thinking block, prose streams without extra row', () => {
  const s = new ActivityState();
  s.start(message([text('plain')])); s.bind('pure'); expect(s.groups).toHaveLength(0);
  s.start(message([thought(), text(), thought('second'), tool('one')])); s.bind('a');
  expect(s.groups).toHaveLength(2);
  expect(s.groups.map(g => g.thoughts)).toEqual([1, 1]);
  expect(s.groups[0].closed).toBe(true);
  expect(snapshot(s.groups[1]).steps).toBe(2);
  s.tool('one', 'probe', undefined, 'ok');
  s.start(message([text('answer')])); s.bind('b');
  expect(s.groups).toHaveLength(2); expect(s.groups[1].thoughts).toBe(1);
});
test('parallel top-level tools unique, nested calls excluded, missing result open', () => {
  const s = new ActivityState(); const m = message([thought(), tool('a'), tool('b'), tool('c')]);
  s.start(m); s.observe(m); s.observe(m);
  s.tool('a', 'probe'); s.tool('b', 'probe');
  s.tool('a/1', 'nested', 'a'); s.tool('a/1/1', 'deep', 'a/1');
  s.tool('a/1', 'nested', 'a', 'err'); s.tool('b', 'probe', undefined, 'ok');
  s.tool('a', 'probe', undefined, 'ok');
  expect(snapshot(s.groups[0])).toEqual({ theme: 'probe', steps: 4, failed: 0, background: 'toolPendingBg' });
  s.boundary(); s.start(message([thought('new')]));
  s.tool('a/late', 'nested', 'a', 'err');
  expect(s.groups[0].tools.size).toBe(3); expect(s.groups[1].tools.size).toBe(0);
});
test('silent model retries add no steps; final failure/abort concise, tool errors not model failures', () => {
  const s = new ActivityState();
  s.start(message([thought()], 'error')); s.bind('a');
  s.start(message([], 'error')); s.bind('b');
  expect(snapshot(s.groups[0]).steps).toBe(1); expect(s.notice).toBe('');
  s.settle(false); expect(s.message?.notice).toBe('模型请求失败');
  s.start(message([tool('c')], 'toolUse')); s.tool('c', 'probe', undefined, 'err'); s.settle(false);
  expect(s.notice).toBe(''); s.settle(true); expect(s.notice).toBe('操作已中断');
});
test('queued user boundary splits without agent_settled', () => {
  const s = new ActivityState(); s.start(message([tool('a')]));
  s.boundary(); s.start(message([thought()]));
  expect(s.groups).toHaveLength(2); expect(s.groups.map(g => g.thoughts)).toEqual([0, 1]);
});
for (const [stop, completion, notice] of [
  ['length', 'incomplete', '模型输出已达长度上限'], ['error', 'error', '模型请求失败'],
  ['aborted', 'incomplete', '操作已中断'], ['stop', 'complete', ''], ['toolUse', 'unknown', ''],
]) test(`user boundary settles ${stop} like replay without waiting for agent_settled`, () => {
  const first = message([thought('First')], stop), next = message([thought('Next')]);
  const s = new ActivityState(); s.start(first); s.bind('first'); s.userBoundary();
  expect(s.groups[0].completion).toBe(completion);
  expect(s.byId.get('first')?.notice).toBe(notice);
  s.start(next); s.bind('next'); s.settle(false);
  const restored = new ActivityState();
  restored.restore([
    { type: 'message', id: 'first', message: first },
    { type: 'message', id: 'user', message: { role: 'user', content: 'Follow-up' } },
    { type: 'message', id: 'next', message: next },
  ]);
  expect(s.groups.map(snapshot)).toEqual(restored.groups.map(snapshot));
  expect(s.byId.get('first')?.notice).toBe(restored.byId.get('first')?.notice);
});
test('a later user boundary preserves an already-settled abort even when the model stopped normally', () => {
  const s = new ActivityState(); s.start(message([thought()], 'stop')); s.bind('aborted');
  s.settle(true); s.userBoundary(); s.userBoundary();
  expect(s.groups[0].completion).toBe('incomplete');
  expect(s.byId.get('aborted')?.notice).toBe('操作已中断');
  expect(s.orphanNotices).toEqual([]);
});
test('ANSI/OSC/CJK/emoji widths exactly one row', () => {
  const s = new ActivityState(); s.start(message([thought('标题👨‍👩‍👧‍👦中文\x1b[31mred\x1b[0m\x1b]52;c;secret\x07\nnew\rline')]));
  for (const width of [1,2,8,40,80]) {
    const line = format(snapshot(s.groups[0]), width, t => `\x1b[2m${t}\x1b[0m`);
    expect(visibleWidth(line)).toBeLessThanOrEqual(width); expect(line).not.toMatch(/[\r\n]/);
    expect(line).not.toContain('secret');
  }
  expect(clean('\x1b]8;;url\x1b\\visible\x1b]8;;\x1b\\')).not.toContain('\x1b');
});
test('native prose keeps transformers, metadata, pad; bodies never rendered; source unchanged', () => {
  const seen: any[] = []; const s = new ActivityState();
  const m = message([thought('Theme\n\nSECRET THINKING BODY'), text('Visible prose'), tool('a')]);
  s.start(m); s.bind('saved-id'); s.tool('a', 'probe', undefined, 'err');
  const f = fixture(s); const before = JSON.stringify(m);
  const native = new AssistantMessageComponent(m, false, undefined, undefined, 2,
    [(value: string, ctx: any) => { seen.push(ctx); return value + ' transformed'; }], 'saved-id', '2026-01-01T00:00:00.000Z');
  const t = new ToolExecutionComponent('probe', 'a', {}, undefined, undefined, f.tui, '/tmp');
  t.updateResult({ content: [{ type: 'text', text: 'SECRET TOOL ERROR\nstack trace' }], isError: true });
  f.source.addChild(native); f.source.addChild(t);
  const result = f.plain();
  expect(result).toContain('Visible prose transformed'); expect(result).not.toContain('SECRET TOOL ERROR');
  // Theme is allowed to quote an existing short paragraph, but never renders the full thinking body.
  expect(result.split('\n').filter(l => /\bstep(?:s)?\b/.test(l))).toHaveLength(2);
  expect(seen.at(-1)).toMatchObject({ messageId: 'saved-id', timestamp: '2026-01-01T00:00:00.000Z', messageType: 'assistant' });
  expect(JSON.stringify(m)).toBe(before); expect((native as any).lastMessage).toBe(m);
  f.release(); expect(f.document.children[2]).toBe(f.source);
  expect(f.plain()).toContain('SECRET TOOL ERROR');
});
test('regular main screen captured terminal renders no tool body', () => {
  const s = new ActivityState(); const m = message([thought('Working'), tool('x')]); s.start(m);
  const f = fixture(s);
  f.source.addChild(new AssistantMessageComponent(m));
  const t = new ToolExecutionComponent('probe', 'x', {}, undefined, undefined, f.tui, '/tmp');
  t.updateResult({ content: [{ type: 'text', text: 'HIDDEN RESULT' }], isError: false }); f.source.addChild(t);
  // Exercise the real regular renderer, including its previous-viewport tracking.
  (f.tui as any).doRender();
  expect(f.terminal.output).toContain('steps'); expect(f.terminal.output).not.toContain('HIDDEN RESULT');
});
test('unsupported roots/modes fail open and leaving regular restores source once', () => {
  const s = new ActivityState(); const tui = new QuietTui(new Terminal() as any);
  expect(mount(tui, () => s, x => x, () => {})).toBeUndefined();
  const f = fixture(s); f.source.addChild({ render: () => ['native'], invalidate() {} });
  (f.tui as any).mode = 'fullscreen'; expect(f.render()).toEqual(['native']);
  expect(f.warnings()).toBe(1); expect(f.document.children[2]).toBe(f.source); f.render(); expect(f.warnings()).toBe(1);
});
test('raw result replay is exact, branch-local, and does not add context metadata', () => {
  const sm = SessionManager.inMemory('/tmp'); const s = new ActivityState();
  const m = message([thought(), tool('a')]); s.start(m); const id = sm.appendMessage(m); s.bind(id);
  s.tool('a/1', 'nested', 'a', 'err'); s.tool('a', 'probe', undefined, 'ok'); s.settle(false);
  sm.appendMessage({ role: 'toolResult', toolCallId: 'a', toolName: 'probe', content: [], isError: false, timestamp: 1001 });
  const restored = new ActivityState(); restored.restore(sm.getBranch());
  expect(snapshot(restored.groups[0])).toEqual(snapshot(s.groups[0]));
  expect(sm.buildSessionContext().messages.some((m: any) => m.role === 'custom')).toBe(false);
  sm.branch(id); const other = new ActivityState(); other.restore(sm.getBranch());
  expect(snapshot(other.groups[0])).toMatchObject({ steps: 2, failed: 0, background: 'toolPendingBg' });
});
test('cached fields are <=4Hz despite native renders; prose freeze and offscreen freeze', () => {
  let now = 0; const s = new ActivityState(); const m = message([thought(), tool('a')]); s.start(m);
  const f = fixture(s); f.release(); f.source.addChild(new AssistantMessageComponent(m));
  const p = new Projection(f.source, () => s, f.tui, () => 0, x => x, () => true, () => {}, () => now); releases.push(() => p.dispose());
  const first = p.render(80); s.tool('a', 'probe', undefined, 'err');
  now = 100; expect(p.render(80)).toEqual(first);
  now = 250; expect(p.render(80).join()).toContain('1 failed');
  (f.tui as any).previousViewportTop = 1;
  m.content.push(tool('b')); s.observe(m); now = 500;
  expect(p.render(80).join()).toContain('2 steps'); expect(s.groups[0].tools.size).toBe(2);
  (f.tui as any).previousViewportTop = 0; now = 1000;
  expect(p.render(80).join()).toContain('2 steps');
  p.dispose(); const requests = f.tui.requests;
  expect(f.tui.requests).toBe(requests);
});
test('settlement flushes once within 250ms, then freezes; disposal cancels delayed requests', async () => {
  let now = 0; const s = new ActivityState(); const m = message([tool('a')]); s.start(m);
  const f = fixture(s); f.release(); f.source.addChild(new AssistantMessageComponent(m));
  const p = new Projection(f.source, () => s, f.tui, () => 0, x => x, () => true, () => {}, () => now);
  p.render(80); s.tool('a', 'probe', undefined, 'ok'); s.settle(false); now = 100;
  expect(p.render(80).join()).toContain('• probe · 1 step'); now = 250;
  expect(p.render(80).join()).toContain('• probe · 1 step');
  p.dispose(); const requests = f.tui.requests; await Bun.sleep(170); expect(f.tui.requests).toBe(requests);
});

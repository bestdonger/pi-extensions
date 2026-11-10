import { test, expect } from 'bun:test';
import { AssistantMessageComponent, ToolExecutionComponent, getPackageDir, initTheme } from '@earendil-works/pi-coding-agent';
import { Container, Text, MouseRegion, TuiAltScreen, visibleWidth, type TuiMouseEvent } from '@earendil-works/pi-tui';
import { ActivityState } from '../src/state.ts';
import { mount, Projection } from '../src/bridge.ts';

initTheme('dark', false);
const { getThemeByName } = await import(`${getPackageDir()}/dist/modes/interactive/theme/theme.js`);
const thought = (title: string) => ({ type: 'thinking', thinking: `**${title}**\n\nDETAIL_${title}` });
const prose = (text: string) => ({ type: 'text', text });
const call = (id: string) => ({ type: 'toolCall', id, name: 'probe', arguments: { path: `${id}.ts` } });
const message = (content: any[], stopReason = 'stop'): any => ({ role: 'assistant', content, stopReason, timestamp: 1000 });
class Terminal {
  columns = 90; rows = 14; output = '';
  start() {} stop() {} write(data: string) { this.output += data; }
  hideCursor() {} showCursor() {} moveBy() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {}
}
class QuietTui extends TuiAltScreen { requestRender() {} }
function fixture() {
  const terminal = new Terminal(), tui = new QuietTui(terminal as any, false, undefined, { copyOnSelect: false });
  let state = new ActivityState(), expanded = false, theme = getThemeByName('dark')!;
  const document = new Container(), source = new Container();
  document.addChild(new Container()); document.addChild(new Container()); document.addChild(source); tui.addChild(document);
  const release = mount(tui, () => state, text => theme.fg('dim', text), () => { throw new Error('unexpected fail-open'); }, () => theme, () => expanded)!;
  const projection = document.children[2] as Projection;
  const render = (width = terminal.columns) => document.render(width);
  const event = (type: TuiMouseEvent['type'], y: number, extra: Partial<TuiMouseEvent> = {}): TuiMouseEvent => ({
    type, button: 'left', x: 2, y, screenX: 2, screenY: y, width: terminal.columns, height: render().length,
    shift: false, alt: false, ctrl: false, ...extra,
  });
  return { terminal, tui, document, source, projection, release, render, event,
    get state() { return state; },
    replaceState(next: ActivityState) { state = next; },
    plain: () => Bun.stripANSI(render().join('\n')),
    click(title: string, padding = 0) {
      const y = render().findIndex(line => Bun.stripANSI(line).includes(title) && /steps?/.test(line)) + padding;
      expect(y).toBeGreaterThanOrEqual(0);
      projection.handleMouse(event('press', y)); projection.handleMouse(event('click', y)); render();
    },
    setExpanded(value: boolean) {
      expanded = value;
      for (const child of source.children) if (child instanceof ToolExecutionComponent) child.setExpanded(value);
    },
    nativeClick(text: string) {
      tui.renderNow();
      const y = tui.getScreenLines().findIndex(line => Bun.stripANSI(line).includes(text));
      expect(y).toBeGreaterThanOrEqual(0);
      const route = (tui as any).handleMouseEvent.bind(tui);
      route({ button: 0, x: 2, y, release: false }); route({ button: 0, x: 2, y, release: true });
      tui.renderNow();
    },
    setTheme(name: string) { theme = getThemeByName(name)!; document.invalidate(); },
    assistant(m: any, id: string) {
      state.start(m); state.bind(id);
      const node = new AssistantMessageComponent(m, true, undefined, '', 2, [], id);
      source.addChild(node); return node;
    },
    tool(id: string, definition?: any) {
      const node = new ToolExecutionComponent('probe', id, { path: `${id}.ts` }, { outputPad: 2 }, definition, tui, '/tmp');
      node.setExpanded(expanded);
      node.updateResult({ content: Array.from({ length: 35 }, (_, i) => prose(`RESULT_${id}_${i}`)), isError: false });
      state.tool(id, 'probe', undefined, 'ok'); source.addChild(node); return node;
    },
  };
}

test('fullscreen mounts without regular viewport internals, uses the same three-row themed headers', () => {
  const f = fixture();
  try {
    expect(f.release).toBeFunction(); expect('previousViewportTop' in f.tui).toBe(false);
    f.assistant(message([thought('中文👨‍👩‍👧‍👦'), call('a')]), 'one'); f.tool('a'); f.state.settle(false);
    const original = JSON.stringify((f.source.children[0] as any).lastMessage);
    for (const theme of ['dark', 'light']) {
      f.setTheme(theme);
      for (const width of [1, 2, 8, 40, 90]) {
        const lines = f.render(width);
        expect(lines).toHaveLength(4); expect(lines[0]).toBe(''); expect(lines[1]).toBe(lines[3]);
        for (const row of lines.slice(1)) {
          expect(visibleWidth(row)).toBe(width);
          expect(row).toContain(getThemeByName(theme)!.getBgAnsi('toolSuccessBg'));
        }
        expect(Bun.stripANSI(lines[2]).trimEnd()).toEndWith('›');
      }
    }
    expect(f.plain()).not.toContain('DETAIL_'); expect(f.plain()).not.toContain('RESULT_');
    expect(JSON.stringify((f.source.children[0] as any).lastMessage)).toBe(original);
  } finally { f.release(); }
});

test('clicking any header row expands only that group; Ctrl+O replaces all local overrides', () => {
  const f = fixture();
  try {
    f.assistant(message([thought('First'), call('a'), prose('MIDDLE')]), 'one'); const a = f.tool('a');
    f.assistant(message([thought('Second'), call('b')]), 'two'); const b = f.tool('b'); f.state.settle(false);
    f.click('probe: a.ts', -1); // Top padding is clickable too.
    expect(f.plain()).toContain('DETAIL_First'); expect(f.plain()).toContain('RESULT_a_34');
    expect(f.plain()).not.toContain('DETAIL_Second'); expect(f.plain()).not.toContain('RESULT_b_0');
    expect((a as any).expanded).toBe(true); expect((b as any).expanded).toBe(false);
    f.setExpanded(true);
    expect(f.plain()).toContain('RESULT_a_34'); expect(f.plain()).toContain('RESULT_b_34');
    f.click('probe: b.ts');
    expect(f.plain()).toContain('DETAIL_First'); expect(f.plain()).not.toContain('DETAIL_Second');
    f.setExpanded(false);
    expect(f.plain()).not.toContain('DETAIL_'); expect(f.plain()).not.toContain('RESULT_');
    f.click('probe: b.ts', 1); // Bottom padding.
    expect(f.plain()).toContain('RESULT_b_34'); expect(f.plain()).not.toContain('RESULT_a_0');
    f.click('probe: b.ts'); expect(f.plain()).not.toContain('RESULT_');
  } finally { f.release(); }
});

test('local expansion follows new streaming tools and restores native flags on disposal', () => {
  const f = fixture();
  try {
    const m = message([thought('Live')], 'pending'); const assistant = f.assistant(m, 'one');
    f.click('Live'); expect(f.plain()).toContain('DETAIL_Live');
    m.content.push(call('late')); f.state.observe(m); assistant.updateContent(m, true); const tool = f.tool('late');
    expect(f.plain()).toContain('RESULT_late_34'); expect((tool as any).expanded).toBe(true);
    f.release(); expect(f.document.children[2]).toBe(f.source); expect((tool as any).expanded).toBe(false);
    f.release(); // Idempotent cleanup, including any throttling timer.
  } finally { f.release(); }
});

test('history/branch replacement resets local expansion and releases old tool UI flags', () => {
  const f = fixture();
  try {
    const m = message([thought('History'), call('a')]); f.assistant(m, 'one'); const tool = f.tool('a'); f.state.settle(false);
    f.click('probe: a.ts'); expect((tool as any).expanded).toBe(true);
    const next = new ActivityState(); next.restore([
      { type: 'message', id: 'one', message: m },
      { type: 'message', id: 'result', message: { role: 'toolResult', toolCallId: 'a', toolName: 'probe', content: [], isError: false } },
    ]);
    f.replaceState(next);
    expect(f.plain()).not.toContain('DETAIL_History'); expect((tool as any).expanded).toBe(false);
    f.click('probe: a.ts'); expect(f.plain()).toContain('DETAIL_History');
  } finally { f.release(); }
});

test('fullscreen delayed failures update offscreen closed rows instead of inheriting regular scrollback freezing', async () => {
  const f = fixture();
  try {
    f.assistant(message([call('a'), prose('answer\n\n' + 'long prose\n\n'.repeat(50))]), 'one');
    f.tui.start(); f.tui.renderNow(); expect(f.tui.viewportTop).toBeGreaterThan(0);
    f.state.tool('a', 'probe', undefined, 'err');
    await Bun.sleep(260);
    expect(f.plain()).toContain('1 step · 1 failed');
    f.tui.scrollToTop(); f.tui.renderNow();
    expect(Bun.stripANSI(f.tui.getScreenLines().join('\n'))).toContain('1 failed');
    expect(f.render()[2]).toContain(getThemeByName('dark')!.getBgAnsi('toolErrorBg'));
  } finally { f.release(); f.tui.stop(); }
});

test('mouse delegation preserves child coordinates, native capture and focus targets', () => {
  const f = fixture(); const seen: TuiMouseEvent[] = [];
  try {
    const body = new MouseRegion(new Text('CUSTOM_BODY', 0, 0), event => {
      seen.push(event); return { capture: true, focus: true };
    });
    f.assistant(message([call('a')]), 'one');
    f.tool('a', { renderShell: 'self', renderResult: () => body }); f.state.settle(false); f.click('probe: a.ts');
    const y = f.render().findIndex(line => line.includes('CUSTOM_BODY'));
    const result = f.projection.handleMouse(f.event('press', y, { screenY: 7 }));
    expect(seen.at(-1)?.y).toBe(0); expect(seen.at(-1)?.screenY).toBe(7);
    expect(result).toMatchObject({ handled: true, capture: true, focus: true, target: { component: body, originY: 7 } });
  } finally { f.release(); }
});

test('wheel/modifiers/drag gestures do not fold; a stale press cannot toggle a different group', () => {
  const f = fixture();
  try {
    f.assistant(message([thought('First'), prose('between'), thought('Second')]), 'one'); f.state.settle(false);
    const first = f.render().findIndex(line => line.includes('First'));
    const second = f.render().findIndex(line => line.includes('Second'));
    for (const extra of [{ shift: true }, { alt: true }, { ctrl: true }, { button: 'right' as const }]) {
      expect(f.projection.handleMouse(f.event('press', first, extra))).toBeUndefined();
    }
    expect(f.projection.handleMouse(f.event('wheel', first, { button: 'none', wheelDelta: -3 }))).toBeUndefined();
    f.projection.handleMouse(f.event('press', first));
    f.projection.handleMouse(f.event('drag', first + 1));
    // Pi suppresses click delivery after a drag; no local state changes on press/drag/release.
    f.projection.handleMouse(f.event('release', first + 1));
    expect(f.plain()).not.toContain('DETAIL_');
    f.projection.handleMouse(f.event('press', first)); f.projection.handleMouse(f.event('click', second));
    expect(f.plain()).not.toContain('DETAIL_');
    f.click('First'); expect(f.plain()).toContain('DETAIL_First');
  } finally { f.release(); }
});

test('late fullscreen results after a boundary retain the 250ms snapshot throttle', () => {
  const f = fixture(); let now = 0;
  try {
    f.assistant(message([call('a'), call('b'), prose('boundary')]), 'one'); f.release();
    const p = new Projection(f.source, () => f.state, f.tui, () => 0, x => x, () => true, () => {}, () => now);
    try {
      const initial = p.render(90);
      f.state.tool('a', 'probe', undefined, 'err'); now = 100; expect(p.render(90)).toEqual(initial);
      now = 250; expect(p.render(90).join()).toContain('1 failed');
      f.state.tool('b', 'probe', undefined, 'err'); now = 300; expect(p.render(90).join()).toContain('1 failed');
      now = 500; expect(p.render(90).join()).toContain('2 failed');
    } finally { p.dispose(); }
  } finally { f.release(); }
});

test('fullscreen resize and theme invalidation retain local folds and rebuild click geometry', () => {
  const f = fixture();
  try {
    f.assistant(message([thought('Resize')]), 'one'); f.state.settle(false); f.click('Resize');
    f.terminal.columns = 32; f.terminal.rows = 10; f.setTheme('light');
    expect(f.plain()).toContain('DETAIL_Resize');
    for (const row of f.render()) expect(visibleWidth(row)).toBeLessThanOrEqual(32);
    f.click('Resize'); expect(f.plain()).not.toContain('DETAIL_Resize');
    expect(f.render()[1]).toBe(f.render()[3]);
  } finally { f.release(); }
});

for (const action of ['local', 'global', 'reset', 'dispose'] as const) test(`hidden custom body releases native keyboard focus on ${action}`, () => {
  const f = fixture(), keys: string[] = [];
  const editor = { focused: false, render: () => ['EDITOR'], invalidate() {}, handleInput(data: string) { keys.push(`editor:${data}`); } };
  const body = { focused: false, render: () => ['FOCUS_BODY'], invalidate() {},
    handleMouse: () => ({ focus: true }), handleInput(data: string) { keys.push(`body:${data}`); } };
  try {
    f.tui.addChild(editor); f.tui.setFocus(editor);
    f.assistant(message([call('a')]), 'one'); f.tool('a', { renderShell: 'self', renderResult: () => body }); f.state.settle(false);
    f.tui.start();
    if (action === 'global') f.setExpanded(true); else f.nativeClick('probe: a.ts');
    f.nativeClick('FOCUS_BODY');
    expect(f.tui.getFocusedComponent()).toBe(body); expect(body.focused).toBe(true);
    (f.tui as any).handleTerminalInput('before'); expect(keys).toEqual(['body:before']);
    if (action === 'local') f.nativeClick('probe: a.ts');
    else if (action === 'global') { f.setExpanded(false); f.tui.renderNow(); }
    else if (action === 'reset') { f.replaceState(new ActivityState()); f.tui.renderNow(); }
    else f.release();
    expect(f.tui.getFocusedComponent()).toBe(editor); expect(body.focused).toBe(false);
    (f.tui as any).handleTerminalInput('after'); expect(keys).toEqual(['body:before', 'editor:after']);
  } finally { f.release(); f.tui.stop(); }
});

test('collapsing one group preserves another body focus and repairs its return target', () => {
  const f = fixture(); f.terminal.rows = 30;
  const editor = { render: () => ['EDITOR'], invalidate() {}, handleInput() {} };
  const body = (text: string) => ({ render: () => [text], invalidate() {}, handleMouse: () => ({ focus: true }), handleInput() {} });
  const a = body('FOCUS_A'), b = body('FOCUS_B');
  try {
    f.tui.addChild(editor); f.tui.setFocus(editor);
    f.assistant(message([call('a'), prose('separator')]), 'one'); f.tool('a', { renderShell: 'self', renderResult: () => a });
    f.assistant(message([call('b')]), 'two'); f.tool('b', { renderShell: 'self', renderResult: () => b }); f.state.settle(false);
    f.tui.start(); f.nativeClick('probe: a.ts'); f.nativeClick('probe: b.ts');
    f.nativeClick('FOCUS_A'); f.nativeClick('FOCUS_B');
    f.nativeClick('probe: a.ts'); expect(f.tui.getFocusedComponent()).toBe(b);
    f.nativeClick('probe: b.ts'); expect(f.tui.getFocusedComponent()).toBe(editor);
    f.nativeClick('probe: a.ts'); f.nativeClick('probe: b.ts');
    f.nativeClick('FOCUS_A'); f.nativeClick('FOCUS_B'); f.nativeClick('FOCUS_A');
    f.nativeClick('probe: a.ts'); expect(f.tui.getFocusedComponent()).toBe(b);
    f.nativeClick('probe: b.ts'); expect(f.tui.getFocusedComponent()).toBe(editor);
  } finally { f.release(); f.tui.stop(); }
});

for (const when of ['click', 'release'] as const) test(`native gesture ${when} focus is released when its group closes`, () => {
  const f = fixture(), keys: string[] = [];
  const editor = { render: () => ['EDITOR'], invalidate() {}, handleInput(data: string) { keys.push(`editor:${data}`); } };
  const body = { render: () => ['LATE_FOCUS'], invalidate() {}, handleInput(data: string) { keys.push(`body:${data}`); },
    handleMouse(event: TuiMouseEvent) { if (event.type === 'press') return { handled: true }; if (event.type === when) return { focus: true }; } };
  try {
    f.tui.addChild(editor); f.tui.setFocus(editor);
    f.assistant(message([call('a')]), 'one'); f.tool('a', { renderShell: 'self', renderResult: () => body }); f.state.settle(false);
    f.tui.start(); f.nativeClick('probe: a.ts'); f.nativeClick('LATE_FOCUS');
    expect(f.tui.getFocusedComponent()).toBe(body);
    f.nativeClick('probe: a.ts'); expect(f.tui.getFocusedComponent()).toBe(editor);
    (f.tui as any).handleTerminalInput('after'); expect(keys).toEqual(['editor:after']);
  } finally { f.release(); f.tui.stop(); }
});

for (const method of ['request', 'direct'] as const) test(`body ${method} focus returns to a replacement editor after refocusing`, () => {
  const f = fixture();
  const editor = { render: () => ['EDITOR'], invalidate() {}, handleInput() {} };
  const replacement = { render: () => ['REPLACEMENT'], invalidate() {}, handleInput() {} };
  const body = { render: () => ['REFOCUS_BODY'], invalidate() {}, handleInput() {},
    handleMouse() { if (method === 'direct') f.tui.setFocus(body); return { focus: true }; } };
  try {
    f.tui.addChild(editor); f.tui.setFocus(editor);
    f.assistant(message([call('a')]), 'one'); f.tool('a', { renderShell: 'self', renderResult: () => body }); f.state.settle(false);
    f.tui.start(); f.nativeClick('probe: a.ts'); f.nativeClick('REFOCUS_BODY');
    f.tui.removeChild(editor); f.tui.addChild(replacement); f.tui.setFocus(replacement);
    f.nativeClick('REFOCUS_BODY'); f.nativeClick('probe: a.ts');
    expect(f.tui.getFocusedComponent()).toBe(replacement);
  } finally { f.release(); f.tui.stop(); }
});

test('a capturing overlay cannot restore focus to a body folded outside its bounds', () => {
  const f = fixture(), keys: string[] = []; f.terminal.rows = 30;
  const editor = { render: () => ['EDITOR'], invalidate() {}, handleInput(data: string) { keys.push(`editor:${data}`); } };
  const body = { render: () => ['OVERLAY_BODY'], invalidate() {}, handleMouse: () => ({ focus: true }),
    handleInput(data: string) { keys.push(`body:${data}`); } };
  try {
    f.tui.addChild(editor); f.tui.setFocus(editor);
    f.assistant(message([call('a')]), 'one'); f.tool('a', { renderShell: 'self', renderResult: () => body }); f.state.settle(false);
    f.tui.start(); f.nativeClick('probe: a.ts'); f.nativeClick('OVERLAY_BODY');
    const overlay = { render: () => ['MODAL'], invalidate() {}, handleInput() {} };
    const handle = f.tui.showOverlay(overlay, { row: 20, col: 30, width: 20 }); f.tui.renderNow();
    f.nativeClick('probe: a.ts'); expect(f.tui.getFocusedComponent()).toBe(overlay);
    expect(f.plain()).not.toContain('OVERLAY_BODY');
    handle.hide(); expect(f.tui.getFocusedComponent()).toBe(editor);
    (f.tui as any).handleTerminalInput('after'); expect(keys).toEqual(['editor:after']);
  } finally { f.release(); f.tui.stop(); }
});

for (const expansion of ['local', 'global'] as const) test(`native result clicks retain their expansion state inside ${expansion} expansion`, () => {
  const f = fixture();
  try {
    f.assistant(message([call('a')]), 'one');
    const tool = f.tool('a', { renderShell: 'self', renderResult: (_result: any, options: any) => new Text(options.expanded ? 'NATIVE_OPEN' : 'NATIVE_CLOSED', 0, 0) });
    f.state.settle(false); f.tui.start();
    if (expansion === 'global') f.setExpanded(true); else f.nativeClick('probe: a.ts');
    f.nativeClick('NATIVE_OPEN');
    expect(Reflect.get(tool, 'expanded')).toBe(false); expect(f.plain()).toContain('NATIVE_CLOSED');
    f.document.invalidate(); expect(f.plain()).toContain('NATIVE_CLOSED');
    f.nativeClick('NATIVE_CLOSED'); expect(f.plain()).toContain('NATIVE_OPEN');
    f.nativeClick('NATIVE_OPEN'); expect(f.plain()).toContain('NATIVE_CLOSED');
    f.nativeClick('probe: a.ts'); f.nativeClick('probe: a.ts'); expect(f.plain()).toContain('NATIVE_OPEN');
  } finally { f.release(); f.tui.stop(); }
});

test('a newly closed group does not cancel another closed group\'s throttled late result', async () => {
  const f = fixture(); let now = 0, requests = 0, final = '';
  f.assistant(message([call('a'), prose('boundary'), thought('Tail')], 'pending'), 'one'); f.release();
  const p = new Projection(f.source, () => f.state, f.tui, () => 0, x => x, () => true, () => {}, () => now);
  f.tui.requestRender = () => { requests++; now = 250; final = p.render(90).join('\n'); };
  try {
    p.render(90); f.state.tool('a', 'probe', undefined, 'err'); f.state.settle(false); now = 100;
    expect(p.render(90).join('\n')).not.toContain('1 failed');
    await Bun.sleep(300);
    expect(requests).toBe(1); expect(final).toContain('1 failed');
  } finally { p.dispose(); }
});

test('unsupported fullscreen layout or focus interface leaves native UI untouched', () => {
  const tui = new QuietTui(new Terminal() as any), doc = new Container(); tui.addChild(doc);
  expect(mount(tui, () => new ActivityState(), x => x, () => {})).toBeUndefined();
  expect(tui.children[0]).toBe(doc); expect(doc.children).toEqual([]);
  const source = new Container();
  doc.addChild(new Container()); doc.addChild(new Container()); doc.addChild(source);
  Object.defineProperty(tui, 'getFocusedComponent', { value: undefined, configurable: true });
  expect(mount(tui, () => new ActivityState(), x => x, () => {})).toBeUndefined();
  expect(doc.children[2]).toBe(source);
  Object.defineProperty(tui, 'getFocusedComponent', { value: () => null });
  Object.defineProperty(tui, 'retargetOverlayPreFocus', { value: undefined });
  expect(mount(tui, () => new ActivityState(), x => x, () => {})).toBeUndefined();
  expect(doc.children[2]).toBe(source);
});

import { test, expect } from 'bun:test';
import { AssistantMessageComponent, getPackageDir, initTheme } from '@earendil-works/pi-coding-agent';
import { Container, TuiMainScreen, visibleWidth } from '@earendil-works/pi-tui';
import { ActivityState } from '../src/state.ts';
import { mount, Projection } from '../src/bridge.ts';
import { renderHeader, type Stats } from '../src/text.ts';
import { paintActivityLines } from '../src/surface.ts';
import expandedLayout from './fixtures/expanded-layout-before-padding.json';

initTheme('dark', false);
const { getThemeByName } = await import(`${getPackageDir()}/dist/modes/interactive/theme/theme.js`);
const thinking = (text = '检查配置') => ({ type: 'thinking', thinking: text });
const tool = { type: 'toolCall', id: 't', name: 'probe', arguments: {} };
const message = (content: any[]): any => ({ role: 'assistant', content, stopReason: 'stop', timestamp: 1000 });
const stats: Stats = { theme: '检查配置 中文👨‍👩‍👧‍👦\x1b[31mred\x1b[0m\x1b]52;c;SECRET\x07', steps: '10', tools: '7', ok: '5', err: '1', open: '1', background: 'toolErrorBg' };

function expectBackground(line: string, expected: string, width: number) {
  let background: string | undefined;
  for (const token of line.match(/\x1b\[[0-9;]*m|[^\x1b]+/g) ?? []) {
    if (!token.startsWith('\x1b')) { if (visibleWidth(token)) expect(background).toBe(expected); continue; }
    const codes = token.slice(2, -1).split(';').map(Number);
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i];
      if (code === 0 || code === 49) background = undefined;
      else if (code === 38 || code === 48) {
        const count = codes[i + 1] === 2 ? 4 : 2;
        if (code === 48) background = `\x1b[${codes.slice(i, i + count + 1).join(';')}m`;
        i += count;
      } else if (code >= 40 && code <= 47 || code >= 100 && code <= 107) background = `\x1b[${code}m`;
    }
  }
  expect(background).toBeUndefined(); expect(visibleWidth(line)).toBe(width);
}

class Terminal {
  columns = 80; rows = 8; output = '';
  start() {} stop() {} write(s: string) { this.output += s; }
  hideCursor() {} showCursor() {} moveBy() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {}
}
class QuietTui extends TuiMainScreen { requestRender() {} }
function fixture() {
  const terminal = new Terminal(), tui = new QuietTui(terminal as any), state = new ActivityState();
  const document = new Container(), source = new Container();
  document.addChild(new Container()); document.addChild(new Container()); document.addChild(source); tui.addChild(document);
  let theme = getThemeByName('dark')!, expanded = false;
  const release = mount(tui, () => state, text => theme.fg('dim', text), () => { throw new Error('unexpected fail-open'); }, () => theme, () => expanded)!;
  return { terminal, tui, state, source, document, release,
    setTheme(name: string) { theme = getThemeByName(name)!; document.invalidate(); },
    setExpanded(value: boolean) { expanded = value; },
    render: () => document.render(80), draw: () => (tui as any).doRender(),
    add(m: any) { state.start(m); const node = new AssistantMessageComponent(m, true); source.addChild(node); return node; },
  };
}

test('collapsed headers have three full-background rows, centered vertically with two-column horizontal padding', () => {
  for (const name of ['dark', 'light']) for (const background of ['toolPendingBg', 'toolSuccessBg', 'toolErrorBg'] as const) {
    const theme = getThemeByName(name)!;
    for (const width of [1, 2, 3, 4, 5, 8, 40, 80, 160]) {
      const rows = renderHeader({ ...stats, background }, width, theme, false);
      expect(rows).toHaveLength(3);
      expect(Bun.stripANSI(rows[0]!)).toBe(' '.repeat(width)); expect(rows[2]).toBe(rows[0]);
      for (const row of rows) {
        expectBackground(row, theme.getBgAnsi(background), width);
        expect(row).not.toMatch(/[\r\n]/); expect(row).not.toContain('SECRET');
      }
      const padding = Math.min(2, Math.floor((width - 1) / 2)), middle = Bun.stripANSI(rows[1]!);
      expect(middle.trim().length).toBeGreaterThan(0);
      expect(middle.startsWith(' '.repeat(padding))).toBe(true); expect(middle.endsWith(' '.repeat(padding))).toBe(true);
      if (width >= 80) expect(middle).toContain('  ▸ 检查配置');
    }
  }
});

test('expanded headers match the independently saved pre-padding layout; zero width emits nothing', () => {
  for (const name of ['dark', 'light']) for (const fixture of expandedLayout.cases) {
    const theme = getThemeByName(name)!;
    expect(renderHeader(expandedLayout.stats as Stats, fixture.width, theme, true).map(row => Bun.stripANSI(row))).toEqual([fixture.text]);
  }
  expect(renderHeader(stats, 0, getThemeByName('dark')!, false)).toEqual([]);
  expect(renderHeader(stats, 0, getThemeByName('dark')!, true)).toEqual([]);
});

test('mounted groups have one external gap plus three colored rows; expanded internal spacing stays unchanged', () => {
  const f = fixture();
  try {
    const m = message([thinking('TITLE\n\nTHOUGHT_BODY')]); f.add(m); f.state.settle(false);
    const collapsed = f.render(); expect(collapsed).toHaveLength(4); expect(collapsed[0]).toBe(''); expect(Bun.stripANSI(collapsed[2]!)).toStartWith('  ▸ ');
    f.setExpanded(true); const expanded = f.render();
    const native = new AssistantMessageComponent(m, false).render(80);
    expect(expanded).toHaveLength(native.length + 2); expect(expanded[0]).toBe(''); expect(expanded[1]).toContain('▾');
    f.setExpanded(false); expect(f.render()).toEqual(collapsed);
    f.add(message([{ type: 'text', text: 'PROSE_OUTSIDE_BLOCK' }])); const withProse = f.render();
    expect(withProse.slice(0, 4)).toEqual(collapsed);
    expect(withProse.find(row => row.includes('PROSE_OUTSIDE_BLOCK'))).not.toMatch(/\x1b\[48[;:]/);
  } finally { f.release(); }
});

test('padding background and counter row flush together when the visible group settles', () => {
  const f = fixture();
  try {
    f.add(message([thinking(), tool])); const before = f.render();
    f.state.tool('t', 'probe', undefined, 'err'); f.state.settle(false);
    const after = f.render(); expect(after).toHaveLength(4); expect(after).not.toEqual(before); expect(after[0]).toBe('');
    for (const row of after.slice(1)) expectBackground(row, getThemeByName('dark')!.getBgAnsi('toolErrorBg'), 80);
    expect(Bun.stripANSI(after[2]!)).toContain('err 1');
  } finally { f.release(); }
});

test('even only the top padding going offscreen freezes all three rows atomically', () => {
  const f = fixture();
  try {
    f.add(message([thinking(), tool])); const before = f.render();
    (f.tui as any).previousViewportTop = 2;
    f.state.tool('t', 'probe', undefined, 'err'); f.state.settle(false);
    expect(f.render()).toEqual(before);
    f.setTheme('light'); const light = f.render();
    expect(light[0]).toBe('');
    for (const row of light.slice(1)) expectBackground(row, getThemeByName('light')!.getBgAnsi('toolPendingBg'), 80);
    expect(Bun.stripANSI(light[2]!)).toContain('err 0');
    f.setExpanded(true); f.render(); f.setExpanded(false);
    const refreshed = f.render(); expect(Bun.stripANSI(refreshed[2]!)).toContain('err 1'); expect(refreshed[0]).toBe('');
    for (const row of refreshed.slice(1)) expectBackground(row, getThemeByName('light')!.getBgAnsi('toolErrorBg'), 80);
  } finally { f.release(); }
});

test('real regular renderer keeps the padded block frozen without clearing scrollback on late failure', () => {
  const f = fixture();
  try {
    f.add(message([thinking(), tool])); f.draw();
    f.add(message([{ type: 'text', text: Array.from({ length: 30 }, (_, i) => `paragraph ${i}`).join('\n\n') }])); f.draw();
    expect((f.tui as any).previousViewportTop).toBeGreaterThan(3);
    const before = f.render().slice(0, 4); f.terminal.output = '';
    f.state.tool('t', 'probe', undefined, 'err'); f.draw();
    expect(f.render().slice(0, 4)).toEqual(before); expect(f.terminal.output).not.toContain('\x1b[3J');
    // Theme invalidation is a host-authorized redraw, not an automatic state thaw.
    f.terminal.output = ''; f.setTheme('light'); f.draw();
    const bg = getThemeByName('light')!.getBgAnsi('toolPendingBg');
    expect(f.terminal.output).toContain(bg); expect(f.terminal.output).toContain('\x1b[3J');
    expect(f.render()[0]).toBe('');
    for (const row of f.render().slice(1, 4)) expectBackground(row, bg, 80);
    expect(Bun.stripANSI(f.render()[2]!)).toContain('err 0');
  } finally { f.release(); }
});

test('a plain external row separates user background from both collapsed and expanded activity', () => {
  const f = fixture(), theme = getThemeByName('dark')!;
  try {
    const user = theme.bg('userMessageBg', 'USER MESSAGE'.padEnd(80));
    f.source.addChild({ render: () => [user], invalidate() {} });
    f.add(message([thinking(), tool, { ...tool, id: 'second' }]));
    for (const expanded of [false, true, false]) {
      f.setExpanded(expanded);
      for (let frame = 0; frame < 3; frame++) {
        const rows = f.render(); expect(rows[0]).toBe(user); expect(rows[1]).toBe('');
        expect(rows[2]).toContain(theme.getBgAnsi('toolPendingBg'));
        // One gap per activity section, not per thinking/tool entry or render.
        expect(rows.filter(row => row === '')).toHaveLength(1);
      }
    }
  } finally { f.release(); }
});

test('adjacent activity groups each receive one neutral separator', () => {
  const f = fixture();
  try {
    f.add(message([thinking('FIRST')])); f.state.boundary(); f.add(message([thinking('SECOND')]));
    const rows = f.render(); expect(rows).toHaveLength(8);
    expect(rows[0]).toBe(''); expect(rows[4]).toBe('');
    expect(rows[2]).toContain('FIRST'); expect(rows[6]).toContain('SECOND');
    expect(rows.filter(row => row === '')).toHaveLength(2);
  } finally { f.release(); }
});

test('only the unpainted gap going offscreen does not freeze a still-visible colored block', () => {
  const f = fixture();
  try {
    f.add(message([thinking(), tool])); f.render();
    (f.tui as any).previousViewportTop = 1;
    f.state.tool('t', 'probe', undefined, 'err'); f.state.settle(false);
    const rows = f.render(); expect(rows[0]).toBe(''); expect(rows[2]).toContain('err 1');
    for (const row of rows.slice(1)) expectBackground(row, getThemeByName('dark')!.getBgAnsi('toolErrorBg'), 80);
  } finally { f.release(); }
});

test('body-prefix protection uses actual header height for visible, partial and fully offscreen payloads', () => {
  const f = fixture(), theme = getThemeByName('dark')!;
  const m = message([thinking('BEFORE_BODY\n\nSECOND_BODY\n\nLAST_BODY')]), native = f.add(m);
  const update = (text: string) => { m.content[0].thinking = text; f.state.observe(m); native.updateContent(m, true); };
  let paints = 0;
  f.release();
  // Exercise geometry independently of the production expanded one-row header.
  const view = new Projection(f.source, () => f.state, f.tui, () => 0, text => text, () => true, () => {},
    undefined, (stats, width) => renderHeader(stats, width, theme, false),
    { isExpanded: () => true, paint: (lines, stats, width) => { paints++; return paintActivityLines(lines, width, stats.background, theme); } });
  try {
    const before = view.render(80); (f.tui as any).previousViewportTop = 3;
    update('AFTER_BODY\n\nSECOND_BODY\n\nLAST_BODY');
    const after = view.render(80);
    expect(after.slice(0, 3)).toEqual(before.slice(0, 3));
    expect(after.slice(3).join('\n')).toContain('AFTER_BODY');
    (f.tui as any).previousViewportTop = 5;
    update('CHANGED_OFFSCREEN_PREFIX\n\nSECOND_BODY\n\nLAST_BODY');
    expect(view.render(80)).toEqual(after);
    // The final body row is still visible: the whole-body cache must NOT kick in early.
    (f.tui as any).previousViewportTop = after.findLastIndex(row => row.includes('LAST_BODY'));
    update('AFTER_BODY\n\nSECOND_BODY\n\nVISIBLE_TAIL'); const count = paints;
    const tail = view.render(80); expect(paints).toBe(count + 1); expect(tail.slice(3).join('\n')).toContain('VISIBLE_TAIL');
    (f.tui as any).previousViewportTop = tail.length;
    update('FULLY_OFFSCREEN_CHANGE'); const cached = paints;
    expect(view.render(80)).toEqual(tail); expect(paints).toBe(cached);
  } finally { view.dispose(); }
});

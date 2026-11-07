import { test, expect } from 'bun:test';
import { AssistantMessageComponent, initTheme, getPackageDir } from '@earendil-works/pi-coding-agent';
import { Container, TuiMainScreen } from '@earendil-works/pi-tui';
import { ActivityState } from '../src/state.ts';
import { mount } from '../src/bridge.ts';
initTheme('dark', false);
const { ThemedText } = await import(`${getPackageDir()}/dist/modes/interactive/components/themed-text.js`);
const { theme } = await import(`${getPackageDir()}/dist/modes/interactive/theme/theme.js`);
const msg = (content: any[]): any => ({ role: 'assistant', content, stopReason: 'stop', timestamp: 42 });
class Terminal {
  columns = 80; rows = 8; output = '';
  start() {} stop() {} write(s: string) { this.output += s; }
  hideCursor() {} showCursor() {} moveBy() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {}
}
class Quiet extends TuiMainScreen { requestRender() {} }
test('real regular viewport: delayed top-level failure never recolors scrollback or rewrites frozen row', () => {
  const terminal = new Terminal(), tui = new Quiet(terminal as any);
  const doc = new Container(), source = new Container();
  doc.addChild(new Container()); doc.addChild(new Container()); doc.addChild(source); tui.addChild(doc);
  const s = new ActivityState();
  const m = msg([{ type: 'thinking', thinking: 'Theme' }, { type: 'toolCall', id: 'outer', name: 'outer', arguments: {} }]);
  s.start(m); source.addChild(new AssistantMessageComponent(m));
  const release = mount(tui, () => s, x => x, () => {}, () => theme)!;
  try {
    (tui as any).doRender();
    const answer = msg([{ type: 'text', text: Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n\n') }]);
    s.start(answer); source.addChild(new AssistantMessageComponent(answer));
    (tui as any).doRender();
    expect((tui as any).previousViewportTop).toBeGreaterThan(0);
    const before = doc.render(80).slice(1, 4); terminal.output = '';
    s.tool('outer', 'outer', undefined, 'err');
    (tui as any).doRender();
    expect(doc.render(80)[0]).toBe('');
    expect(doc.render(80).slice(1, 4)).toEqual(before);
    expect(terminal.output).not.toContain('\x1b[3J');
    expect([...s.groups[0].tools.values()]).toEqual(['err']);
  } finally { release(); }
});
test('pure prose stays native; error body hidden until exactly one settled notice', () => {
  const terminal = new Terminal(), tui = new Quiet(terminal as any);
  const doc = new Container(), source = new Container(); doc.addChild(new Container()); doc.addChild(new Container()); doc.addChild(source); tui.addChild(doc);
  const s = new ActivityState(); const m = { ...msg([{ type: 'text', text: 'Prose immediately' }]), stopReason: 'error', errorMessage: 'SECRET STACK\nat provider' };
  s.start(m); source.addChild(new AssistantMessageComponent(m)); const release = mount(tui, () => s, x => x, () => {})!;
  try {
    const before = Bun.stripANSI(doc.render(80).join('\n'));
    expect(before).toContain('Prose immediately'); expect(before).not.toContain('steps'); expect(before).not.toContain('SECRET STACK');
    source.addChild(new ThemedText(() => 'Error: Retry failed after 3 attempts: SECRET RETRY STACK', 0, 0));
    source.addChild(new ThemedText(() => 'If this looks like a pi bug, /bug sends a report to the developers.', 0, 0));
    for (const width of [1, 2, 8, 40, 80]) {
      expect(Bun.stripANSI(doc.render(width).join(''))).not.toContain('SECRET');
      expect(Bun.stripANSI(doc.render(width).join(''))).not.toContain('Retry');
    }
    s.settle(false); const after = Bun.stripANSI(doc.render(80).join('\n'));
    expect(after.match(/模型请求失败/g)).toHaveLength(1); expect(after).not.toContain('SECRET STACK');
    s.start(msg([{ type: 'text', text: 'next' }]));
    expect(Bun.stripANSI(doc.render(80).join('\n'))).toContain('模型请求失败');
  } finally { release(); }
});

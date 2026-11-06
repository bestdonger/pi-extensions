import { test, expect } from 'bun:test';
import { Container, TuiMainScreen } from '@earendil-works/pi-tui';
import { UserMessageComponent, initTheme } from '@earendil-works/pi-coding-agent';
import { ActivityState, RECORD } from '../src/state.ts';
import { mount } from '../src/bridge.ts';
initTheme('dark', false);
test('abort before assistant start attaches one notice to user and restores by stable ID', () => {
  const s = new ActivityState(); s.userBoundary(); s.settle(true, 'user-id');
  const source = new Container(), doc = new Container(); doc.addChild(new Container()); doc.addChild(new Container()); doc.addChild(source);
  source.addChild(new UserMessageComponent('question'));
  class Quiet extends TuiMainScreen { requestRender() {} }
  const tui = new Quiet({ columns: 80, rows: 24 } as any); tui.addChild(doc);
  const release = mount(tui, () => s, x => x, () => {})!;
  try {
    expect(doc.render(80).join('\n').match(/操作已中断/g)).toHaveLength(1);
    s.userBoundary(); source.addChild(new UserMessageComponent('next question'));
    expect(doc.render(80).join('\n').indexOf('操作已中断')).toBeLessThan(doc.render(80).join('\n').indexOf('next question'));
    const restored = new ActivityState();
    restored.restore([{ type: 'message', id: 'user-id', message: { role: 'user', content: 'question' } },
      { type: 'custom', customType: RECORD, data: { version: 2, groups: [], notices: s.saveNotices() } }]);
    expect(restored.byId.get('user-id')?.notice).toBe('操作已中断');
  } finally { release(); }
});

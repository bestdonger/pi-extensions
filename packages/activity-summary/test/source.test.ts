import { test, expect } from 'bun:test';
import { AssistantMessageComponent, ToolExecutionComponent, initTheme } from '@earendil-works/pi-coding-agent';
import { Container } from '@earendil-works/pi-tui';
import { ActivityState } from '../src/state.ts';
import { Projection } from '../src/bridge.ts';
import { snapshot } from '../src/text.ts';

initTheme('dark', false);
const thinking = (label: string) => ({ type: 'thinking', thinking: `**${label}**\n\n${label}_BODY` });
const tool = (id: string, command = 'bun test') => ({ type: 'toolCall', id, name: 'bash', arguments: { command } });
const message = (content: any[], stopReason = 'toolUse'): any => ({ role: 'assistant', content, stopReason, timestamp: 1000 });
function fixture() {
  const state = new ActivityState(), source = new Container(), tui = { previousViewportTop: 0, requestRender() {} };
  let expanded = true, now = 0;
  const view = new Projection(source, () => state, tui as any, () => 0, x => x, () => true, () => { throw new Error('unsupported'); },
    () => now, undefined, { isExpanded: () => expanded, paint: lines => lines });
  return { state, source, tui, view, setExpanded: (value: boolean) => { expanded = value; }, setTime: (value: number) => { now = value; },
    plain: () => Bun.stripANSI(view.render(120).join('\n')),
    assistant: (m: any) => { const node = new AssistantMessageComponent(m, true); source.addChild(node); return node; } };
}

test('execution-before-declaration adopts the provisional occurrence, including a prior failure', () => {
  for (const withProse of [false, true]) {
    const s = new ActivityState(); s.tool('early', 'bash', undefined, 'err', { command: 'bun test' });
    const m = message([...(withProse ? [{ type: 'text', text: 'Visible prose' }] : []), tool('early')]);
    s.start(m); s.observe(m); s.tool('early', 'bash', undefined, 'err');
    expect(s.groups).toHaveLength(1);
    expect(snapshot(s.groups[0])).toEqual({ theme: 'bash: bun test', steps: 1, failed: 1, background: 'toolErrorBg' });
    const restored = new ActivityState(); restored.restore([
      { type: 'message', id: 'a', message: m },
      { type: 'message', id: 'r', message: { role: 'toolResult', toolCallId: 'early', toolName: 'bash', isError: true } },
    ]);
    expect(restored.groups.map(snapshot)).toEqual(s.groups.map(snapshot));
  }
});

test('ambiguous concurrent duplicate IDs stay unresolved rather than overwriting an occurrence', () => {
  const s = new ActivityState(), m = message([tool('dup', 'first'), tool('dup', 'second')]);
  s.start(m); s.observe(m);
  for (const isError of [true, false]) {
    s.result({ toolCallId: 'dup', toolName: 'bash', isError });
    s.tool('dup', 'bash', undefined, isError ? 'err' : 'ok');
  }
  expect(s.groups[0].tools.size).toBe(2);
  expect([...s.groups[0].tools.values()]).toEqual(['open', 'open']);
  expect(snapshot(s.groups[0])).toMatchObject({ theme: 'bash: second', steps: 2, background: 'toolPendingBg' });
});

for (const count of [1, 2]) for (const userBoundary of [false, true]) {
  test(`a new assistant message can reuse ${count} unresolved IDs (user boundary=${userBoundary})`, () => {
    const first = message(Array.from({ length: count }, () => tool('reused', 'old')), userBoundary ? 'aborted' : 'error');
    const next = message([tool('reused', 'new')]);
    const result = { role: 'toolResult', toolCallId: 'reused', toolName: 'bash', isError: true };
    const final = message([{ type: 'text', text: 'Done' }], 'stop');
    const s = new ActivityState(); s.start(first); s.bind('first');
    const oldTools = [...s.groups[0].tools.keys()];
    if (userBoundary) { s.settle(true); s.userBoundary(); }
    s.start(next); s.bind('next'); s.tool('reused', 'bash', undefined, 'err'); s.result(result);
    s.start(final); s.bind('final'); s.settle(false);
    expect(oldTools.map(t => s.groups[0].tools.get(t))).toEqual(Array(count).fill('open'));
    expect(snapshot(s.groups.at(-1)!)).toMatchObject({ failed: 1, background: 'toolErrorBg' });
    const restored = new ActivityState(); restored.restore([
      { type: 'message', id: 'first', message: first },
      ...(userBoundary ? [{ type: 'message', id: 'user', message: { role: 'user', content: 'Next' } }] : []),
      { type: 'message', id: 'next', message: next },
      { type: 'message', id: 'result', message: result },
      { type: 'message', id: 'final', message: final },
    ]);
    expect(restored.groups.map(snapshot)).toEqual(s.groups.map(snapshot));
  });
}

test('truncated tool calls at EOF still retain their terminal notice without a continuation', () => {
  const s = new ActivityState(); s.restore([
    { type: 'message', id: 'truncated', message: message([tool('cut')], 'length') },
    { type: 'message', id: 'result', message: { role: 'toolResult', toolCallId: 'cut', toolName: 'bash', isError: true } },
  ]);
  expect(s.groups[0].completion).toBe('incomplete');
  expect(s.byId.get('truncated')?.notice).toBe('模型输出已达长度上限');
  expect(snapshot(s.groups[0])).toMatchObject({ steps: 1, failed: 1, background: 'toolErrorBg' });
});

for (const ending of ['eof', 'user']) test(`a hidden instruction without a continued response retains truncation at ${ending}`, () => {
  const s = new ActivityState(); s.restore([
    { type: 'message', id: 'cut', message: message([thinking('Cut')], 'length') },
    { type: 'custom_message', customType: 'instruction', content: 'Continue', display: false },
    ...(ending === 'user' ? [{ type: 'message', id: 'user', message: { role: 'user', content: 'New request' } }] : []),
  ]);
  expect(s.groups).toHaveLength(1);
  expect(s.groups[0].completion).toBe('incomplete');
  expect(s.byId.get('cut')?.notice).toBe('模型输出已达长度上限');
});

for (const initiallyKnown of [true, false]) test(`fallback partitions preserve A/B/C source order, middle initially known=${initiallyKnown}`, () => {
  const f = fixture(), messages = ['A', 'B', 'C'].map(label => message([thinking(label)], 'stop'));
  try {
    if (initiallyKnown) f.state.start(messages[1]);
    messages.forEach(m => f.assistant(m));
    if (!initiallyKnown) { expect(f.plain()).toContain('3 steps'); f.state.start(messages[1]); f.setTime(300); }
    const text = f.plain();
    expect(text.match(/1 step/g)).toHaveLength(3);
    expect(text.indexOf('A_BODY')).toBeLessThan(text.indexOf('B_BODY'));
    expect(text.indexOf('B_BODY')).toBeLessThan(text.indexOf('C_BODY'));
    expect(text.match(/A_BODY/g)).toHaveLength(1); expect(text.match(/C_BODY/g)).toHaveLength(1);
    f.setExpanded(false); f.plain(); f.setExpanded(true); expect(f.plain()).toBe(text);
  } finally { f.view.dispose(); }
});

test('duplicate ID native payloads remain in declaration order, without stealing the second slot', () => {
  const f = fixture(), m = message([tool('dup', 'first'), thinking('MIDDLE'), tool('dup', 'second')]);
  try {
    f.state.start(m); f.assistant(m);
    for (const text of ['FIRST_PAYLOAD', 'SECOND_PAYLOAD']) {
      const node = new ToolExecutionComponent('custom', 'dup', {}, undefined, undefined, f.tui as any, '/tmp');
      node.updateResult({ content: [{ type: 'text', text }], isError: false }); node.setExpanded(true); f.source.addChild(node);
    }
    const text = f.plain();
    expect(text.match(/3 steps/g)).toHaveLength(1);
    expect(text.match(/FIRST_PAYLOAD/g)).toHaveLength(1); expect(text.match(/SECOND_PAYLOAD/g)).toHaveLength(1);
    expect(text.indexOf('FIRST_PAYLOAD')).toBeLessThan(text.indexOf('MIDDLE_BODY'));
    expect(text.indexOf('MIDDLE_BODY')).toBeLessThan(text.indexOf('SECOND_PAYLOAD'));
  } finally { f.view.dispose(); }
});

test('prose-boundary display freeze is intentional; raw live/history state and manual refresh stay exact', () => {
  const f = fixture(), m = message([tool('t'), { type: 'text', text: 'PROSE' }]);
  try {
    f.state.start(m); f.assistant(m); f.setExpanded(false); const before = f.plain();
    f.state.result({ toolCallId: 't', toolName: 'bash', isError: true }); f.setTime(500);
    expect(f.plain()).toBe(before); // Existing approved freeze policy, even when visible.
    const restored = new ActivityState(); restored.restore([
      { type: 'message', id: 'a', message: m },
      { type: 'message', id: 'r', message: { role: 'toolResult', toolCallId: 't', toolName: 'bash', isError: true } },
    ]);
    expect(restored.groups.map(snapshot)).toEqual(f.state.groups.map(snapshot));
    f.setExpanded(true); expect(f.plain()).toContain('1 failed');
  } finally { f.view.dispose(); }
});

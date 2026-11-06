import { test, expect } from 'bun:test';
import { AssistantMessageComponent, SessionManager, initTheme } from '@earendil-works/pi-coding-agent';
import { Container } from '@earendil-works/pi-tui';
import { ActivityState, RECORD } from '../src/state.ts';
import { Projection } from '../src/bridge.ts';
import { snapshot, thoughtTheme } from '../src/text.ts';
import extension from '../src/index.ts';
initTheme('dark', false);
const thought = (thinking = 'Inspect') => ({ type: 'thinking', thinking });
const text = (text = 'Answer') => ({ type: 'text', text });
const tool = { type: 'toolCall', id: 'one', name: 'probe', arguments: {} };
const msg = (content: any[], stopReason = 'stop'): any => ({ role: 'assistant', content, timestamp: 1000, stopReason });

test('silent failed attempts and pure prose add no steps to another segment', () => {
  const s = new ActivityState();
  s.start(msg([], 'error')); s.bind('failed');
  s.start(msg([thought()])); s.bind('retry');
  expect(snapshot(s.groups[0]).steps).toBe('1');
  s.settle(false);
  s.start(msg([text()])); s.bind('pure');
  s.start(msg([thought('next')])); s.bind('next');
  expect(s.groups).toHaveLength(2); expect(s.groups[1].thoughts).toBe(1);
});

test('metadata is incremental and records preserve adjacent settled activity boundaries', () => {
  const sm = SessionManager.inMemory('/tmp'), s = new ActivityState();
  let saved = 0;
  for (let i = 0; i < 5; i++) {
    const m = msg([thought(`group ${i}`)]);
    s.start(m); s.bind(sm.appendMessage(m)); s.settle(false);
    const record = s.pendingRecord();
    expect(record.groups).toHaveLength(1);
    saved += record.groups.length;
    sm.appendCustomEntry(RECORD, record); s.committed(record);
    expect(s.pendingRecord().groups).toEqual([]);
  }
  expect(saved).toBe(5);
  const restored = new ActivityState(); restored.restore(sm.getBranch());
  expect(restored.groups.map(snapshot)).toEqual(s.groups.map(snapshot));
  expect(restored.pendingRecord().groups).toEqual([]);
  expect(sm.buildSessionContext().messages).toHaveLength(5);
});

test('latest thinking heading wins over following body; paragraph fallback remains available', () => {
  expect(thoughtTheme('# First\n\nbody\n\n**Second**\n\nPRIVATE_BODY')).toBe('Second');
  expect(thoughtTheme('first paragraph\n\nlatest short theme')).toBe('latest short theme');
});

test('unchanged prose does not re-run Markdown transforms on every activity render', () => {
  const s = new ActivityState(), source = new Container();
  const message = msg([text('Stable prose')]); s.start(message); s.bind('id');
  let transforms = 0;
  const node = new AssistantMessageComponent(message, false, undefined, '', 1,
    [(value: string) => { transforms++; return value; }], 'id', '2026-01-01T00:00:00.000Z');
  source.addChild(node);
  const p = new Projection(source, () => s, { requestRender() {}, previousViewportTop: 0 } as any, () => 0, x => x, () => true, () => {});
  try {
    p.render(80); const count = transforms;
    for (let i = 0; i < 20; i++) p.render(80);
    expect(transforms).toBe(count);
    const next = msg([text('Changed prose')]); s.observe(next); node.updateContent(next);
    expect(p.render(80).join('\n')).toContain('Changed prose');
    expect(transforms).toBeGreaterThan(count);
  } finally { p.dispose(); }
});

test('final flush never overrides the offscreen freeze', () => {
  const s = new ActivityState(), source = new Container();
  const message = msg([thought(), tool]); s.start(message); source.addChild(new AssistantMessageComponent(message));
  const tui = { previousViewportTop: 0, requestRender() {} };
  const p = new Projection(source, () => s, tui as any, () => 0, x => x, () => true, () => {}, () => 0);
  try {
    const initial = p.render(80);
    tui.previousViewportTop = 1;
    s.tool('one', 'probe', undefined, 'ok'); s.settle(false);
    expect(p.render(80)).toEqual(initial);
    expect(snapshot(s.groups[0]).ok).toBe('1');
  } finally { p.dispose(); }
});

test('non-TUI sessions are a quiet no-op', () => {
  const handlers = new Map<string, Function>();
  extension({ on: (name: string, fn: Function) => handlers.set(name, fn) } as any);
  expect(() => handlers.get('session_start')!({}, { mode: 'print', ui: { notify() { throw new Error('unexpected warning'); } } })).not.toThrow();
});

import { test, expect } from 'bun:test';
import { AssistantMessageComponent, getPackageDir, initTheme } from '@earendil-works/pi-coding-agent';
import { Container, visibleWidth } from '@earendil-works/pi-tui';
import { ActivityState } from '../src/state.ts';
import { format, renderSummary, snapshot, toolTheme } from '../src/text.ts';
import { Projection } from '../src/bridge.ts';

initTheme('dark', false);
const { getThemeByName } = await import(`${getPackageDir()}/dist/modes/interactive/theme/theme.js`);
const thought = (thinking = '检查配置') => ({ type: 'thinking', thinking });
const prose = (text = '正文') => ({ type: 'text', text });
const tool = (id = 'outer') => ({ type: 'toolCall', id, name: 'codemode', arguments: {} });
const message = (content: any[], stopReason = 'stop'): any => ({ role: 'assistant', content, stopReason, timestamp: 1000 });
const entry = (id: string, content: any[], stopReason = 'stop') => ({ type: 'message', id, message: message(content, stopReason) });
const result = (id = 'outer', isError = false) => ({ type: 'message', id: `result-${id}`, message: { role: 'toolResult', toolCallId: id, toolName: 'codemode', isError } });

function projection(s: ActivityState, m: any) {
  const source = new Container(); source.addChild(new AssistantMessageComponent(m));
  const tui = { previousViewportTop: 0, requestRender() {} };
  let time = 0, theme = getThemeByName('dark')!;
  const view = new Projection(source, () => s, tui as any, () => 0, x => x, () => true, () => {},
    () => time, (stats, width) => renderSummary(stats, width, theme));
  return { view, tui, source, setTime: (t: number) => { time = t; },
    setTheme: (name: string) => { theme = getThemeByName(name)!; view.invalidate(); } };
}

test('fullscreen steps count thinking blocks, not model requests, updates, results or nested calls', () => {
  for (const [content, expected] of [
    [[thought('one'), thought('two'), tool()], 3],
    [[tool()], 1],
    [[thought(), tool()], 2],
  ] as const) {
    const s = new ActivityState(), m = message([...content]);
    s.start(m); s.observe(m); s.observe(m);
    s.tool('opaque-nested-id', 'read', 'outer', 'err');
    s.tool('deep', 'read', 'opaque-nested-id', 'err');
    s.tool('outer', 'codemode', undefined, 'ok');
    expect(snapshot(s.groups[0]).steps).toBe(expected);
    expect(s.groups[0].tools.size).toBe(1);
    expect(snapshot(s.groups[0]).failed).toBe(0);
    s.start(message([prose()]));
    expect(snapshot(s.groups[0]).steps).toBe(expected);
    expect(snapshot(s.groups[0]).background).toBe('toolSuccessBg');
  }
});

test('empty thinking has no row; its first nonempty delta counts exactly once', () => {
  const s = new ActivityState(), m = message([thought(' \n ')]), p = projection(s, m);
  try {
    s.start(m); expect(s.groups).toHaveLength(0); expect(p.view.render(80)).toEqual([]);
    m.content[0].thinking = 'Now thinking'; s.observe(m); s.observe(m);
    expect(snapshot(s.groups[0]).steps).toBe(1);
    expect(p.view.render(80)).toHaveLength(1);
  } finally { p.view.dispose(); }
});

test('top-level IDs are not inferred from slash spelling, nested-only events create no phantom activity', () => {
  const s = new ActivityState();
  s.tool('unrelated', 'read', 'not-yet-seen', 'err'); expect(s.groups).toHaveLength(0);
  s.start(message([tool('provider/id')]));
  s.tool('provider/id', 'codemode', undefined, 'ok'); s.settle(false);
  expect(snapshot(s.groups[0])).toMatchObject({ steps: 1, failed: 0, background: 'toolSuccessBg' });
});

test('thinking-prose-thinking in one response has one step in EACH segment', () => {
  const s = new ActivityState(); s.start(message([thought('first'), prose(), thought('second')]));
  expect(s.groups.map(g => snapshot(g).steps)).toEqual([1, 1]);
  expect(s.groups.map(g => snapshot(g).background)).toEqual(['toolSuccessBg', 'toolPendingBg']);
});

test('failure wins over active thinking and open tools; success waits for the segment boundary', () => {
  const s = new ActivityState(); s.start(message([thought(), tool('a'), tool('b')]));
  s.tool('a', 'codemode', undefined, 'err');
  expect(snapshot(s.groups[0])).toMatchObject({ failed: 1, background: 'toolErrorBg' });
  s.settle(true); expect(snapshot(s.groups[0]).background).toBe('toolErrorBg');
  const ok = new ActivityState(); ok.start(message([tool()])); ok.tool('outer', 'codemode', undefined, 'ok');
  expect(snapshot(ok.groups[0]).background).toBe('toolPendingBg');
  ok.start(message([prose()])); expect(snapshot(ok.groups[0]).background).toBe('toolSuccessBg');
});

for (const [stop, abort, bg] of [
  ['stop', false, 'toolSuccessBg'], ['error', false, 'toolErrorBg'],
  ['aborted', false, 'toolPendingBg'], ['length', false, 'toolPendingBg'], ['stop', true, 'toolPendingBg'],
] as const) {
  test(`pure thinking terminal state: ${stop}, aborted=${abort}`, () => {
    const s = new ActivityState(); s.start(message([thought()], stop));
    expect(snapshot(s.groups[0]).background).toBe('toolPendingBg');
    s.settle(abort); expect(snapshot(s.groups[0]).background).toBe(bg);
  });
}

test('open tools remain pending even when the segment/run is closed', () => {
  const s = new ActivityState(); s.start(message([tool()], 'toolUse')); s.settle(false);
  expect(snapshot(s.groups[0])).toMatchObject({ steps: 1, background: 'toolPendingBg' });
});

test('a later model failure does not recolor an earlier normally ended segment', () => {
  const s = new ActivityState(); s.start(message([thought('done'), prose(), thought('failed')], 'error')); s.settle(false);
  expect(s.groups.map(g => snapshot(g).background)).toEqual(['toolSuccessBg', 'toolErrorBg']);
});

// Check every rendered terminal cell, including right padding, has a background;
// SGR resets embedded in secondary text must not punch holes in the full row.
function paintedColumns(line: string) {
  let bg = false, columns = 0;
  for (const token of line.match(/\x1b\[[0-9;]*m|[^\x1b]+/g) ?? []) {
    if (!token.startsWith('\x1b')) {
      if (visibleWidth(token)) expect(bg).toBe(true);
      columns += visibleWidth(token); continue;
    }
    const codes = token.slice(2, -1).split(';').map(Number);
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i];
      if (code === 0 || code === 49) bg = false;
      else if (code === 38 || code === 48) { if (code === 48) bg = true; i += codes[i + 1] === 2 ? 4 : 2; }
      else if (code >= 40 && code <= 47 || code >= 100 && code <= 107) bg = true;
    }
  }
  expect(bg).toBe(false); // The next prose line must not inherit the background.
  return columns;
}

test('dark/light semantic backgrounds fill exactly one row at narrow and Unicode widths', () => {
  const s = new ActivityState(); s.start(message([thought('中文👨‍👩‍👧‍👦\x1b[31mred\x1b[0m\x1b]52;c;SECRET\x07')]));
  for (const name of ['light', 'dark']) for (const background of ['toolPendingBg', 'toolSuccessBg', 'toolErrorBg'] as const) {
    const theme = getThemeByName(name)!;
    for (const width of [1, 2, 8, 40, 80, 160]) {
      const row = renderSummary({ ...snapshot(s.groups[0]), background }, width, theme);
      expect(visibleWidth(row)).toBe(width); expect(paintedColumns(row)).toBe(width);
      expect(row).toContain(theme.getBgAnsi(background));
      expect(row).not.toMatch(/[\r\n]/); expect(row).not.toContain('SECRET');
    }
    expect(renderSummary(snapshot(s.groups[0]), 0, theme)).toBe('');
  }
});

test('background and counters share throttling, final flush, and frozen snapshots', () => {
  const s = new ActivityState(), m = message([thought(), tool()]); s.start(m); const p = projection(s, m);
  try {
    const first = p.view.render(80);
    s.tool('outer', 'codemode', undefined, 'err'); p.setTime(100);
    expect(p.view.render(80)).toEqual(first);
    p.setTime(250); const failed = p.view.render(80);
    expect(failed[0]).toContain(getThemeByName('dark')!.getBgAnsi('toolErrorBg'));
    expect(Bun.stripANSI(failed[0])).toContain('1 failed');
    s.settle(false); p.setTime(260); const frozen = p.view.render(80);
    s.groups[0].completion = 'complete'; s.tool('outer', 'codemode', undefined, 'ok'); p.setTime(1000);
    expect(p.view.render(80)).toEqual(frozen);
  } finally { p.view.dispose(); }
});

test('color-only final failure cannot redraw an offscreen row, including after invalidation', () => {
  const s = new ActivityState(), m = message([thought()], 'error'); s.start(m); const p = projection(s, m);
  try {
    const first = p.view.render(80)[0]; p.tui.previousViewportTop = 1;
    s.settle(false); expect(snapshot(s.groups[0]).background).toBe('toolErrorBg');
    expect(p.view.render(80)[0]).toBe(first);
    expect(p.view.render(80).join('\n')).toContain('模型请求失败');
    p.tui.previousViewportTop = 0; p.view.invalidate();
    expect(p.view.render(80)[0]).toBe(first);
  } finally { p.view.dispose(); }
});

test('a final completion flush can change only the background inside the 250ms interval', () => {
  const s = new ActivityState(), m = message([thought()]); s.start(m); const p = projection(s, m);
  try {
    const first = p.view.render(80); s.settle(false); p.setTime(10);
    const last = p.view.render(80);
    expect(last).not.toEqual(first); expect(Bun.stripANSI(last[0])).toBe(Bun.stripANSI(first[0]).replace('●', '•'));
    expect(last[0]).toContain(getThemeByName('dark')!.getBgAnsi('toolSuccessBg'));
    p.setTheme('light'); const light = p.view.render(80);
    expect(light[0]).toContain(getThemeByName('light')!.getBgAnsi('toolSuccessBg'));
    expect(Bun.stripANSI(light[0])).toBe(Bun.stripANSI(last[0]));
  } finally { p.view.dispose(); }
});

test('history counts original entries without any custom record, including failure results', () => {
  const branch = [entry('a', [thought(), tool()], 'toolUse'), result('outer', true), entry('b', [prose()])];
  const before = JSON.stringify(branch), s = new ActivityState(); s.restore(branch);
  expect(snapshot(s.groups[0])).toEqual({ theme: 'codemode', steps: 2, failed: 1, background: 'toolErrorBg' });
  expect(JSON.stringify(branch)).toBe(before);
});

test('all old/invalid custom records are ignored, including their artificial run boundaries', () => {
  const raw = [entry('a', [thought(), tool()], 'toolUse'), result(), entry('b', [thought('latest')])];
  const clean = new ActivityState(); clean.restore(raw);
  for (const customType of ['pi-activity-summary/v1', 'pi-activity-summary/v2']) for (const data of [
    null, { groups: 'invalid' }, { version: 2, groups: [{ anchors: ['a:0'], theme: 'FAKE', thoughts: 999,
      tools: [['outer', 'err']], completion: 'error' }], notices: [['a', '模型请求失败']] },
  ]) {
    const branch = [raw[0], { type: 'custom', customType, data }, ...raw.slice(1)];
    const before = JSON.stringify(branch), s = new ActivityState(); s.restore(branch);
    expect(s.groups.map(snapshot)).toEqual(clean.groups.map(snapshot));
    expect(s.groups).toHaveLength(1);
    expect(snapshot(s.groups[0])).toMatchObject({ theme: 'latest', steps: 3, failed: 0, background: 'toolSuccessBg' });
    expect(s.byId.get('a')?.notice).toBeUndefined();
    expect(JSON.stringify(branch)).toBe(before);
  }
});

test('interrupted and truncated history has concrete counts, but remains pending', () => {
  for (const stop of ['aborted', 'length', 'toolUse']) {
    const s = new ActivityState(); s.restore([entry('a', [thought(' '), thought(), tool()], stop), result()]);
    expect(snapshot(s.groups[0])).toMatchObject({ steps: 2, failed: 0, background: 'toolPendingBg' });
    expect(format(snapshot(s.groups[0]), 80)).not.toContain('—');
  }
});

test('raw terminal failure restores one concise notice and error background without failed tools', () => {
  const s = new ActivityState(); s.restore([entry('a', [thought()], 'error')]);
  expect(snapshot(s.groups[0])).toMatchObject({ steps: 1, failed: 0, background: 'toolErrorBg' });
  expect(s.byId.get('a')?.notice).toBe('模型请求失败');
  expect(format(snapshot(s.groups[0]), 80)).not.toContain('failed');
});

test('nested or undeclared raw results never create entries or overwrite an outer result', () => {
  const s = new ActivityState(); s.restore([
    entry('a', [tool()], 'toolUse'), result('inner', true),
    { ...result('outer', true), message: { ...result('outer', true).message, parentToolCallId: 'parent' } },
    result(), entry('b', [prose()]),
  ]);
  expect(snapshot(s.groups[0])).toMatchObject({ steps: 1, failed: 0, background: 'toolSuccessBg' });
});

test('retried model errors do not survive a successful continuation in history', () => {
  const s = new ActivityState(); s.restore([entry('a', [thought('retry')], 'error'), entry('b', [thought('recovered')])]);
  expect(snapshot(s.groups[0])).toMatchObject({ theme: 'recovered', steps: 2, failed: 0, background: 'toolSuccessBg' });
  expect(s.byId.get('a')?.notice).toBeUndefined(); expect(s.byId.get('b')?.notice).toBe('');
});

test('reused call IDs in different original entries count separately and keep their own outcomes', () => {
  const s = new ActivityState(); s.restore([
    entry('a', [tool()], 'toolUse'), result('outer', true),
    entry('b', [{ ...tool(), name: 'bash', arguments: { command: 'bun test' } }], 'toolUse'),
    result(), entry('c', [prose()]),
  ]);
  expect(snapshot(s.groups[0])).toEqual({ theme: 'bash: bun test', steps: 2, failed: 1, background: 'toolErrorBg' });
  expect([...s.groups[0].tools.values()]).toEqual(['err', 'ok']);
});

test('latest activity wins; out-of-order parallel results cannot roll the title back', () => {
  const s = new ActivityState();
  const m = message([thought('earlier'), { ...tool('a'), name: 'read', arguments: { path: '/tmp/config' } },
    { ...tool('b'), name: 'bash', arguments: { command: 'bun test' } }], 'toolUse');
  s.start(m); s.observe(m);
  s.tool('b', 'bash', undefined, 'ok'); s.tool('a', 'read', undefined, 'err');
  expect(snapshot(s.groups[0])).toMatchObject({ theme: 'bash: bun test', steps: 3, failed: 1 });
  s.start(message([thought('latest thinking')]));
  expect(snapshot(s.groups[0])).toMatchObject({ theme: 'latest thinking', steps: 4 });
});

test('raw tool results alone update live state without requiring execution-end events', () => {
  const s = new ActivityState(); s.start(message([tool()], 'toolUse'));
  s.result(result('outer', true).message); s.result(result('outer', true).message);
  expect(snapshot(s.groups[0])).toMatchObject({ steps: 1, failed: 1, background: 'toolErrorBg' });
});

test('compact grammar: singular/plural, optional failures, status and trailing disclosure', () => {
  const base = { theme: 'bash: bun test', steps: 1, failed: 0, background: 'toolSuccessBg' as const };
  expect(format(base, 80)).toBe('• bash: bun test · 1 step ›');
  expect(format({ ...base, steps: 6 }, 80)).toBe('• bash: bun test · 6 steps ›');
  expect(format({ ...base, steps: 6, failed: 1, background: 'toolErrorBg' }, 80)).toBe('× bash: bun test · 6 steps · 1 failed ›');
  expect(format(base, 80, x => x, true)).toBe('• bash: bun test · 1 step ⌄');
  for (const width of [1, 2, 3, 8, 24, 80]) {
    const line = format(base, width);
    expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    expect(line).toEndWith('›');
    expect(line).not.toMatch(/tools|ok |err |open |0 failed/);
  }
});

test('tool argument title fallback is short and sanitized, not arbitrary result text', () => {
  expect(toolTheme('bash', { command: 'bun test' })).toBe('bash: bun test');
  expect(toolTheme('read', { path: '/tmp/config' })).toBe('read: /tmp/config');
  expect(toolTheme('custom', { body: 'PRIVATE BODY' })).toBe('custom');
  expect(toolTheme('bash', { command: '\u001b]52;c;SECRET\u0007echo ok' })).toBe('bash: echo ok');
});

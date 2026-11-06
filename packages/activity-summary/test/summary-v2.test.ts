import { test, expect } from 'bun:test';
import { AssistantMessageComponent, getPackageDir, initTheme } from '@earendil-works/pi-coding-agent';
import { Container, visibleWidth } from '@earendil-works/pi-tui';
import { ActivityState, LEGACY_RECORD, RECORD } from '../src/state.ts';
import { renderSummary, snapshot } from '../src/text.ts';
import { Projection } from '../src/bridge.ts';

initTheme('dark', false);
const { getThemeByName } = await import(`${getPackageDir()}/dist/modes/interactive/theme/theme.js`);
const thought = (thinking = '检查配置') => ({ type: 'thinking', thinking });
const prose = (text = '正文') => ({ type: 'text', text });
const tool = (id = 'outer') => ({ type: 'toolCall', id, name: 'codemode', arguments: {} });
const message = (content: any[], stopReason = 'stop'): any => ({ role: 'assistant', content, stopReason, timestamp: 1000 });
const entry = (id: string, content: any[], stopReason = 'stop') => ({ type: 'message', id, message: message(content, stopReason) });
const saved = (data: any, customType = LEGACY_RECORD) => ({ type: 'custom', customType, data });
const legacyGroup = (overrides = {}) => ({ anchors: ['a:0', 'a:1'], theme: '旧主题', models: 9,
  tools: [['outer', 'ok'], ['opaque-nested-id', 'err']], ...overrides });

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
    [[thought('one'), thought('two'), tool()], '3'],
    [[tool()], '1'],
    [[thought(), tool()], '2'],
  ] as const) {
    const s = new ActivityState(), m = message([...content]);
    s.start(m); s.observe(m); s.observe(m);
    s.tool('opaque-nested-id', 'read', 'outer', 'err');
    s.tool('deep', 'read', 'opaque-nested-id', 'err');
    s.tool('outer', 'codemode', undefined, 'ok');
    expect(snapshot(s.groups[0]).steps).toBe(expected);
    expect(snapshot(s.groups[0]).tools).toBe('1');
    expect(snapshot(s.groups[0]).err).toBe('0');
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
    expect(snapshot(s.groups[0]).steps).toBe('1');
    expect(p.view.render(80)).toHaveLength(1);
  } finally { p.view.dispose(); }
});

test('top-level IDs are not inferred from slash spelling, nested-only events create no phantom activity', () => {
  const s = new ActivityState();
  s.tool('unrelated', 'read', 'not-yet-seen', 'err'); expect(s.groups).toHaveLength(0);
  s.start(message([tool('provider/id')]));
  s.tool('provider/id', 'codemode', undefined, 'ok'); s.settle(false);
  expect(snapshot(s.groups[0])).toMatchObject({ steps: '1', tools: '1', ok: '1', background: 'toolSuccessBg' });
});

test('thinking-prose-thinking in one response has one step in EACH segment', () => {
  const s = new ActivityState(); s.start(message([thought('first'), prose(), thought('second')]));
  expect(s.groups.map(g => snapshot(g).steps)).toEqual(['1', '1']);
  expect(s.groups.map(g => snapshot(g).background)).toEqual(['toolSuccessBg', 'toolPendingBg']);
});

test('failure wins over active thinking and open tools; success waits for the segment boundary', () => {
  const s = new ActivityState(); s.start(message([thought(), tool('a'), tool('b')]));
  s.tool('a', 'codemode', undefined, 'err');
  expect(snapshot(s.groups[0])).toMatchObject({ err: '1', open: '1', background: 'toolErrorBg' });
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
  expect(snapshot(s.groups[0])).toMatchObject({ open: '1', background: 'toolPendingBg' });
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
    expect(Bun.stripANSI(failed[0])).toContain('err 1');
    s.settle(false); p.setTime(260); const frozen = p.view.render(80);
    s.groups[0].completion = 'complete'; s.groups[0].tools.set('outer', 'ok'); p.setTime(1000);
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
    expect(last).not.toEqual(first); expect(Bun.stripANSI(last[0])).toBe(Bun.stripANSI(first[0]));
    expect(last[0]).toContain(getThemeByName('dark')!.getBgAnsi('toolSuccessBg'));
    p.setTheme('light'); const light = p.view.render(80);
    expect(light[0]).toContain(getThemeByName('light')!.getBgAnsi('toolSuccessBg'));
    expect(Bun.stripANSI(light[0])).toBe(Bun.stripANSI(last[0]));
  } finally { p.view.dispose(); }
});

test('trusted v1 migrates steps from raw blocks and filters nested results without rewriting history', () => {
  const branch = [entry('a', [thought(), tool()]), saved({ version: 1, groups: [legacyGroup()] })];
  const before = JSON.stringify(branch), s = new ActivityState(); s.restore(branch);
  expect(snapshot(s.groups[0])).toMatchObject({ steps: '2', tools: '1', ok: '1', err: '0', open: '0', background: 'toolSuccessBg' });
  expect(s.pendingRecord().groups).toEqual([]); expect(JSON.stringify(branch)).toBe(before);
});

test('v1 empty thinking anchors can be verified and dropped, never counted as a step', () => {
  const s = new ActivityState();
  s.restore([entry('a', [thought(' '), thought(), tool()]), saved({ groups: [legacyGroup({ anchors: ['a:0', 'a:1', 'a:2'] })] })]);
  expect(snapshot(s.groups[0])).toMatchObject({ steps: '2', tools: '1' });
});

test('v1 metadata is not proof that a tool-only segment completed normally', () => {
  const s = new ActivityState();
  s.restore([entry('a', [thought(), tool()], 'toolUse'), saved({ groups: [legacyGroup()] })]);
  expect(snapshot(s.groups[0])).toMatchObject({ steps: '2', ok: '1', background: 'toolPendingBg' });
});

test('trusted v1 restores explicit model failure and interruption evidence', () => {
  for (const [notice, background] of [['模型请求失败', 'toolErrorBg'], ['操作已中断', 'toolPendingBg']] as const) {
    const s = new ActivityState();
    s.restore([entry('a', [thought(), tool()]), saved({ groups: [legacyGroup()], notices: [['a', notice]] })]);
    expect(snapshot(s.groups[0])).toMatchObject({ steps: '2', background });
    expect(s.byId.get('a')?.notice).toBe(notice);
  }
});

test('unrecorded interrupted history stays unknown rather than assuming EOF means success', () => {
  const s = new ActivityState(); s.restore([entry('a', [thought(), tool()], 'aborted')]);
  expect(snapshot(s.groups[0])).toMatchObject({ steps: '—', tools: '—', background: 'toolPendingBg' });
  expect(s.save()).toEqual([]);
});

test('partial, missing, duplicate or inconsistent metadata anchors are not trusted', () => {
  for (const overrides of [
    { anchors: ['a:0'] }, { anchors: ['missing:0', 'a:1'] }, { anchors: ['a:0', 'a:0'] },
    { tools: [['opaque-nested-id', 'ok']] }, { tools: [['outer', 'ok'], ['outer', 'err']] },
  ]) {
    const s = new ActivityState(); s.restore([entry('a', [thought(), tool()]), saved({ groups: [legacyGroup(overrides)] })]);
    expect(snapshot(s.groups[0])).toMatchObject({ steps: '—', background: 'toolPendingBg' });
  }
});

test('v2 records persist completion and new counters exactly, without trusting mismatched thought counts', () => {
  const m = message([thought(), tool()], 'error'), s = new ActivityState();
  s.start(m); s.bind('a'); s.tool('outer', 'codemode', undefined, 'ok'); s.settle(false);
  const record = s.pendingRecord(), restored = new ActivityState();
  restored.restore([entry('a', m.content, m.stopReason), saved(record, RECORD)]);
  expect(snapshot(restored.groups[0])).toEqual(snapshot(s.groups[0]));
  expect(restored.pendingRecord().groups).toEqual([]);
  const bad = structuredClone(record); bad.groups[0].thoughts++;
  const invalid = new ActivityState(); invalid.restore([entry('a', m.content), saved(bad, RECORD)]);
  expect(snapshot(invalid.groups[0]).steps).toBe('—');
});

test('known final model failure remains red even when history counters are unknown', () => {
  const s = new ActivityState(); s.restore([entry('a', [thought()], 'error')]);
  expect(snapshot(s.groups[0])).toMatchObject({ steps: '—', background: 'toolErrorBg' });
  expect(s.byId.get('a')?.notice).toBe('模型请求失败');
});

test('known top-level error results remain red with unknown counters; nested records do not count', () => {
  const s = new ActivityState(); s.restore([
    entry('a', [thought(), tool()], 'toolUse'),
    { type: 'message', id: 'result', message: { role: 'toolResult', toolCallId: 'outer', isError: true } },
  ]);
  expect(snapshot(s.groups[0])).toMatchObject({ steps: '—', tools: '—', background: 'toolErrorBg' });
  const nested = new ActivityState(); nested.restore([
    entry('a', [tool()], 'toolUse'),
    { type: 'message', id: 'result', message: { role: 'toolResult', toolCallId: 'inner', isError: true } },
  ]);
  expect(snapshot(nested.groups[0]).background).toBe('toolPendingBg');
});

test('an earlier failed model attempt is not mistaken for a final failure during history replay', () => {
  const s = new ActivityState(); s.restore([entry('a', [thought('retry')], 'error'), entry('b', [thought('recovered')])]);
  expect(snapshot(s.groups[0])).toMatchObject({ steps: '—', background: 'toolPendingBg' });
  expect(s.byId.get('b')?.notice).toBe('');
});

test('v1 nested tool names cannot override the reconstructed top-level title', () => {
  const s = new ActivityState(); s.restore([entry('a', [tool()], 'toolUse'), saved({ groups: [legacyGroup({
    anchors: ['a:0'], theme: 'read', tools: [['outer', 'open'], ['inner', 'open']],
  })] })]);
  expect(snapshot(s.groups[0])).toMatchObject({ theme: 'codemode', steps: '1', tools: '1', background: 'toolPendingBg' });
});

test('metadata contradicting a raw terminal result is untrusted and cannot hide the failure', () => {
  const s = new ActivityState(); s.restore([
    entry('a', [thought(), tool()], 'toolUse'),
    { type: 'message', id: 'result', message: { role: 'toolResult', toolCallId: 'outer', isError: true } },
    saved({ groups: [legacyGroup()] }),
  ]);
  expect(snapshot(s.groups[0])).toMatchObject({ steps: '—', background: 'toolErrorBg' });
});

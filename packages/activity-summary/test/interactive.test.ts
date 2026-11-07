import { test, expect } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai';
import { createAgentSessionFromServices, createAgentSessionRuntime, DefaultResourceLoader, InteractiveMode, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { ProcessTerminal } from '@earendil-works/pi-tui';
import extension from '../src/index.ts';
class CapturedTerminal extends ProcessTerminal {
  input?: (data: string) => void; output = '';
  get columns() { return 120; } get rows() { return 24; }
  start(input: (data: string) => void) { this.input = input; }
  stop() { this.input = undefined; }
  hideCursor() {} showCursor() {} setTitle(_title: string) {}
  write(data: string) { this.output += data; if (data.includes('\x1b[c')) queueMicrotask(() => this.input?.('\x1b[?1;2c')); }
}
const thought = (title = 'Inspect') => ({ type: 'thinking', thinking: `**${title}**\n\nPRIVATE_THINKING_DETAIL` });
const prose = (text: string) => ({ type: 'text', text });
const tool = (id: string, name: string) => ({ type: 'toolCall', id, name, arguments: {} });
async function scenario(responses: any[], retry = false, continuation: 'none' | 'empty' | 'hidden' = 'none') {
  const root = await mkdtemp(join(tmpdir(), 'pi-parent-acceptance-'));
  let captured: any, context: any, calls = 0, current: any;
  const terminal = new CapturedTerminal();
  const manager = SessionManager.inMemory(root);
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  const modelRuntime = await ModelRuntime.create({ authPath: join(root, 'auth.json'), modelsPath: null, modelsStorePath: join(root, 'models.json'), refreshOnCreate: false, allowModelNetwork: false });
  const snapshots: string[] = [];
  const rawRendered = () => captured?.children[0]?.render(120).join('\n') ?? '';
  const rendered = () => Bun.stripANSI(rawRendered());
  modelRuntime.registerProvider('acceptance-fixture', {
    baseUrl: 'https://test.invalid', apiKey: 'fixture', api: 'openai-completions',
    models: [{ id: 'fake', name: 'fake', reasoning: true, input: ['text'], cost, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple(_model: any, _context: any, options: any) {
      const response = responses[calls++] ?? { content: [prose('fallback')], stopReason: 'stop' };
      const msg: any = { role: 'assistant', api: 'openai-completions', provider: 'acceptance-fixture', model: 'fake', content: [], stopReason: 'pending', timestamp: 1000 + calls, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost } };
      const stream = new AssistantMessageEventStream();
      queueMicrotask(async () => {
        await options?.onPayload?.({}, _model);
        stream.push({ type: 'start', partial: { ...msg } }); await Bun.sleep(20);
        for (const [index, block] of response.content.entries()) {
          msg.content = [...msg.content, block];
          stream.push({ type: block.type === 'thinking' ? 'thinking_delta' : block.type === 'text' ? 'text_delta' : 'toolcall_delta', contentIndex: index, delta: block.thinking ?? block.text ?? '{}', partial: { ...msg } } as any);
          await Bun.sleep(30); snapshots.push(rendered());
        }
        Object.assign(msg, response);
        if (response.stopReason === 'error' || response.stopReason === 'aborted') stream.push({ type: 'error', reason: response.stopReason, error: msg });
        else stream.push({ type: 'done', reason: response.stopReason, message: msg });
        stream.end();
      });
      return stream;
    },
  });
  const settingsManager = SettingsManager.inMemory({ tuiMode: 'regular', theme: 'dark', quietStartup: true, showCacheMissNotices: false, hideThinkingBlock: true, compaction: { enabled: false }, retry: { enabled: retry, maxRetries: 1, baseDelayMs: 1 }, packages: [] });
  const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager, noExtensions: true, noSkills: true, noThemes: true, noContextFiles: true, noPromptTemplates: true, extensionFactories: [extension, (pi: any) => {
    let continued = false;
    pi.on('turn_end', (event: any) => {
      if (continuation === 'none' || continued) return;
      continued = true;
      return { continue: true, entries: continuation === 'hidden'
        ? [...event.entries, { type: 'custom_message', customType: 'fixture-continuation', content: 'Continue reasoning.', display: false }]
        : event.entries };
    });
    pi.on('session_start', (_e: any, ctx: any) => {
      context = ctx;
      ctx.ui.setWidget('capture', (tui: any) => { captured = tui; return { render: () => [], invalidate() {} }; });
    });
    const parameters = { type: 'object', properties: {} };
    pi.registerTool({ name: 'outer', label: 'outer', description: 'fake', parameters, async execute(_id: string, _args: any, _sig: any, _update: any, ctx: any) { await Promise.all([ctx.executeTool('inner', {}), ctx.executeTool('inner', {})]); return { content: [prose('PRIVATE_OUTER_RESULT')], details: {} }; } });
    pi.registerTool({ name: 'inner', label: 'inner', description: 'fake', parameters, async execute() { return { content: [prose('PRIVATE_INNER_RESULT')], details: {} }; } });
    pi.registerTool({ name: 'fail', label: 'fail', description: 'fake', parameters, async execute() { throw new Error('PRIVATE_TOOL_FAILURE'); } });
  }] });
  await resourceLoader.reload();
  const services = { cwd: root, agentDir: root, modelRuntime, settingsManager, resourceLoader, diagnostics: [] };
  const start = async () => {
    const runtime = await createAgentSessionRuntime(async ({ sessionManager }: any) => ({ ...(await createAgentSessionFromServices({ services, sessionManager, model: modelRuntime.getModel('acceptance-fixture', 'fake'), tools: ['outer', 'inner', 'fail'] })), services, diagnostics: [] }), { cwd: root, agentDir: root, sessionManager: manager });
    const mode = new InteractiveMode(runtime, { terminal, tuiMode: 'regular', initialThemeSetting: 'dark' });
    await mode.init(); return { runtime, mode };
  };
  try { current = await start(); } catch (e) { await rm(root, { recursive: true, force: true }); throw e; }
  return { manager, terminal, rendered, rawRendered, snapshots, calls: () => calls,
    expanded: () => context.ui.getToolsExpanded(),
    key: (data: string) => terminal.input?.(data),
    dialog: () => context.ui.input('Modal fixture'),
    prompt: (text = 'acceptance fixture') => current.runtime.session.prompt(text),
    queue: () => current.runtime.session.followUp('queued fixture'),
    idle: () => current.runtime.session.waitForIdle(),
    reload: () => current.mode.handleReloadCommand(),
    async resume() { current.mode.stop(); await current.runtime.dispose(); current = await start(); },
    async close() { current.mode.stop(); await current.runtime.dispose(); await rm(root, { recursive: true, force: true }); },
  };
}
test('real InteractiveMode: prose streams, nested errors hidden, settled summaries match resume', async () => {
  const s = await scenario([
    { content: [thought(), prose('Checking configuration.'), tool('outer', 'outer'), tool('failure', 'fail')], stopReason: 'toolUse' },
    { content: [thought('Verify'), prose('Final answer.')], stopReason: 'stop' },
  ]);
  try {
    await s.prompt(); await Bun.sleep(300);
    const before = s.rendered();
    expect(before).not.toContain('PRIVATE_TOOL_FAILURE'); expect(before).not.toContain('PRIVATE_OUTER_RESULT'); expect(before).not.toContain('PRIVATE_INNER_RESULT');
    expect(before).toContain('Checking configuration.'); expect(before).toContain('Final answer.');
    expect(s.snapshots.some(x => x.includes('Checking configuration.') && !x.includes('Final answer.'))).toBe(true);
    const summaries = before.split('\n').filter(x => /\b\d+ steps?\b/.test(x));
    const colored = s.rawRendered().split('\n').filter((x: string) => /\b\d+ steps?\b/.test(x));
    expect(summaries).toHaveLength(2);
    expect(summaries[0]).toContain('1 step');
    expect(summaries[1]).toContain('3 steps · 1 failed');
    expect(summaries[0]).toContain('Inspect'); expect(summaries[1]).toContain('Verify');
    expect(s.terminal.output).not.toContain('PRIVATE_TOOL_FAILURE');
    await s.reload();
    expect(s.rendered()).not.toContain('Reload failed');
    expect(s.rendered().split('\n').filter(x => /\b\d+ steps?\b/.test(x))).toEqual(summaries);
    expect(s.rawRendered().split('\n').filter((x: string) => /\b\d+ steps?\b/.test(x))).toEqual(colored);
    await s.resume();
    expect(s.rendered().split('\n').filter(x => /\b\d+ steps?\b/.test(x))).toEqual(summaries);
    expect(s.rawRendered().split('\n').filter((x: string) => /\b\d+ steps?\b/.test(x))).toEqual(colored);
  } finally { await s.close(); }
}, 30000);
test('real InteractiveMode: queued follow-up has independent groups before the final idle boundary', async () => {
  const s = await scenario([
    { content: [thought(), tool('outer', 'outer')], stopReason: 'toolUse' },
    { content: [prose('First answer.')], stopReason: 'stop' },
    { content: [thought('Follow-up'), prose('Follow-up answer.')], stopReason: 'stop' },
  ]);
  try {
    const run = s.prompt(); await Bun.sleep(40);
    expect(await s.queue()).toBe('queued');
    await run; await s.idle();
    const text = s.rendered();
    expect(s.calls()).toBe(3);
    expect(text).toContain('First answer.'); expect(text).toContain('Follow-up answer.');
    const rows = text.split('\n').filter(x => /\b\d+ steps?\b/.test(x));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('2 steps');
    expect(rows[1]).toContain('1 step');
    const records = s.manager.getBranch().filter((e: any) => e.type === 'custom' && e.customType === 'pi-activity-summary/v2') as any[];
    expect(records).toEqual([]);
    await s.reload();
    expect(s.rendered().split('\n').filter(x => /\b\d+ steps?\b/.test(x))).toEqual(rows);
  } finally { await s.close(); }
}, 30000);

test('real InteractiveMode: a queued follow-up preserves the preceding truncation before and after reload', async () => {
  const s = await scenario([
    { content: [thought('Truncated response')], stopReason: 'length' },
    { content: [thought('Follow-up'), prose('Follow-up answer.')], stopReason: 'stop' },
  ]);
  try {
    const run = s.prompt(); await Bun.sleep(40);
    expect(await s.queue()).toBe('queued');
    await run; await s.idle();
    expect(s.calls()).toBe(2);
    const rows = () => s.rawRendered().split('\n').filter(x => /steps?|模型输出已达长度上限/.test(x));
    const before = rows();
    expect(before).toHaveLength(3);
    expect(Bun.stripANSI(before[0]).trim()).toBe('● Truncated response · 1 step ›');
    expect(Bun.stripANSI(before[1]).trim()).toBe('模型输出已达长度上限');
    expect(Bun.stripANSI(before[2]).trim()).toBe('• Follow-up · 1 step ›');
    await s.reload(); expect(rows()).toEqual(before);
    await s.resume(); expect(rows()).toEqual(before);
  } finally { await s.close(); }
}, 30000);

test('real InteractiveMode: truncated tool calls auto-continue without introducing a replay boundary', async () => {
  const s = await scenario([
    { content: [thought('Truncated tool'), tool('truncated', 'outer')], stopReason: 'length' },
    { content: [thought('Recovery'), prose('Recovered answer.')], stopReason: 'stop' },
  ]);
  try {
    await s.prompt(); await s.idle();
    expect(s.calls()).toBe(2);
    const rows = () => s.rawRendered().split('\n').filter(x => /steps?|模型输出已达长度上限/.test(x));
    const before = rows();
    expect(before).toHaveLength(1);
    expect(Bun.stripANSI(before[0])).toContain('Recovery · 3 steps · 1 failed');
    await s.reload(); expect(rows()).toEqual(before);
    await s.resume(); expect(rows()).toEqual(before);
  } finally { await s.close(); }
}, 30000);

test('real InteractiveMode: an unexecuted aborted tool ID can be reused by a later failed call', async () => {
  const s = await scenario([
    { content: [tool('reused', 'fail')], stopReason: 'aborted' },
    { content: [tool('reused', 'fail')], stopReason: 'toolUse' },
    { content: [prose('Final answer.')], stopReason: 'stop' },
  ]);
  try {
    await s.prompt(); await s.idle();
    await s.prompt(); await s.idle();
    expect(s.calls()).toBe(3);
    const rows = () => s.rawRendered().split('\n').filter(x => /steps?|操作已中断/.test(x));
    const before = rows();
    expect(before).toHaveLength(3);
    expect(Bun.stripANSI(before[0])).toContain('● fail · 1 step');
    expect(Bun.stripANSI(before[1])).toContain('操作已中断');
    expect(Bun.stripANSI(before[2])).toContain('× fail · 1 step · 1 failed');
    await s.reload(); expect(rows()).toEqual(before);
    await s.resume(); expect(rows()).toEqual(before);
  } finally { await s.close(); }
}, 30000);

for (const stopReason of ['stop', 'length']) for (const continuation of ['empty', 'hidden'] as const) {
  test(`real InteractiveMode: ${stopReason} without tools honors ${continuation} continuation context`, async () => {
    const s = await scenario([
      { content: [thought('Before continuation')], stopReason },
      { content: [thought('After continuation')], stopReason: 'stop' },
    ], false, continuation);
    try {
      await s.prompt(); await s.idle();
      // Pi rejects continue:true when no runnable context was appended. Preserve
      // that terminal response; only the hidden instruction actually continues.
      const continued = continuation === 'hidden';
      expect(s.calls()).toBe(continued ? 2 : 1);
      const rows = () => s.rawRendered().split('\n').filter(x => /steps?|模型输出已达长度上限/.test(x));
      const before = rows();
      expect(before).toHaveLength(!continued && stopReason === 'length' ? 2 : 1);
      expect(Bun.stripANSI(before[0])).toContain(continued ? '• After continuation · 2 steps' : 'Before continuation · 1 step');
      if (!continued && stopReason === 'length') expect(Bun.stripANSI(before[1])).toContain('模型输出已达长度上限');
      await s.reload(); expect(rows()).toEqual(before);
      await s.resume(); expect(rows()).toEqual(before);
    } finally { await s.close(); }
  }, 30000);
}

test('real InteractiveMode: unmatched duplicate declarations cannot capture a later batch payload', async () => {
  const s = await scenario([
    { content: [tool('reused', 'outer'), tool('reused', 'outer')], stopReason: 'toolUse' },
    { content: [prose('First answer.')], stopReason: 'stop' },
    { content: [tool('reused', 'fail')], stopReason: 'toolUse' },
    { content: [prose('Second answer.')], stopReason: 'stop' },
  ]);
  try {
    await s.prompt('FIRST_USER'); await s.idle();
    await s.prompt('SECOND_USER'); await s.idle();
    expect(s.calls()).toBe(4);
    s.key('\x0f'); await Bun.sleep(30);
    const checkPlacement = () => {
      const text = s.rendered();
      expect(text).toContain('PRIVATE_OUTER_RESULT'); expect(text).toContain('SECOND_USER');
      expect(text).toContain('PRIVATE_TOOL_FAILURE');
      expect(text.indexOf('PRIVATE_OUTER_RESULT')).toBeLessThan(text.indexOf('SECOND_USER'));
      expect(text.indexOf('PRIVATE_TOOL_FAILURE')).toBeGreaterThan(text.indexOf('SECOND_USER'));
      expect(text.match(/PRIVATE_TOOL_FAILURE/g)).toHaveLength(1);
    };
    checkPlacement();
    await s.reload(); checkPlacement();
    await s.resume(); s.key('\x0f'); await Bun.sleep(30); checkPlacement();
  } finally { await s.close(); }
}, 30000);

test('real native Ctrl+O: global fold/unfold preserves counters, contexts and reload/resume behavior', async () => {
  const s = await scenario([
    { content: [thought(), prose('Visible middle.'), tool('outer', 'outer'), tool('failure', 'fail')], stopReason: 'toolUse' },
    { content: [thought('Verify'), prose('Visible answer.')], stopReason: 'stop' },
  ]);
  try {
    await s.prompt(); await Bun.sleep(50);
    const before = s.rendered(), entries = JSON.stringify(s.manager.getBranch());
    const summaryFields = (text: string) => text.split('\n').filter(x => /\b\d+ steps?\b/.test(x)).map(x => x.replace(/[›⌄]/g, '').trim());
    expect(s.expanded()).toBe(false); expect(before).not.toContain('PRIVATE_THINKING_DETAIL');
    const collapsedRows = s.rawRendered().split('\n');
    for (const [index, row] of collapsedRows.entries()) if (/\b\d+ steps?\b/.test(row)) {
      expect(Bun.stripANSI(row)).toMatch(/^[•×●] /);
      expect(Bun.stripANSI(row).trimEnd()).toEndWith('›');
      expect(collapsedRows[index - 2]).toBe(''); // Native-style external gap, no state background.
      expect(Bun.stripANSI(collapsedRows[index - 1]).trim()).toBe('');
      expect(collapsedRows[index + 1]).toBe(collapsedRows[index - 1]);
    }
    s.key('\x0f'); await Bun.sleep(30);
    expect(s.expanded()).toBe(true);
    const open = s.rendered();
    expect(open.match(/PRIVATE_THINKING_DETAIL/g)).toHaveLength(2);
    expect(open).toContain('PRIVATE_OUTER_RESULT'); expect(open).toContain('PRIVATE_TOOL_FAILURE');
    expect(open).toContain('Visible middle.'); expect(open).toContain('Visible answer.');
    expect(summaryFields(open)).toEqual(summaryFields(before));
    expect(JSON.stringify(s.manager.getBranch())).toBe(entries); // Presentation only.
    await s.reload();
    expect(s.expanded()).toBe(true); expect(s.rendered()).toContain('PRIVATE_OUTER_RESULT');
    expect(summaryFields(s.rendered())).toEqual(summaryFields(open));
    s.key('\x0f'); await Bun.sleep(30);
    expect(s.expanded()).toBe(false); expect(s.rendered()).not.toContain('PRIVATE_OUTER_RESULT');
    s.key('\x0f'); await Bun.sleep(30);
    await s.resume(); // A fresh native UI starts collapsed; history still opens correctly.
    expect(s.expanded()).toBe(false); expect(s.rendered()).not.toContain('PRIVATE_THINKING_DETAIL');
    s.key('\x0f'); await Bun.sleep(30);
    expect(s.expanded()).toBe(true); expect(s.rendered()).toContain('PRIVATE_TOOL_FAILURE');
    expect(summaryFields(s.rendered())).toEqual(summaryFields(before));
  } finally { await s.close(); }
}, 30000);

test('real native Ctrl+O during streaming also expands tools created after the keypress', async () => {
  const s = await scenario([
    { content: [thought(), prose('Streaming body.'), tool('outer', 'outer')], stopReason: 'toolUse' },
    { content: [thought('Complete'), prose('Done.')], stopReason: 'stop' },
  ]);
  try {
    const run = s.prompt();
    for (let i = 0; i < 100 && !s.rendered().includes('Inspect'); i++) await Bun.sleep(5);
    expect(s.rendered()).toContain('Inspect');
    s.key('\x0f'); expect(s.expanded()).toBe(true);
    expect(s.rendered()).toContain('PRIVATE_THINKING_DETAIL');
    await run; await Bun.sleep(50);
    expect(s.rendered()).toContain('PRIVATE_OUTER_RESULT'); expect(s.rendered()).toContain('Done.');
    expect(s.snapshots.some(x => x.includes('Streaming body.') && !x.includes('Done.'))).toBe(true);
    s.key('\x0f'); await Bun.sleep(30);
    expect(s.rendered()).not.toContain('PRIVATE_THINKING_DETAIL'); expect(s.rendered()).not.toContain('PRIVATE_OUTER_RESULT');
  } finally { await s.close(); }
}, 30000);

test('native Ctrl+O is not stolen from a focused modal by the projection', async () => {
  const s = await scenario([{ content: [thought(), prose('Done.')], stopReason: 'stop' }]);
  try {
    await s.prompt();
    const dialog = s.dialog(); await Bun.sleep(20);
    s.key('\x0f'); await Bun.sleep(20); expect(s.expanded()).toBe(false);
    s.key('\x1b'); await dialog;
    s.key('\x0f'); await Bun.sleep(20); expect(s.expanded()).toBe(true); expect(s.rendered()).toContain('PRIVATE_THINKING_DETAIL');
  } finally { await s.close(); }
}, 30000);

test('real InteractiveMode: transient retry hidden, final retry failure emits one short line', async () => {
  const response = { content: [thought()], stopReason: 'error', errorMessage: '429 rate limit\nPRIVATE_PROVIDER_STACK\n at socket()' };
  const s = await scenario([response, response], true);
  try {
    await s.prompt(); await Bun.sleep(300);
    const text = s.rendered();
    expect(s.calls()).toBe(2);
    expect(text).not.toContain('PRIVATE_PROVIDER_STACK');
    expect(text.match(/模型请求失败/g)).toHaveLength(1);
    expect(text).not.toContain('Retry failed after');
    expect(text).toContain('2 steps');
  } finally { await s.close(); }
}, 30000);

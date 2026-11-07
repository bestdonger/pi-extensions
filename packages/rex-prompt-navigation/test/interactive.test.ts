import { test, expect } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai';
import { createAgentSessionFromServices, createAgentSessionRuntime, DefaultResourceLoader,
  InteractiveMode, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { ProcessTerminal, formatProgramStatus, stripTerminalSequences } from '@earendil-works/pi-tui';
import extension from '../src/index.ts';
import activity from '../../activity-summary/src/index.ts';
const A = '\x1b]133;A\x07';
class Terminal extends ProcessTerminal {
  input?: (data: string) => void;
  output = ''; statusOutput = ''; width = 96; height = 24;
  get columns() { return this.width; } get rows() { return this.height; }
  start(input: (data: string) => void) { this.input = input; }
  stop() { this.input = undefined; }
  hideCursor() {} showCursor() {} setTitle(_title: string) {}
  setProgramStatus(status: any) {
    Reflect.set(this, 'programStatus', status);
    this.statusOutput += formatProgramStatus(status);
  }
  write(data: string) {
    this.output += data;
    if (data.includes('\x1b[c')) queueMicrotask(() => this.input?.('\x1b[?1;2c'));
  }
}
async function scenario({ enabled = true, mode = 'regular', withActivity = false, rex = true, disabled = false }:
  { enabled?: boolean; mode?: 'regular' | 'fullscreen'; withActivity?: boolean; rex?: boolean; disabled?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pi-rex-prompts-test-'));
  const envKeys = ['REX_SESSION', 'REX_BLOCK', 'TMUX', 'STY', 'PI_REX_PROMPTS'];
  const saved = Object.fromEntries(envKeys.map(k => [k, process.env[k]]));
  delete process.env.TMUX; delete process.env.STY; delete process.env.PI_REX_PROMPTS;
  if (disabled) process.env.PI_REX_PROMPTS = '0';
  if (rex) { process.env.REX_SESSION = 'fixture'; process.env.REX_BLOCK = 'fixture'; }
  else { delete process.env.REX_SESSION; delete process.env.REX_BLOCK; }
  let host: any, ctx: any, current: any, calls = 0;
  const terminal = new Terminal();
  Reflect.set(terminal, 'programStatusSupported', true);
  const manager = SessionManager.inMemory(root);
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  const modelRuntime = await ModelRuntime.create({ authPath: join(root, 'auth.json'), modelsPath: null,
    modelsStorePath: join(root, 'models.json'), refreshOnCreate: false, allowModelNetwork: false });
  modelRuntime.registerProvider('rex-fixture', {
    baseUrl: 'https://test.invalid', apiKey: 'fixture', api: 'openai-completions',
    models: [{ id: 'fake', name: 'fake', reasoning: true, input: ['text'], cost, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple(_model: any, _context: any, options: any) {
      const turn = ++calls;
      const msg: any = { role: 'assistant', api: 'openai-completions', provider: 'rex-fixture', model: 'fake', content: [],
        stopReason: 'pending', timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost } };
      const stream = new AssistantMessageEventStream();
      queueMicrotask(async () => {
        await options?.onPayload?.({}, _model);
        stream.push({ type: 'start', partial: { ...msg } });
        await Bun.sleep(30);
        const block = turn === 1
          ? { type: 'toolCall', id: 'probe-1', name: 'fixture_tool', arguments: {} }
          : { type: 'text', text: `Streaming body ${turn} 中文😀` };
        msg.content.push(block);
        stream.push({ type: turn === 1 ? 'toolcall_delta' : 'text_delta', contentIndex: 0,
          delta: (block as any).text ?? '{}', partial: { ...msg } } as any);
        await Bun.sleep(40);
        msg.stopReason = turn === 1 ? 'toolUse' : 'stop';
        stream.push({ type: 'done', reason: msg.stopReason, message: msg }); stream.end();
      });
      return stream;
    },
  });
  const settingsManager = SettingsManager.inMemory({ tuiMode: mode, theme: 'dark', quietStartup: true,
    showCacheMissNotices: false, compaction: { enabled: false }, packages: [] });
  const capture = (pi: any) => {
    pi.on('session_start', (_: any, context: any) => {
      ctx = context;
      ctx.ui.setWidget('capture', (tui: any) => { host = tui;
        return { render: () => [], invalidate() {} }; });
    });
    pi.registerTool({ name: 'fixture_tool', label: 'fixture_tool', description: 'offline fixture',
      parameters: { type: 'object', properties: {} }, async execute() {
        await Bun.sleep(30); return { content: [{ type: 'text', text: 'TOOL_RESULT_FIXTURE' }], details: {} };
      } });
    pi.registerCommand('fixture_dialog', { handler: async (_: any, context: any) => context.ui.input('Fixture question') });
  };
  const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager,
    noExtensions: true, noSkills: true, noThemes: true, noContextFiles: true, noPromptTemplates: true,
    extensionFactories: [...(withActivity ? [activity] : []), ...(enabled ? [extension] : []), capture] });
  await resourceLoader.reload();
  const services = { cwd: root, agentDir: root, modelRuntime, settingsManager, resourceLoader, diagnostics: [] };
  const start = async () => {
    const runtime = await createAgentSessionRuntime(async ({ sessionManager }: any) => ({
      ...(await createAgentSessionFromServices({ services, sessionManager,
        model: modelRuntime.getModel('rex-fixture', 'fake'), tools: ['fixture_tool'] })), services, diagnostics: [],
    }), { cwd: root, agentDir: root, sessionManager: manager });
    const ui = new InteractiveMode(runtime, { terminal, tuiMode: mode, initialThemeSetting: 'dark' });
    await ui.init(); return { runtime, ui };
  };
  const cleanupEnv = () => { for (const k of envKeys) saved[k] === undefined ? delete process.env[k] : process.env[k] = saved[k]; };
  try { current = await start(); } catch (e) { cleanupEnv(); await rm(root, { recursive: true, force: true }); throw e; }
  const flush = () => Reflect.get(host, 'doRender').call(host);
  return { terminal, manager, flush, host: () => host,
    output: () => terminal.output,
    clear: () => { terminal.output = ''; },
    text: () => stripTerminalSequences(host.render(terminal.width).join('\n')),
    prompt: (text: string) => current.runtime.session.prompt(text),
    command: (text: string) => current.runtime.session.prompt(text),
    status: () => Reflect.get(terminal, 'programStatus'),
    dialog: () => ctx.ui.input('Fixture question'),
    async reload() { await current.ui.handleReloadCommand(); flush(); },
    switchMode(mode: 'regular' | 'fullscreen') { current.ui.switchTuiMode(mode); flush(); },
    async resume() { current.ui.stop(); await current.runtime.dispose(); current = await start(); flush(); },
    async close() { current.ui.stop(); await current.runtime.dispose(); cleanupEnv(); await rm(root, { recursive: true, force: true }); },
  };
}

for (const withActivity of [false, true]) test(`real InteractiveMode: old/new prompts, streaming, tools, status, resize, reload/resume (activity=${withActivity})`, async () => {
  const s = await scenario({ withActivity });
  try {
    const pending = s.prompt('FIRST_USER_FIXTURE');
    await Bun.sleep(45); s.flush();
    expect(s.status().state).toBe('working');
    expect(s.output()).toContain(A + formatProgramStatus(s.status()));
    await pending; s.flush();
    expect(s.status().state).toBe('done');
    expect(s.text()).toContain('FIRST_USER_FIXTURE'); expect(s.text()).toContain('Streaming body 2');
    if (!withActivity) expect(s.text()).toContain('TOOL_RESULT_FIXTURE');
    s.clear(); await s.prompt('SECOND_USER_FIXTURE'); s.flush();
    expect(s.output()).toContain(A); expect(s.text()).toContain('SECOND_USER_FIXTURE');
    const messagesBefore = JSON.stringify(s.manager.getBranch().filter(e => e.type === 'message'));
    s.terminal.width = 68; s.terminal.height = 18; s.clear(); s.flush();
    expect(s.output().match(/\x1b\]133;A\x07/g)).toHaveLength(2);
    expect(s.status().state).toBe('done');
    expect(s.output()).not.toContain('\x1b]7501;'); // resizing must not announce completion again
    expect(JSON.stringify(s.manager.getBranch().filter(e => e.type === 'message'))).toBe(messagesBefore);
    await s.reload(); expect(s.text()).not.toContain('Reload failed');
    s.terminal.width = 69; s.clear(); s.flush();
    expect(s.output().match(/\x1b\]133;A\x07/g)).toHaveLength(2); // not nested after reload
    await s.resume(); s.clear(); s.terminal.width = 70; s.flush();
    expect(s.output().match(/\x1b\]133;A\x07/g)).toHaveLength(2);
    expect(s.text()).toContain('FIRST_USER_FIXTURE'); expect(s.text()).toContain('SECOND_USER_FIXTURE');
  } finally { await s.close(); }
}, 30000);

test('real dialog preserves blocked status through prompt redraw, then restores idle/done', async () => {
  const s = await scenario();
  try {
    await s.prompt('USER_DIALOG_FIXTURE'); s.flush();
    const dialog = s.dialog(); await Bun.sleep(20);
    expect(s.status().state).toBe('blocked'); expect(s.status().kind).toBe('question');
    s.terminal.width = 70; s.clear(); s.flush();
    expect(s.output()).toContain(A + formatProgramStatus(s.status()));
    s.terminal.input?.('\x1b'); await dialog;
    expect(s.status().state).toBe('done');
  } finally { await s.close(); }
}, 30000);

test('commands off/on are reversible without touching persisted messages', async () => {
  const s = await scenario();
  try {
    await s.prompt('USER_TOGGLE_FIXTURE');
    const entries = JSON.stringify(s.manager.getBranch());
    await s.command('/rex-prompts off'); s.clear(); s.terminal.width--; s.flush();
    expect(s.output()).not.toContain(A);
    await s.command('/rex-prompts on'); s.clear(); s.terminal.width--; s.flush();
    expect(s.output()).toContain(A);
    expect(JSON.stringify(s.manager.getBranch())).toBe(entries);
  } finally { await s.close(); }
}, 30000);

test('real runtime mode replacement disables safely; returning to regular supports explicit on', async () => {
  const s = await scenario();
  try {
    await s.prompt('USER_MODE_FIXTURE'); s.flush();
    s.switchMode('fullscreen'); await Bun.sleep(20);
    s.clear(); s.terminal.width--; s.flush(); expect(s.output()).not.toContain(A);
    s.switchMode('regular'); await Bun.sleep(20);
    await s.command('/rex-prompts on');
    s.clear(); s.terminal.width--; s.flush(); expect(s.output()).toContain(A);
  } finally { await s.close(); }
}, 30000);

for (const options of [{ enabled: false }, { rex: false }, { disabled: true }, { mode: 'fullscreen' as const }])
  test(`negative control: no native OSC markers with ${JSON.stringify(options)}`, async () => {
    const s = await scenario(options);
    try {
      await s.prompt('USER_NEGATIVE_FIXTURE'); s.flush();
      expect(s.output()).not.toContain(A);
      if (options.mode !== 'fullscreen') expect(s.text()).toContain('USER_NEGATIVE_FIXTURE');
    } finally { await s.close(); }
  }, 30000);

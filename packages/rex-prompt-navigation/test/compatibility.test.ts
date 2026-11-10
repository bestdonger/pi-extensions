import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const packagePath = fileURLToPath(new URL('../', import.meta.url));
const entry = new URL('../src/index.ts', import.meta.url).href;

// Isolate the advertised VERSION override; keep the real current host's classes,
// renderer and terminal interfaces. This does not simulate other implementations.
for (const version of ['1.4.0', '1.5.0', '1.5.1', '1.6.0', '2.0.0', '99.0.0']) test(`compatible host ${version} enables without a version whitelist`, () => {
  const script = `
    import { mock } from 'bun:test';
    import assert from 'node:assert/strict';
    import * as host from '@earendil-works/pi-coding-agent';
    import { ProcessTerminal, TuiMainScreen } from '@earendil-works/pi-tui';
    mock.module('@earendil-works/pi-coding-agent', () => ({ ...host, VERSION: ${JSON.stringify(version)} }));
    const { default: extension } = await import(${JSON.stringify(entry)});
    host.initTheme('dark', false);
    process.env.REX_SESSION = 'version-fixture'; process.env.REX_BLOCK = 'version-fixture';
    delete process.env.TMUX; delete process.env.STY; delete process.env.PI_REX_PROMPTS;
    class Terminal extends ProcessTerminal {
      output = '';
      get columns() { return 80; } get rows() { return 20; }
      start() {} stop() {} hideCursor() {} showCursor() {}
      write(data) { this.output += data; }
    }
    const terminal = new Terminal(), tui = new TuiMainScreen(terminal);
    tui.requestRender = () => {};
    Reflect.set(terminal, 'programStatusSupported', true);
    Reflect.set(terminal, 'programStatus', { state: 'working', app: 'pi' });
    tui.addChild(new host.UserMessageComponent('VERSION_FIXTURE'));
    const handlers = new Map(), commands = new Map(), warnings = [], notices = [];
    const ctx = { mode: 'tui', ui: {
      notify(message, type) { notices.push(message); if (type === 'warning') warnings.push(message); },
      setWidget(_name, factory) { factory?.(tui); },
    } };
    const originalRender = tui.render, originalWrite = terminal.write;
    extension({ on: (name, fn) => handlers.set(name, fn), registerCommand: (name, command) => commands.set(name, command) });
    try {
      handlers.get('session_start')({}, ctx);
      assert.deepEqual(warnings, []);
      assert.notEqual(tui.render, originalRender);
      await commands.get('rex-prompts').handler('status', ctx);
      assert(notices.at(-1).includes('已启用'));
      assert(notices.at(-1).includes('Pi ' + ${JSON.stringify(version)}));
      Reflect.set(tui, 'stopped', false); Reflect.get(tui, 'doRender').call(tui);
      assert(terminal.output.includes('\u001b]133;A\u0007'));
      handlers.get('session_shutdown')({}, ctx);
      assert.equal(tui.render, originalRender); assert.equal(terminal.write, originalWrite);
      tui.doRender = () => {}; // An actual incompatible renderer still refuses installation.
      handlers.get('session_start')({}, ctx); handlers.get('session_start')({}, ctx);
      assert.equal(warnings.length, 1); assert(warnings[0].includes('渲染器已变化'));
      assert.equal(tui.render, originalRender); assert.equal(terminal.write, originalWrite);
    } finally { handlers.get('session_shutdown')({}, ctx); tui.stop(); }
  `;
  const result = spawnSync(process.execPath, ['--eval', script], { cwd: packagePath, encoding: 'utf8' });
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
});

test('workspace Pi peers do not impose version limits and Rex lock metadata matches', async () => {
  const manifest = await Bun.file(new URL('../package.json', import.meta.url)).json();
  const lock = await Bun.file(new URL('../../../package-lock.json', import.meta.url)).json();
  expect(manifest.peerDependencies['@earendil-works/pi-coding-agent']).toBe('*');
  expect(manifest.peerDependencies['@earendil-works/pi-tui']).toBe('*');
  expect(lock.packages['packages/rex-prompt-navigation'].version).toBe(manifest.version);
  expect(lock.packages['packages/rex-prompt-navigation'].peerDependencies).toEqual(manifest.peerDependencies);
  for (const metadata of Object.values(lock.packages) as any[]) {
    for (const [name, range] of Object.entries(metadata.peerDependencies ?? {})) {
      if (name.startsWith('@earendil-works/pi-')) expect(range).toBe('*');
    }
  }
});

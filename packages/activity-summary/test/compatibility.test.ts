import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const packagePath = fileURLToPath(new URL('../', import.meta.url));
const entry = new URL('../src/index.ts', import.meta.url).href;

// Mock only the advertised host version, keeping real Pi classes/exports. Each
// subprocess isolates mock.module from the native integration tests in this suite.
for (const version of ['1.5.2', '2.0.0', '99.0.0']) test(`compatible host ${version} loads without a version whitelist`, () => {
  const script = `
    import { mock } from 'bun:test';
    import assert from 'node:assert/strict';
    import * as host from '@earendil-works/pi-coding-agent';
    import { Container } from '@earendil-works/pi-tui';
    mock.module('@earendil-works/pi-coding-agent', () => ({ ...host, VERSION: ${JSON.stringify(version)} }));
    const { default: extension } = await import(${JSON.stringify(entry)});
    for (const mode of ['regular', 'fullscreen']) {
      const handlers = new Map(), warnings = [], source = new Container(), document = new Container();
      document.addChild(new Container()); document.addChild(new Container()); document.addChild(source);
      const tui = { mode, children: [document], previousViewportTop: 0, requestRender() {}, getFocusedComponent: () => null, setFocus() {}, retargetOverlayPreFocus() {} };
      const ctx = { mode: 'tui', sessionManager: { getBranch: () => [] }, ui: {
        notify: message => warnings.push(message), getToolsExpanded: () => false,
        setWidget(_name, factory) { factory?.(tui); },
      } };
      extension({ on: (name, fn) => handlers.set(name, fn) });
      handlers.get('session_start')({}, ctx);
      assert.notEqual(document.children[2], source, mode + ' projection must mount');
      assert.deepEqual(warnings, []);
      handlers.get('message_start')({ message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'Inspect' }] } }, ctx);
      assert.equal(document.children[2].state().groups[0].thoughts, 1);
      handlers.get('session_shutdown')({}, ctx);
      assert.equal(document.children[2], source, mode + ' cleanup must restore native rendering');
      document.children.pop(); // A real incompatible layout, unlike a newer version number.
      handlers.get('session_start')({}, ctx); handlers.get('session_start')({}, ctx);
      assert.equal(warnings.length, 1);
      assert.equal(document.children.length, 2);
      handlers.get('session_shutdown')({}, ctx);
    }
  `;
  const result = spawnSync(process.execPath, ['--eval', script], { cwd: packagePath, encoding: 'utf8' });
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
});

test('host peer declarations do not impose a Pi version ceiling', async () => {
  const manifest = await Bun.file(new URL('../package.json', import.meta.url)).json();
  const lock = await Bun.file(new URL('../../../package-lock.json', import.meta.url)).json();
  expect(manifest.peerDependencies['@earendil-works/pi-coding-agent']).toBe('*');
  expect(manifest.peerDependencies['@earendil-works/pi-tui']).toBe('*');
  expect(lock.packages['packages/activity-summary'].peerDependencies).toEqual(manifest.peerDependencies);
});

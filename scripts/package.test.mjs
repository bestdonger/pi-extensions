import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const root = process.env.PI_EXTENSIONS_ROOT || fileURLToPath(new URL('../', import.meta.url));
const host = process.env.PI_PACKAGE_ROOT || '/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent';
const { DefaultResourceLoader, SettingsManager } = await import(pathToFileURL(join(host, 'dist/index.js')).href);

test('root package loads exactly five extensions with host-provided peers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-root-package-'));
  try {
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    const expected = [
      'packages/ask-user-question/index.ts',
      'packages/activity-summary/src/index.ts',
      'packages/rex-prompt-navigation/src/index.ts',
      'packages/fast-mode/src/index.ts',
      'packages/token-speed/src/index.ts',
    ].map(path => resolve(root, path)).sort();
    assert.deepEqual(manifest.pi.extensions.map(path => resolve(root, path)).sort(), expected);
    const loader = new DefaultResourceLoader({
      cwd: dir, agentDir: dir,
      settingsManager: SettingsManager.inMemory({ packages: [root] }),
      noSkills: true, noThemes: true, noContextFiles: true, noPromptTemplates: true,
    });
    await loader.reload();
    const result = loader.getExtensions();
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.extensions.map(extension => extension.path).sort(), expected);
    assert.equal(result.extensions.filter(extension => extension.tools.size > 0).length, 1);
    assert.equal(result.extensions.filter(extension => extension.commands.has('rex-prompts')).length, 1);
    assert.equal(result.extensions.filter(extension => extension.commands.has('fast')).length, 1);
    const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
    assert.equal(lock.packages['node_modules/@juicesharp/rpiv-config'].version, '2.15.0');
    assert.equal(Object.keys(lock.packages).some(path => /node_modules\/(?:@earendil-works\/pi-|typebox(?:\/|$))/.test(path)), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

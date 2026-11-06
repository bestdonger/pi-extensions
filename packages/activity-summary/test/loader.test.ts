import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';

test('real package discovery loads the local entry and filters both old package extensions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-summary-loader-'));
  const packagePath = fileURLToPath(new URL('../', import.meta.url));
  const oldPackage = '/Users/bytedance/.pi/agent/npm/node_modules/@luan.sh/pi-collapse-transcript';
  try {
    const settingsManager = SettingsManager.inMemory({ packages: [
      { source: oldPackage, extensions: [] }, packagePath,
    ] });
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager,
      noSkills: true, noThemes: true, noContextFiles: true, noPromptTemplates: true });
    await loader.reload();
    const loaded = loader.getExtensions();
    expect(loaded.errors).toEqual([]);
    const paths = loaded.extensions.map(e => e.path);
    expect(paths).toContain(join(packagePath, 'src/index.ts'));
    expect(paths.some(p => p.includes('pi-collapse-transcript') || p.includes('pi-libtui'))).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 20000);

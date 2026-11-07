import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';

test('global extension directory symlink discovers one package entry with the real Pi loader', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-rex-loader-'));
  const packageRoot = fileURLToPath(new URL('..', import.meta.url));
  try {
    await mkdir(join(root, 'extensions'));
    await symlink(packageRoot, join(root, 'extensions', 'rex-prompt-navigation'));
    const settingsManager = SettingsManager.inMemory({ packages: [] });
    const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager,
      noSkills: true, noThemes: true, noContextFiles: true, noPromptTemplates: true });
    await loader.reload();
    const result = loader.getExtensions();
    expect(result.errors).toEqual([]);
    const extensions = result.extensions.filter(e => e.commands.has('rex-prompts'));
    expect(extensions).toHaveLength(1);
    expect(extensions[0]!.tools.size).toBe(0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

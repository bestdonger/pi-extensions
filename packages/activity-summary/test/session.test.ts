import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai';
import { Container, TuiMainScreen } from '@earendil-works/pi-tui';
import extension from '../src/index.ts';
import { RECORD } from '../src/state.ts';

// Real AgentSession + extension dispatch + nested tool execution; transport is entirely in process.
test('real session ordering persists top-level blocked/parallel calls, excludes nested calls and model continuation', async () => {
  const dir = mkdtempSync('/tmp/pi-activity-test-');
  let session: any;
  let calls = 0;
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  try {
    const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: join(dir, 'models.json'), modelsStorePath: join(dir, 'catalog.json'), refreshOnCreate: false, allowModelNetwork: false });
    runtime.registerProvider('fixture', {
      api: 'openai-completions', apiKey: 'not-a-real-key', baseUrl: 'http://invalid.test',
      models: [{ id: 'fake', name: 'fake', reasoning: true, input: ['text'], contextWindow: 10000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      streamSimple: () => {
        calls++;
        const stream = new AssistantMessageEventStream();
        const content: any[] = calls === 1 ? [
          { type: 'thinking', thinking: '检查配置' },
          { type: 'toolCall', id: 'outer', name: 'outer', arguments: {} },
          { type: 'toolCall', id: 'blocked', name: 'blocked', arguments: {} },
        ] : [{ type: 'text', text: 'Final answer' }];
        const msg: any = { role: 'assistant', api: 'openai-completions', provider: 'fixture', model: 'fake', timestamp: 1000, usage,
          content, stopReason: calls === 1 ? 'toolUse' : 'stop' };
        queueMicrotask(() => { stream.push({ type: 'start', partial: { ...msg, content: [] } }); stream.push({ type: 'done', reason: msg.stopReason, message: msg }); stream.end(); });
        return stream;
      },
    });
    const sm = SessionManager.inMemory(dir);
    const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, packages: [] });
    const events: string[] = [];
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      extensionFactories: [extension, (pi: any) => {
        const parameters = { type: 'object', properties: {} };
        pi.registerTool({ name: 'outer', label: 'outer', description: 'fixture', parameters,
          async execute(_id: string, _args: any, _sig: any, _update: any, ctx: any) {
            await ctx.executeTool('inner', {});
            return { content: [{ type: 'text', text: 'private outer result' }], details: {} };
          } });
        pi.registerTool({ name: 'inner', label: 'inner', description: 'fixture', parameters,
          async execute() { return { content: [{ type: 'text', text: 'private inner error' }], details: {}, isError: true }; } });
        pi.registerTool({ name: 'blocked', label: 'blocked', description: 'fixture', parameters,
          async execute() { throw new Error('blocked tool must not execute'); } });
        pi.on('tool_call', (e: any) => e.toolName === 'blocked' ? { block: true, reason: 'fixture block' } : undefined);
        for (const name of ['message_end', 'tool_execution_start', 'tool_execution_end', 'turn_end', 'agent_end', 'agent_settled']) {
          pi.on(name, (e: any) => { events.push(name + ':' + (e.toolCallId ?? e.message?.role ?? '')); });
        }
      }],
    });
    await loader.reload();
    ({ session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime, model: runtime.getModel('fixture', 'fake')!,
      resourceLoader: loader, sessionManager: sm, settingsManager: settings, tools: ['outer', 'inner', 'blocked'] }));
    class Quiet extends TuiMainScreen { requestRender() {} }
    const tui = new Quiet({ columns: 80, rows: 24 } as any);
    const doc = new Container(); doc.addChild(new Container()); doc.addChild(new Container()); doc.addChild(new Container()); tui.addChild(doc);
    const warnings: string[] = [];
    await session.bindExtensions({ mode: 'tui', uiContext: {
      theme: { fg: (_name: string, text: string) => text, style: (text: string) => text },
      setWidget: (_key: string, factory: any) => { if (typeof factory === 'function') factory(tui, {}); },
      notify: (text: string) => warnings.push(text),
    } as any });
    session.setActiveToolsByName(['outer', 'inner', 'blocked']);
    await session.prompt('fixture');
    expect(warnings).toEqual([]); expect(calls).toBe(2);
    const records = sm.getBranch().filter((e: any) => e.type === 'custom' && e.customType === RECORD) as any[];
    expect(records).toHaveLength(1);
    const groups = records[0].data.groups;
    expect(groups).toHaveLength(1); expect(groups[0].thoughts).toBe(1);
    expect(groups[0].tools).toHaveLength(2);
    expect(groups[0].tools.filter(([, outcome]: any[]) => outcome === 'err')).toHaveLength(1);
    expect(groups[0].completion).toBe('complete');
    expect(groups[0]).not.toHaveProperty('models');
    expect(groups[0].anchors.every((a: string) => /^[^:]+:\d+$/.test(a))).toBe(true);
    expect(events.indexOf('tool_execution_start:outer')).toBeGreaterThan(events.indexOf('message_end:assistant'));
    expect(events.at(-1)).toBe('agent_settled:');
    expect(sm.buildSessionContext().messages.some((m: any) => m.customType === RECORD)).toBe(false);
    expect(JSON.stringify(sm.getBranch())).toContain('private outer result');
  } finally { session?.dispose(); rmSync(dir, { recursive: true, force: true }); }
}, 20000);

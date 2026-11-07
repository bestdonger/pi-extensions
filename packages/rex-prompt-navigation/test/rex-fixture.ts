// Manual/CLI QA only. Explicitly load with -e; never a package entry point.
// Uses no network, real provider credentials, tools, or user sessions.
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai';
export default function fixture(pi: ExtensionAPI) {
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  pi.registerProvider('rex-nav-fixture', {
    baseUrl: 'https://test.invalid', apiKey: 'fixture', api: 'openai-completions',
    models: [{ id: 'fake', name: 'OFFLINE NAV QA', reasoning: false, input: ['text'], cost, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple(model, context, options) {
      const stream = new AssistantMessageEventStream();
      const count = context.messages.filter(m => m.role === 'user').length;
      const msg: any = { role: 'assistant', api: 'openai-completions', provider: 'rex-nav-fixture', model: model.id,
        content: [{ type: 'text', text: '' }], stopReason: 'pending', timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost } };
      queueMicrotask(async () => {
        await options?.onPayload?.({}, model);
        stream.push({ type: 'start', partial: { ...msg } });
        for (let i = 1; i <= 40; i++) {
          if (options?.signal?.aborted) { msg.stopReason = 'aborted'; break; }
          msg.content[0].text += `QA answer ${count} line ${i} — 中文😀; no network, fixture only.\n\n`;
          stream.push({ type: 'text_delta', contentIndex: 0, delta: msg.content[0].text, partial: { ...msg, content: [{ ...msg.content[0] }] } });
          await new Promise(r => setTimeout(r, 50));
        }
        msg.stopReason = msg.stopReason === 'aborted' ? 'aborted' : 'stop';
        stream.push({ type: 'done', reason: msg.stopReason, message: msg }); stream.end();
      });
      return stream;
    },
  });
}

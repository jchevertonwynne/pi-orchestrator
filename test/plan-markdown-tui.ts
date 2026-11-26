// Finite offline provider for an isolated real Pi TUI, not a reasoning worker.
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import type { AssistantMessage } from '@earendil-works/pi-ai';

export const plan = '# Synthetic plan\n\nRead **bold scope** with `inline code` and [a link](https://example.com/docs).\n\n- Preserve approval checks.\n  - Review original source bytes.\n\n```ts\nconst retries = 2;\n```\n\n| Check | Result |\n| --- | --- |\n| Markdown | Formatted |\n| Approval | Separate |\n\n> Offline synthetic fixture only.\n';

export default function fixture(pi: ExtensionAPI) {
  let created = false;
  pi.registerCommand('fixture-exit', { description: 'Exit the offline plan viewer fixture', handler: async (_args, ctx) => ctx.shutdown() });
  pi.registerProvider('plan-markdown-fixture', {
    api: 'plan-markdown-fixture', baseUrl: 'http://127.0.0.1/never-requested', apiKey: 'offline-fixture-not-a-secret',
    models: [{ id: 'offline', name: 'Offline plan fixture', reasoning: false, input: ['text'], contextWindow: 200000, maxTokens: 2000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model) {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
        timestamp: Date.now(), stopReason: 'pending', content: [],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      queueMicrotask(() => {
        if (!created) {
          created = true;
          message.stopReason = 'toolUse';
          message.content = [{ type: 'toolCall', id: 'synthetic-plan-create', name: 'orchestrator_task',
            arguments: { action: 'create', id: 'synthetic-plan', title: 'Synthetic Markdown review', planText: plan, ships: false } }];
        } else {
          message.stopReason = 'stop';
          message.content = [{ type: 'text', text: 'Offline fixture finished. Open /orchestrator, then p. No task approval or implementation was performed.' }];
        }
        stream.push({ type: 'done', reason: message.stopReason as 'toolUse' | 'stop', message });
        stream.end();
      });
      return stream;
    },
  });
}

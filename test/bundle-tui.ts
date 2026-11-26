// Finite offline provider for an isolated real Pi TUI bundle check, not a reasoning worker.
// Each typed prompt (setup, build, authorize, install) queues fixed orchestrator tool calls;
// FIXTURE_* variables name the synthetic registry, repository, commits and evidence file.
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { openStore } from '../src/store.ts';

const env = (name: string) => { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; };
type Call = { name: string; arguments: Record<string, unknown> };
const shipping = { alpha: 'FIXTURE_A', beta: 'FIXTURE_B', gamma: 'FIXTURE_C', integration: 'FIXTURE_I' } as const;

function calls(prompt: string): Call[] {
  const task = (args: Record<string, unknown>) => ({ name: 'orchestrator_task', arguments: args });
  const release = (args: Record<string, unknown>) => ({ name: 'orchestrator_release', arguments: args });
  const install = { taskId: 'integration', commit: env('FIXTURE_I'), installationTarget: env('FIXTURE_TARGET') };
  if (prompt === 'setup') return [
    ...Object.keys(shipping).map((id) => task({ action: 'create', id, title: `Synthetic ${id}`, planText: `# Synthetic ${id}\n\nOffline fixture scope.\n` })),
    ...['review-one', 'review-two'].map((id) => task({ action: 'create', id, title: `Synthetic ${id}`, planText: `# ${id}\n`, ships: false })),
  ];
  if (prompt === 'build') return [
    ...Object.entries(shipping).flatMap(([id, variable]) => [task({ action: 'start', id }),
      task({ action: 'result', id, status: 'ready', commit: env(variable), reportText: `Synthetic ${id} report`, evidence: [env('FIXTURE_PROOF')] }),
      task({ action: 'verify', id, commit: env(variable), evidence: [env('FIXTURE_PROOF')] })]),
    ...['review-one', 'review-two'].flatMap((id) => [task({ action: 'start', id }), task({ action: 'result', id, status: 'ready', reportText: `Synthetic ${id} findings` })]),
  ];
  if (prompt === 'authorize') return [release({ action: 'request-authorization', source: 'offline bundle fixture',
    scope: [{ action: 'local-install', ...install, repoPath: env('FIXTURE_REPO'), includes: includes() }] })];
  if (prompt === 'install') return [
    release({ action: 'claim', operation: 'local-install', ...install, includes: includes() }),
    release({ action: 'record', stage: 'installed', taskId: 'integration', installedCommit: install.commit, installationTarget: install.installationTarget, evidence: [env('FIXTURE_PROOF')] }),
    release({ action: 'unlock', taskId: 'integration', reason: 'Offline fixture: synthetic receipt only, nothing installed' }),
  ];
  return [];
}
// The exact current results, read from the synthetic registry like a coordinator reading status.
function includes() {
  const store = openStore(env('FIXTURE_ROOT'), false);
  try {
    const tasks = store.read().tasks;
    return ['alpha', 'beta', 'gamma'].map((taskId) => ({ taskId, resultId: tasks[taskId].result!.id, commit: tasks[taskId].result!.commit! }));
  } finally { store.close(); }
}
const textOf = (message: any) => (typeof message?.content === 'string' ? message.content
  : (message?.content ?? []).filter((part: any) => part.type === 'text').map((part: any) => part.text).join(' '));

export default function fixture(pi: ExtensionAPI) {
  let queue: Call[] = [], step = 0;
  pi.registerCommand('fixture-exit', { description: 'Exit the offline bundle fixture', handler: async (_args, ctx) => ctx.shutdown() });
  pi.registerProvider('bundle-fixture', {
    api: 'bundle-fixture', baseUrl: 'http://127.0.0.1/never-requested', apiKey: 'offline-fixture-not-a-secret',
    models: [{ id: 'offline', name: 'Offline bundle fixture', reasoning: false, input: ['text'], contextWindow: 200000, maxTokens: 2000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
        timestamp: Date.now(), stopReason: 'pending', content: [],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      queueMicrotask(() => {
        const last: any = context.messages.at(-1);
        // Stop at the first failed tool call instead of continuing the script.
        const failed = last?.role === 'toolResult' && last.isError;
        if (last?.role === 'user') queue = calls(textOf(last).trim());
        const next = failed ? undefined : queue.shift();
        if (next) {
          message.stopReason = 'toolUse';
          message.content = [{ type: 'toolCall', id: `fixture-${++step}`, name: next.name, arguments: next.arguments }];
        } else {
          queue = [];
          message.stopReason = 'stop';
          message.content = [{ type: 'text', text: `Offline fixture ${failed ? 'STOPPED on error' : 'step done'}. Last tool result: ${textOf(last).slice(0, 400)}` }];
        }
        stream.push({ type: 'done', reason: message.stopReason as 'toolUse' | 'stop', message });
        stream.end();
      });
      return stream;
    },
  });
}

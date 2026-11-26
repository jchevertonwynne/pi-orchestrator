import { Type } from '@earendil-works/pi-ai';
import { getAgentDir, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { fileURLToPath } from 'node:url';
import { setup } from './bridge.ts';
import { registerReviewLoop } from './review-loop.ts';

export default function (pi: ExtensionAPI) {
  const agentDir = getAgentDir();
  setup(pi, Type, fileURLToPath(import.meta.url), { agentDir });
  registerReviewLoop(pi, agentDir);
  pi.on('resources_discover', () => ({ skillPaths: [fileURLToPath(new URL('../skills', import.meta.url))] }));
}

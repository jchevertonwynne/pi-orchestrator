import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export const TIERS = ['blocker', 'major', 'minor', 'nit'] as const;
export type Tier = typeof TIERS[number];
// Without a PR, the loop reviews the branch checked out in the session's cwd against `base`.
export interface ReviewLoopRequest { pr?: string; base?: string; threshold: Tier; rounds: number; reviewer: string; fixer: string }

export const DEFAULTS = { threshold: 'major' as Tier, rounds: 3 };
export const USAGE = 'Usage: /review-loop [PR number | #number | GitHub PR URL | --base ref] [--threshold blocker|major|minor|nit] [--rounds 1-10] [--reviewer provider/model] [--fixer provider/model]';

const PR = /^(?:#?\d+|https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+\/?)$/;
const MODEL = /^[\w.-]+\/[\w.~/:-]+$/;
const REF = /^(?!-)[\w./@^~-]+$/;

function defaultModel(agentDir: string, role: 'reviewer' | 'fixer'): string {
  const filename = role === 'reviewer' ? 'model-roles.json' : 'settings.json';
  const fields = role === 'reviewer' ? 'judgement' : 'defaultProvider and defaultModel';
  try {
    const config = JSON.parse(readFileSync(join(agentDir, filename), 'utf8'));
    const model = role === 'reviewer' ? config?.judgement
      : typeof config?.defaultProvider === 'string' && /^[\w.-]+$/.test(config.defaultProvider) &&
        typeof config?.defaultModel === 'string' ? `${config.defaultProvider}/${config.defaultModel}` : undefined;
    if (typeof model === 'string' && MODEL.test(model)) return model;
  } catch { /* The diagnostic below also covers unreadable and malformed files. */ }
  throw new Error(`No valid ${role} model default. Set ${fields} in ${filename} in the Pi agent directory, or pass --${role} provider/model.`);
}

export function parseReviewLoopArgs(args: string, agentDir: string): ReviewLoopRequest {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const request: Partial<ReviewLoopRequest> = {};
  while (tokens.length) {
    const token = tokens.shift()!;
    const [flag, inline] = token.startsWith('--') ? token.split(/=(.*)/s) : [token];
    const value = () => {
      const v = inline ?? tokens.shift();
      if (!v) throw new Error(`${flag} needs a value. ${USAGE}`);
      return v;
    };
    if (flag === '--threshold') {
      const tier = value().toLowerCase();
      if (!(TIERS as readonly string[]).includes(tier)) throw new Error(`Unknown threshold "${tier}". ${USAGE}`);
      request.threshold = tier as Tier;
    } else if (flag === '--rounds') {
      const rounds = Number(value());
      if (!Number.isInteger(rounds) || rounds < 1 || rounds > 10) throw new Error(`--rounds must be an integer from 1 to 10. ${USAGE}`);
      request.rounds = rounds;
    } else if (flag === '--base') {
      const base = value();
      if (!REF.test(base)) throw new Error(`--base must be a Git ref. ${USAGE}`);
      request.base = base;
    } else if (flag === '--reviewer' || flag === '--fixer') {
      const model = value();
      if (!MODEL.test(model)) throw new Error(`${flag} must be provider/model-id. ${USAGE}`);
      request[flag === '--reviewer' ? 'reviewer' : 'fixer'] = model;
    } else if (!flag.startsWith('--') && !request.pr && PR.test(flag)) {
      request.pr = flag.replace(/^#/, '').replace(/\/$/, '');
    } else {
      throw new Error(`Unexpected argument "${token}". ${USAGE}`);
    }
  }
  // A PR brings its own base branch.
  if (request.pr && request.base) throw new Error(`--base applies only to a local branch. ${USAGE}`);
  return {
    ...DEFAULTS, ...request,
    reviewer: request.reviewer ?? defaultModel(agentDir, 'reviewer'),
    fixer: request.fixer ?? defaultModel(agentDir, 'fixer'),
  };
}

export function reviewLoopPrompt(request: ReviewLoopRequest, cwd: string): string {
  const target = request.pr ? `PR ${request.pr}`
    : `local branch checked out in ${cwd}; base ${request.base ?? "origin's default branch"}`;
  return `/skill:review-loop ${target}; threshold ${request.threshold}; at most ${request.rounds} fix rounds; `
    + `reviewer model ${request.reviewer}; fixer model ${request.fixer}.`;
}

export function registerReviewLoop(pi: ExtensionAPI, agentDir: string) {
  pi.registerCommand('review-loop', {
    description: 'Review a PR (or the current local branch) with a subagent, fix findings at or above a tier, and re-review until clear. '
      + '[PR | --base ref] [--threshold blocker|major|minor|nit] [--rounds N] [--reviewer model] [--fixer model]',
    getArgumentCompletions: (prefix: string) => {
      const items = ['--base', '--threshold', '--rounds', '--reviewer', '--fixer', ...TIERS]
        .filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      try {
        // Queued messages reach the model as plain text, so the skill only expands when idle.
        if (!ctx.isIdle()) throw new Error('Wait until the current turn ends, then run /review-loop again.');
        const request = parseReviewLoopArgs(args, agentDir);
        pi.sendUserMessage(reviewLoopPrompt(request, ctx.cwd), { expandPromptTemplates: true });
      } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error'); }
    },
  });
}

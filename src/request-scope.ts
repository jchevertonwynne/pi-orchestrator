import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import type { ProcessRunner, Registry, RequestScope } from './contracts.ts';
import { hashPlan } from './workflow.ts';

// Local read-only queries. Never consult a remote or return a URL containing credentials.
export async function requestRepository(run: ProcessRunner, repo: string, remote?: string, ref?: string): Promise<Pick<RequestScope, 'repoPath' | 'push'>> {
  if (realpathSync(repo) !== repo) throw new Error('Use the canonical checkout path.');
  const git = async (...args: string[]) => (await run('git', ['-C', repo, ...args], { timeout: 10000 })).stdout.trimEnd();
  if (await git('rev-parse', '--show-toplevel') !== repo) throw new Error('Expected repository root');
  if (remote === undefined && ref === undefined) return { repoPath: repo };
  if (!remote || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(remote) || !ref || !/^refs\/heads\/[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(ref)) throw new Error('Specify one named remote and exact refs/heads/branch.');
  await git('check-ref-format', ref);
  const url = await git('remote', 'get-url', '--push', '--all', remote);
  if (!/^(?:https:\/\/[a-zA-Z0-9.-]+\/|git@[a-zA-Z0-9.-]+:)[a-zA-Z0-9._/-]+$/.test(url)) throw new Error('Require one unambiguous credential-free HTTPS or Git SSH destination.');
  return { repoPath: repo, push: { remote, url, ref } };
}

export function requestSnapshot(state: Registry, root: string, taskId: string, repository: Pick<RequestScope, 'repoPath' | 'push'>) {
  const t = Object.hasOwn(state.tasks, taskId) && state.tasks[taskId];
  if (!t || state.approvalPolicy !== 'request-scoped' || !t.requestEligible || t.parentTask || t.state !== 'planned' || t.approval || t.requestGrant) throw new Error('Only a new planned root request is eligible. Earlier requests and subtasks retain their approval gates.');
  if (t.ships === false && repository.push) throw new Error('Cannot authorize push for a non-shipping task');
  if (hashPlan(t.planPath) !== t.planHash) throw new Error('Plan changed');
  const plan = readFileSync(t.planPath, 'utf8');
  if (Buffer.byteLength(plan) > 16000 || createHash('sha256').update(plan).digest('hex') !== t.planHash) throw new Error('Plan changed, is too long, or is not UTF-8');
  const scope: RequestScope = { root, taskId, title: t.title, planPath: t.planPath, planHash: t.planHash, ...repository };
  const displayedScope = `Confirm this NEW request, not a continuation of earlier work.\n${JSON.stringify(scope, null, 2)}\nPlan:\n${plan}\nActions: implement and verify${scope.push ? '; then one non-force push of the verified commit to the exact destination above' : ' only; no push'}. No PR, merge, deployment or installation.`;
  return { scope, displayedScope };
}

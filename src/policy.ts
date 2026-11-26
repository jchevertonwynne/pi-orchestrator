import type { Profile, Registry, Release, Task } from './contracts.ts';

// Shared profile rules for workflow, runtime and registry validation.
// The light profile removes coordination gates, not evidence:
// owners still publish exact commits and existing report/evidence files.

export function profileOf(state: Registry): Profile {
  return state.profile ?? 'strict';
}

// A risky task makes its whole subtree risky.
export function risky(state: Registry, task: Task): boolean {
  const seen = new Set<string>();
  let current: Task | undefined = task;
  while (current && typeof current === 'object' && !seen.has(current.id)) {
    if (current.risky === true) return true;
    seen.add(current.id);
    current = current.parentTask && Object.hasOwn(state.tasks, current.parentTask) ? state.tasks[current.parentTask] : undefined;
  }
  return false;
}

// Gated tasks keep per-task human plan approval and independent verification.
export function gated(state: Registry, task: Task): boolean {
  return profileOf(state) === 'strict' || risky(state, task);
}

// The bundle receipt of the attested local installation that delivered this exact shipping result, if any.
// It requires the explicit included snapshot, never a dependency, parent or ancestry relationship.
export function deliveredBy(state: Registry, task: Task): Release | undefined {
  if (task.state === 'skipped' || task.ships === false || task.result?.status !== 'ready') return undefined;
  return Object.values(state.releases).find((release) => release.route === 'local-install' && release.installedCommit !== undefined
    && release.included?.some((entry) => entry.taskId === task.id && entry.resultId === task.result!.id && entry.commit === task.result!.commit));
}
// The local-install release whose bundle names this task, delivered or still claimed.
export function bundledIn(state: Registry, taskId: string): Release | undefined {
  return Object.values(state.releases).find((release) => release.route === 'local-install' && release.included?.some((entry) => entry.taskId === taskId));
}

// Light dependencies unblock consumers once their owner publishes a ready commit,
// so consumers can stack on it; strict dependencies must be verified first.
export function dependencyAccepted(state: Registry, dep: Task): boolean {
  if (profileOf(state) === 'strict' || risky(state, dep)) {
    return ['verified', 'merged', 'deployed'].includes(dep.state) && Boolean(dep.verification);
  }
  return ['ready', 'verified', 'merged', 'deployed'].includes(dep.state) && dep.result?.status === 'ready';
}

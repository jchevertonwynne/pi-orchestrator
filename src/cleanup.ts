import { existsSync } from 'node:fs';
import type { ProcessRunner, Registry, Task } from './contracts.ts';
import { done, shipped } from './board.ts';

// What a finished run leaves behind, from the registry plus live git/docker/zellij reads.
// Listing is read-only. Automatic cleanup uses stricter integration checks;
// manual cleanup requires selection and confirmation. Both re-check before removal.

export type CleanupItem = {
  id: string;
  kind: 'session' | 'worktree' | 'compose' | 'volumes' | 'reservations' | 'records';
  label: string;
  detail: string;
  removable: boolean;
  // Pre-selected in the checklist: every removable item, including volumes.
  suggested: boolean;
  target: { session?: string; repo?: string; worktree?: string; project?: string; resourceIds?: string[]; agentIds?: string[] };
};

// Removal order: data-bearing items first, then bookkeeping, and the worker session last,
// because closing it needs every agent record closed.
export const cleanupOrder: CleanupItem['kind'][] = ['worktree', 'compose', 'volumes', 'reservations', 'records', 'session'];

export type InventoryOptions = {
  // An earlier run whose coordinator has gone: its own coordinator record may be closed too.
  abandoned?: boolean;
  // Finished current run only: task state alone never proves worktree integration.
  automatic?: boolean;
  isAlive?: (pid: number) => boolean;
};

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error: any) { return error.code === 'EPERM'; }
}

// A coordinator heartbeats every 5 seconds while attached, so an hour of silence means its session moved on.
// A live PID proves nothing here: the same Pi process may since have switched to another transcript.
export const ABANDONED_MS = 60 * 60_000;

export function abandoned(state: Registry, now = Date.now()): boolean {
  const coordinators = Object.values(state.agents).filter((agent) => agent.role === 'coordinator');
  return coordinators.length > 0
    && coordinators.every((agent) => agent.lifecycle === 'closed' || !agent.heartbeatAt || now - agent.heartbeatAt > ABANDONED_MS);
}

export function runEnded(state: Registry): boolean {
  const tasks = Object.values(state.tasks);
  return tasks.length > 0 && tasks.every((task) => ended(state, task));
}

// Reservations of ended tasks protect nothing; releasing them is bookkeeping with no external effect.
export function releaseEnded(state: Registry, now = Date.now()): number {
  let released = 0;
  for (const resource of state.resources) {
    if (resource.releasedAt === undefined && ended(state, state.tasks[resource.taskId])) { resource.releasedAt = now; released++; }
  }
  return released;
}

export const ended = (state: Registry, task: Task | undefined) => !task || task.state === 'skipped' || shipped(state, task) || done(state, task);
const liveAgent = ['registered', 'starting', 'running'];

async function quiet(runner: ProcessRunner, command: string, args: string[], cwd?: string): Promise<string | undefined> {
  try { return (await runner(command, args, cwd ? { cwd } : {})).stdout; } catch { return undefined; }
}

async function defaultBranch(runner: ProcessRunner, repo: string): Promise<string | undefined> {
  const remote = (await quiet(runner, 'git', ['-C', repo, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD']))?.trim();
  if (remote) return remote;
  for (const name of ['main', 'master']) if (await quiet(runner, 'git', ['-C', repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${name}`]) !== undefined) return name;
  return undefined;
}

export async function cleanupInventory(state: Registry, runner: ProcessRunner, options: InventoryOptions = {}): Promise<CleanupItem[]> {
  const isAlive = options.isAlive ?? processAlive;
  const items: CleanupItem[] = [];
  const workers = Object.values(state.agents).filter((agent) => agent.role !== 'coordinator');
  // Records left open by agents whose process is gone and whose task has ended:
  // nothing can resume them usefully, and they keep the worker session from closing.
  const stale = workers.filter((agent) => agent.lifecycle !== 'closed' && !(agent.pid && isAlive(agent.pid))
    && (!agent.taskId || ended(state, state.tasks[agent.taskId])));
  const coordinator = options.abandoned && runEnded(state)
    ? Object.values(state.agents).filter((agent) => agent.role === 'coordinator' && agent.lifecycle !== 'closed') : [];
  const closing = new Set(stale.map((agent) => agent.id));
  const shared = state.sharedSession;
  if (shared && !shared.closedAt) {
    const open = workers.filter((agent) => agent.zellijSession === shared.name && agent.lifecycle !== 'closed' && !closing.has(agent.id));
    const listed = await quiet(runner, 'zellij', ['list-sessions', '--no-formatting']);
    const live = listed?.split('\n').some((line) => line.trim().split(/\s+/)[0] === shared.name && !/\bEXITED\b/.test(line));
    const where = listed === undefined ? '' : live ? '' : '; session already gone, bookkeeping only';
    items.push({ id: `session:${shared.name}`, kind: 'session', label: `worker session ${shared.name}`,
      detail: (open.length ? `agents not closed: ${open.map((a) => a.id).join(', ')}; retire them first (orchestrator_agent retire)` : 'every agent closed') + where,
      removable: !open.length, suggested: !open.length, target: { session: shared.name } });
  }
  const bases = new Map<string, string | undefined>();
  const seen = new Set<string>();
  for (const agent of workers) {
    if (!agent.repo || seen.has(agent.worktree) || !existsSync(agent.worktree)) continue;
    seen.add(agent.worktree);
    if (!bases.has(agent.repo)) bases.set(agent.repo, await defaultBranch(runner, agent.repo));
    const base = bases.get(agent.repo);
    const status = await quiet(runner, 'git', ['-C', agent.worktree, 'status', '--porcelain']);
    const dirty = status === undefined ? undefined : status.split('\n').filter(Boolean).length;
    // Worktrees share refs with their repository, so the worktree's HEAD is tested against the default branch.
    const merged = !!base && await quiet(runner, 'git', ['-C', agent.worktree, 'merge-base', '--is-ancestor', 'HEAD', base]) !== undefined;
    // Identical trees also cover squash merges without trusting a release attestation.
    // If main has moved on and ancestry cannot prove integration, keep it for manual review.
    const trees = options.automatic && !merged && base
      ? (await quiet(runner, 'git', ['-C', agent.worktree, 'rev-parse', 'HEAD^{tree}', `${base}^{tree}`]))?.trim().split('\n') : undefined;
    const identical = trees?.length === 2 && /^[0-9a-f]{40,64}$/.test(trees[0]) && trees[0] === trees[1];
    const task = agent.taskId ? state.tasks[agent.taskId] : undefined;
    const reasons: string[] = [];
    // A record left open by a process that is gone does not protect the worktree; its clean, merged state does.
    if (options.automatic && agent.pid && isAlive(agent.pid)) reasons.push(`agent ${agent.id} process is still alive`);
    else if (liveAgent.includes(agent.lifecycle) && !(closing.has(agent.id) || (agent.pid && !isAlive(agent.pid)))) reasons.push(`agent ${agent.id} is ${agent.lifecycle}`);
    if (dirty === undefined) reasons.push('git status failed');
    else if (dirty) reasons.push(`${dirty} uncommitted change${dirty === 1 ? '' : 's'}`);
    if (options.automatic) {
      if (!task || !ended(state, task)) reasons.push(task ? `task ${task.id} is ${task.state}` : 'no task');
      if (!merged && !identical) reasons.push(base ? `integration into ${base} is unproven; use /orchestrator cleanup to review` : 'default branch is unknown');
    } else if (!merged && !ended(state, task)) {
      // Explicit manual confirmation can discard ended, unmerged work; automatic cleanup cannot.
      reasons.push(`not merged into ${base ?? 'an unknown default branch'} and ${task ? `task ${task.id} is ${task.state}` : 'no task'}`);
    }
    items.push({ id: `worktree:${agent.worktree}`, kind: 'worktree', label: `worktree ${agent.worktree}`,
      detail: reasons.length ? reasons.join('; ') : `${agent.branch ?? 'branch'} ${merged ? `merged into ${base}` : identical ? `tree matches ${base}` : `task ${task?.state ?? 'ended'}`}; clean; branch kept`,
      removable: !reasons.length, suggested: !reasons.length, target: { repo: agent.repo, worktree: agent.worktree } });
  }
  const projects = new Map<string, string[]>();
  for (const resource of state.resources) if (resource.kind === 'compose') {
    projects.set(resource.value, [...(projects.get(resource.value) ?? []), resource.taskId]);
  }
  for (const [project, taskIds] of projects) {
    const containers = await quiet(runner, 'docker', ['ps', '-a', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.State}}']);
    const volumes = await quiet(runner, 'docker', ['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`]);
    if (containers === undefined || volumes === undefined) {
      items.push({ id: `compose:${project}`, kind: 'compose', label: `compose ${project}`, detail: 'docker unavailable', removable: false, suggested: false, target: { project } });
      continue;
    }
    const states = containers.split('\n').filter(Boolean);
    const running = states.filter((s) => s === 'running').length;
    const open = [...new Set(taskIds)].filter((id) => !ended(state, state.tasks[id]));
    const keep = open.length ? `task ${open.join(', ')} still open` : '';
    if (states.length) {
      items.push({ id: `compose:${project}`, kind: 'compose', label: `compose ${project}`,
        detail: `${states.length} container${states.length === 1 ? '' : 's'} (${running} running)${keep ? `; ${keep}` : ''}; down keeps volumes`,
        removable: !keep, suggested: !keep, target: { project } });
    }
    const count = volumes.split('\n').filter(Boolean).length;
    if (count) {
      items.push({ id: `volumes:${project}`, kind: 'volumes', label: `volumes of ${project}`,
        detail: `${count} volume${count === 1 ? '' : 's'}: data is deleted${keep ? `; ${keep}` : ''}`,
        removable: !keep, suggested: !keep, target: { project } });
    }
  }
  const reserved = state.resources.filter((r) => r.releasedAt === undefined && ended(state, state.tasks[r.taskId]));
  if (reserved.length) {
    const kinds = [...new Set(reserved.map((r) => r.kind))].join(', ');
    items.push({ id: 'reservations', kind: 'reservations', label: `${reserved.length} reservation${reserved.length === 1 ? '' : 's'} of ended tasks`,
      detail: `${kinds}; bookkeeping only`, removable: true, suggested: true, target: { resourceIds: reserved.map((r) => r.id) } });
  }
  const records = [...stale, ...coordinator];
  if (records.length) {
    items.push({ id: 'records', kind: 'records', label: `${records.length} agent record${records.length === 1 ? '' : 's'} left open`,
      detail: `${records.map((a) => `${a.id} (${a.lifecycle})`).join(', ')}: process gone and work ended; marked closed, bookkeeping only`
        + (coordinator.length ? '; the run\'s coordinator cannot be resumed afterwards' : ''),
      removable: true, suggested: true, target: { agentIds: records.map((a) => a.id) } });
  }
  return items;
}

export function cleanupText(items: CleanupItem[]): string {
  if (!items.length) return 'Nothing from this run is left to clean up.';
  return items.map((item) => `${item.removable ? '○' : '■'} ${item.label}: ${item.detail}${item.removable ? '' : ' (keep)'}`).join('\n')
    + '\nOnly reserved Compose projects are listed; use the stacks tool for anything else.';
}

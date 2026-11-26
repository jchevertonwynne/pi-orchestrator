import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Agent, Message, Registry, Release, ReleaseAction, ReleaseGrant, ReleaseOperation, ReleaseProposal, ReleaseScope, Resource, ResourceAction, Store, Task, TaskAction, TaskState } from './contracts.ts';
import { dependencyAccepted, gated, profileOf } from './policy.ts';
import { acquireDeploy, adoptDeploy, readDeploy, releaseDeploy } from './family.ts';

function require(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
function text(value: unknown, label: string, max = 4096): asserts value is string {
  require(typeof value === 'string' && value.trim().length > 0 && !value.includes('\0') && Buffer.byteLength(value) <= max, `Invalid ${label}`);
}
function id(value: unknown): asserts value is string {
  require(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)
    && !['__proto__', 'prototype', 'constructor'].includes(value), 'Invalid ID');
}
function sha(value: unknown): asserts value is string {
  require(typeof value === 'string' && /^[a-fA-F0-9]{40}$/.test(value), 'Expected full Git SHA (40 hex characters)');
}
function inputObject(input: unknown): void {
  require(input !== null && typeof input === 'object' && !Array.isArray(input), 'Invalid action input');
}
function actor(state: Registry, actorId: string): Agent {
  id(actorId);
  require(Object.hasOwn(state.agents, actorId), 'Unknown agent');
  const agent = state.agents[actorId];
  require(!['exited', 'collected', 'closed'].includes(agent.lifecycle), 'Agent is not active');
  return agent;
}
function taskById(state: Registry, taskId: string): Task {
  id(taskId); require(Object.hasOwn(state.tasks, taskId), 'Unknown task'); return state.tasks[taskId];
}
function coordinator(agent: Agent): void { require(agent.role === 'coordinator', 'Coordinator required'); }
function ancestor(state: Registry, parent: string, child: string): boolean {
  const seen = new Set<string>();
  let current = state.agents[child]?.parentId;
  while (current && !seen.has(current)) {
    if (current === parent) return true;
    seen.add(current); current = state.agents[current]?.parentId;
  }
  return false;
}
function manages(state: Registry, agent: Agent, taskId: string): boolean {
  return agent.role === 'coordinator' || agent.taskId === taskId
    || Object.values(state.agents).some((a) => a.taskId === taskId && ancestor(state, agent.id, a.id));
}
function history(task: Task, state: TaskState, note: string): void {
  task.state = state; task.history.push({ state, at: Date.now(), note });
}
function mutable(state: Registry, task: Task): void {
  require(!['merged', 'deployed', 'skipped'].includes(task.state), 'Terminal task requires a new task');
  // Light PR owners keep fixing their open PR until merge.
  // Local-install candidates freeze at claim in either profile.
  const release = state.releases[task.id];
  require(!release || (profileOf(state) === 'light' && release.route !== 'local-install' && !release.mergedCommit), 'Task is frozen by its release record');
}

// Plans are content-addressed, not trusted executable instructions.
// Bound reads using an opened regular file, including if the file grows concurrently.
function file(path: unknown, read = false): { path: string; hash: string } {
  text(path, 'file path');
  let canonical: string;
  try { canonical = realpathSync(resolve(path)); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`File not found: ${path}. Create the file before this call, not in a parallel call.`);
    throw error;
  }
  const fd = openSync(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    require(stat.isFile(), 'Expected a regular file');
    if (!read) return { path: canonical, hash: '' };
    require(stat.size <= 1024 * 1024, 'Plan exceeds 1 MiB');
    const data = Buffer.alloc(1024 * 1024 + 1);
    let length = 0;
    while (length < data.length) {
      const count = readSync(fd, data, length, data.length - length, null);
      if (!count) break;
      length += count;
    }
    require(length <= 1024 * 1024, 'Plan exceeds 1 MiB');
    return { path: canonical, hash: createHash('sha256').update(data.subarray(0, length)).digest('hex') };
  } finally { closeSync(fd); }
}
export function hashPlan(path: string): string {
  return file(path, true).hash;
}
function evidence(paths: unknown, nonempty = false): string[] {
  require(Array.isArray(paths) && paths.length <= 256 && (!nonempty || paths.length > 0), nonempty
    ? 'This action requires evidence. Pass 1 to 256 existing file paths in evidence.'
    : 'evidence must be an array of at most 256 existing file paths.');
  return [...new Set(paths.map((path) => file(path).path))].sort();
}
// Returns the current plan hash.
// Gated (strict or risky) scope requires human approval of those exact bytes;
// light non-risky scope only requires the plan file to remain readable.
function approved(state: Registry, task: Task): string {
  const hash = file(task.planPath, true).hash;
  if (gated(state, task)) require(task.approval && task.approval.hash === hash && task.planHash === hash, 'Current plan is not approved');
  // Nested scope remains tied to current ancestor approvals, not merely a historic state.
  let parent = task.parentTask;
  const seen = new Set<string>([task.id]);
  while (parent) {
    require(!seen.has(parent), 'Task scope cycle'); seen.add(parent);
    const scope = taskById(state, parent);
    require(scope.state !== 'skipped' && (!gated(state, scope)
      || (scope.approval && file(scope.planPath, true).hash === scope.approval.hash)), 'Parent scope is not currently approved');
    parent = scope.parentTask;
  }
  return hash;
}
function dependenciesReady(state: Registry, task: Task): void {
  // Strict: ready results are not dependency checkpoints.
  // Light: a ready commit lets consumers stack on it; owners merge in dependency order.
  for (const depId of task.dependencies) {
    const dep = taskById(state, depId);
    require(dependencyAccepted(state, dep), gated(state, dep) ? 'Dependency must be verified' : 'Dependency must publish a ready result');
    if (gated(state, dep)) require(dep.verification!.planHash === approved(state, dep), 'Dependency verification is stale');
  }
}
function verified(state: Registry, task: Task): void {
  const hash = approved(state, task);
  require(task.result?.status === 'ready' && task.verification
    && task.verification.commit === task.result.commit
    && (!gated(state, task) || task.verification.planHash === hash), 'Exact ready result must be verified');
  file(task.result.report); evidence(task.result.evidence); evidence(task.verification.evidence, true);
  dependenciesReady(state, task);
}
// Planners and reviewers stay read-only on the repository, but report on their own non-shipping task.
// Reviewers attached to a shipping task report to their parent instead of replacing its owner's result.
function readOnlyOwner(agent: Agent, task: Task): boolean {
  return ['planner', 'reviewer'].includes(agent.role) && agent.taskId === task.id && task.ships === false;
}
// reportText lands under the run, never in a worktree; the path is fixed by the validated task ID.
function writeReport(root: string, taskId: string, text: unknown, report: unknown): string {
  require(report === undefined, 'Pass either report (an existing file) or reportText, not both');
  require(typeof text === 'string' && text.trim() !== '' && Buffer.byteLength(text) <= 256 * 1024, 'reportText must be non-empty and at most 256 KiB');
  id(taskId);
  const directory = join(root, 'reports', taskId);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'report.md');
  writeFileSync(path, text.endsWith('\n') ? text : text + '\n', { mode: 0o600 });
  return path;
}
// planText lands under the run as plans/<task>.md, so create needs no separate write that a parallel tool batch could race.
// It never overwrites an existing plan, which another task may have registered by hash.
function writePlan(root: string, taskId: string, text: unknown, planPath: unknown): string {
  require(planPath === undefined, 'Pass either planPath (an existing file) or planText, not both');
  require(typeof text === 'string' && text.trim() !== '' && Buffer.byteLength(text) <= 1024 * 1024, 'planText must be non-empty and at most 1 MiB');
  id(taskId);
  const directory = join(root, 'plans');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${taskId}.md`);
  require(!existsSync(path), `${path} already exists; pass it as planPath instead of planText`);
  writeFileSync(path, text.endsWith('\n') ? text : text + '\n', { mode: 0o600, flag: 'wx' });
  return path;
}
// The prefix ask_user puts on the needsHuman note, so a reply to that question can clear it.
export const QUESTION_PREFIX = 'Question for the human: ';
export function taskAction(store: Store, actorId: string, input: TaskAction): Task {
  inputObject(input);
  return store.transact((state) => {
    const agent = actor(state, actorId);
    require(['create', 'approve', 'start', 'skip', 'result', 'verify', 'note'].includes(input.action), 'Unknown task action');
    id(input.id);
    if (input.action === 'create') {
      require(!Object.hasOwn(state.tasks, input.id), 'Task already exists');
      text(input.title, 'title', 1024);
      require(agent.role === 'coordinator' || ['planner', 'implementer'].includes(agent.role), 'Task creation role required');
      if (agent.role !== 'coordinator') require(input.parentTask, 'Nested task must name its approved parent scope');
      if (input.parentTask !== undefined) {
        const parent = taskById(state, input.parentTask);
        require(manages(state, agent, parent.id), 'Cannot create outside own task scope');
        approved(state, parent);
        require(parent.state !== 'skipped', 'Parent scope is skipped');
      }
      const deps = input.dependencies ?? [];
      require(Array.isArray(deps) && deps.length <= 1000, 'Invalid dependencies');
      require(input.risky === undefined || typeof input.risky === 'boolean', 'Invalid risky flag');
      require(input.ships === undefined || typeof input.ships === 'boolean', 'Invalid ships flag');
      for (const dep of deps) { id(dep); require(dep !== input.id, 'Dependency cycle'); taskById(state, dep); }
      require(input.planPath !== undefined || input.planText !== undefined, 'create requires planPath (an existing plan file) or planText');
      const plan = file(input.planText === undefined ? input.planPath : writePlan(store.root, input.id, input.planText, input.planPath), true);
      const task: Task = {
        id: input.id, title: input.title, state: 'planned', planPath: plan.path, planHash: plan.hash,
        dependencies: [...new Set(deps)], history: [],
        ...(input.parentTask ? { parentTask: input.parentTask } : {}),
        ...(input.risky ? { risky: true } : {}),
        ...(input.ships === false ? { ships: false as const } : {}),
      };
      history(task, 'planned', `Created by ${agent.id}`);
      state.tasks[task.id] = task;
      return task;
    }
    const task = taskById(state, input.id);
    if (input.action === 'note') {
      // A one-line owner status for the human board; never a state transition or approval.
      require(manages(state, agent, task.id), 'Only the task owner, its ancestors or the coordinator may annotate');
      text(input.summary, 'summary', 1024);
      require(input.needsHuman === undefined || typeof input.needsHuman === 'boolean', 'Invalid needsHuman flag');
      task.summary = { text: input.summary.trim().replace(/\s+/g, ' '), needsHuman: input.needsHuman === true, by: agent.id, at: Date.now() };
      return task;
    }
    mutable(state, task);
    switch (input.action) {
      case 'approve': {
        coordinator(agent); text(input.source, 'approval source');
        const current = file(task.planPath, true).hash;
        const expectedHash = (input as typeof input & { expectedHash?: string }).expectedHash;
        if (expectedHash !== undefined) require(expectedHash === current, 'Plan changed since human confirmation');
        if (task.parentTask) approved(state, taskById(state, task.parentTask));
        task.planHash = current;
        task.approval = { hash: current, source: input.source, at: Date.now() };
        delete task.result; delete task.verification;
        history(task, 'approved', `Approved by ${agent.id}: ${input.source}`);
        break;
      }
      case 'start': {
        require(agent.role === 'coordinator' || (agent.role === 'implementer' && agent.taskId === task.id) || readOnlyOwner(agent, task),
          'Implementer for this task required (planners and reviewers may start only their own ships: false task)');
        // Owners often start the task their coordinator already started; that is a no-op.
        if (task.state === 'implementing') return task;
        require(['approved', 'blocked', 'ready', 'verified'].includes(task.state) || (task.state === 'planned' && !gated(state, task)), 'Task is not approved, blocked, ready or verified');
        approved(state, task); dependenciesReady(state, task);
        const rework = ['ready', 'verified'].includes(task.state);
        // Retain the submitted candidate for reference, but require resubmission and fresh verification.
        delete task.verification;
        history(task, 'implementing', `${rework ? 'Rework started' : 'Started'} by ${agent.id}`);
        break;
      }
      case 'skip':
        coordinator(agent); text(input.reason, 'skip reason');
        delete task.verification;
        history(task, 'skipped', `Skipped by ${agent.id}: ${input.reason}`);
        break;
      case 'result': {
        require(agent.role === 'coordinator' || agent.role === 'release' || (agent.role === 'implementer' && agent.taskId === task.id) || readOnlyOwner(agent, task),
          'Cannot publish another task result (planners and reviewers may publish only on their own ships: false task)');
        require(['implementing', 'blocked', 'ready', 'verified'].includes(task.state), 'Task has not started implementation');
        require(['ready', 'blocked', 'failed'].includes(input.status), 'Invalid result status');
        if (input.status === 'ready') {
          if (task.ships !== false) {
            require(input.commit !== undefined, 'A ready shipping result requires commit. Supply the candidate commit SHA.');
            sha(input.commit);
          }
          approved(state, task); dependenciesReady(state, task);
        }
        if (input.commit !== undefined) sha(input.commit);
        const commit = input.commit?.toLowerCase();
        const report = file(input.reportText === undefined ? input.report : writeReport(store.root, task.id, input.reportText, input.report)).path;
        const paths = evidence(input.evidence ?? []);
        const prior = task.result;
        if (prior && prior.status === input.status && prior.commit === commit && prior.report === report
          && JSON.stringify(prior.evidence) === JSON.stringify(paths)) {
          if (task.state === 'implementing') history(task, input.status === 'ready' ? 'ready' : 'blocked', `Repeated result ${prior.id} published by ${agent.id}`);
          return task;
        }
        task.result = { id: randomUUID(), status: input.status, report, evidence: paths, createdAt: Date.now(), ...(commit ? { commit } : {}) };
        delete task.verification;
        // A ready task no longer waits on the human; blocked and failed results keep the flag.
        if (input.status === 'ready' && task.summary?.needsHuman) task.summary = { ...task.summary, needsHuman: false, by: agent.id, at: Date.now() };
        history(task, input.status === 'ready' ? 'ready' : 'blocked', `Result ${task.result.id} published by ${agent.id}`);
        break;
      }
      case 'verify': {
        const independent = gated(state, task);
        if (independent) coordinator(agent);
        else require(agent.role === 'coordinator' || (agent.role === 'implementer' && manages(state, agent, task.id)), 'Task owner or coordinator required');
        // Non-shipping work published without a commit is verified without one.
        const commitless = task.ships === false && task.result?.commit === undefined;
        if (commitless) require(input.commit === undefined, 'This result has no commit. Omit commit when you verify this result.');
        else {
          require(input.commit !== undefined, 'verify requires commit. Repeat the commit from the ready result.');
          sha(input.commit);
        }
        require(task.state === 'ready' && task.result?.status === 'ready', 'Ready result required; a result is not verification');
        // Collecting an exited worker's result is not implementing it.
        // Role and task assignment fence self-verification; publication history does not.
        // Light non-risky owners attest their own evidence instead of queueing for review.
        if (independent) require(agent.taskId !== task.id, 'Self-verification is forbidden');
        const hash = approved(state, task); dependenciesReady(state, task);
        const commit = input.commit?.toLowerCase();
        require(task.result.commit === commit, 'Verification commit differs from result');
        file(task.result.report); evidence(task.result.evidence);
        task.verification = { ...(commit ? { commit } : {}), planHash: hash, evidence: evidence(input.evidence, true), at: Date.now() };
        // An open light PR follows the owner's latest verified commit.
        const release = state.releases[task.id];
        if (release && !release.mergedCommit && commit) { release.commit = commit; release.updatedAt = Date.now(); }
        history(task, 'verified', `Verified by ${agent.id}`);
        break;
      }
    }
    return task;
  });
}

// Ports and Compose project names share the host's namespace,
// so their scope is only a label and never separates reservations.
function hostWide(kind: Resource['kind']): boolean {
  return kind === 'port' || kind === 'compose';
}
function canonicalScope(kind: Resource['kind'], scope: unknown, worktree: string): string {
  if (hostWide(kind) && scope === undefined) return 'localhost';
  require(scope !== undefined, kind === 'migration'
    ? 'Migration scope required: the migrations directory, absolute or relative to your worktree'
    : 'File scope required: the repository directory');
  text(scope, 'resource scope');
  if (hostWide(kind)) return scope.trim();
  require(scope === scope.trim(), 'Scope must be canonical');
  if (kind === 'migration') return migrationScope(resolve(worktree, scope));
  const canonical = realpathSync(resolve(scope));
  require(lstatSync(canonical).isDirectory(), 'File scope must be a repository directory');
  return canonical;
}
// One migration sequence per repository directory,
// so every worktree of a repository maps that directory to the same scope.
function migrationScope(path: string): string {
  let dir: string;
  try { dir = realpathSync(path); } catch { throw new Error(`Migration directory not found: ${path}`); }
  require(statSync(dir).isDirectory(), 'Migration scope must be a directory');
  let root = dir;
  while (!existsSync(join(root, '.git'))) {
    require(dirname(root) !== root, 'Migration directory must be inside a Git repository');
    root = dirname(root);
  }
  return `${gitCommonDir(root)}:${relative(root, dir) || '.'}`;
}
// Linked worktrees and submodules name their Git directory in a .git file.
function gitCommonDir(root: string): string {
  const marker = join(root, '.git');
  if (statSync(marker).isDirectory()) return realpathSync(marker);
  const gitdir = /^gitdir: (.+)$/m.exec(readFileSync(marker, 'utf8'))?.[1];
  require(gitdir, 'Unrecognised .git file');
  const dir = resolve(root, gitdir.trim());
  const common = join(dir, 'commondir');
  return realpathSync(existsSync(common) ? resolve(dir, readFileSync(common, 'utf8').trim()) : dir);
}
function portSpan(value: string): [number, number] {
  const [low, high = low] = value.split('-').map(Number);
  return [low, high];
}
function resourceValue(kind: Resource['kind'], scope: string, value: unknown): string {
  text(value, 'resource value');
  if (kind === 'port') {
    const match = /^([1-9][0-9]*)(?:-([1-9][0-9]*))?$/.exec(value);
    const low = Number(match?.[1]), high = Number(match?.[2] ?? match?.[1]);
    require(match && low <= high && high <= 65535, 'Expected a port number or range such as 23100-23115');
    return low === high ? String(low) : `${low}-${high}`;
  }
  if (kind === 'migration') {
    require(/^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value)), 'Expected a positive migration number');
  } else if (kind === 'file') {
    // File reservations include future paths; do not require the leaf to exist.
    const path = resolve(scope, value);
    const rel = relative(scope, path);
    require(rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel), 'File must be within repository scope');
    // Resolve the nearest existing ancestor to prevent symlink aliases bypassing overlap checks.
    let existing = path;
    const tail: string[] = [];
    while (true) {
      let present = false;
      try {
        lstatSync(existing); present = true;
        const canonical = resolve(realpathSync(existing), ...tail);
        const inside = relative(scope, canonical);
        require(inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside), 'File symlink escapes repository scope');
        return canonical;
      } catch (error: any) {
        if (error.code !== 'ENOENT' || present) throw error;
        const parent = resolve(existing, '..');
        require(parent !== existing, 'Cannot resolve file reservation');
        tail.unshift(relative(parent, existing)); existing = parent;
      }
    }
  } else require(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value), 'Invalid compose project');
  return value;
}
export function resourceAction(store: Store, actorId: string, input: ResourceAction): Resource {
  inputObject(input);
  return store.transact((state) => {
    const agent = actor(state, actorId);
    require(['reserve', 'release'].includes(input.action), 'Unknown resource action');
    if (input.action === 'release') {
      require(input.id !== undefined, 'release requires id. Use the reservation id from reserve or orchestrator_status, not kind, value, or taskId.');
      id(input.id);
      const resource = state.resources.find((r) => r.id === input.id);
      require(resource, 'Unknown reservation');
      require(manages(state, agent, resource.taskId), 'Only owning task agent, ancestor, or coordinator may release');
      resource.releasedAt ??= Date.now();
      return resource;
    }
    require(['migration', 'port', 'compose', 'file'].includes(input.kind), 'Unknown resource kind');
    const task = taskById(state, input.taskId);
    require(manages(state, agent, task.id), 'Cannot reserve for another task');
    require(!['skipped', 'merged', 'deployed'].includes(task.state), 'Task cannot acquire new resources');
    const scope = canonicalScope(input.kind, input.scope, agent.worktree);
    const value = resourceValue(input.kind, scope, input.value);
    const sameKey = (resource: Resource) => resource.value === value && (hostWide(input.kind) || resource.scope === scope);
    const collides = (resource: Resource) => {
      if (input.kind === 'file') return resource.value === value || resource.value.startsWith(value + sep) || value.startsWith(resource.value + sep);
      if (input.kind !== 'port') return sameKey(resource);
      const [low, high] = portSpan(value), [heldLow, heldHigh] = portSpan(resource.value);
      return low <= heldHigh && heldLow <= high;
    };
    for (const resource of state.resources) {
      if (resource.releasedAt !== undefined || resource.kind !== input.kind) continue;
      if (!collides(resource)) continue;
      if (resource.taskId === task.id && sameKey(resource)) return resource;
      throw new Error(`Resource reservation conflicts with active ownership: ${resource.kind} ${resource.value} is held by task ${resource.taskId}`);
    }
    const resource: Resource = { id: randomUUID(), kind: input.kind, scope, value, taskId: task.id };
    state.resources.push(resource); return resource;
  });
}

function migrationOrder(state: Registry, taskId: string): void {
  for (const own of state.resources.filter((r) => r.taskId === taskId && r.kind === 'migration' && r.releasedAt === undefined)) {
    for (const lower of state.resources) {
      if (lower.kind !== 'migration' || lower.releasedAt !== undefined || lower.scope !== own.scope || lower.taskId === taskId) continue;
      if (Number(lower.value) < Number(own.value)) {
        require(['merged', 'deployed'].includes(taskById(state, lower.taskId).state), 'Lower active migration must merge first in this scope');
      }
    }
  }
}
function localCandidate(state: Registry, task: Task, commit: unknown, target: unknown): void {
  require(task.ships !== false, 'Non-shipping task has nothing to install');
  verified(state, task);
  require(task.approval?.hash === task.planHash && task.verification?.planHash === task.planHash, 'Local installation requires current human approval and verification');
  sha(commit);
  require(commit === task.result!.commit, 'Local installation SHA must equal the exact verified result');
  text(target, 'installation target', 1024);
  require(isAbsolute(target) && resolve(target) === target && target.trim() === target, 'Installation target must be an absolute normalized local path');
}
// Snapshot exact proposals; no action implications or task/action cross-products.
export function releaseScope(state: Registry, proposals: ReleaseProposal[]): ReleaseScope[] {
  require(Array.isArray(proposals) && proposals.length > 0 && proposals.length <= 100, 'Expected 1..100 exact release pairs');
  const seen = new Set<string>();
  return proposals.map((proposal) => {
    inputObject(proposal);
    require(Object.keys(proposal).every((key) => ['taskId', 'action', 'deploymentTarget', 'installationTarget', 'commit'].includes(key)), 'Unknown release proposal field');
    require(['pr', 'merge', 'deploy', 'local-install'].includes(proposal.action), 'Unknown release operation');
    const task = taskById(state, proposal.taskId);
    require(task.state !== 'skipped', 'Skipped task cannot receive release authorization');
    require(task.ships !== false, 'Non-shipping task has nothing to release; it is done once ready (light) or verified (gated)');
    if (proposal.action === 'deploy') text(proposal.deploymentTarget, 'explicit deployment target', 1024);
    else require(proposal.deploymentTarget === undefined, 'Deployment target only applies to deploy');
    const hash = hashPlan(task.planPath);
    require(hash === task.planHash, `Plan drift: ${task.planPath} changed since it was registered. Restore its registered content, or have the human re-approve it (/o approve ${task.id}), which resets the task's result and verification`);
    if (proposal.action === 'local-install') localCandidate(state, task, proposal.commit, proposal.installationTarget);
    else require(proposal.commit === undefined && proposal.installationTarget === undefined, 'Local installation fields only apply to local-install');
    const samePlan = state.releaseGrants?.flatMap(g => g.scope).filter(p => p.taskId === task.id && p.planHash === task.planHash) ?? [];
    const route = proposal.action === 'local-install' ? 'local-install' : 'pr';
    require([...samePlan, ...proposals.filter(p => p.taskId === task.id)].every(p => (p.action === 'local-install' ? 'local-install' : 'pr') === route)
      && (!state.releases[task.id] || (state.releases[task.id].route ?? 'pr') === route), 'Conflicting release routes require separate tasks');
    const key = JSON.stringify([task.id, proposal.action, proposal.deploymentTarget, proposal.installationTarget, proposal.commit]);
    require(!seen.has(key), 'Duplicate release pair'); seen.add(key);
    return { taskId: task.id, action: proposal.action, title: task.title, planPath: task.planPath, planHash: hash,
      ...(proposal.action === 'deploy' ? { deploymentTarget: proposal.deploymentTarget } : {}),
      ...(proposal.action === 'local-install' ? { installationTarget: proposal.installationTarget, commit: proposal.commit } : {}) };
  });
}
// 'cards' is the current rendering.
// JSON layouts 2 (pretty) and 0 (compact) are what older grants recorded,
// still accepted when loading older registries.
export type ScopeLayout = 'cards' | 2 | 0;
export const scopeLayouts: ScopeLayout[] = ['cards', 2, 0];
export function displayReleaseScope(root: string, scope: ReleaseScope[], source?: string, layout: ScopeLayout = 'cards'): string {
  // JSON quoting keeps untrusted titles, paths, targets and proposal metadata distinct from UI instructions.
  // Every line starts with fixed text; untrusted values never begin a line.
  // Task IDs are validated tokens and actions an enum, so they appear unquoted.
  const q = (value: unknown) => JSON.stringify(value);
  const pairs = layout === 'cards'
    ? scope.map((pair, index) => [
      `${index + 1}. ${pair.action.toUpperCase()} ${pair.taskId}${pair.action === 'deploy' ? ` -> ${q(pair.deploymentTarget)}` : ''}`,
      `   Title:  ${q(pair.title)}`,
      `   Plan:   ${q(pair.planPath)}`,
      `   SHA256: ${pair.planHash}`,
      ...(pair.action === 'local-install' ? [`   Commit: ${pair.commit}`, `   Install destination: ${q(pair.installationTarget)}`] : []),
    ].join('\n')).join('\n\n') + '\n'
    : scope.map((pair) => JSON.stringify(pair, null, layout)).join('\n');
  return `Registry: ${q(root)}\nExact release scope:\n${pairs}\n`
    + 'PR permission includes the branch push required to open/update that PR. No action implies another.\n'
    + 'Deployment is limited to its explicit target. Cleanup permission is NOT granted.\n'
    + (scope.some(pair => pair.action === 'local-install') ? 'Local installation is limited to the exact verified commit and local destination shown. It grants no PR, merge, deployment or cleanup permission.\n' : '')
    + 'Existing implementation approval, verification and ownership gates still apply. No external action is executed by this dialog.\n'
    + `Untrusted proposal reference: ${JSON.stringify(source ?? null)}`;
}
export function permittedRelease(state: Registry, root: string, task: Task, operation?: ReleaseOperation, deploymentTarget?: string, local?: Pick<ReleaseProposal, 'commit' | 'installationTarget'>): ReleaseGrant | undefined {
  const hash = hashPlan(task.planPath);
  if (task.planHash !== hash) return undefined;
  return state.releaseGrants?.find((grant) => grant.root === root && grant.scope.some((pair) => pair.taskId === task.id
    && pair.planHash === hash && pair.planPath === task.planPath && (operation ? (pair.action === operation
      && (operation !== 'deploy' || pair.deploymentTarget === deploymentTarget)
      && (operation !== 'local-install' || (pair.commit === local?.commit && pair.installationTarget === local?.installationTarget))) : pair.action !== 'local-install')));
}
function releasePermission(state: Registry, agent: Agent, task: Task): void {
  // Light feature owners ship their own task; strict releases stay with the coordinator/release role.
  // Helpers under an owner integrate through that owner instead of releasing slices.
  const owner = profileOf(state) === 'light' && agent.role === 'implementer' && manages(state, agent, task.id)
    && agent.parentId !== undefined && state.agents[agent.parentId]?.role === 'coordinator';
  require(['coordinator', 'release'].includes(agent.role) || owner, 'Release role required');
}
function requireReleaseGrant(state: Registry, root: string, task: Task, operation?: ReleaseOperation, deploymentTarget?: string, local?: Pick<ReleaseProposal, 'commit' | 'installationTarget'>): ReleaseGrant {
  if (operation === 'deploy') text(deploymentTarget, 'explicit deployment target', 1024);
  if (operation === 'local-install') localCandidate(state, task, local?.commit, local?.installationTarget);
  const grant = permittedRelease(state, root, task, operation, deploymentTarget, local);
  require(grant, `Human release authorization required for this exact task, current plan and action/target; request it with orchestrator_release request-authorization scope [{"taskId":"${task.id}"${operation ? `,"action":"${operation}"` : ''}${operation === 'deploy' ? `,"deploymentTarget":${JSON.stringify(deploymentTarget)}` : ''}${operation === 'local-install' ? `,"commit":${JSON.stringify(local?.commit)},"installationTarget":${JSON.stringify(local?.installationTarget)}` : ''}}]`);
  return grant;
}
function releaseStageAllowed(state: Registry, release: Release, stage: string): void {
  const previous = release.stage === 'blocked'
    ? release.installedCommit ? 'installed' : release.deployedCommit ? 'deployed' : release.mergedCommit ? 'merged' : release.pr ? 'pr' : 'claimed'
    : release.stage;
  require(previous !== 'cleaned', 'Release is already cleaned');
  if (stage === 'blocked') return;
  const next: Record<string, string[]> = release.route === 'local-install'
    ? { claimed: ['installed'], installed: ['cleaned'] }
    : profileOf(state) === 'light'
    ? { claimed: ['pr', 'merged'], pr: ['merged'], merged: ['deployed', 'cleaned'], deployed: ['cleaned'] }
    : { claimed: ['pr'], pr: ['merged'], merged: ['deployed'], deployed: ['cleaned'] };
  require(next[previous]?.includes(stage), `Release stages must advance in order: it is at ${previous}; next allowed: ${next[previous]?.join(' or ') || 'none'}`);
}
// The bridge fences every call by agent generation and process,
// so a release's owner may omit the token that claim returned.
function releaseToken(state: Registry, agent: Agent, taskId: string, token: unknown): string {
  const release = state.releases[taskId];
  require(release, 'No release is claimed for this task; claim it first');
  require(release.owner === agent.id, `Release is owned by ${release.owner}; only its owner, or a coordinator adopting an exited owner's release, may act on it`);
  if (token === undefined || token === '') return release.token;
  id(token); return token;
}
function deployLocked(state: Registry, root: string): void {
  require(state.releaseLock, 'Deploy lock required: record the merge, then take it with orchestrator_release lock (taskId, deploymentTarget)');
  if (state.family) {
    const holder = readDeploy(state.family);
    require(holder && holder.root === root && holder.token === state.releaseLock.token
      && holder.owner === state.releaseLock.owner && holder.taskId === state.releaseLock.taskId, 'Family deploy lock mismatch');
  }
}
type ReleaseCheck = { allowed: true; grantId: string; taskId: string; operation: ReleaseOperation; deploymentTarget?: string; installationTarget?: string; commit?: string; validUntil: string };
// A read-only, point-in-time guard before external effects, not an executor or reservation.
function checkRelease(state: Registry, root: string, actorId: string, input: Extract<ReleaseAction, { action: 'check' }>): ReleaseCheck {
  {
    const agent = actor(state, actorId), task = taskById(state, input.taskId);
    releasePermission(state, agent, task);
    require(['pr', 'merge', 'deploy', 'local-install'].includes(input.operation), 'Unknown release operation');
    if (input.operation === 'local-install') {
      require(['coordinator', 'release'].includes(agent.role), 'Local installation requires coordinator/release role');
      require(input.deploymentTarget === undefined, 'Deployment target does not apply to local-install');
    } else require(input.commit === undefined && input.installationTarget === undefined, 'Unexpected local installation fields');
    const grant = requireReleaseGrant(state, root, task, input.operation, input.deploymentTarget, input);
    const token = releaseToken(state, agent, task.id, input.token);
    const release = state.releases[task.id];
    require(release && release.owner === agent.id && release.token === token, 'Release record mismatch');
    verified(state, task);
    require(task.result!.commit === release.commit, 'Release commit differs from verified result');
    require((release.route === 'local-install') === (input.operation === 'local-install'), 'Release route mismatch');
    if (release.route === 'local-install') require(release.installationTarget === input.installationTarget, 'Installation target differs from claimed release');
    if (profileOf(state) !== 'light' || release.route === 'local-install') {
      require(state.releaseLock?.token === token && state.releaseLock.owner === agent.id && state.releaseLock.taskId === task.id, 'Release lock owner/token mismatch');
      migrationOrder(state, task.id);
      deployLocked(state, root);
    } else if (input.operation === 'deploy') {
      deployLocked(state, root);
      // Executing a deployment requires this release's lock;
      // batched deployed attestations may share another release's held lock.
      require(state.releaseLock?.token === token && state.releaseLock.owner === agent.id && state.releaseLock.taskId === task.id, 'Release lock owner/token mismatch');
    }
    // An existing open PR may need another authorized branch push after light owner fixes.
    if (!(input.operation === 'pr' && release.pr && !release.mergedCommit && release.stage !== 'cleaned')) {
      releaseStageAllowed(state, release, input.operation === 'merge' ? 'merged' : input.operation === 'deploy' ? 'deployed' : input.operation === 'local-install' ? 'installed' : 'pr');
    }
    return { allowed: true, grantId: grant.id, taskId: task.id, operation: input.operation,
      ...(input.operation === 'deploy' ? { deploymentTarget: input.deploymentTarget } : {}),
      ...(input.operation === 'local-install' ? { installationTarget: input.installationTarget, commit: input.commit } : {}),
      validUntil: 'this release record, its grant or the deploy lock changes; run every command of this operation without re-checking' };
  }
}

// Releases sharing one PR or deploy may act together in light registries: one transaction, all or nothing.
// Each task keeps its own release record and token; lock and unlock stay single-task.
function batchIds(state: Registry, input: ReleaseAction): string[] | undefined {
  const ids = (input as { taskIds?: unknown }).taskIds;
  if (ids === undefined) return undefined;
  require(['check', 'claim', 'record'].includes(input.action), 'taskIds applies to check, claim and record only');
  require(profileOf(state) === 'light', 'taskIds needs the light profile; strict releases go one task at a time under the serial lock');
  require((input as { taskId?: unknown }).taskId === undefined && (input as { token?: unknown }).token === undefined, 'Pass either taskId (with token) or taskIds, not both');
  require(Array.isArray(ids) && ids.length >= 1 && ids.length <= 20 && new Set(ids).size === ids.length, 'taskIds must list 1 to 20 distinct tasks');
  for (const taskId of ids) {
    id(taskId);
    require(state.releases[taskId]?.route !== 'local-install', 'Local installation does not support taskIds');
  }
  require(!('operation' in input && input.operation === 'local-install') && !('stage' in input && input.stage === 'installed'), 'Local installation does not support taskIds');
  return ids as string[];
}

export type NextStep = { action: 'claim' | 'check' | 'lock' | 'record' | 'unlock' | 'none'; operation?: ReleaseOperation; stage?: string; deploymentTarget?: string; installationTarget?: string; commit?: string; allowed?: boolean; reason?: string };
// What the release owner does next, with the same read-only check it would otherwise call separately.
export function nextStep(state: Registry, root: string, actorId: string, taskId: string): NextStep {
  const release = state.releases[taskId];
  if (!release) return { action: 'claim' };
  const lockHeld = state.releaseLock?.taskId === taskId && state.releaseLock.owner === actorId;
  const probe = (operation: ReleaseOperation, deploymentTarget?: string): NextStep => {
    const local = operation === 'local-install' ? { installationTarget: release.installationTarget, commit: release.commit } : {};
    try {
      checkRelease(state, root, actorId, { action: 'check', taskId, operation, ...(deploymentTarget ? { deploymentTarget } : {}), ...local });
      return { action: 'check', operation, ...(deploymentTarget ? { deploymentTarget } : {}), ...local, allowed: true };
    } catch (error) { return { action: 'check', operation, ...(deploymentTarget ? { deploymentTarget } : {}), ...local, allowed: false, reason: (error as Error).message }; }
  };
  const target = state.releaseGrants?.flatMap((grant) => grant.scope).find((pair) => pair.taskId === taskId && pair.action === 'deploy')?.deploymentTarget;
  const stage = release.stage;
  if (stage === 'blocked') return { action: 'none', reason: 'Release is blocked; resolve it, then record the next stage' };
  if (stage === 'claimed') return probe(release.route === 'local-install' ? 'local-install' : 'pr');
  if (release.route === 'local-install' && stage === 'installed') return lockHeld
    ? { action: 'record', stage: 'cleaned', reason: 'Local install attested; optional bookkeeping before unlocking, not destructive cleanup' }
    : { action: 'none', reason: 'Local install attested and lock released; artifacts retained' };
  if (stage === 'pr') return probe('merge');
  if (stage === 'merged') {
    if (!target) return { action: 'record', stage: 'cleaned', reason: 'No deploy is authorized; record cleaned, or request authorization to deploy' };
    if (lockHeld) return probe('deploy', target);
    if (state.releaseLock) return { action: 'none', deploymentTarget: target, reason: `Deploy lock is held by ${state.releaseLock.owner} for ${state.releaseLock.taskId}; wait, or attest that batched deployment when it lands` };
    return { action: 'lock', deploymentTarget: target };
  }
  if (lockHeld) return { action: 'unlock', reason: 'Unlock with a reason once the smoke check passes' };
  return stage === 'cleaned' ? { action: 'none' } : { action: 'record', stage: 'cleaned', reason: 'Optional bookkeeping' };
}

export function releaseAction(store: Store, actorId: string, input: ReleaseAction): any {
  inputObject(input);
  const current = store.read();
  const local = current.releases[input.taskId]?.route === 'local-install'
    || ('operation' in input && input.operation === 'local-install') || ('stage' in input && input.stage === 'installed');
  if (local) {
    const fields: Record<string, string[]> = {
      claim: ['action', 'taskId', 'operation', 'commit', 'installationTarget'],
      check: ['action', 'taskId', 'token', 'operation', 'commit', 'installationTarget'],
      record: ['action', 'taskId', 'token', 'stage', 'installedCommit', 'installationTarget', 'evidence'],
      unlock: ['action', 'taskId', 'token', 'reason'],
    };
    require(fields[input.action] && Object.keys(input).every(key => fields[input.action].includes(key)), 'Unexpected fields or action for single-task local installation');
  } else require(!Object.keys(input).some(key => ['commit', 'installationTarget', 'installedCommit'].includes(key)), 'Local installation fields require the explicit local-install route');
  const ids = batchIds(current, input);
  if (input.action === 'check') {
    const state = store.read();
    return ids ? ids.map((taskId) => checkRelease(state, store.root, actorId, { ...input, taskId }))
      : checkRelease(state, store.root, actorId, input);
  }
  const result = store.transact((state) => ids
    ? ids.map((taskId) => mutateRelease(state, store.root, actorId, { ...input, taskId } as ReleaseAction))
    : mutateRelease(state, store.root, actorId, input));
  if (input.action === 'unlock') return result;
  const after = store.read();
  const withNext = (release: Release) => ({ ...release, next: nextStep(after, store.root, actorId, release.taskId) });
  return Array.isArray(result) ? result.map(withNext) : withNext(result);
}

function mutateRelease(state: Registry, root: string, actorId: string, input: ReleaseAction): Release {
  {
    const store = { root };
    const agent = actor(state, actorId);
    require(['claim', 'lock', 'record', 'unlock'].includes(input.action), 'Unknown release action');
    const task = taskById(state, input.taskId);
    // Strict: one lock spans claim -> PR -> merge -> deploy -> cleanup.
    // Light: owners claim, PR and merge concurrently (Git serializes merges);
    // the lock covers only deploying merged main and its short smoke check.
    const light = profileOf(state) === 'light';
    if (input.action === 'claim') {
      releasePermission(state, agent, task);
      require(task.ships !== false, 'Non-shipping task has nothing to release');
      require(input.operation === undefined || input.operation === 'local-install',
        'Ordinary claim requires no operation field. Omit operation. Only a local installation uses operation local-install on claim.');
      const local = input.operation === 'local-install';
      if (local) require(['coordinator', 'release'].includes(agent.role), 'Local installation requires coordinator/release role');
      else require(input.commit === undefined && input.installationTarget === undefined, 'Local installation needs an explicit local-install claim');
      requireReleaseGrant(state, store.root, task, local ? 'local-install' : undefined, undefined, input);
      if (!light || local) require(!state.releaseLock, 'Release lock is already held');
      require(['verified', 'merged', 'deployed'].includes(task.state), `Task must be verified before claiming; it is ${task.state}. Publish a ready result and verify it with orchestrator_task verify`);
      verified(state, task); if (!light) migrationOrder(state, task.id);
      const prior = state.releases[task.id];
      if (prior) {
        require((prior.route === 'local-install') === local, 'Release route mismatch');
        if (local) require(prior.installationTarget === input.installationTarget && !prior.installedCommit, 'Local installation already attested or target changed');
        // A coordinator may adopt a light release whose owner has exited.
        const orphaned = light && !local && agent.role === 'coordinator' && prior.owner !== agent.id
          && ['exited', 'collected', 'closed'].includes(state.agents[prior.owner]?.lifecycle);
        require(prior.stage !== 'cleaned', 'Release is already cleaned; ship further changes as a new task');
        require(prior.owner === agent.id || orphaned, `Release is owned by ${prior.owner} (${state.agents[prior.owner]?.lifecycle ?? 'unknown'}); a coordinator may adopt it only after that owner exits`);
        // Verification moves an unmerged release to its new commit, so a mismatch means the merge is already recorded.
        require(prior.commit === task.result!.commit,
          `Release was claimed at ${prior.commit.slice(0, 12)} but the verified result is ${task.result!.commit!.slice(0, 12)}, and its merge is recorded; ship further changes as a new task`);
        if (light && !orphaned) require(state.releaseLock?.taskId !== task.id, 'Deploy lock is held by this release; use its token');
      }
      const release: Release = prior
        ? { ...prior, owner: agent.id, token: randomUUID(), updatedAt: Date.now() }
        : { taskId: task.id, owner: agent.id, token: randomUUID(), commit: task.result!.commit!, stage: 'claimed', route: local ? 'local-install' : 'pr',
          ...(local ? { installationTarget: input.installationTarget } : {}), evidence: [], updatedAt: Date.now() };
      state.releases[task.id] = release;
      const holder = { root: store.root, taskId: task.id, token: release.token, owner: agent.id };
      history(task, task.state, `Release claimed by ${agent.id}`);
      // Family file effects come last, so a rejected transaction leaves no foreign lock behind.
      if (!light || local) {
        state.releaseLock = { owner: agent.id, token: release.token, taskId: task.id };
        if (state.family) acquireDeploy(state.family, holder);
      } else if (state.releaseLock?.taskId === task.id) {
        // Adopting an exited owner's release also adopts its deploy lock, to reconcile and unlock deliberately.
        const previous = { root: store.root, taskId: task.id, token: state.releaseLock.token, owner: state.releaseLock.owner };
        state.releaseLock = { owner: agent.id, token: release.token, taskId: task.id };
        if (state.family) adoptDeploy(state.family, previous, holder);
      }
      return release;
    }
    const token = releaseToken(state, agent, task.id, input.token);
    const lock = state.releaseLock;
    const release = state.releases[task.id];
    if (input.action === 'lock') {
      require(light && release.route !== 'local-install', 'Strict and local-install releases take the lock at claim');
      require(release && release.owner === agent.id && release.token === token, 'Release record mismatch');
      releasePermission(state, agent, task);
      requireReleaseGrant(state, store.root, task, 'deploy', input.deploymentTarget);
      verified(state, task);
      require(release.mergedCommit, 'Record the merge first; the deploy lock covers deploying merged main');
      const holder = { root: store.root, taskId: task.id, token: release.token, owner: agent.id };
      if (lock) {
        require(lock.taskId === task.id && lock.token === release.token, 'Deploy lock is already held');
        if (state.family) acquireDeploy(state.family, holder);
        return release;
      }
      state.releaseLock = { owner: agent.id, token: release.token, taskId: task.id };
      history(task, task.state, `Deploy lock taken by ${agent.id}`);
      // Forks of one family deploy the same target, so they share one lock.
      if (state.family) acquireDeploy(state.family, holder);
      return release;
    }
    if (input.action === 'unlock' || !light || release.route === 'local-install') {
      require(lock && lock.taskId === task.id && lock.owner === agent.id && lock.token === token, 'Release lock owner/token mismatch');
    }
    require(release && release.owner === agent.id && release.token === token, 'Release record mismatch');
    if (input.action === 'unlock') {
      require(typeof input.reason === 'string' && input.reason.trim() !== '', 'Unlock requires a reason; it is recorded in the task history');
      text(input.reason, 'unlock reason');
      history(task, task.state, `Release unlocked by ${agent.id}: ${input.reason}`);
      delete state.releaseLock; release.updatedAt = Date.now();
      if (state.family) releaseDeploy(state.family, { root: store.root, taskId: task.id, token, owner: agent.id });
      return release;
    }
    releasePermission(state, agent, task);
    require(['pr', 'merged', 'deployed', 'installed', 'cleaned', 'blocked'].includes(input.stage), 'Invalid release stage');
    if (release.route === 'local-install') {
      require(['coordinator', 'release'].includes(agent.role), 'Local installation requires coordinator/release role');
      require(input.pr === undefined && input.mergedCommit === undefined && input.deployedCommit === undefined && input.deploymentTarget === undefined, 'PR/merge/deploy fields do not apply to local installation');
      if (input.stage !== 'installed') require(input.installedCommit === undefined && input.installationTarget === undefined, 'Installation fields only apply to installed checkpoint');
    } else require(input.installedCommit === undefined && input.installationTarget === undefined && input.stage !== 'installed', 'Release route mismatch');
    const operation = input.stage === 'pr' ? 'pr' : input.stage === 'merged' ? 'merge' : input.stage === 'deployed' ? 'deploy' : input.stage === 'installed' ? 'local-install' : undefined;
    if (operation) requireReleaseGrant(state, store.root, task, operation, input.deploymentTarget, { commit: input.installedCommit, installationTarget: input.installationTarget });
    if (input.stage === 'installed') {
      require(input.installedCommit === release.commit && input.installationTarget === release.installationTarget, 'Installed commit/target differs from claimed release');
      deployLocked(state, store.root);
    }
    if (input.stage !== 'blocked') {
      verified(state, task); if (!light) migrationOrder(state, task.id);
      require(task.result!.commit === release.commit, 'Release commit differs from verified result');
    }
    const paths = evidence(input.evidence, true);
    releaseStageAllowed(state, release, input.stage);
    if (input.stage === 'deployed') deployLocked(state, store.root);
    if (input.pr !== undefined) {
      text(input.pr, 'PR URL');
      const url = new URL(input.pr);
      require(['https:', 'http:'].includes(url.protocol) && !url.username && !url.password, 'Invalid PR URL');
      require(input.stage === 'pr' || input.pr === release.pr || (light && input.stage === 'merged' && !release.pr), 'Cannot mutate PR outside PR stage');
    }
    if (input.mergedCommit !== undefined) {
      sha(input.mergedCommit);
      require(input.stage === 'merged' || input.mergedCommit.toLowerCase() === release.mergedCommit, 'Cannot mutate merged SHA outside merged stage');
    }
    if (input.deployedCommit !== undefined) {
      sha(input.deployedCommit);
      require(input.stage === 'deployed' || input.deployedCommit.toLowerCase() === release.deployedCommit, 'Cannot mutate deployed SHA outside deployed stage');
    }
    if (input.stage === 'pr') { require(input.pr, 'PR URL required'); release.pr = input.pr; }
    if (input.stage === 'merged') {
      sha(input.mergedCommit); release.mergedCommit = input.mergedCommit.toLowerCase();
      if (input.pr && !release.pr) release.pr = input.pr;
      history(task, 'merged', `Merge attested by ${agent.id}`);
    }
    if (input.stage === 'deployed') {
      sha(input.deployedCommit);
      // Light deploys batch whatever main contains; the deployed main must include this merge (attested).
      require(light || input.deployedCommit.toLowerCase() === release.mergedCommit, 'Deployed SHA must equal merged SHA');
      release.deployedCommit = input.deployedCommit.toLowerCase();
      history(task, 'deployed', `Deployment attested by ${agent.id}`);
    }
    if (input.stage === 'installed') {
      release.installedCommit = input.installedCommit;
      history(task, 'deployed', `Local installation attested by ${agent.id}: ${release.commit} at ${release.installationTarget}`);
    }
    release.stage = input.stage; release.evidence = [...new Set([...release.evidence, ...paths])].sort(); release.updatedAt = Date.now();
    if (!['merged', 'deployed', 'installed'].includes(input.stage)) history(task, task.state, `Release ${input.stage} attested by ${agent.id}`);
    return release;
  }
}

// Without an explicit mode, messages to busy workers steer:
// Pi delivers them after the recipient's current tool batch, without aborting it,
// instead of holding them until the whole task finishes.
// The coordinator (which converses with the human) and shutdowns still wait for idle.
// Prefix of a worker's ask_user relay; such a relay is a question and never a result handoff.
export const QUESTION_RELAY_PREFIX = 'ask_user from ';
export function sendMessage(store: Store, from: string, to: string, body: string, mode?: Message['mode'], kind: Message['kind'] = 'message', resultId?: string): Message {
  text(body, 'message body', 16384);
  require(mode === undefined || ['followUp', 'steer'].includes(mode), 'Invalid delivery mode');
  require(['message', 'shutdown'].includes(kind), 'Invalid message kind');
  if (resultId !== undefined) id(resultId);
  return store.transact((state) => {
    const sender = actor(state, from); const target = actor(state, to);
    // An explicit handoff names the sender's own task's exact current result, worker to coordinator only.
    // It may spare the coordinator a second wake for that result, so anything else is rejected, not guessed.
    if (resultId !== undefined) {
      require(kind === 'message', 'resultId is only for ordinary messages, not shutdown');
      require(!body.startsWith(QUESTION_RELAY_PREFIX), 'resultId cannot mark a human-question relay');
      require(sender.role !== 'coordinator' && target.role === 'coordinator', 'resultId is only for worker-to-coordinator handoffs');
      const task = sender.taskId ? state.tasks[sender.taskId] : undefined;
      require(task && ((sender.role === 'implementer' && sender.taskId === task.id) || readOnlyOwner(sender, task)), 'resultId requires a worker that may publish its own task result');
      require(task.result?.id === resultId, 'resultId must be the current result of your own task');
    }
    require(['registered', 'starting', 'running'].includes(target.lifecycle), 'Target is not accepting messages');
    require(sender.id !== target.id, 'Cannot message self');
    // Light siblings (for example two feature owners sharing a rebase) talk directly.
    const siblings = profileOf(state) === 'light' && sender.parentId !== undefined && sender.parentId === target.parentId;
    if (kind === 'shutdown') require(sender.role === 'coordinator' || target.parentId === sender.id, 'Shutdown requires parent or coordinator');
    else require(sender.role === 'coordinator' || target.role === 'coordinator' || siblings
      || ancestor(state, sender.id, target.id) || ancestor(state, target.id, sender.id), 'Unrelated peer routing is forbidden');
    const delivery = mode ?? (kind === 'shutdown' || target.role === 'coordinator' ? 'followUp' : 'steer');
    const message: Message = { id: randomUUID(), from, to, generation: target.generation, body, mode: delivery, kind, ...(resultId !== undefined ? { resultId } : {}), createdAt: Date.now() };
    // A reply to an agent that asked the human (ask_user) answers it, so the task stops flagging needsHuman.
    const asked = kind === 'message' && target.taskId ? state.tasks[target.taskId]?.summary : undefined;
    if (asked?.needsHuman && asked.by === target.id && asked.text.startsWith(QUESTION_PREFIX)) {
      let answered = `Answered by ${from}: ${asked.text.slice(QUESTION_PREFIX.length)}`;
      while (Buffer.byteLength(answered) > 1024) answered = answered.slice(0, -1);
      state.tasks[target.taskId!].summary = { text: answered, needsHuman: false, by: from, at: message.createdAt };
    }
    state.messages.push(message); return message;
  });
}
export function pendingMessages(store: Store, agentId: string, generation: string): Message[] {
  id(generation);
  const state = store.read(); const agent = actor(state, agentId);
  require(agent.generation === generation, 'Stale agent generation');
  return state.messages.filter((m) => m.to === agentId && m.generation === generation && m.acknowledgedAt === undefined);
}
export function acknowledge(store: Store, agentId: string, generation: string, messageId: string): void {
  id(generation); id(messageId);
  store.transact((state) => {
    const agent = actor(state, agentId);
    require(agent.generation === generation, 'Stale agent generation');
    const message = state.messages.find((m) => m.id === messageId);
    require(message && message.to === agentId && message.generation === generation, 'Message recipient/generation mismatch');
    // This acknowledges persisted transcript delivery, never completion of the requested work.
    message.deliveredAt ??= Date.now(); message.acknowledgedAt ??= Date.now();
  });
}

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import { homedir } from 'node:os';
import { LIMITS } from './contracts.ts';
import type { Agent, Fork, ProcessRunner, Profile, Registry, Role, SpawnInput, Store, Task } from './contracts.ts';
import { deliveredBy, dependencyAccepted, gated, profileOf } from './policy.ts';
import { openStore } from './store.ts';
import { ensureFamily, familyRootFor, reserveMember } from './family.ts';
import { sendMessage } from './workflow.ts';

const execute = promisify(execFile);
const OUTPUT_LIMIT = 1024 * 1024;
const STALE_MS = 60_000;

export const run: ProcessRunner = async (command, args, options = {}) => {
  const timeout = options.timeout ?? 30_000;
  const maxBuffer = options.maxBuffer ?? OUTPUT_LIMIT;
  requireThat(Number.isSafeInteger(timeout) && timeout > 0, 'Timeout must be a positive integer');
  requireThat(Number.isSafeInteger(maxBuffer) && maxBuffer > 0 && maxBuffer <= 16 * 1024 * 1024, 'Output budget must be a positive integer no larger than 16 MiB');
  const result = await execute(command, args, {
    cwd: options.cwd, timeout: Math.min(timeout, 120_000),
    maxBuffer, encoding: 'utf8', shell: false,
  });
  return { stdout: result.stdout, stderr: result.stderr };
};

function requireThat(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

// Pane presentation and Zellij/ps availability can lapse while a verified worker is busy or its host slept.
// They gate a first promotion but are not identity evidence,
// so they never revoke a verified worker whose current-generation heartbeat is fresh.
class Unobserved extends Error {}

function observable(value: unknown, message: string): asserts value {
  if (!value) throw new Unobserved(message);
}

async function observing<T>(work: Promise<T>): Promise<T> {
  try { return await work; } catch { throw new Unobserved('Zellij or process observation failed'); }
}

function id(value: string) {
  requireThat(typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value), 'Invalid identifier');
}

// Refuse aliases and symlinks in every existing component,
// including dangling links at destinations that do not yet exist.
function safePath(path: string, existing = true): string {
  requireThat(typeof path === 'string' && isAbsolute(path) && normalize(path) === path && !/[\x00-\x1f\x7f]/.test(path), 'Expected a normalized absolute path');
  let part: string = sep;
  for (const component of path.split(sep).filter(Boolean)) {
    part = join(part, component);
    try {
      requireThat(!lstatSync(part).isSymbolicLink(), 'Symlink paths are not allowed');
      requireThat(realpathSync(part) === part, 'Filesystem path aliases are not allowed');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || existing) throw error;
    }
  }
  return path;
}

function exists(path: string) {
  try { lstatSync(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function within(parent: string, child: string) {
  const suffix = relative(parent, child);
  return suffix === '' || (!suffix.startsWith(`..${sep}`) && suffix !== '..' && !isAbsolute(suffix));
}

function privateDir(path: string) {
  safePath(path, false);
  if (!exists(path)) {
    try { mkdirSync(path, { mode: 0o700 }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  const stat = lstatSync(path);
  requireThat(stat.isDirectory() && (stat.mode & 0o077) === 0, 'Runtime directory must be private');
}

function boundedFile(path: string, limit = OUTPUT_LIMIT) {
  safePath(path);
  const stat = lstatSync(path);
  requireThat(stat.isFile() && stat.size <= limit, 'Expected a bounded regular file');
  return readFileSync(path);
}

function planHash(task: Task) {
  return createHash('sha256').update(boundedFile(task.planPath)).digest('hex');
}

// Gated (strict or risky) scope needs current human approval at every level.
// Light non-risky scope needs only readable plans and no skipped ancestor.
function currentApproval(state: Registry, task: Task) {
  const approval = gated(state, task);
  const seen = new Set<string>();
  let current: Task | undefined = task;
  while (current) {
    requireThat(!seen.has(current.id), 'Task scope cycle');
    seen.add(current.id);
    requireThat(current.state !== 'skipped' && (approval
      ? current.approval?.hash === current.planHash && current.planHash === planHash(current)
      : Boolean(planHash(current))), 'Current plan approval required for task and parent scope');
    if (!current.parentTask) break;
    requireThat(Object.hasOwn(state.tasks, current.parentTask), 'Unknown parent task scope');
    current = state.tasks[current.parentTask];
  }
}

function authorized(state: Registry, parentId: string, taskId: string, role: Role) {
  id(parentId); id(taskId);
  const parent = state.agents[parentId];
  const task = state.tasks[taskId];
  requireThat(Object.hasOwn(state.agents, parentId) && parent && !['exited', 'collected', 'closed'].includes(parent.lifecycle), 'Parent must be registered and live');
  requireThat(Object.hasOwn(state.tasks, taskId) && task, 'Unknown task');
  requireThat(['planner', 'reviewer', 'implementer', 'release'].includes(role), 'spawn requires role. Use planner, reviewer, implementer, or release.');
  if (parent.role !== 'coordinator') {
    requireThat(parent.taskId, 'Parent has no task scope');
    const seen = new Set<string>();
    let cursor: Task | undefined = task;
    while (cursor && cursor.id !== parent.taskId && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      cursor = cursor.parentTask ? state.tasks[cursor.parentTask] : undefined;
    }
    requireThat(cursor?.id === parent.taskId && task.id !== parent.taskId, 'Child task must descend from parent task scope');
    requireThat(!['implementer', 'release'].includes(role) || ['implementer', 'release'].includes(parent.role), 'Read-only parent cannot delegate write authorization');
  }
  if (role === 'implementer' || role === 'release') {
    const allowed = role === 'release'
      ? ['approved', 'implementing', 'ready', 'verified', 'blocked', 'merged', 'deployed']
      : ['approved', 'implementing', 'ready', 'verified', 'blocked'];
    requireThat(allowed.includes(task.state) || (task.state === 'planned' && !gated(state, task)), 'Task is not approved for implementation');
    // A bundle-delivered result is terminal like a deployed one; only release bookkeeping remains.
    requireThat(role === 'release' || !deliveredBy(state, task), 'Task was delivered through a local-install bundle; implement further changes as a new task');
    currentApproval(state, task);
    for (const dependencyId of task.dependencies) {
      const dependency = state.tasks[dependencyId];
      requireThat(Object.hasOwn(state.tasks, dependencyId) && dependency, 'Verified current dependencies required');
      if (gated(state, dependency)) {
        requireThat(['verified', 'merged', 'deployed'].includes(dependency.state)
          && dependency.verification?.planHash === dependency.planHash && dependency.result?.status === 'ready'
          && dependency.result.commit === dependency.verification?.commit, 'Verified current dependencies required');
      } else {
        // Light consumers may stack on a dependency's ready commit.
        requireThat(dependencyAccepted(state, dependency), 'Ready dependencies required');
      }
      currentApproval(state, dependency);
    }
  } else {
    requireThat(!['skipped', 'merged', 'deployed'].includes(task.state) && !deliveredBy(state, task), 'Task cannot be inspected in this state');
  }
}

function agentFrom(store: Store, agentId: string) {
  id(agentId);
  const state = store.read();
  const agent = state.agents[agentId];
  requireThat(Object.hasOwn(state.agents, agentId) && agent, 'Unknown agent');
  return structuredClone(agent);
}

function owned(state: Registry, parentId: string, agentId: string) {
  id(parentId); id(agentId);
  const parent = state.agents[parentId];
  const agent = state.agents[agentId];
  requireThat(Object.hasOwn(state.agents, parentId) && Object.hasOwn(state.agents, agentId)
    && parent && agent && (parent.role === 'coordinator' || agent.parentId === parentId), 'Only parent or coordinator may manage agent');
  return agent;
}

function update(store: Store, agent: Agent, change: Partial<Agent>) {
  return store.transact(state => {
    const current = state.agents[agent.id];
    requireThat(current?.generation === agent.generation, 'Generation changed; inspect again');
    Object.assign(current, change);
    return structuredClone(current);
  });
}

type Pane = {
  id: number; is_plugin: boolean; tab_id: number; tab_name: string; tab_position?: number;
  title: string; exited: boolean; terminal_command?: string | null;
  pane_command?: string; pane_cwd?: string; plugin_url?: string | null; is_suppressed?: boolean;
  pane_content_rows?: number; pane_content_columns?: number;
};
type Launch = {
  generation: string; session: string; argv: string[]; createdAt: number;
  tabLaunchAttempted?: boolean;
  tabChrome?: string[];
  taskMessageId?: string;
  promptHash?: string;
  identity: Pick<Agent, 'id' | 'parentId' | 'taskId' | 'role' | 'model' | 'thinking' | 'repo' | 'base' | 'branch' | 'worktree' | 'sessionDir' | 'piSessionId'>;
};

// Keep initial layout command identities without retaining unrelated command text.
function paneIdentity(pane: Pane) {
  const { id, is_plugin, tab_id, terminal_command, pane_command, pane_cwd, plugin_url } = pane;
  return createHash('sha256').update(JSON.stringify({ id, is_plugin, tab_id, terminal_command, pane_command, pane_cwd, plugin_url })).digest('hex');
}

function identity(agent: Agent): Launch['identity'] {
  const { id, parentId, taskId, role, model, repo, base, branch, worktree, sessionDir, piSessionId } = agent;
  return { id, parentId, taskId, role, model, repo, base, branch, worktree, sessionDir, piSessionId,
    ...(agent.thinking === undefined ? {} : { thinking: agent.thinking }) };
}

function artifacts(store: Store, agent: Agent) {
  safePath(store.root);
  id(agent.id); id(agent.generation);
  const directory = join(store.root, 'runtime', agent.id);
  return { directory, manifest: join(directory, `${agent.generation}.json`), prompt: join(directory, `${agent.generation}.md`),
    bootstrap: join(directory, `${agent.generation}.bootstrap.md`) };
}

function launchRecord(store: Store, agent: Agent): Launch {
  const record = JSON.parse(boundedFile(artifacts(store, agent).manifest).toString('utf8')) as Launch;
  requireThat(record.generation === agent.generation && record.session === agent.zellijSession
    && Array.isArray(record.argv) && record.argv.every(v => typeof v === 'string')
    && JSON.stringify(record.identity) === JSON.stringify(identity(agent)), 'Invalid launch identity');
  requireThat((record.taskMessageId === undefined && record.promptHash === undefined)
    || (typeof record.taskMessageId === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(record.taskMessageId)
      && typeof record.promptHash === 'string' && /^[a-f0-9]{64}$/.test(record.promptHash)), 'Invalid launch delivery identity');
  return record;
}

async function panes(agent: Agent, runner: ProcessRunner): Promise<Pane[]> {
  requireThat(agent.zellijSession && /^piorch-[a-zA-Z0-9_-]+$/.test(agent.zellijSession), 'Missing dedicated session identity');
  // --all includes non-selectable layout plugins as well as identity/state fields.
  // A busy or exiting session can answer with empty or truncated JSON; retry briefly.
  let values: unknown;
  for (let attempt = 0; ; attempt++) {
    const result = await runner('zellij', ['--session', agent.zellijSession, 'action', 'list-panes', '--json', '--all']);
    requireThat(result.stdout.length <= OUTPUT_LIMIT, 'Pane output too large');
    try { values = JSON.parse(result.stdout); break; } catch {
      requireThat(attempt < 4, 'Pane inventory unreadable after retries');
      await sleep(200);
    }
  }
  requireThat(Array.isArray(values) && values.every(p => p && Number.isSafeInteger(p.id) && p.id >= 0
    && Number.isSafeInteger(p.tab_id) && p.tab_id >= 0 && typeof p.is_plugin === 'boolean'
    && typeof p.exited === 'boolean' && typeof p.title === 'string'), 'Unrecognized pane inventory');
  return values;
}

function isChrome(pane: Pane) {
  return pane.is_plugin && (pane.plugin_url === 'zellij:tab-bar' || pane.plugin_url === 'zellij:status-bar');
}

// Layout plugins can arrive after the terminal has already settled.
// New bundled sessions require both bars; legacy sessions keep their existing layout.
async function settledPanes(agent: Agent, runner: ProcessRunner, expectChrome: boolean, tabId?: number): Promise<Pane[]> {
  let previous = '';
  let values: Pane[] = [];
  for (let attempt = 0; attempt < 40; attempt++) {
    values = (await panes(agent, runner)).filter(p => tabId === undefined || p.tab_id === tabId);
    const current = JSON.stringify(values.map(paneIdentity));
    const chromeReady = ['zellij:tab-bar', 'zellij:status-bar'].every(url =>
      values.filter(p => isChrome(p) && p.plugin_url === url).length === 1);
    if (values.length && current === previous && (!expectChrome || chromeReady)) return values;
    previous = current;
    await sleep(150);
  }
  throw new Error('Layout panes did not settle; ownership remains unverified');
}

function matchingPane(agent: Agent, record: Launch, values: Pane[]) {
  const matches = values.filter(p => !p.is_plugin && p.tab_name === agent.id
    && (p.pane_cwd === agent.worktree || (p.exited && p.pane_cwd === undefined
      && agent.tabId === p.tab_id && agent.paneId === `terminal_${p.id}`))
    && p.terminal_command === ['pi', ...record.argv].join(' ')
    && (agent.tabId === undefined || p.tab_id === agent.tabId)
    && (agent.paneId === undefined || `terminal_${p.id}` === agent.paneId));
  requireThat(matches.length === 1, 'Owned pane command/session identity is unverified');
  return matches[0];
}

async function sessions(runner: ProcessRunner, includeExited = false) {
  let stdout: string;
  try {
    ({ stdout } = await runner('zellij', ['list-sessions', '--no-formatting']));
  } catch (error) {
    const failure = error as Error & { code?: unknown; stdout?: unknown; stderr?: unknown; killed?: unknown; signal?: unknown };
    // Zellij exits 1 for an empty inventory as well as for actual listing errors.
    if (error instanceof Error && failure.code === 1 && failure.stdout === ''
      && failure.stderr === 'No active zellij sessions found.\n'
      && (failure.killed === undefined || failure.killed === false)
      && (failure.signal === undefined || failure.signal === null)) return [];
    throw error;
  }
  requireThat(stdout.length <= OUTPUT_LIMIT, 'Session inventory too large');
  // Short output includes resurrectable EXITED sessions without their status.
  // Generated session names contain no whitespace, so the first field is exact.
  return stdout.split('\n').filter(line => line.trim() && (includeExited || !/\bEXITED\b/.test(line)))
    .map(line => line.trim().split(/\s+/)[0]);
}

async function pidAlive(pid: number | undefined, runner: ProcessRunner) {
  if (pid === undefined) return false;
  requireThat(Number.isSafeInteger(pid) && pid > 1, 'Invalid worker PID');
  try {
    const { stdout } = await runner('ps', ['-p', String(pid), '-o', 'pid=']);
    requireThat(stdout.trim() === '' || stdout.trim() === String(pid), 'Uncertain worker PID');
    return stdout.trim() !== '';
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    if (failure.code === 1 && failure.stdout === '' && failure.stderr === '') return false;
    throw error;
  }
}

function transcript(agent: Agent) {
  requireThat(agent.sessionFile, 'Persisted session-file handshake required');
  safePath(agent.sessionDir); safePath(agent.sessionFile);
  requireThat(within(agent.sessionDir, agent.sessionFile), 'Transcript outside dedicated session directory');
  const stat = lstatSync(agent.sessionFile);
  requireThat(stat.isFile() && stat.nlink === 1, 'Transcript must be an unshared regular file');
  const fd = openSync(agent.sessionFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const buffer = Buffer.alloc(16 * 1024);
    const length = readSync(fd, buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, length).toString('utf8');
    const end = text.indexOf('\n');
    requireThat(end >= 0, 'Invalid transcript header');
    const header = JSON.parse(text.slice(0, end));
    requireThat(header.type === 'session' && header.id === agent.piSessionId && header.cwd === agent.worktree, 'Transcript identity mismatch');
  } finally { closeSync(fd); }
}

function modelParts(model: string) {
  const slash = model.indexOf('/');
  requireThat(slash > 0 && slash < model.length - 1 && !/\s/.test(model), 'Invalid model; expected provider/model-id');
  return [model.slice(0, slash), model.slice(slash + 1)];
}

function launchThinking(model: string, override: SpawnInput['thinking'], agentDir?: string): NonNullable<SpawnInput['thinking']> {
  let value: unknown = override;
  let source = 'thinking override';
  if (override === undefined && agentDir !== undefined) {
    const path = join(agentDir, 'model-roles.json');
    let config: Record<string, unknown>;
    try {
      config = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'high';
      throw new Error(`Cannot read model roles from ${path}: ${(error as Error).message}`);
    }
    requireThat(config !== null && typeof config === 'object' && !Array.isArray(config), `Expected a JSON object in ${path}`);
    const key = model === config.judgement ? 'judgementThinking' : 'implementationThinking';
    value = config[key];
    source = `${key} in ${path}`;
  }
  if (value === undefined) return 'high';
  requireThat(typeof value === 'string' && ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(value),
    `Invalid thinking level for ${source}. Use off, minimal, low, medium, high, or xhigh.`);
  return value as NonNullable<SpawnInput['thinking']>;
}

async function availableModel(runner: ProcessRunner, model: string) {
  const [provider, name] = modelParts(model);
  const { stdout } = await runner('pi', ['--list-models']);
  requireThat(stdout.split('\n').some(line => {
    const fields = line.trim().split(/\s+/);
    return fields[0] === provider && fields[1] === name || fields[0] === model;
  }), `Required model unavailable: ${model}; no substitute permitted`);
}

function sharedSessionPrefix(store: Store) {
  return `piorch-${createHash('sha256').update(store.root).digest('hex').slice(0, 6)}-`;
}

function newSharedSession(store: Store) {
  return `${sharedSessionPrefix(store)}${randomUUID().replaceAll('-', '').slice(0, 6)}`;
}

function isSharedSession(store: Store, name: string | undefined) {
  const oldPrefix = `piorch-task-${createHash('sha256').update(store.root).digest('hex').slice(0, 16)}-`;
  return !!name && (name.startsWith(oldPrefix) || (name.startsWith(sharedSessionPrefix(store)) && name.length === 20));
}

function neverStarted(store: Store, agent: Agent) {
  if (agent.pid !== undefined) return false;
  try {
    const record = launchRecord(store, agent);
    return record.tabLaunchAttempted === false
      || (record.tabLaunchAttempted === undefined && !!agent.launchError?.startsWith('Launch incomplete during shared task-session readiness;'));
  } catch (error) {
    // Git preflight and artifact creation can fail before a manifest exists.
    // Only recover those recorded phases, never corrupt manifests or a worker
    // with any evidence that a tab or Pi process has started.
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      && (agent.launchError?.startsWith('Launch incomplete during Git preflight;') === true
        || agent.launchError?.startsWith('Launch incomplete during artifacts;') === true)
      && agent.tabId === undefined && agent.paneId === undefined
      && agent.sessionFile === undefined && agent.heartbeatAt === undefined;
  }
}

function saveLaunch(store: Store, agent: Agent, record: Launch) {
  const fd = openSync(artifacts(store, agent).manifest, constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW);
  try { writeFileSync(fd, JSON.stringify(record)); } finally { closeSync(fd); }
}

// Historical Agent.zellijSession values remain unchanged during group recovery.
type RuntimeRegistry = Registry;

function currentSharedSession(store: Store, state: RuntimeRegistry) {
  if (state.sharedSession) {
    requireThat(typeof state.sharedSession.name === 'string' && isSharedSession(store, state.sharedSession.name)
      && Object.hasOwn(state.agents, state.sharedSession.ownerId), 'Invalid shared session reservation');
    return state.sharedSession;
  }
  const previous = Object.values(state.agents).filter(a => isSharedSession(store, a.zellijSession));
  requireThat(new Set(previous.map(a => a.zellijSession)).size <= 1, 'Conflicting shared task-session reservations');
  return previous.length ? { name: previous[0].zellijSession!, ownerId: previous[0].id } : undefined;
}

// A Store root is one orchestration task, including its nested workflow tasks.
// Agent reservations choose the session atomically before any external action.
function reserveSharedSession(store: Store, state: RuntimeRegistry, ownerId: string) {
  // A deliberately closed worker session is never reused; the next spawn creates a fresh one.
  const previous = currentSharedSession(store, state);
  const open = previous && !(previous as { closedAt?: number }).closedAt ? previous : undefined;
  state.sharedSession = open ?? { name: newSharedSession(store), ownerId };
  return { session: state.sharedSession.name, create: !open };
}

type SharedSession = { session: string; ownerId: string; initial: string[]; ready: boolean; chrome?: boolean };

async function recoverUnstartedSession(store: Store, agent: Agent, runner: ProcessRunner): Promise<Agent> {
  const snapshot = store.read();
  const reservation = currentSharedSession(store, snapshot);
  requireThat(reservation, 'Shared session reservation missing');
  if (reservation.name !== agent.zellijSession) {
    requireThat(neverStarted(store, agent), 'Cannot retarget an already-launched worker');
    const record = launchRecord(store, agent);
    agent = update(store, agent, { zellijSession: reservation.name });
    record.session = reservation.name;
    saveLaunch(store, agent, record);
    return prepareSharedSession(store, agent, runner, false);
  }
  requireThat(!(await sessions(runner)).includes(reservation.name), 'Shared session is still active; recovery refused');
  const workers = Object.values(snapshot.agents).filter(a => a.zellijSession === reservation.name);
  requireThat(workers.length > 0, 'Unknown missing session ownership');
  for (const worker of workers) {
    if (neverStarted(store, worker)) continue;
    requireThat(worker.pid !== undefined, 'Cannot prove old worker exited without a PID handshake');
    requireThat(!await pidAlive(worker.pid, runner), 'Old shared-session worker is still live; recovery refused');
  }
  const record = launchRecord(store, agent);
  let create = false;
  agent = store.transact(state => {
    const current = state.agents[agent.id];
    requireThat(current?.generation === agent.generation && neverStarted(store, current), 'Launch changed during recovery');
    const latest = currentSharedSession(store, state);
    requireThat(latest, 'Shared reservation missing');
    if (latest.name === reservation.name) {
      requireThat(Object.values(state.agents).filter(a => a.zellijSession === reservation.name).length === workers.length,
        'Worker joined during session recovery');
      for (const worker of workers) {
        const now = state.agents[worker.id];
        requireThat(now?.generation === worker.generation && now.pid === worker.pid && now.heartbeatAt === worker.heartbeatAt
          && now.zellijSession === worker.zellijSession && (worker.pid !== undefined || neverStarted(store, now)),
          'Worker changed during session recovery');
      }
      (state as RuntimeRegistry).sharedSession = { name: newSharedSession(store), ownerId: current.id };
      create = true;
    } else (state as RuntimeRegistry).sharedSession = latest;
    current.zellijSession = (state as RuntimeRegistry).sharedSession!.name;
    return structuredClone(current);
  });
  record.session = agent.zellijSession!;
  saveLaunch(store, agent, record);
  return prepareSharedSession(store, agent, runner, create);
}

async function prepareSharedSession(store: Store, agent: Agent, runner: ProcessRunner, create: boolean): Promise<Agent> {
  if (!create && currentSharedSession(store, store.read())?.name !== agent.zellijSession) {
    return recoverUnstartedSession(store, agent, runner);
  }
  const directory = join(store.root, 'runtime', 'task-sessions');
  privateDir(directory);
  let path = join(directory, `${agent.zellijSession}.json`);
  const legacyPath = join(store.root, 'runtime', 'shared-session.json');
  if (!create && !exists(path) && exists(legacyPath)) {
    const legacy = JSON.parse(boundedFile(legacyPath).toString('utf8')) as SharedSession;
    if (legacy.session === agent.zellijSession) path = legacyPath;
  }
  if (create) {
    requireThat(!(await sessions(runner, true)).includes(agent.zellijSession!), 'Shared session name already exists without ownership');
    const record: SharedSession = { session: agent.zellijSession!, ownerId: agent.id, initial: [], ready: false, chrome: true };
    writeFileSync(path, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
    await runner('zellij', ['--new-session-with-layout', fileURLToPath(new URL('./worker-layout.kdl', import.meta.url)),
      'attach', '--create-background', agent.zellijSession!]);
    record.initial = (await settledPanes(agent, runner, true)).map(paneIdentity);
    record.ready = true;
    const fd = openSync(path, constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW);
    try { writeFileSync(fd, JSON.stringify(record)); } finally { closeSync(fd); }
    return agent;
  }
  // A concurrent creator may still be performing its Git preflight.
  // A failed creator leaves its reservation/artifacts for explicit recovery.
  for (let attempt = 0; attempt < 300; attempt++) {
    if (exists(path)) {
      let record: SharedSession | undefined;
      try { record = JSON.parse(boundedFile(path).toString('utf8')) as SharedSession; } catch {
        if (attempt === 299) throw new Error('Shared session ownership record unavailable');
      }
      if (record) {
        requireThat(record.session === agent.zellijSession && typeof record.ready === 'boolean'
          && Array.isArray(record.initial) && record.initial.every(v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v))
          && store.read().agents[record.ownerId]?.zellijSession === record.session,
          'Shared session ownership mismatch');
        if (record.ready) {
          if (!(await sessions(runner)).includes(agent.zellijSession!)) return recoverUnstartedSession(store, agent, runner);
          return agent;
        }
      }
    }
    const state = store.read();
    const reservation = currentSharedSession(store, state);
    const creator = reservation && state.agents[reservation.ownerId];
    if (reservation?.name !== agent.zellijSession || creator?.launchError) return recoverUnstartedSession(store, agent, runner);
    await sleep(100);
  }
  throw new Error('Shared task-session creator not ready; inspect retained reservation');
}

async function launch(store: Store, agent: Agent, extensionPath: string, prompt: string, runner: ProcessRunner, resume = false, createSession = false) {
  let phase = 'artifacts';
  try {
    const files = artifacts(store, agent);
    privateDir(join(store.root, 'runtime')); privateDir(files.directory);
    privateDir(join(store.root, 'sessions')); privateDir(agent.sessionDir);
    const snapshot = store.read();
    const task = snapshot.tasks[agent.taskId!];
    const light = profileOf(snapshot) === 'light' && !gated(snapshot, task);
    const ownership = light && agent.role === 'implementer'
      ? (snapshot.agents[agent.parentId!]?.role === 'coordinator'
        ? 'Light profile: you own this task end to end.\nImplement and test here (an isolated Compose project/ports if runtime checks are needed), rebase on latest main, publish your ready result, then verify your own evidence.\nIf release authorization is recorded: claim, open the PR, merge it yourself, and take the deploy lock only while deploying merged main and running a short smoke check.\nKeep a one-line status current with orchestrator_task note; set needsHuman only when you need the human.\nCoordinate overlaps directly with sibling owners. You may split this feature into helpers; helpers cannot spawn agents.\n'
        : 'Light helper: finish your slice and report to your feature owner. You cannot spawn agents or release.\n')
      : 'A result is not verification, approval, or deployment authorization.\n';
    // Spawned workers read the short worker reference from this package, wherever their repository is.
    const guide = join(dirname(dirname(extensionPath)), 'skills', 'orchestrate-work', 'references', 'worker.md');
    const workerGuide = `Read ${guide} from the orchestrator package before starting. It replaces orchestrate-work/SKILL.md and its coordinator references for spawned workers; follow its conditional release/recovery links only when needed.\nRecord routine progress with orchestrator_task note, not an inbox message. Message questions or blockers that need action.\n`;
    const body = `Agent: ${agent.id}\nParent: ${agent.parentId}\nTask: ${task.id}\nRole: ${agent.role}\nGeneration: ${agent.generation}\nPlan: ${task.planPath}\nPlan hash: ${task.planHash}\nDependencies: ${task.dependencies.join(', ')}\nWorktree: ${agent.worktree}\n\n${workerGuide}Stay within this task and role.\nPlanner/reviewer roles have no repository write authorization. Their bash is not a sandbox: use it only for read-only Git inspection and task-relevant tests in your own worktree. Disclose any tracked changes tests generate; never reset, clean or fix them. Source edits, destructive commands, dependency installation, credential changes and release actions stay unauthorized.\nOn your own ships: false task, start it and publish your result with orchestrator_task result reportText (the runtime stores it under the run); keep a one-line note current. Otherwise report an existing absolute report path and commit/evidence to your parent.\n${ownership}Before correcting your ready or verified task, call orchestrator_task start to record rework as implementing; publish the corrected result when done and obtain fresh verification before release. Existing release freezes still apply.\nDo not restart yourself or infer approval from marker files.\n${resume ? 'This is a resumed generation. Old-generation messages were not retargeted; ask the parent to resend them.\n' : ''}\n${prompt}\n`;
    requireThat(Buffer.byteLength(body) <= 16 * 1024, 'Task prompt including runtime instructions exceeds the inbox limit');
    writeFileSync(files.prompt, body, { flag: 'wx', mode: 0o600 });
    // Persist a harmless assistant response before the parent can verify the transcript.
    // Never put task instructions (including resume's continuation) in startup argv.
    writeFileSync(files.bootstrap, 'Orchestrator startup check only. Reply "Waiting for verified launch." and stop.\nDo not use tools, inspect the task, or continue previous work.\nThe task will arrive through the inbox only after the parent verifies your Pi pane and handshake.\n', { flag: 'wx', mode: 0o600 });
    const [provider, model] = modelParts(agent.model);
    // Older worker records with no thinking field launched at medium.
    const argv = ['--approve', '--provider', provider, '--model', model, '--thinking', agent.thinking ?? 'medium',
      '--extension', extensionPath, '--session-dir', agent.sessionDir,
      ...(resume ? ['--session', agent.sessionFile!] : ['--session-id', agent.piSessionId]),
      '--orchestrator-root', store.root, '--orchestrator-agent', agent.id, '--orchestrator-generation', agent.generation,
      ...(agent.role === 'planner' || agent.role === 'reviewer' ? ['--tools', 'read,bash,grep,find,ls,orchestrator_status,orchestrator_message,orchestrator_agent,orchestrator_task,ask_user'] : []),
      `@${files.bootstrap}`];
    const record: Launch = { generation: agent.generation, session: agent.zellijSession!, argv, createdAt: Date.now(), identity: identity(agent), tabLaunchAttempted: false,
      taskMessageId: randomUUID(), promptHash: createHash('sha256').update(body).digest('hex') };
    writeFileSync(files.manifest, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
    phase = 'shared task-session readiness';
    agent = await prepareSharedSession(store, agent, runner, createSession);
    record.session = agent.zellijSession!;
    phase = 'tab creation';
    // Authorization may have changed while Git/Zellij were running.
    store.transact(state => authorized(state, agent.parentId!, agent.taskId!, agent.role));
    record.tabLaunchAttempted = true;
    saveLaunch(store, agent, record);
    const { stdout } = await runner('zellij', ['--session', agent.zellijSession!, 'action', 'new-tab', '--name', agent.id,
      '--cwd', agent.worktree, '--', 'pi', ...argv]);
    requireThat(/^\d+\s*$/.test(stdout), 'Missing created tab ID');
    agent = update(store, agent, { tabId: Number(stdout.trim()) });
    phase = 'tab chrome identity';
    const sessionPath = join(store.root, 'runtime', 'task-sessions', `${agent.zellijSession}.json`);
    const expectChrome = exists(sessionPath) && (JSON.parse(boundedFile(sessionPath).toString('utf8')) as SharedSession).chrome === true;
    const inventory = await settledPanes(agent, runner, expectChrome, agent.tabId);
    matchingPane(agent, record, inventory);
    // Capture only the bundled bars during launch, never adopt plugins later at cleanup.
    record.tabChrome = inventory.filter(isChrome).map(paneIdentity);
    saveLaunch(store, agent, record);
    phase = 'startup identity/handshake';
    const observed = (await inspectAgent(store, agent.id, runner)).agent;
    return observed.lifecycle === 'starting'
      ? update(store, observed, { launchError: 'Launch incomplete during startup identity/handshake; task withheld. Await verified inspection.' })
      : observed;
  } catch (error) {
    // The artifacts phase runs only local filesystem checks and writes, never external commands,
    // so its message (for example a non-private runtime directory) is safe to record.
    // Later phases may carry command output and stay generic.
    const cause = phase === 'artifacts' && error instanceof Error
      ? ` Cause: ${error.message.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 300)}` : '';
    return update(store, agent, { launchError: `Launch incomplete during ${phase}; artifacts retained. Inspect before retrying.${cause}` });
  }
}

// Worktrees default to one shared directory so they never pile up beside the repository.
export const WORKTREE_ROOT = join(homedir(), '.local', 'share', 'pi-orchestrator', 'worktrees');
export const WORKTREE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export function defaultWorktree(repo: string, agentId: string, root = WORKTREE_ROOT): string {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return join(root, `${basename(repo)}-${agentId}-${randomUUID().slice(0, 8)}`);
}

function mtime(path: string): number {
  try { return lstatSync(path).mtimeMs; } catch { return 0; }
}

// Latest sign of life: the directory itself, Git's per-worktree index/HEAD/reflog, and any dirty file.
async function lastActivity(worktree: string, runner: ProcessRunner): Promise<number> {
  let latest = mtime(worktree);
  // No optional locks: a status refresh must not rewrite the index and reset the clock it measures.
  const git = (args: string[]) => runner('git', ['--no-optional-locks', '-C', worktree, ...args], { timeout: 10_000 });
  try {
    if ((await git(['rev-parse', '--show-toplevel'])).stdout.trim() !== worktree) return latest;
    const admin = (await git(['rev-parse', '--absolute-git-dir'])).stdout.trim();
    for (const file of ['index', 'HEAD', join('logs', 'HEAD')]) latest = Math.max(latest, mtime(join(admin, file)));
    const { stdout } = await git(['status', '--porcelain', '-z', '--untracked-files=all']);
    for (const entry of stdout.split('\0').filter(Boolean).slice(0, 1000)) latest = Math.max(latest, mtime(join(worktree, entry.slice(3))));
  } catch { /* Broken worktrees fall back to the directory mtime. */ }
  return latest;
}

// Deletes worktrees (and their local branches) with no activity for maxAge, merged or not.
// Worktrees of live agents are always kept.
export async function pruneWorktrees(keep: string[], runner: ProcessRunner = run, now = Date.now(), root = WORKTREE_ROOT, maxAge = WORKTREE_MAX_AGE_MS): Promise<string[]> {
  let names: string[];
  try { names = readdirSync(root); } catch { return []; }
  const removed: string[] = [];
  for (const name of names) {
    const worktree = join(root, name);
    try {
      if (!lstatSync(worktree).isDirectory() || keep.some((path) => within(worktree, path))) continue;
      if (now - await lastActivity(worktree, runner) < maxAge) continue;
      const git = (args: string[]) => runner('git', ['-C', worktree, ...args], { timeout: 10_000 });
      let repo: string | undefined, branch: string | undefined;
      // Only trust Git answers from the worktree itself, never from an enclosing repository.
      const top = await git(['rev-parse', '--show-toplevel']).then((r) => r.stdout.trim(), () => '');
      if (top === worktree) try { repo = dirname((await git(['rev-parse', '--path-format=absolute', '--git-common-dir'])).stdout.trim()); } catch { /* Repository gone. */ }
      if (repo) try { branch = (await git(['symbolic-ref', '--short', '-q', 'HEAD'])).stdout.trim() || undefined; } catch { /* Detached. */ }
      if (repo) {
        try { await runner('git', ['-C', repo, 'worktree', 'remove', '--force', '--force', worktree], { timeout: 60_000 }); } catch { /* Fall back to rm below. */ }
      }
      rmSync(worktree, { recursive: true, force: true });
      if (repo) {
        await runner('git', ['-C', repo, 'worktree', 'prune'], { timeout: 30_000 }).catch(() => undefined);
        if (branch) await runner('git', ['-C', repo, 'branch', '-D', '--end-of-options', branch], { timeout: 10_000 }).catch(() => undefined);
      }
      removed.push(branch ? `${worktree} (${branch})` : worktree);
    } catch { /* Leave anything we cannot inspect. */ }
  }
  return removed;
}

export async function spawnAgent(store: Store, parentId: string, input: SpawnInput, extensionPath: string,
  runner: ProcessRunner = run, parentModel?: string, agentDir?: string): Promise<Agent> {
  id(input.id);
  requireThat(input.taskId !== undefined, 'spawn requires taskId. Supply a registered task ID.');
  id(input.taskId);
  requireThat(input.repo !== undefined, 'spawn requires repo. Supply the absolute path to the primary Git checkout.');
  safePath(store.root); safePath(input.repo); safePath(input.worktree, false); safePath(extensionPath);
  requireThat(lstatSync(input.repo).isDirectory() && lstatSync(extensionPath).isFile(), 'Repository/extension paths invalid');
  safePath(join(input.repo, '.git'));
  requireThat(lstatSync(join(input.repo, '.git')).isDirectory(), 'Source must be a primary non-bare repository checkout');
  requireThat(!exists(input.worktree) && exists(dirname(input.worktree)) && !within(input.repo, input.worktree), 'Worktree must be a new external path');
  requireThat(typeof input.base === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_./~-]{0,199}$/.test(input.base), 'spawn requires a valid base. Use HEAD, a branch, or a commit SHA.');
  requireThat(typeof input.branch === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_./-]{0,199}$/.test(input.branch), 'spawn requires a new branch name. Use a Git branch name such as agents/worker.');
  requireThat(typeof input.prompt === 'string' && Buffer.byteLength(input.prompt) <= 16 * 1024, 'spawn requires prompt text of at most 16 KiB.');
  const generation = randomUUID();
  let createSession = false;
  let agent = store.transact(state => {
    authorized(state, parentId, input.taskId, input.role);
    const request = state.tasks[input.taskId]?.requestGrant;
    if (request) requireThat(request.scope.repoPath === input.repo, 'Repository differs from confirmed request');
    requireThat(!state.agents[input.id], 'Agent ID already reserved; inspect retained launch record');
    for (const existing of Object.values(state.agents)) {
      // A coordinator may start outside Git;
      // its working directory is not then a reserved worktree.
      const reservesWorktree = existing.role !== 'coordinator' || exists(join(existing.worktree, '.git'));
      requireThat((!reservesWorktree || (!within(existing.worktree, input.worktree) && !within(input.worktree, existing.worktree)))
        && !(existing.repo === input.repo && existing.branch === input.branch), 'Worktree/branch already reserved');
      if (existing.taskId === input.taskId && existing.launchError && neverStarted(store, existing)) existing.lifecycle = 'exited';
      requireThat(existing.taskId !== input.taskId || ['exited', 'collected', 'closed'].includes(existing.lifecycle), 'Task already has a live agent');
    }
    if (profileOf(state) === 'light') {
      // Flat fan-out: owners may split their feature into helpers, and helpers recruit nobody.
      const parent = state.agents[parentId];
      if (parent.role !== 'coordinator') {
        requireThat(parent.parentId !== undefined && state.agents[parent.parentId]?.role === 'coordinator', 'Light helpers cannot spawn agents; ask the feature owner');
      }
    }
    // Each orchestrator (registry) runs a bounded number of live subagents, helpers included.
    const live = Object.values(state.agents).filter((a) => a.role !== 'coordinator' && !['exited', 'collected', 'closed'].includes(a.lifecycle)).length;
    requireThat(live < LIMITS.agents, `An orchestrator runs at most ${LIMITS.agents} subagents at once; ship, collect or close one first`);
    const model = input.model ?? parentModel ?? state.agents[parentId].model;
    const thinking = launchThinking(model, input.thinking, agentDir);
    const shared = reserveSharedSession(store, state, input.id);
    createSession = shared.create;
    const agent: Agent = { id: input.id, parentId, taskId: input.taskId, role: input.role, model, thinking, generation,
      lifecycle: 'starting', repo: input.repo, base: input.base, branch: input.branch, worktree: input.worktree,
      sessionDir: join(store.root, 'sessions', input.id), piSessionId: randomUUID(), zellijSession: shared.session };
    state.agents[input.id] = agent;
    return structuredClone(agent);
  });
  let phase = 'model availability';
  try {
    await availableModel(runner, agent.model);
    phase = 'Git preflight';
    const git = (args: string[]) => runner('git', args, { cwd: input.repo });
    const { stdout: top } = await git(['rev-parse', '--show-toplevel']);
    requireThat(top.trim() === input.repo, 'Repository must be its checkout root');
    await git(['check-ref-format', '--branch', input.branch]);
    const { stdout: base } = await git(['rev-parse', '--verify', '--end-of-options', `${input.base}^{commit}`]);
    requireThat(/^[a-f0-9]{40,64}$/.test(base.trim()), 'Base did not resolve to a commit');
    const { stdout: branches } = await git(['for-each-ref', '--format=%(refname)', `refs/heads/${input.branch}`]);
    requireThat(!branches.trim(), 'Branch already exists');
    const { stdout: worktrees } = await git(['worktree', 'list', '--porcelain', '-z']);
    requireThat(!worktrees.split('\0').includes(`worktree ${input.worktree}`), 'Worktree already registered');
    requireThat(!exists(input.worktree), 'Worktree destination appeared during preflight');
    phase = 'worktree creation';
    await git(['worktree', 'add', '-b', input.branch, input.worktree, base.trim()]);
    phase = 'worktree validation';
    safePath(input.worktree); safePath(join(input.worktree, '.git'));
    requireThat(lstatSync(join(input.worktree, '.git')).isFile(), 'Dedicated linked worktree required');
    const { stdout: worktreeTop } = await runner('git', ['rev-parse', '--show-toplevel'], { cwd: input.worktree });
    const { stdout: worktreeDirty } = await runner('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: input.worktree });
    requireThat(worktreeTop.trim() === input.worktree && !worktreeDirty.trim(), 'New worktree is not clean or has unexpected identity');
    agent = update(store, agent, { base: base.trim() });
  } catch {
    return update(store, agent, { launchError: `Launch incomplete during ${phase}; reservation retained. Required model: ${agent.model}. No rollback or model substitution performed.` });
  }
  return launch(store, agent, extensionPath, input.prompt, runner, false, createSession);
}

export async function inspectAgent(store: Store, agentId: string, runner: ProcessRunner = run): Promise<{ agent: Agent; observation: string; screen?: string }> {
  let agent = agentFrom(store, agentId);
  requireThat(agent.role !== 'coordinator', 'Cannot inspect a coordinator as a worker; use orchestrator_status for coordinator metadata');
  const generation = agent.generation;
  if (agent.lifecycle === 'closed') return { agent, observation: 'closed; artifacts preserved' };
  try {
    const record = launchRecord(store, agent);
    if (!(await observing(sessions(runner))).includes(agent.zellijSession!)) {
      requireThat(!await observing(pidAlive(agent.pid, runner)), 'Session absent but worker PID remains live');
      agent = update(store, agent, { lifecycle: agent.collectedReport ? 'collected' : 'exited' });
      return { agent, observation: 'exited; dedicated session absent and no live recorded PID' };
    }
    const inventory = await observing(panes(agent, runner));
    const pane = matchingPane(agent, record, inventory);
    if (record.taskMessageId) {
      const sessionPath = join(store.root, 'runtime', 'task-sessions', `${agent.zellijSession}.json`);
      const expectChrome = exists(sessionPath) && (JSON.parse(boundedFile(sessionPath).toString('utf8')) as SharedSession).chrome === true;
      observable(!expectChrome || ['zellij:tab-bar', 'zellij:status-bar'].every(url =>
        inventory.filter(p => p.tab_id === pane.tab_id && isChrome(p) && p.plugin_url === url).length === 1), 'Worker tab chrome incomplete');
    }
    agent = update(store, agent, { tabId: pane.tab_id, paneId: `terminal_${pane.id}` });
    if (pane.exited) {
      requireThat(!await observing(pidAlive(agent.pid, runner)), 'Exited pane still has a live recorded PID');
      agent = update(store, agent, { lifecycle: agent.collectedReport ? 'collected' : 'exited' });
      return { agent, observation: 'exited; owned pane reports process exit' };
    }
    observable(!pane.is_suppressed
      && (pane.pane_content_rows === undefined || pane.pane_content_rows > 0)
      && (pane.pane_content_columns === undefined || pane.pane_content_columns > 0), 'Worker terminal has no visible viewport');
    observable(/(?:π|\bpi\b)/i.test(pane.title), 'Pi title not yet visible');
    const { stdout } = await observing(runner('zellij', ['--session', agent.zellijSession!, 'action', 'dump-screen', '--pane-id', agent.paneId!]));
    const screen = stdout.slice(0, 32 * 1024);
    // Narrow detached panes truncate Pi's footer and scroll its header away,
    // so also accept the truncated model name or the footer's context gauge.
    observable(/(?:π|\bpi\b|gpt-6-a|\d+(?:\.\d+)?%\/\d+k)/i.test(screen), 'Pi TUI not yet visible');
    agent = agentFrom(store, agentId);
    requireThat(agent.generation === record.generation, 'Generation changed during inspection');
    transcript(agent);
    requireThat(agent.pid && agent.heartbeatAt && agent.heartbeatAt >= record.createdAt
      && agent.heartbeatAt <= Date.now() + 5_000, 'Worker handshake pending');
    if (!await observing(pidAlive(agent.pid, runner))) {
      agent = update(store, agent, { lifecycle: agent.collectedReport ? 'collected' : 'exited' });
      return { agent, observation: 'exited; recorded worker PID no longer exists', screen };
    }
    if (Date.now() - agent.heartbeatAt > STALE_MS) return { agent, observation: 'unresponsive; heartbeat stale, no restart attempted', screen };
    const body = record.taskMessageId ? boundedFile(artifacts(store, agent).prompt, 16 * 1024).toString('utf8') : undefined;
    requireThat(body === undefined || createHash('sha256').update(body).digest('hex') === record.promptHash, 'Task prompt changed after launch');
    // Readiness and the one generation-bound task intent commit together.
    // Repeated/concurrent inspections cannot enqueue a second task message.
    agent = store.transact(state => {
      const current = state.agents[agent.id];
      requireThat(current?.generation === record.generation && current.pid === agent.pid
        && current.sessionFile === agent.sessionFile && current.tabId === pane.tab_id && current.paneId === `terminal_${pane.id}`
        && JSON.stringify(identity(current)) === JSON.stringify(record.identity)
        && !['exited', 'collected', 'closed'].includes(current.lifecycle), 'Worker changed during inspection');
      if (record.taskMessageId && body !== undefined) {
        const existing = state.messages.find(m => m.id === record.taskMessageId);
        if (existing) requireThat(existing.to === current.id && existing.generation === current.generation
          && existing.from === current.parentId && existing.body === body && existing.kind === 'message'
          && existing.mode === 'followUp', 'Task delivery identity mismatch');
        else {
          authorized(state, current.parentId!, current.taskId!, current.role);
          state.messages.push({ id: record.taskMessageId, from: current.parentId!, to: current.id,
            generation: current.generation, kind: 'message', mode: 'followUp', body, createdAt: Date.now() });
        }
      }
      // An idle worker only becomes reachable now, so its idle clock starts at (re-)verification.
      if (current.lifecycle !== 'running' && current.activity === 'idle') current.activityAt = Date.now();
      Object.assign(current, { lifecycle: 'running', launchError: undefined });
      return structuredClone(current);
    });
    const resumed = record.argv.includes('--session') ? '; resumed generation: old messages were not retargeted, resend explicitly' : '';
    return { agent, observation: `running; owned Pi pane and current-generation handshake verified${resumed}`, screen };
  } catch (error) {
    agent = agentFrom(store, agentId);
    if (agent.generation === generation && agent.lifecycle === 'running') {
      if (error instanceof Unobserved && !agent.launchError && agent.heartbeatAt !== undefined
        && Date.now() - agent.heartbeatAt <= STALE_MS) {
        return { agent, observation: 'running; readiness retained on a fresh current-generation heartbeat, but the owned pane was not observable this time' };
      }
      agent = update(store, agent, { lifecycle: 'starting', launchError: 'Launch incomplete during startup identity/handshake; task withheld. Await verified inspection.' });
    }
    const stale = agent.heartbeatAt && Date.now() - agent.heartbeatAt > STALE_MS;
    return { agent, observation: stale ? 'unresponsive; heartbeat stale and process identity unverified' : 'unverified; startup/ownership/handshake pending', };
  }
}

// Takes the human to a worker's own pane after verifying it is still the owned one.
export async function goToAgent(store: Store, agentId: string, how: 'window' | 'switch', currentSession?: string, runner: ProcessRunner = run): Promise<string> {
  const agent = agentFrom(store, agentId);
  requireThat(['registered', 'starting', 'running'].includes(agent.lifecycle), `${agent.id} is ${agent.lifecycle}; it has no live tab`);
  const pane = matchingPane(agent, launchRecord(store, agent), await panes(agent, runner));
  requireThat(!pane.exited, `${agent.id}'s pane has exited`);
  return goToPane(agent.zellijSession!, pane, how, currentSession, runner);
}

// Takes the human from a worker back to the coordinator's pane in their own session.
// The pane is the one the coordinator recorded on attach, and its process must still be live.
export async function goToCoordinator(store: Store, currentSession?: string, runner: ProcessRunner = run): Promise<string> {
  const coordinator = Object.values(store.read().agents).find((a) => a.role === 'coordinator' && a.lifecycle === 'running');
  requireThat(coordinator?.homeSession && coordinator.homePaneId, 'The coordinator recorded no Zellij pane; reattach it inside Zellij');
  requireThat(await pidAlive(coordinator.pid, runner), 'The coordinator process is not running');
  requireThat((await sessions(runner)).includes(coordinator.homeSession), `The coordinator's session ${coordinator.homeSession} is gone`);
  const { stdout } = await runner('zellij', ['--session', coordinator.homeSession, 'action', 'list-panes', '--json', '--all']);
  requireThat(stdout.length <= OUTPUT_LIMIT, 'Pane output too large');
  const values = JSON.parse(stdout) as Pane[];
  const pane = Array.isArray(values) ? values.find((p) => !p.is_plugin && `terminal_${p.id}` === coordinator.homePaneId) : undefined;
  requireThat(pane && !pane.exited, "The coordinator's pane is gone");
  return goToPane(coordinator.homeSession, pane, 'switch', currentSession, runner);
}

// Zellij runs CLI actions as the client that sent the last keystroke: the human pressing a board key.
// In the current session this switches tab; otherwise 'window' opens a new Ghostty window
// attached to the session and 'switch' moves this window to it.
async function goToPane(session: string, pane: Pane, how: 'window' | 'switch', currentSession: string | undefined, runner: ProcessRunner): Promise<string> {
  const target = `${session} › ${pane.tab_name}`;
  const focus = async (prefix: string[]) => {
    await runner('zellij', [...prefix, 'action', 'go-to-tab-by-id', String(pane.tab_id)]);
    await runner('zellij', [...prefix, 'action', 'focus-pane-id', `terminal_${pane.id}`]);
  };
  if (session === currentSession) { await focus([]); return `Switched to tab ${pane.tab_name}.`; }
  if (how === 'switch') {
    requireThat(Number.isSafeInteger(pane.tab_position), 'Tab position unknown; use g for a new window');
    await runner('zellij', ['action', 'switch-session', session, '--tab-position', String(pane.tab_position), '--pane-id', `terminal_${pane.id}`]);
    return `Switched this window to ${target}. Return with the session manager (Ctrl+s, w).`;
  }
  const clients = async () => (await runner('zellij', ['--session', session, 'action', 'list-clients'])).stdout
    .split('\n').filter((line) => /^\d+\s/.test(line)).length;
  const before = await clients();
  await runner('open', ['-na', 'Ghostty', '--args', '-e', 'zellij', 'attach', session]);
  // The tab can only be chosen once the new window's client has attached.
  for (let i = 0; i < 40 && (await clients()) <= before; i++) await sleep(250);
  await focus(['--session', session]);
  return `Opened ${target} in a new Ghostty window.`;
}

export async function resumeAgent(store: Store, parentId: string, agentId: string, extensionPath: string, runner: ProcessRunner = run): Promise<Agent> {
  let agent = agentFrom(store, agentId);
  safePath(extensionPath);
  requireThat(lstatSync(extensionPath).isFile(), 'Extension must be a file');
  owned(store.read(), parentId, agentId);
  transcript(agent);
  const previous = launchRecord(store, agent);
  requireThat(isSharedSession(store, agent.zellijSession), 'Legacy dedicated sessions require explicit migration; resume refused');
  requireThat(!await pidAlive(agent.pid, runner), 'Original worker is still live; clean shutdown required');
  const activeSessions = await sessions(runner);
  if (activeSessions.includes(agent.zellijSession!)) {
    const inventory = await panes(agent, runner);
    const previousPane = inventory.find(p => !p.is_plugin && `terminal_${p.id}` === agent.paneId);
    if (previousPane) {
      requireThat(matchingPane(agent, previous, inventory) === previousPane && previousPane.exited,
        'Original worker pane is still live or has uncertain identity');
    } else {
      requireThat(!inventory.some(p => !p.is_plugin && p.terminal_command === ['pi', ...previous.argv].join(' ')),
        'Original command still has a pane; resume refused');
    }
  }
  const snapshot = store.read();
  const reservation = currentSharedSession(store, snapshot);
  requireThat(reservation, 'Shared session reservation missing');
  const recover = !activeSessions.includes(reservation.name) && reservation.name === agent.zellijSession;
  const oldWorkers = Object.values(snapshot.agents).filter(a => a.zellijSession === reservation.name);
  if (recover) {
    requireThat(oldWorkers.length > 0, 'Cannot prove ownership of missing shared session');
    for (const worker of oldWorkers) {
      if (neverStarted(store, worker)) continue;
      requireThat(worker.pid !== undefined, 'Cannot prove old worker exited without a PID handshake');
      requireThat(!await pidAlive(worker.pid, runner), 'Old shared-session worker is still live; recovery refused');
    }
  }
  await availableModel(runner, agent.model);
  safePath(agent.worktree);
  const { stdout: branch } = await runner('git', ['branch', '--show-current'], { cwd: agent.worktree });
  requireThat(branch.trim() === agent.branch, 'Original branch/worktree identity changed');
  const { stdout: top } = await runner('git', ['rev-parse', '--show-toplevel'], { cwd: agent.worktree });
  requireThat(top.trim() === agent.worktree, 'Original worktree identity changed');
  let createSession = false;
  agent = store.transact(state => {
    const current = owned(state, parentId, agentId);
    requireThat(current.generation === agent.generation && current.sessionFile === agent.sessionFile, 'Concurrent resume or transcript change');
    authorized(state, current.parentId!, current.taskId!, current.role);
    for (const other of Object.values(state.agents)) {
      if (other.id !== current.id) requireThat(other.sessionFile !== current.sessionFile
        && !within(other.sessionDir, current.sessionDir) && !within(current.sessionDir, other.sessionDir), 'Shared transcript writer refused');
      if (other.id !== current.id && other.taskId === current.taskId) requireThat(['exited', 'collected', 'closed'].includes(other.lifecycle), 'Task already has a live agent');
    }
    const latest = currentSharedSession(store, state);
    requireThat(latest, 'Shared session reservation changed');
    if (recover && latest.name === reservation.name) {
      for (const worker of oldWorkers) {
        const now = state.agents[worker.id];
        requireThat(now?.generation === worker.generation && now.pid === worker.pid
          && now.zellijSession === worker.zellijSession && now.heartbeatAt === worker.heartbeatAt
          && (worker.pid !== undefined || neverStarted(store, now)),
          'Worker changed during shared-session recovery');
      }
      const currentWorkers = Object.values(state.agents).filter(a => a.zellijSession === reservation.name);
      requireThat(currentWorkers.length === oldWorkers.length, 'Worker joined during shared-session recovery');
      (state as RuntimeRegistry).sharedSession = { name: newSharedSession(store), ownerId: current.id };
      createSession = true;
    } else {
      (state as RuntimeRegistry).sharedSession = latest;
    }
    current.zellijSession = (state as RuntimeRegistry).sharedSession!.name;
    current.generation = randomUUID();
    current.lifecycle = 'starting';
    current.tabId = undefined; current.paneId = undefined; current.pid = undefined;
    current.heartbeatAt = undefined; current.activity = undefined; current.progressAt = undefined; current.currentTool = undefined; current.collectedReport = undefined; current.launchError = undefined;
    return structuredClone(current);
  });
  return launch(store, agent, extensionPath, 'Continue the original task under its current approved permissions.', runner, true, createSession);
}

export function collectAgent(store: Store, parentId: string, agentId: string, report: string): Agent {
  requireThat(report !== undefined, 'collect requires report. Supply an existing report file with an absolute path.');
  boundedFile(report);
  return store.transact(state => {
    const agent = owned(state, parentId, agentId);
    requireThat(agent.lifecycle !== 'closed', 'Closed agent cannot be collected');
    agent.collectedReport = report;
    // Collection must not disable the live worker's shutdown mailbox.
    if (agent.lifecycle === 'exited') agent.lifecycle = 'collected';
    return structuredClone(agent);
  });
}

// Close is the bookkeeping step after a worker has stopped.
// Worker sessions are disposable, so a worker that is provably gone
// (dead PID, plus an absent session, an absent tab, or no launch at all) closes without a Zellij action.
export async function closeAgent(store: Store, parentId: string, agentId: string, runner: ProcessRunner = run): Promise<Agent> {
  let agent = agentFrom(store, agentId);
  owned(store.read(), parentId, agentId);
  requireThat(agent.collectedReport, 'Collect an existing report before closing');
  if (agent.lifecycle === 'closed') return agent;
  requireThat(!await pidAlive(agent.pid, runner), 'Worker PID is live; use retire, or request clean shutdown through mailbox first');
  // A generation fence prevents a concurrent resume from changing our target.
  const fence = () => store.transact(state => {
    const current = owned(state, parentId, agentId);
    requireThat(current.generation === agent.generation && current.collectedReport, 'Agent changed during cleanup');
  });
  const finish = () => { fence(); return update(store, agent, { lifecycle: 'closed' }); };
  if (!exists(artifacts(store, agent).manifest)) {
    requireThat(agent.pid === undefined && agent.heartbeatAt === undefined, 'Launch record missing for a worker that started');
    return finish();
  }
  const record = launchRecord(store, agent);
  if (!agent.zellijSession || !(await sessions(runner)).includes(agent.zellijSession)) return finish();
  const values = await panes(agent, runner);
  const inTab = (p: Pane) => (agent.tabId !== undefined && p.tab_id === agent.tabId) || p.tab_name === agent.id;
  if (!values.some(p => !p.is_plugin && inTab(p))) {
    // Pi's pane is gone. A tab left holding only plugins (bars, Session Manager) is still ours to close.
    const leftover = values.find(p => p.is_plugin && agent.tabId !== undefined && p.tab_id === agent.tabId && p.tab_name === agent.id);
    if (leftover) { fence(); await runner('zellij', ['--session', agent.zellijSession, 'action', 'close-tab', '--tab-id', String(leftover.tab_id)]); }
    return finish();
  }
  const pane = matchingPane(agent, record, values);
  requireThat(pane.exited, 'Worker pane must have exited; busy/unverified workers cannot be closed');
  // Anything else in the tab (Session Manager, a shell the human opened) goes with it,
  // except another open agent's pane.
  // Zellij numbers plugin and terminal panes separately, so only terminal panes can be an agent's.
  const others = Object.values(store.read().agents)
    .filter(a => a.id !== agent.id && a.lifecycle !== 'closed' && a.zellijSession === agent.zellijSession && a.paneId);
  requireThat(!values.some(p => !p.is_plugin && p.tab_id === pane.tab_id && p.id !== pane.id && others.some(a => a.paneId === `terminal_${p.id}`)),
    'Another agent\'s pane is in this tab; refusing tab cleanup');
  fence();
  await runner('zellij', ['--session', agent.zellijSession, 'action', 'close-tab', '--tab-id', String(pane.tab_id)]);
  if ((await sessions(runner)).includes(agent.zellijSession)) {
    const after = await panes(agent, runner);
    requireThat(!after.some(p => p.tab_id === pane.tab_id), 'Owned tab cleanup not confirmed');
  }
  return finish();
}

const RETIRE_WAIT_MS = 60_000;

// One idempotent step from a live worker to a closed one:
// durable shutdown, bounded wait for exit, collection, then close.
// A busy worker is a status to retry later, not an error.
export async function retireAgent(store: Store, parentId: string, agentId: string, report?: string, runner: ProcessRunner = run,
  waitMs = RETIRE_WAIT_MS, pollMs = 1_000): Promise<{ agent: Agent; observation: string }> {
  let agent = agentFrom(store, agentId);
  owned(store.read(), parentId, agentId);
  if (agent.lifecycle === 'closed') return { agent, observation: 'already closed' };
  if (await pidAlive(agent.pid, runner)) {
    const state = store.read();
    const queued = state.messages.some(m => m.to === agentId && m.generation === agent.generation && m.kind === 'shutdown' && m.acknowledgedAt === undefined);
    if (!queued) sendMessage(store, parentId, agentId, 'Retire: finish your current turn and stop. Record any result first.', 'followUp', 'shutdown');
    for (const start = Date.now(); await pidAlive(agent.pid, runner);) {
      if (Date.now() - start >= waitMs) return { agent, observation: 'shutdown requested; worker is still mid-turn. Call retire again later.' };
      await sleep(pollMs);
    }
  }
  agent = agentFrom(store, agentId);
  if (!agent.collectedReport) {
    const path = report ?? (agent.taskId ? store.read().tasks[agent.taskId]?.result?.report : undefined);
    requireThat(path, 'Worker stopped, but there is no report to collect: pass report, or record a task result first');
    collectAgent(store, parentId, agentId, path);
  }
  agent = await closeAgent(store, parentId, agentId, runner);
  const open = Object.values(store.read().agents).filter(a => a.zellijSession === agent.zellijSession && a.lifecycle !== 'closed');
  const session = currentSharedSession(store, store.read());
  const last = !open.length && session?.name === agent.zellijSession && !(session as { closedAt?: number }).closedAt;
  return { agent, observation: last ? `closed; it was the last agent in ${agent.zellijSession}` : 'closed' };
}

// Close this orchestrator's detached worker session once every agent in it is closed.
// Only panes from the session's initial layout may remain; anything else is left for the human.
export async function closeTaskSession(store: Store, coordinatorId: string, name: string, runner: ProcessRunner = run): Promise<{ session: string; observation: string }> {
  id(coordinatorId);
  const state = store.read();
  requireThat(Object.hasOwn(state.agents, coordinatorId) && state.agents[coordinatorId].role === 'coordinator', 'Only the coordinator closes its worker session');
  const shared = currentSharedSession(store, state);
  requireThat(shared && shared.name === name, "Not this orchestrator's worker session");
  if ((shared as { closedAt?: number }).closedAt) return { session: name, observation: 'already closed' };
  const open = Object.values(state.agents).filter((a) => a.zellijSession === name && a.lifecycle !== 'closed');
  requireThat(!open.length, `Retire every agent first: ${open.map((a) => a.id).join(', ')}`);
  // The registry's reservation proves ownership; worker sessions are disposable,
  // so panes added later (Session Manager, a human's shell) go with the session.
  let observation = 'session already absent';
  if ((await sessions(runner)).includes(name)) {
    await runner('zellij', ['kill-session', name]);
    observation = 'killed';
  }
  // Remove the resurrectable EXITED entry too.
  try { await runner('zellij', ['delete-session', name]); } catch { /* Already removed. */ }
  store.transact((next) => {
    const current = currentSharedSession(store, next)!;
    next.sharedSession = { name: current.name, ownerId: current.ownerId, closedAt: Date.now() };
  });
  return { session: name, observation };
}

export type ForkInput = { name: string; request: string; repo?: string; profile?: Profile; model?: string; thinking?: SpawnInput['thinking'] };

// Start an independent orchestrator as a new tab in the human's Zellij session.
// It gets its own registry, coordinator and worker session, and never reports back:
// the human talks to it directly. The parent records only a pointer.
// Family members share one deploy lock and can read each other's boards.
export async function forkOrchestrator(store: Store, coordinatorId: string, input: ForkInput, extensionPath: string,
  session: string | undefined, runner: ProcessRunner = run, parentModel?: string, agentDir?: string): Promise<Fork> {
  id(coordinatorId); id(input.name);
  requireThat(typeof input.request === 'string' && input.request.trim() && Buffer.byteLength(input.request) <= 16 * 1024, 'Fork request must be 1 byte to 16 KiB');
  requireThat(typeof session === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(session), 'Forks open as a tab in your Zellij session; this Pi is not running inside Zellij');
  const state = store.read();
  const coordinator = state.agents[coordinatorId];
  requireThat(Object.hasOwn(state.agents, coordinatorId) && coordinator.role === 'coordinator', 'Only a coordinator can fork');
  const selectedModel = input.model ?? parentModel ?? coordinator.model;
  const [provider, model] = modelParts(selectedModel);
  const thinking = launchThinking(selectedModel, input.thinking, agentDir);
  await availableModel(runner, selectedModel);
  const profile = input.profile ?? profileOf(state);
  requireThat(profile === 'light' || profile === 'strict', 'Invalid profile');
  const repo = input.repo ?? coordinator.worktree;
  safePath(repo); safePath(extensionPath);
  requireThat(lstatSync(repo).isDirectory() && lstatSync(extensionPath).isFile(), 'Repository/extension paths invalid');
  const family = state.family ?? familyRootFor(store.root);
  safePath(dirname(family));
  ensureFamily(family, store.root);
  if (!state.family) store.transact((next) => { next.family = family; });
  const root = reserveMember(family, input.name);
  const db = openStore(root, true);
  try { db.transact((next) => { next.profile = profile; next.family = family; }); } finally { db.close(); }
  const prompt = join(root, 'fork-prompt.md');
  writeFileSync(prompt, `You are an independent Pi orchestrator, forked by ${coordinatorId}.
The human talks to you directly in this tab.
You do not report to, or take instructions from, the orchestrator that forked you; it has handed this work over.
Your registry is ${root} (${profile} profile); you are attached to it as coordinator.
Family ${family}: sibling orchestrators share its deploy lock.
Before planning, read orchestrator_status with view "family" and avoid overlapping their tasks.
Your subagents run in your own detached Zellij session, created on first spawn, at most ${LIMITS.agents} at once.
When your work is done, collect and close them, then close that session with orchestrator_agent action close-session.
Follow the orchestrate-work skill.
First restate the scope below and confirm it with the human before spawning anyone.

Handed-off request:
${input.request}
`, { flag: 'wx', mode: 0o600 });
  let tab: string;
  try {
    ({ stdout: tab } = await runner('zellij', ['--session', session, 'action', 'new-tab', '--name', input.name, '--cwd', repo, '--',
      'pi', '--provider', provider, '--model', model, '--thinking', thinking, '--extension', extensionPath, '--orchestrator-coordinate', root, `@${prompt}`]));
    requireThat(/^\d+\s*$/.test(tab), 'Missing created tab ID');
  } catch {
    throw new Error(`Fork registry prepared at ${root}, but its tab did not start; inspect it, then retry with a new name.`);
  }
  // Focus stays on the new tab by design; switching back would be more distracting.
  const fork: Fork = { name: input.name, root, session, tabId: Number(tab.trim()), createdAt: Date.now() };
  store.transact((next) => { next.forks = [...(next.forks ?? []), fork]; });
  return fork;
}

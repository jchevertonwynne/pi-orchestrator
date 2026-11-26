import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { closeSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SCHEMA_VERSION } from './contracts.ts';
import type { Registry, Store } from './contracts.ts';
import { gated } from './policy.ts';
import { displayReleaseScope, scopeLayouts } from './workflow.ts';

const MAX_SNAPSHOT = 16 * 1024 * 1024;
const MAX_DB = 64 * 1024 * 1024;
const tokenPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const taskStates = ['planned', 'approved', 'implementing', 'blocked', 'ready', 'verified', 'merged', 'deployed', 'skipped'];

// Where validation is, so a failure names the entry instead of only "Invalid registry schema".
const where: string[] = [];
function within<T>(step: string, fn: () => T): T {
  where.push(step);
  try { return fn(); } finally { where.pop(); }
}
function check(ok: unknown, message = 'Invalid registry schema'): asserts ok {
  if (!ok) throw new Error(where.length ? `${message} at ${where.join('').replace(/^\./, '')}` : message);
}
function object(value: any): void {
  check(value && typeof value === 'object' && !Array.isArray(value));
}
function text(value: any, max = 4096): void {
  check(typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= max && !value.includes('\0'));
}
function token(value: any): void {
  check(typeof value === 'string' && tokenPattern.test(value) && !forbidden.has(value));
}
function time(value: any): void { check(Number.isSafeInteger(value) && value >= 0); }
function list(value: any, item: (value: any) => void, max = 10000, name = ''): void {
  within(name ? `.${name}` : '', () => {
    check(Array.isArray(value) && value.length <= max);
    value.forEach((entry: any, index: number) => within(`[${index}]`, () => item(entry)));
  });
}
function one(value: any, values: string[]): void { check(values.includes(value)); }
function sha(value: any): void { check(typeof value === 'string' && /^[a-f0-9]{40}$/.test(value)); }
function hash(value: any): void { check(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)); }
function optional(value: any, validate: (value: any) => void): void { if (value !== undefined) validate(value); }
function record(value: any, validate: (value: any) => void, name = ''): void {
  within(name ? `.${name}` : '', () => {
    object(value);
    check(Object.keys(value).length <= 10000);
    for (const [key, entry] of Object.entries(value)) within(`.${key}`, () => { token(key); validate(entry); });
  });
}

function validate(state: any): asserts state is Registry {
  object(state);
  check(state.version === SCHEMA_VERSION, 'Unsupported registry schema version');
  time(state.revision); time(state.createdAt);
  optional(state.profile, (value) => one(value, ['light', 'strict']));
  optional(state.family, (value) => { text(value); check(value.startsWith('/')); });
  optional(state.forks, (forks) => list(forks, (fork) => {
    object(fork); token(fork.name); text(fork.root); check(fork.root.startsWith('/')); text(fork.session, 256); time(fork.tabId); time(fork.createdAt);
  }, 100, 'forks'));
  if (state.releaseAuthorization !== undefined) {
    object(state.releaseAuthorization); text(state.releaseAuthorization.source); time(state.releaseAuthorization.at);
  }
  optional(state.releaseGrants, (grants) => list(grants, (grant) => {
    object(grant); token(grant.id); text(grant.root); check(grant.root.startsWith('/'));
    optional(grant.source, (value) => text(value, 1024));
    check(Array.isArray(grant.scope) && grant.scope.length > 0);
    const pairs = new Set<string>();
    list(grant.scope, (pair) => {
      object(pair); token(pair.taskId); one(pair.action, ['pr', 'merge', 'deploy', 'local-install']);
      text(pair.title, 1024); text(pair.planPath); hash(pair.planHash);
      check(Object.hasOwn(state.tasks, pair.taskId));
      if (pair.action === 'deploy') text(pair.deploymentTarget, 1024);
      else check(pair.deploymentTarget === undefined);
      if (pair.action === 'local-install') {
        sha(pair.commit); text(pair.installationTarget, 1024);
        check(pair.installationTarget.startsWith('/') && resolve(pair.installationTarget) === pair.installationTarget && pair.installationTarget.trim() === pair.installationTarget);
      } else check(pair.commit === undefined && pair.installationTarget === undefined);
      const key = JSON.stringify([pair.taskId, pair.action, pair.deploymentTarget, pair.installationTarget, pair.commit]);
      check(!pairs.has(key)); pairs.add(key);
    }, 100);
    const c = grant.confirmation;
    object(c); check(c.kind === 'tui'); token(c.coordinator); token(c.generation); token(c.sessionId);
    text(c.sessionFile); if (c.branchAnchor !== null) token(c.branchAnchor);
    one(c.origin, ['slash', 'tool']);
    if (c.origin === 'tool') text(c.toolCallId, 1024); else check(c.toolCallId === undefined);
    time(c.at); text(c.displayedScope, 1024 * 1024); hash(c.digest);
    // Older grants recorded the JSON layouts; each grant must match one layout exactly.
    check(scopeLayouts.some((layout) => c.displayedScope === displayReleaseScope(grant.root, grant.scope, grant.source, layout)));
    check(createHash('sha256').update(c.displayedScope).digest('hex') === c.digest);
    check(Object.hasOwn(state.agents, c.coordinator));
    if (grant.continuation !== undefined) {
      check(c.origin === 'slash'); object(grant.continuation); optional(grant.continuation.acknowledgedAt, time);
    }
  }, 1000, 'releaseGrants'));
  if (state.releaseGrants) check(new Set(state.releaseGrants.map((g: any) => g.id)).size === state.releaseGrants.length);
  record(state.tasks, (task) => {
    object(task); token(task.id); text(task.title, 1024); one(task.state, taskStates);
    text(task.planPath); hash(task.planHash); list(task.dependencies, token, 1000);
    optional(task.parentTask, token);
    optional(task.risky, (value) => check(typeof value === 'boolean'));
    optional(task.ships, (value) => check(value === false));
    if (task.summary !== undefined) {
      object(task.summary); text(task.summary.text, 1024); check(typeof task.summary.needsHuman === 'boolean');
      token(task.summary.by); time(task.summary.at);
    }
    if (task.approval !== undefined) {
      object(task.approval); hash(task.approval.hash); text(task.approval.source); time(task.approval.at);
    }
    if (task.result !== undefined) {
      const r = task.result;
      object(r); token(r.id); one(r.status, ['ready', 'blocked', 'failed']);
      // Non-shipping work (design, review) may be ready without a commit.
      optional(r.commit, sha); if (r.status === 'ready' && task.ships !== false) sha(r.commit);
      text(r.report); list(r.evidence, text, 256); time(r.createdAt);
    }
    if (task.verification !== undefined) {
      object(task.verification); if (task.ships !== false) sha(task.verification.commit); else optional(task.verification.commit, sha); hash(task.verification.planHash);
      list(task.verification.evidence, text, 256); time(task.verification.at);
      check(task.result?.status === 'ready' && task.result.commit === task.verification.commit);
      // Light non-risky work is owner-verified against its current plan bytes, without per-task approval.
      if (gated(state, task)) check(task.approval?.hash === task.verification.planHash);
    }
    list(task.history, (entry) => {
      object(entry); one(entry.state, taskStates); time(entry.at); text(entry.note);
    });
    if (['verified', 'merged', 'deployed'].includes(task.state)) check(task.verification);
  }, 'tasks');
  record(state.agents, (agent) => {
    object(agent); token(agent.id); token(agent.generation);
    one(agent.role, ['coordinator', 'planner', 'implementer', 'reviewer', 'release']);
    one(agent.lifecycle, ['registered', 'starting', 'running', 'exited', 'collected', 'closed']);
    optional(agent.parentId, token); optional(agent.taskId, token);
    optional(agent.thinking, value => one(value, ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']));
    text(agent.model); text(agent.worktree); text(agent.sessionDir); token(agent.piSessionId);
    for (const field of ['repo', 'base', 'branch', 'sessionFile', 'zellijSession', 'paneId', 'homeSession', 'homePaneId', 'collectedReport', 'launchError']) optional(agent[field], text);
    for (const field of ['tabId', 'pid', 'heartbeatAt', 'activityAt', 'progressAt']) optional(agent[field], time);
    if (agent.activity !== undefined) one(agent.activity, ['busy', 'idle']);
    if (agent.currentTool !== undefined) { object(agent.currentTool); text(agent.currentTool.name, 256); time(agent.currentTool.since); optional(agent.currentTool.until, time); }
  }, 'agents');
  list(state.messages, (m) => {
    object(m); token(m.id); token(m.from); token(m.to); token(m.generation);
    one(m.kind, ['message', 'shutdown']); one(m.mode, ['followUp', 'steer']); text(m.body, 16384);
    time(m.createdAt); optional(m.deliveredAt, time); optional(m.acknowledgedAt, time);
    check(Object.hasOwn(state.agents, m.from) && Object.hasOwn(state.agents, m.to));
  }, 50000, 'messages');
  list(state.resources, (r) => {
    object(r); token(r.id); token(r.taskId); one(r.kind, ['migration', 'port', 'compose', 'file']);
    text(r.scope); text(r.value); optional(r.releasedAt, time);
    check(Object.hasOwn(state.tasks, r.taskId));
  }, undefined, 'resources');
  record(state.releases, (r) => {
    object(r); token(r.taskId); token(r.owner); token(r.token); sha(r.commit);
    one(r.stage, ['claimed', 'pr', 'merged', 'deployed', 'installed', 'cleaned', 'blocked']);
    optional(r.route, value => one(value, ['pr', 'local-install']));
    if (r.route === 'local-install') {
      text(r.installationTarget, 1024);
      check(r.installationTarget.startsWith('/') && resolve(r.installationTarget) === r.installationTarget && r.installationTarget.trim() === r.installationTarget);
      one(r.stage, ['claimed', 'installed', 'cleaned', 'blocked']);
      check(r.pr === undefined && r.mergedCommit === undefined && r.deployedCommit === undefined);
      optional(r.installedCommit, sha);
      if (r.installedCommit !== undefined) check(r.installedCommit === r.commit && r.stage !== 'claimed');
      if (['installed', 'cleaned'].includes(r.stage)) check(r.installedCommit === r.commit);
    } else check(r.stage !== 'installed' && r.installationTarget === undefined && r.installedCommit === undefined);
    optional(r.pr, text); optional(r.mergedCommit, sha); optional(r.deployedCommit, sha);
    list(r.evidence, text, 256); time(r.updatedAt);
    check(Object.hasOwn(state.tasks, r.taskId) && Object.hasOwn(state.agents, r.owner));
  }, 'releases');
  if (state.releaseLock !== undefined) {
    const lock = state.releaseLock;
    object(lock); token(lock.owner); token(lock.token); token(lock.taskId);
    const release = state.releases[lock.taskId];
    check(release && release.owner === lock.owner && release.token === lock.token);
  }
  if (state.sharedSession !== undefined) {
    object(state.sharedSession); token(state.sharedSession.name); token(state.sharedSession.ownerId); optional(state.sharedSession.closedAt, time);
    check(Object.hasOwn(state.agents, state.sharedSession.ownerId));
  }
  record(state.notifications, (entries) => list(entries, (entry) => text(entry, 1024)), 'notifications');
  for (const [id, task] of Object.entries(state.tasks) as [string, any][]) {
    check(id === task.id);
    for (const dep of [...task.dependencies, ...(task.parentTask ? [task.parentTask] : [])]) check(Object.hasOwn(state.tasks, dep));
  }
  for (const [id, agent] of Object.entries(state.agents) as [string, any][]) {
    check(id === agent.id);
    if (agent.parentId) check(Object.hasOwn(state.agents, agent.parentId));
    if (agent.taskId) check(Object.hasOwn(state.tasks, agent.taskId));
  }
  for (const [id, release] of Object.entries(state.releases) as [string, any][]) check(id === release.taskId);
  // Iterative traversal bounds stack usage even for a malicious deep graph.
  for (const [entries, edges] of [
    [state.tasks, (t: any) => [...t.dependencies, ...(t.parentTask ? [t.parentTask] : [])]],
    [state.agents, (a: any) => a.parentId ? [a.parentId] : []],
  ] as const) {
    const done = new Set<string>();
    for (const id of Object.keys(entries)) {
      const active = new Set<string>();
      const stack: [string, boolean][] = [[id, false]];
      while (stack.length) {
        const [key, exiting] = stack.pop()!;
        if (exiting) { active.delete(key); done.add(key); continue; }
        check(!active.has(key), 'Registry graph cycle');
        if (done.has(key)) continue;
        active.add(key); stack.push([key, true]);
        for (const next of edges(entries[key])) stack.push([next, false]);
      }
    }
  }
}

function safePath(path: string, directory: boolean): void {
  const stat = lstatSync(path);
  check(!stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile()), `Unsafe registry path: ${path}`);
  check((stat.mode & 0o077) === 0, `Registry path must be private: ${path}`);
  if (process.getuid) check(stat.uid === process.getuid(), `Registry path has another owner: ${path}`);
  if (!directory) check(stat.nlink === 1 && stat.size <= MAX_DB, 'Invalid registry database size or hard link');
}
function exists(path: string): boolean {
  try { lstatSync(path); return true; } catch (error: any) { if (error.code === 'ENOENT') return false; throw error; }
}

export function openStore(root: string, create = true): Store {
  text(root); check(typeof create === 'boolean', 'Invalid create flag');
  root = resolve(root);
  if (!exists(root)) {
    check(create, 'Registry root does not exist');
    mkdirSync(root, { recursive: true, mode: 0o700 });
  }
  safePath(root, true);
  root = realpathSync(root);
  const path = join(root, 'registry.sqlite');
  let fresh = false;
  if (!exists(path)) {
    check(create, 'Registry database does not exist');
    try { closeSync(openSync(path, 'wx', 0o600)); fresh = true; }
    catch (error: any) { if (error.code !== 'EEXIST') throw error; }
  }
  const checkPaths = () => {
    safePath(root, true); safePath(path, false);
    for (const suffix of ['-journal', '-wal', '-shm']) {
      try { safePath(path + suffix, false); }
      catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    }
  };
  checkPaths();
  const db = new DatabaseSync(path);
  let inTransaction = false;
  let closed = false;
  try {
    db.exec('PRAGMA busy_timeout = 10000; PRAGMA trusted_schema = OFF; PRAGMA synchronous = FULL; PRAGMA max_page_count = 16384;');
    db.exec('BEGIN IMMEDIATE');
    try {
      if (fresh) {
        db.exec(`CREATE TABLE registry (id INTEGER PRIMARY KEY CHECK (id = 1), snapshot TEXT NOT NULL) STRICT; PRAGMA user_version = ${SCHEMA_VERSION};`);
        const initial: Registry = {
          version: SCHEMA_VERSION, revision: 0, createdAt: Date.now(), tasks: {}, agents: {},
          messages: [], resources: [], releases: {}, notifications: {},
        };
        db.prepare('INSERT INTO registry (id, snapshot) VALUES (1, ?)').run(JSON.stringify(initial));
      }
      check((db.prepare('PRAGMA user_version').get() as any).user_version === SCHEMA_VERSION, 'Unsupported registry schema version');
      const tables = db.prepare("SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all();
      check(tables.length === 1 && tables[0].name === 'registry' && tables[0].sql === 'CREATE TABLE registry (id INTEGER PRIMARY KEY CHECK (id = 1), snapshot TEXT NOT NULL) STRICT', 'Invalid SQLite registry schema');
      check((db.prepare('PRAGMA quick_check').get() as any).quick_check === 'ok', 'Corrupt registry database');
      load();
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  } catch (error) { db.close(); throw error; }

  function load(): Registry {
    const rows = db.prepare('SELECT snapshot, length(CAST(snapshot AS BLOB)) AS bytes FROM registry').all();
    check(rows.length === 1 && Number(rows[0].bytes) <= MAX_SNAPSHOT, 'Invalid registry snapshot size');
    const state = JSON.parse(String(rows[0].snapshot));
    validate(state);
    return state;
  }
  function available(): void {
    check(!closed, 'Registry is closed');
    check(!inTransaction, 'Nested registry operations are not allowed');
    checkPaths();
  }
  return {
    root,
    read() { available(); return load(); },
    transact<T>(fn: (state: Registry) => T): T {
      available();
      inTransaction = true;
      try {
        db.exec('BEGIN IMMEDIATE');
        try {
          const state = load();
          const revision = state.revision;
          const createdAt = state.createdAt;
          const result = fn(state);
          check(!(result && typeof (result as any).then === 'function'), 'Registry transactions must be synchronous');
          check(state.revision === revision && state.createdAt === createdAt, 'Registry metadata is immutable');
          state.revision++;
          validate(state);
          const snapshot = JSON.stringify(state);
          check(Buffer.byteLength(snapshot) <= MAX_SNAPSHOT, 'Registry snapshot is too large');
          db.prepare('UPDATE registry SET snapshot = ? WHERE id = 1').run(snapshot);
          db.exec('COMMIT');
          return result;
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      } finally { inTransaction = false; }
    },
    close() {
      check(!inTransaction, 'Cannot close during a transaction');
      if (!closed) { db.close(); closed = true; }
    },
  };
}

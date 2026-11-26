import test from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '../src/store.ts';
import { acquireDeploy, ensureFamily, readDeploy, releaseDeploy } from '../src/family.ts';
import { acknowledge, pendingMessages, releaseAction, resourceAction, sendMessage, taskAction, releaseScope, displayReleaseScope } from '../src/workflow.ts';

const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);
const storeUrl = new URL('../src/store.ts', import.meta.url).href;
const workflowUrl = new URL('../src/workflow.ts', import.meta.url).href;
function run(code, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { output += data; });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve(output) : reject(new Error(`Child exit ${code}: ${output}`)));
  });
}
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'orchestrator-registry-test-'));
  const root = join(dir, 'registry');
  const plan = join(dir, 'plan.md');
  const report = join(dir, 'report.md');
  const proof = join(dir, 'evidence.log');
  writeFileSync(plan, 'Approved scope\n'); writeFileSync(report, 'Synthetic report\n'); writeFileSync(proof, 'Synthetic evidence\n');
  const store = openStore(root);
  t.after(() => store.close());
  function agent(id, role = 'implementer', taskId, parentId = 'coord') {
    store.transact((state) => {
      state.agents[id] = { id, role, ...(parentId ? { parentId } : {}), ...(taskId ? { taskId } : {}),
        model: 'openai-codex/gpt-6-astra', generation: `${id}-g1`, lifecycle: 'registered', worktree: dir,
        sessionDir: join(dir, id), piSessionId: `${id}-session` };
    });
  }
  agent('coord', 'coordinator', undefined, null);
  function create(id, dependencies = [], parentTask) {
    return taskAction(store, 'coord', { action: 'create', id, title: id, planPath: plan, dependencies, ...(parentTask ? { parentTask } : {}) });
  }
  function approve(id) { return taskAction(store, 'coord', { action: 'approve', id, source: 'Synthetic human confirmation' }); }
  function ready(id = 'task', who = `worker-${id}`) {
    create(id); approve(id); agent(who, 'implementer', id);
    taskAction(store, who, { action: 'start', id });
    return taskAction(store, who, { action: 'result', id, status: 'ready', commit: SHA, report, evidence: [proof] });
  }
  function verify(id = 'task') { return taskAction(store, 'coord', { action: 'verify', id, commit: SHA, evidence: [proof] }); }
  function authorize(proposals = Object.keys(store.read().tasks).flatMap(taskId => ['pr', 'merge', 'deploy'].map(action => ({ taskId, action, ...(action === 'deploy' ? { deploymentTarget: 'synthetic' } : {}) })))) {
    store.transact((s) => {
      const scope = releaseScope(s, proposals), displayedScope = displayReleaseScope(store.root, scope);
      (s.releaseGrants ??= []).push({ id: `synthetic-${s.revision}`, root: store.root, scope, confirmation: {
        kind: 'tui', coordinator: 'coord', generation: 'coord-g1', sessionId: 'coord-session', sessionFile: join(dir, 'session.jsonl'), branchAnchor: null,
        origin: 'tool', toolCallId: 'synthetic-call', at: Date.now(), displayedScope, digest: createHash('sha256').update(displayedScope).digest('hex'),
      } });
    });
  }
  function record(release, stage, fields = {}) {
    return releaseAction(store, release.owner, { action: 'record', taskId: release.taskId, token: release.token, stage, deploymentTarget: 'synthetic', evidence: [proof], ...fields });
  }
  return { dir, root, plan, report, proof, store, agent, create, approve, ready, verify, authorize, record };
}

for (const profile of ['strict', 'light']) {
  test(`local-install binds commit and target without PR or merge (${profile})`, t => {
    const f = fixture(t); f.store.transact(s => { s.profile = profile; });
    f.ready(); f.verify();
    const target = join(f.dir, 'installed');
    const scope = { taskId: 'task', action: 'local-install', commit: SHA, installationTarget: target };
    f.authorize([scope]);
    const grant = f.store.read().releaseGrants[0];
    assert.ok(grant.confirmation.displayedScope.includes(SHA));
    assert.ok(grant.confirmation.displayedScope.includes(target));
    const release = releaseAction(f.store, 'coord', { action: 'claim', taskId: 'task', operation: 'local-install', commit: SHA, installationTarget: target });
    assert.equal(release.route, 'local-install');
    assert.equal(release.next.operation, 'local-install'); assert.equal(release.next.allowed, true);
    assert.equal(f.store.read().releaseLock.token, release.token);
    const check = { action: 'check', taskId: 'task', operation: 'local-install', commit: SHA, installationTarget: target };
    assert.equal(releaseAction(f.store, 'coord', check).allowed, true);
    f.agent('other-coordinator', 'coordinator', undefined, null);
    assert.throws(() => releaseAction(f.store, 'other-coordinator', check), /owned by/);
    for (const fields of [{ commit: OTHER_SHA }, { commit: undefined }, { installationTarget: target + '-other' }, { installationTarget: undefined }, { token: 'wrong' }]) {
      assert.throws(() => releaseAction(f.store, 'coord', { ...check, ...fields }));
    }
    for (const operation of ['pr', 'merge', 'deploy']) assert.throws(() => releaseAction(f.store, 'coord', { action: 'check', taskId: 'task', operation, deploymentTarget: 'synthetic' }));
    assert.throws(() => f.authorize([{ taskId: 'task', action: 'pr' }]), /route/i);
    assert.throws(() => taskAction(f.store, 'worker-task', { action: 'result', id: 'task', status: 'ready', commit: OTHER_SHA, report: f.report, evidence: [f.proof] }), /frozen/);
    const candidate = f.store.read().tasks.task;
    assert.throws(() => taskAction(f.store, 'worker-task', { action: 'start', id: 'task' }), /frozen/);
    assert.deepEqual(f.store.read().tasks.task, candidate);
    const record = { action: 'record', taskId: 'task', stage: 'installed', installationTarget: target, installedCommit: SHA, evidence: [f.proof] };
    assert.throws(() => releaseAction(f.store, 'coord', { ...record, installedCommit: OTHER_SHA }));
    assert.throws(() => releaseAction(f.store, 'coord', { ...record, evidence: [] }));
    assert.throws(() => releaseAction(f.store, 'coord', { ...record, pr: 'https://example.invalid/pr/1' }));
    f.store.transact(s => { s.tasks.task.result.commit = OTHER_SHA; s.tasks.task.verification.commit = OTHER_SHA; });
    assert.throws(() => releaseAction(f.store, 'coord', check), /verified/);
    assert.throws(() => releaseAction(f.store, 'coord', record), /verified/);
    f.store.transact(s => { s.tasks.task.result.commit = SHA; s.tasks.task.verification.commit = SHA; });
    const installed = releaseAction(f.store, 'coord', record);
    assert.equal(installed.installedCommit, SHA); assert.equal(installed.installationTarget, target);
    for (const field of ['pr', 'mergedCommit', 'deployedCommit']) assert.equal(installed[field], undefined);
    assert.equal(f.store.read().tasks.task.state, 'deployed');
    for (const mutate of [r => { r.route = 'pr'; }, r => { r.pr = 'https://example.invalid/pr/1'; }, r => { delete r.installationTarget; }, r => { r.installedCommit = OTHER_SHA; }]) {
      assert.throws(() => f.store.transact(s => mutate(s.releases.task)), /schema/);
    }
    assert.throws(() => releaseAction(f.store, 'coord', record), /stage|already/i);
    const reopened = openStore(f.root, false);
    assert.deepEqual(reopened.read().releases.task, f.store.read().releases.task); reopened.close();
    releaseAction(f.store, 'coord', { action: 'record', taskId: 'task', stage: 'cleaned', evidence: [f.proof] });
    releaseAction(f.store, 'coord', { action: 'unlock', taskId: 'task', reason: 'Synthetic installation attested; no real effects' });
    assert.equal(f.store.read().releaseLock, undefined);
  });
}

test('local-install rejects incomplete grants, route conflicts and ready-only results', t => {
  const f = fixture(t); f.ready();
  const proposal = { taskId: 'task', action: 'local-install', commit: SHA, installationTarget: join(f.dir, 'installed') };
  assert.throws(() => f.authorize([proposal]), /verified/i);
  f.verify();
  for (const fields of [{ commit: undefined }, { commit: OTHER_SHA }, { installationTarget: 'relative' }, { installationTarget: '/tmp/../install' }, { installationTarget: 'https://example.invalid' }, { deploymentTarget: 'unrelated' }]) {
    assert.throws(() => f.authorize([{ ...proposal, ...fields }]));
  }
  assert.throws(() => f.authorize([proposal, { taskId: 'task', action: 'pr' }]), /route/i);
  f.authorize([{ taskId: 'task', action: 'pr' }]);
  assert.throws(() => f.authorize([proposal]), /route/i);
  assert.throws(() => f.authorize([{ taskId: 'task', action: 'pr', commit: SHA }]), /fields/i);
  assert.throws(() => f.authorize([{ taskId: 'task', action: 'deploy', deploymentTarget: 'test', installationTarget: proposal.installationTarget }]), /fields/i);
  assert.throws(() => releaseAction(f.store, 'coord', { action: 'claim', taskId: 'task', operation: 'local-install', commit: SHA, installationTarget: proposal.installationTarget }));
});

test('local-install locks survive blocked recovery and reject family contention without state changes', t => {
  const f = fixture(t); f.store.transact(s => { s.profile = 'light'; }); f.ready(); f.verify();
  const family = f.root + '.family'; ensureFamily(family, f.root);
  f.store.transact(s => { s.family = family; });
  const target = join(f.dir, 'installed');
  f.authorize([{ taskId: 'task', action: 'local-install', commit: SHA, installationTarget: target }]);
  const claim = { action: 'claim', taskId: 'task', operation: 'local-install', commit: SHA, installationTarget: target };
  const foreign = { root: '/synthetic-sibling', taskId: 'foreign', owner: 'other', token: 'foreign-token' };
  acquireDeploy(family, foreign);
  const before = f.store.read();
  assert.throws(() => releaseAction(f.store, 'coord', claim), /already held/);
  assert.deepEqual(f.store.read(), before); assert.equal(readDeploy(family).token, foreign.token);
  releaseDeploy(family, foreign);
  const release = releaseAction(f.store, 'coord', claim);
  assert.equal(readDeploy(family).token, release.token);
  assert.throws(() => releaseAction(f.store, 'worker-task', { ...claim, action: 'check' }), /role/);
  assert.throws(() => releaseAction(f.store, 'coord', { ...claim, taskId: undefined, taskIds: ['task'] }), /single-task|taskIds/);
  releaseAction(f.store, 'coord', { action: 'record', taskId: 'task', stage: 'blocked', evidence: [f.proof] });
  releaseAction(f.store, 'coord', { action: 'unlock', taskId: 'task', reason: 'Synthetic interrupted operation; no external effect' });
  assert.equal(readDeploy(family), undefined);
  assert.throws(() => releaseAction(f.store, 'coord', { ...claim, action: 'check' }), /lock/i);
  assert.throws(() => releaseAction(f.store, 'coord', { action: 'record', taskId: 'task', stage: 'installed', installedCommit: SHA, installationTarget: target, evidence: [f.proof] }), /lock/i);
  const resumed = releaseAction(f.store, 'coord', claim);
  assert.equal(resumed.route, 'local-install'); assert.equal(resumed.stage, 'blocked'); assert.equal(resumed.next.action, 'none');
  assert.equal(releaseAction(f.store, 'coord', { ...claim, action: 'check' }).allowed, true);
  releaseAction(f.store, 'coord', { action: 'record', taskId: 'task', stage: 'installed', installedCommit: SHA, installationTarget: target, evidence: [f.proof] });
  releaseAction(f.store, 'coord', { action: 'unlock', taskId: 'task', reason: 'Synthetic verification complete' });
  assert.throws(() => releaseAction(f.store, 'coord', claim), /already attested/);
  assert.equal(readDeploy(family), undefined);
});

test('local-install grants do not follow changed light candidates, approvals or non-shipping tasks', t => {
  const f = fixture(t); f.store.transact(s => { s.profile = 'light'; }); f.ready(); f.verify();
  const target = join(f.dir, 'installed');
  const scope = { taskId: 'task', action: 'local-install', commit: SHA, installationTarget: target };
  f.authorize([scope]);
  taskAction(f.store, 'worker-task', { action: 'result', id: 'task', status: 'ready', commit: OTHER_SHA, report: f.report, evidence: [f.proof] });
  taskAction(f.store, 'coord', { action: 'verify', id: 'task', commit: OTHER_SHA, evidence: [f.proof] });
  assert.throws(() => releaseAction(f.store, 'coord', { action: 'claim', taskId: 'task', operation: 'local-install', commit: OTHER_SHA, installationTarget: target }), /authorization/);
  assert.throws(() => releaseAction(f.store, 'coord', { action: 'claim', taskId: 'task', operation: 'local-install', commit: SHA, installationTarget: target }), /verified/);
  assert.throws(() => releaseAction(f.store, 'coord', { action: 'claim', taskId: 'task' }), /authorization/);
  f.store.transact(s => { delete s.tasks.task.approval; });
  assert.throws(() => f.authorize([{ ...scope, commit: OTHER_SHA }]), /human approval/);
  f.approve('task');
  f.store.transact(s => { s.tasks.task.ships = false; });
  assert.throws(() => f.authorize([{ ...scope, commit: OTHER_SHA }]), /Non-shipping/);
});

test('local-install workflow also preserves its explicit route in a memory snapshot', t => {
  const f = fixture(t); f.ready(); f.verify();
  const target = join(f.dir, 'installed');
  f.authorize([{ taskId: 'task', action: 'local-install', commit: SHA, installationTarget: target }]);
  let state = f.store.read();
  const memory = { root: f.store.root, read: () => structuredClone(state), transact: fn => {
    const next = structuredClone(state); const result = fn(next); state = next; return result;
  }, close() {} };
  const release = releaseAction(memory, 'coord', { action: 'claim', taskId: 'task', operation: 'local-install', commit: SHA, installationTarget: target });
  assert.equal(release.next.allowed, true);
  state = JSON.parse(JSON.stringify(state));
  releaseAction(memory, 'coord', { action: 'record', taskId: 'task', stage: 'installed', installedCommit: SHA, installationTarget: target, evidence: [f.proof] });
  assert.equal(memory.read().releases.task.installedCommit, SHA);
  assert.equal(memory.read().releases.task.mergedCommit, undefined);
});

test('local-install leaves historical ordinary grant display bytes unchanged', () => {
  const pair = { taskId: 'task', action: 'pr', title: 'Task', planPath: '/test/plan.md', planHash: 'a'.repeat(64) };
  const tail = 'PR permission includes the branch push required to open/update that PR. No action implies another.\n'
    + 'Deployment is limited to its explicit target. Cleanup permission is NOT granted.\n'
    + 'Existing implementation approval, verification and ownership gates still apply. No external action is executed by this dialog.\n'
    + 'Untrusted proposal reference: null';
  for (const layout of ['cards', 0, 2]) {
    const body = layout === 'cards' ? `1. PR task\n   Title:  "Task"\n   Plan:   "/test/plan.md"\n   SHA256: ${pair.planHash}\n` : JSON.stringify(pair, null, layout);
    assert.equal(displayReleaseScope('/test/run', [pair], undefined, layout), `Registry: "/test/run"\nExact release scope:\n${body}\n${tail}`);
  }
});

test('import does not create registry files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orchestrator-import-test-'));
  await run(`process.chdir(process.argv[1]); await import(${JSON.stringify(storeUrl)}); await import(${JSON.stringify(workflowUrl)});`, [dir]);
  assert.equal(existsSync(join(dir, 'registry.sqlite')), false);
});

test('private store persists snapshots and rejects async/nested transactions with rollback', (t) => {
  const f = fixture(t);
  assert.equal(lstatSync(f.root).mode & 0o777, 0o700);
  assert.equal(lstatSync(join(f.root, 'registry.sqlite')).mode & 0o777, 0o600);
  const before = f.store.read();
  assert.throws(() => f.store.transact((s) => { s.notifications.coord = ['should-rollback']; throw new Error('abort'); }), /abort/);
  assert.deepEqual(f.store.read(), before);
  assert.throws(() => f.store.transact(async (s) => { s.notifications.coord = ['async']; }), /synchronous/);
  assert.throws(() => f.store.transact(() => f.store.read()), /Nested/);
  assert.throws(() => f.store.transact((s) => { s.version = 999; }), /version/);
  assert.throws(() => f.store.transact((s) => { s.revision++; }), /immutable/);
  assert.deepEqual(f.store.read(), before);
  f.create('persisted');
  const second = openStore(f.root, false);
  assert.equal(second.read().tasks.persisted.id, 'persisted'); second.close();
});

test('create=false, symlink roots/databases, public permissions and corrupt schema fail closed', (t) => {
  const f = fixture(t);
  const absent = join(f.dir, 'absent');
  assert.throws(() => openStore(absent, false), /does not exist/);
  assert.equal(existsSync(absent), false);
  const empty = join(f.dir, 'empty'); mkdirSync(empty, { mode: 0o700 });
  assert.throws(() => openStore(empty, false), /does not exist/);
  assert.equal(existsSync(join(empty, 'registry.sqlite')), false);
  const linked = join(f.dir, 'linked'); symlinkSync(f.root, linked);
  assert.throws(() => openStore(linked), /Unsafe/);
  symlinkSync(join(f.root, 'registry.sqlite'), join(empty, 'registry.sqlite'));
  assert.throws(() => openStore(empty), /Unsafe/);
  const publicRoot = join(f.dir, 'public'); mkdirSync(publicRoot, { mode: 0o755 }); chmodSync(publicRoot, 0o755);
  assert.throws(() => openStore(publicRoot), /private/);
  f.store.close();
  const db = new DatabaseSync(join(f.root, 'registry.sqlite'));
  db.exec('PRAGMA user_version = 900'); db.close();
  assert.throws(() => openStore(f.root), /version/);
  const bad = join(f.dir, 'bad'); mkdirSync(bad, { mode: 0o700 });
  writeFileSync(join(bad, 'registry.sqlite'), 'not a database', { mode: 0o600 });
  assert.throws(() => openStore(bad));
  assert.equal(readFileSync(join(bad, 'registry.sqlite'), 'utf8'), 'not a database');
});

test('malformed snapshots, extra schema objects and oversized inputs fail without reset', (t) => {
  const f = fixture(t); f.store.close();
  const db = new DatabaseSync(join(f.root, 'registry.sqlite'));
  const prior = db.prepare('SELECT snapshot FROM registry').get().snapshot;
  db.prepare('UPDATE registry SET snapshot = ?').run('{"version":1}');
  assert.throws(() => openStore(f.root), /schema/);
  assert.equal(db.prepare('SELECT snapshot FROM registry').get().snapshot, '{"version":1}');
  db.prepare('UPDATE registry SET snapshot = ?').run(prior);
  db.exec('CREATE TABLE extra (x)');
  assert.throws(() => openStore(f.root), /schema/); db.close();
});

test('multiple independent processes update the SQLite snapshot without losing writes', async (t) => {
  const f = fixture(t);
  const revision = f.store.read().revision;
  await Promise.all(Array.from({ length: 6 }, (_, worker) => run(`
    import { openStore } from ${JSON.stringify(storeUrl)};
    const s = openStore(process.argv[1], false);
    for (let i = 0; i < 25; i++) s.transact(state => { state.notifications['worker-${worker}'] ??= []; state.notifications['worker-${worker}'].push('item-' + i); });
    s.close();
  `, [f.root])));
  const state = f.store.read();
  assert.equal(state.revision, revision + 150);
  for (let i = 0; i < 6; i++) assert.equal(state.notifications[`worker-${i}`].length, 25);
});

test('concurrent release claims have exactly one durable winner', async (t) => {
  const f = fixture(t); f.ready(); f.verify(); f.authorize();
  const outcomes = await Promise.all(Array.from({ length: 4 }, () => run(`
    import { openStore } from ${JSON.stringify(storeUrl)};
    import { releaseAction } from ${JSON.stringify(workflowUrl)};
    const store = openStore(process.argv[1], false);
    try { releaseAction(store, 'coord', { action: 'claim', taskId: 'task' }); console.log('CLAIMED'); }
    catch (error) { if (!error.message.includes('already held')) throw error; console.log('LOCKED'); }
    finally { store.close(); }
  `, [f.root])));
  assert.equal(outcomes.filter((output) => output.includes('CLAIMED')).length, 1);
  assert.equal(outcomes.filter((output) => output.includes('LOCKED')).length, 3);
  assert.equal(f.store.read().releaseLock.taskId, 'task');
});

test('acknowledged monitor notification keys are preserved, not treated as pending queues', (t) => {
  const f = fixture(t); const first = f.ready();
  const key = `result:task:${first.result.id}`;
  f.store.transact((s) => { s.notifications.coord = [key]; });
  taskAction(f.store, 'worker-task', { action: 'result', id: 'task', status: 'failed', report: f.report });
  assert.deepEqual(f.store.read().notifications.coord, [key]);
});

test('runtime validation rejects unsafe IDs, unknown actions/status and invalid plans', (t) => {
  const f = fixture(t);
  for (const id of ['__proto__', 'constructor', '../escape', 'x'.repeat(129), '']) {
    assert.throws(() => f.create(id), /ID/);
  }
  assert.throws(() => taskAction(f.store, 'coord', { action: 'invent', id: 'x' }), /Unknown/);
  assert.throws(() => taskAction(f.store, 'coord', null), /input/);
  assert.throws(() => f.create('unknown', ['missing']), /Unknown task/);
  assert.throws(() => f.create('cycle', ['cycle']), /cycle/);
  writeFileSync(f.plan, Buffer.alloc(1024 * 1024 + 1));
  assert.throws(() => f.create('huge'), /1 MiB/);
  assert.throws(() => taskAction(f.store, 'coord', { action: 'create', id: 'dir', title: 'dir', planPath: f.dir }), /regular file/);
});

test('plan edits require explicit approval and prevent stale start, verify, and release', (t) => {
  const f = fixture(t);
  const planned = f.create('task'); f.approve('task'); f.agent('worker', 'implementer', 'task');
  assert.equal(planned.planHash.length, 64);
  writeFileSync(f.plan, 'changed scope');
  assert.throws(() => taskAction(f.store, 'worker', { action: 'start', id: 'task' }), /not approved/);
  assert.throws(() => taskAction(f.store, 'coord', { action: 'approve', id: 'task', source: 'confirmed old plan', expectedHash: planned.planHash }), /human confirmation/);
  const approved = f.approve('task'); assert.notEqual(approved.planHash, planned.planHash);
  taskAction(f.store, 'worker', { action: 'start', id: 'task' });
  taskAction(f.store, 'worker', { action: 'result', id: 'task', status: 'ready', commit: SHA, report: f.report });
  writeFileSync(f.plan, 'changed again');
  assert.throws(() => f.verify(), /not approved/);
  const reset = f.approve('task'); assert.equal(reset.result, undefined);
  taskAction(f.store, 'worker', { action: 'start', id: 'task' });
  taskAction(f.store, 'worker', { action: 'result', id: 'task', status: 'ready', commit: SHA, report: f.report });
  f.verify(); f.authorize(); writeFileSync(f.plan, 'changed after verification');
  assert.throws(() => releaseAction(f.store, 'coord', { action: 'claim', taskId: 'task' }), /authorization required/);
});

test('only coordinator approves/skips/verifies; result is never verification and full SHA/evidence required', (t) => {
  const f = fixture(t); f.create('task'); f.agent('worker', 'implementer', 'task');
  for (const input of [
    { action: 'approve', id: 'task', source: 'no' }, { action: 'skip', id: 'task', reason: 'no' },
    { action: 'verify', id: 'task', commit: SHA, evidence: [f.proof] },
  ]) assert.throws(() => taskAction(f.store, 'worker', input), /Coordinator/);
  f.approve('task'); const started = taskAction(f.store, 'worker', { action: 'start', id: 'task' });
  const again = taskAction(f.store, 'worker', { action: 'start', id: 'task' });
  assert.equal(again.state, 'implementing'); assert.equal(again.history.length, started.history.length);
  const result = { action: 'result', id: 'task', status: 'ready', commit: SHA, report: f.report, evidence: [f.proof] };
  assert.throws(() => taskAction(f.store, 'worker', { ...result, commit: 'abcdef' }), /full Git SHA/);
  assert.throws(() => taskAction(f.store, 'worker', { ...result, status: 'verified' }), /status/);
  assert.throws(() => taskAction(f.store, 'worker', { ...result, report: join(f.dir, 'missing') }), /File not found: .*missing\. Create the file before this call, not in a parallel call\.$/);
  const ready = taskAction(f.store, 'worker', result);
  assert.equal(ready.state, 'ready'); assert.equal(ready.verification, undefined);
  f.authorize();
  assert.throws(() => releaseAction(f.store, 'coord', { action: 'claim', taskId: 'task' }), /verified/);
  assert.throws(() => taskAction(f.store, 'coord', { action: 'verify', id: 'task', commit: OTHER_SHA, evidence: [f.proof] }), /differs/);
  assert.throws(() => taskAction(f.store, 'coord', { action: 'verify', id: 'task', commit: SHA, evidence: [] }), /evidence/);
  assert.equal(f.verify().state, 'verified');
});

test('missing evidence refuses verification and release without mutating the task', (t) => {
  const f = fixture(t); f.ready();
  renameSync(f.proof, `${f.proof}.away`);
  assert.throws(() => f.verify(), /File not found/);
  assert.equal(f.store.read().tasks.task.state, 'ready');
  renameSync(`${f.proof}.away`, f.proof); f.verify(); f.authorize();
  renameSync(f.proof, `${f.proof}.away`);
  assert.throws(() => releaseAction(f.store, 'coord', { action: 'claim', taskId: 'task' }), /File not found/);
  assert.equal(f.store.read().releaseLock, undefined);
});

test('coordinator may independently verify a collected result but not its own assigned task', (t) => {
  const f = fixture(t); f.create('task'); f.approve('task');
  taskAction(f.store, 'coord', { action: 'start', id: 'task' });
  taskAction(f.store, 'coord', { action: 'result', id: 'task', status: 'ready', commit: SHA, report: f.report });
  f.store.transact((s) => { s.agents.coord.taskId = 'task'; });
  assert.throws(() => f.verify(), /Self-verification/);
  f.store.transact((s) => { delete s.agents.coord.taskId; });
  assert.equal(f.verify().state, 'verified');
});

test('duplicate results do not notify repeatedly; changed ready/blocked/failed results invalidate verification', (t) => {
  const f = fixture(t); const first = f.ready();
  const input = { action: 'result', id: 'task', status: 'ready', commit: SHA, report: f.report, evidence: [f.proof] };
  f.verify();
  const again = taskAction(f.store, 'worker-task', input);
  assert.equal(again.result.id, first.result.id); assert.equal(again.state, 'verified');
  assert.deepEqual(f.store.read().notifications, {});
  for (const status of ['blocked', 'failed']) {
    const changed = taskAction(f.store, 'worker-task', { ...input, status });
    assert.equal(changed.result.status, status); assert.equal(changed.state, 'blocked'); assert.equal(changed.verification, undefined);
  }
  const failedId = f.store.read().tasks.task.result.id;
  taskAction(f.store, 'worker-task', { action: 'start', id: 'task' });
  const repeatedFailure = taskAction(f.store, 'worker-task', { ...input, status: 'failed' });
  assert.equal(repeatedFailure.state, 'blocked'); assert.equal(repeatedFailure.result.id, failedId);
  const changed = taskAction(f.store, 'worker-task', { ...input, commit: OTHER_SHA });
  assert.notEqual(changed.result.id, first.result.id); assert.equal(changed.verification, undefined);
  assert.deepEqual(f.store.read().notifications, {});
});

test('dependency gate requires verified results, not ready or skipped, and detects stale plans', (t) => {
  const f = fixture(t); f.ready('dep'); f.create('dependent', ['dep']); f.approve('dependent');
  f.agent('worker', 'implementer', 'dependent');
  const start = () => taskAction(f.store, 'worker', { action: 'start', id: 'dependent' });
  assert.throws(start, /Dependency/); f.verify('dep'); assert.equal(start().state, 'implementing');
  f.create('skipped'); taskAction(f.store, 'coord', { action: 'skip', id: 'skipped', reason: 'not required' });
  f.create('needs-skipped', ['skipped']); f.approve('needs-skipped');
  assert.throws(() => taskAction(f.store, 'coord', { action: 'start', id: 'needs-skipped' }), /Dependency/);
  assert.throws(() => f.approve('skipped'), /Terminal/);
  assert.throws(() => f.store.transact((s) => { s.tasks.dep.dependencies = ['dependent']; }), /cycle/);
});

test('nested tasks require owned approved scope and current ancestor plan', (t) => {
  const f = fixture(t); f.create('parent'); f.agent('planner', 'planner', 'parent');
  const create = { action: 'create', id: 'child', title: 'nested task', planPath: f.plan, parentTask: 'parent' };
  assert.throws(() => taskAction(f.store, 'planner', create), /not approved/);
  f.approve('parent'); assert.equal(taskAction(f.store, 'planner', create).state, 'planned');
  assert.throws(() => taskAction(f.store, 'planner', { action: 'start', id: 'parent' }), /Implementer/);
  assert.throws(() => taskAction(f.store, 'planner', { ...create, id: 'unscoped', parentTask: undefined }), /parent scope/);
  f.create('other'); f.approve('other');
  assert.throws(() => taskAction(f.store, 'planner', { ...create, id: 'outside', parentTask: 'other' }), /own task scope/);
  f.approve('child');
  const childPlan = join(f.dir, 'child.md'); writeFileSync(childPlan, 'child plan');
  f.store.transact((s) => { s.tasks.child.planPath = childPlan; }); f.approve('child');
  writeFileSync(f.plan, 'parent scope changed');
  assert.throws(() => taskAction(f.store, 'coord', { action: 'start', id: 'child' }), /Parent scope/);
});

test('reservations conflict across exact keys and ancestor paths, with owner-scoped release', (t) => {
  const f = fixture(t); f.create('one'); f.create('two'); f.agent('one-agent', 'implementer', 'one'); f.agent('two-agent', 'implementer', 'two');
  const reserve = (kind, scope, value, taskId = 'one', actor = 'coord') => resourceAction(f.store, actor, { action: 'reserve', kind, scope, value, taskId });
  const port = reserve('port', 'host-a', '5432');
  assert.equal(reserve('port', 'host-a', '5432').id, port.id);
  assert.throws(() => reserve('port', 'host-a', '5432', 'two'), /conflicts/);
  // Ports and Compose names are host-wide: scope is a label, defaulting to localhost.
  assert.throws(() => reserve('port', 'host-b', '5432', 'two'), /conflicts.*port 5432 is held by task one/);
  assert.equal(reserve('port', undefined, '5432').id, port.id);
  for (const value of ['0', '65536', '01', '-2', '1.5', '5-4', '1-65536', '23100-']) assert.throws(() => reserve('port', 'host', value), /port number or range/);
  const range = reserve('port', undefined, '23100-23115', 'two');
  assert.equal(range.scope, 'localhost'); assert.equal(range.value, '23100-23115');
  assert.throws(() => reserve('port', undefined, '23115'), /port 23100-23115 is held by task two/);
  assert.throws(() => reserve('port', undefined, '23090-23100'), /conflicts/);
  assert.equal(reserve('port', undefined, '23116-23120').value, '23116-23120');
  assert.equal(reserve('port', undefined, '5000-5000').value, '5000');
  // A migration scope is a real directory, keyed by its repository and repository-relative path.
  mkdirSync(join(f.dir, '.git')); mkdirSync(join(f.dir, 'db'));
  assert.throws(() => reserve('migration', undefined, '1'), /Migration scope required/);
  assert.throws(() => reserve('migration', 'repo/db', '1'), /Migration directory not found/);
  for (const value of ['0', '01', '-2', '9007199254740992']) assert.throws(() => reserve('migration', 'db', value), /migration number/);
  const migration = reserve('migration', 'db', '1');
  assert.equal(migration.scope, `${realpathSync(join(f.dir, '.git'))}:db`);
  assert.throws(() => reserve('migration', join(f.dir, 'db'), '1', 'two'), /conflicts/);
  reserve('compose', 'host-a', 'stack'); assert.throws(() => reserve('compose', 'host-a', 'stack', 'two'), /conflicts/);
  assert.throws(() => reserve('compose', undefined, 'stack', 'two'), /compose stack is held by task one/);
  reserve('file', f.dir, 'src'); assert.throws(() => reserve('file', f.dir, 'src/deep/new.ts', 'two'), /conflicts/);
  assert.throws(() => reserve('file', f.dir, '..'), /within/);
  mkdirSync(join(f.dir, 'src')); symlinkSync(join(f.dir, 'src'), join(f.dir, 'alias'));
  assert.throws(() => reserve('file', f.dir, 'alias/new.ts', 'two'), /conflicts/);
  assert.throws(() => reserve('file', join(f.dir, 'src'), 'nested.ts', 'two'), /conflicts/);
  assert.throws(() => reserve('file', f.dir, '.', 'two'), /conflicts/);
  symlinkSync(join(f.dir, 'missing-target'), join(f.dir, 'dangling'));
  assert.throws(() => reserve('file', f.dir, 'dangling/new.ts'), /ENOENT/);
  assert.throws(() => reserve('file', f.report, 'new.ts'), /directory/);
  assert.throws(() => resourceAction(f.store, 'two-agent', { action: 'release', id: port.id }), /owning/);
  assert.throws(() => reserve('port', 'host-a', '1234', 'two', 'one-agent'), /another task/);
  resourceAction(f.store, 'one-agent', { action: 'release', id: port.id }); reserve('port', 'host-a', '5432', 'two');
  assert.throws(() => resourceAction(f.store, 'coord', { action: 'steal', id: port.id }), /Unknown/);
});

test('release requires explicit human grant, exact verification, role and durable single lock', (t) => {
  const f = fixture(t); f.ready(); f.verify();
  assert.throws(() => releaseAction(f.store, 'coord', { action: 'claim', taskId: 'task' }), /authorization/);
  f.authorize();
  assert.throws(() => releaseAction(f.store, 'worker-task', { action: 'claim', taskId: 'task' }), /role/);
  const release = releaseAction(f.store, 'coord', { action: 'claim', taskId: 'task' });
  const reopened = openStore(f.root, false);
  assert.equal(reopened.read().releaseLock.token, release.token); reopened.close();
  assert.throws(() => releaseAction(f.store, 'coord', { action: 'claim', taskId: 'task' }), /already held/);
  f.agent('releaser', 'release');
  assert.throws(() => releaseAction(f.store, 'releaser', { action: 'unlock', taskId: 'task', token: release.token, reason: 'no' }), /owner/);
  assert.throws(() => releaseAction(f.store, 'coord', { action: 'unlock', taskId: 'task', token: 'wrong', reason: 'no' }), /owner/);
  assert.throws(() => releaseAction(f.store, 'coord', { action: 'unlock', taskId: 'task', token: release.token, reason: '' }), /requires a reason/);
  assert.throws(() => releaseAction(f.store, 'coord', { action: 'unlock', taskId: 'task' }), /requires a reason/);
  assert.throws(() => releaseAction(f.store, 'releaser', { action: 'unlock', taskId: 'task', reason: 'no' }), /owned by coord/);
  f.store.transact((s) => { delete s.releaseGrants; });
  assert.throws(() => f.record(release, 'pr', { pr: 'https://example.test/pr/1' }), /authorization/);
  // Revocation does not prevent the owner from explicitly relinquishing its lock, token omitted.
  releaseAction(f.store, 'coord', { action: 'unlock', taskId: 'task', reason: 'cancelled by human' });
  assert.equal(f.store.read().releaseLock, undefined);
});

test('release attestations advance only in order, block without stealing, and bind deployment to merge', (t) => {
  const f = fixture(t); f.ready(); f.verify(); f.authorize();
  const release = releaseAction(f.store, 'coord', { action: 'claim', taskId: 'task' });
  assert.throws(() => f.record(release, 'merged', { mergedCommit: SHA }), /order/);
  assert.throws(() => f.record(release, 'pr'), /PR URL/);
  assert.throws(() => f.record(release, 'pr', { pr: 'file:///tmp/x' }), /URL/);
  assert.throws(() => releaseAction(f.store, 'coord', { action: 'record', taskId: 'task', token: release.token, stage: 'pr', pr: 'https://example.test/pr/1', evidence: [] }), /evidence/);
  f.record(release, 'blocked'); assert.equal(f.store.read().releaseLock.token, release.token);
  f.record(release, 'pr', { pr: 'https://example.test/pr/1' });
  f.record(release, 'blocked');
  f.record(release, 'merged', { mergedCommit: OTHER_SHA });
  assert.equal(f.store.read().tasks.task.state, 'merged');
  assert.throws(() => f.approve('task'), /Terminal/);
  assert.throws(() => f.record(release, 'deployed', { deployedCommit: SHA }), /equal merged/);
  f.record(release, 'deployed', { deployedCommit: OTHER_SHA }); f.record(release, 'cleaned');
  assert.equal(f.store.read().tasks.task.state, 'deployed');
  assert.equal(f.store.read().releaseLock.token, release.token);
  assert.throws(() => f.record(release, 'blocked'), /cleaned/);
  releaseAction(f.store, 'coord', { action: 'unlock', taskId: 'task', token: release.token, reason: 'release complete' });
  assert.match(f.store.read().tasks.task.history.at(-1).note, /release complete/);
});

test('release records reject plan edits after claim and retain the lock', (t) => {
  const f = fixture(t); f.ready(); f.verify(); f.authorize();
  const release = releaseAction(f.store, 'coord', { action: 'claim', taskId: 'task' });
  writeFileSync(f.plan, 'post-claim mutation');
  assert.throws(() => f.record(release, 'pr', { pr: 'https://example.test/pr/1' }), /authorization required/);
  assert.equal(f.store.read().releaseLock.token, release.token);
});

test('lower active migrations gate only their own scope until their task is merged', (t) => {
  const f = fixture(t);
  for (const id of ['lower', 'higher', 'other']) { f.ready(id); f.verify(id); }
  const reserve = (taskId, scope, value) => resourceAction(f.store, 'coord', { action: 'reserve', taskId, kind: 'migration', scope, value });
  for (const path of ['.git', 'repo/db', 'other/db']) mkdirSync(join(f.dir, path), { recursive: true });
  reserve('lower', 'repo/db', '2'); reserve('higher', 'repo/db', '3'); reserve('other', 'other/db', '1');
  f.authorize();
  assert.throws(() => releaseAction(f.store, 'coord', { action: 'claim', taskId: 'higher' }), /Lower active/);
  const lower = releaseAction(f.store, 'coord', { action: 'claim', taskId: 'lower' });
  f.record(lower, 'pr', { pr: 'https://example.test/pr/2' }); f.record(lower, 'merged', { mergedCommit: SHA });
  releaseAction(f.store, 'coord', { action: 'unlock', taskId: 'lower', token: lower.token, reason: 'merged, defer deployment' });
  const higher = releaseAction(f.store, 'coord', { action: 'claim', taskId: 'higher' });
  assert.equal(higher.stage, 'claimed');
  // An already-applied external version represented by an active reservation still conflicts.
  assert.throws(() => reserve('other', 'repo/db', '2'), /conflicts/);
});

test('mailbox persists early delivery, fences generations and scopes idempotent acknowledgements', (t) => {
  const f = fixture(t); f.agent('parent', 'planner'); f.agent('child', 'implementer', undefined, 'parent');
  const message = sendMessage(f.store, 'parent', 'child', 'queued before startup', 'steer');
  assert.equal(message.generation, 'child-g1'); assert.equal(message.mode, 'steer');
  const reopened = openStore(f.root, false);
  assert.equal(pendingMessages(reopened, 'child', 'child-g1')[0].id, message.id); reopened.close();
  assert.throws(() => acknowledge(f.store, 'parent', 'parent-g1', message.id), /recipient/);
  assert.throws(() => acknowledge(f.store, 'child', 'old-generation', message.id), /Stale/);
  acknowledge(f.store, 'child', 'child-g1', message.id);
  const once = f.store.read().messages[0].acknowledgedAt;
  acknowledge(f.store, 'child', 'child-g1', message.id);
  assert.equal(f.store.read().messages[0].acknowledgedAt, once);
  assert.deepEqual(pendingMessages(f.store, 'child', 'child-g1'), []);
  const pending = sendMessage(f.store, 'coord', 'child', 'old generation');
  f.store.transact((s) => { s.agents.child.generation = 'child-g2'; });
  assert.throws(() => pendingMessages(f.store, 'child', 'child-g1'), /Stale/);
  assert.deepEqual(pendingMessages(f.store, 'child', 'child-g2'), []);
  assert.throws(() => acknowledge(f.store, 'child', 'child-g2', pending.id), /generation/);
  sendMessage(f.store, 'parent', 'child', 'new generation');
  assert.equal(pendingMessages(f.store, 'child', 'child-g2').length, 1);
});

test('mail routing allows ancestry/coordinator, rejects peers and restricts shutdown to immediate parent', (t) => {
  const f = fixture(t); f.agent('parent', 'planner'); f.agent('child', 'implementer', undefined, 'parent');
  f.agent('grandchild', 'implementer', undefined, 'child'); f.agent('peer', 'implementer');
  sendMessage(f.store, 'parent', 'grandchild', 'ancestor'); sendMessage(f.store, 'grandchild', 'parent', 'descendant');
  sendMessage(f.store, 'peer', 'coord', 'route via coordinator'); sendMessage(f.store, 'coord', 'grandchild', 'coordinator');
  // By default workers get steering, delivered after their current tool batch; the coordinator and shutdowns wait for idle.
  assert.equal(sendMessage(f.store, 'parent', 'grandchild', 'default to a worker').mode, 'steer');
  assert.equal(sendMessage(f.store, 'peer', 'coord', 'default to the coordinator').mode, 'followUp');
  assert.equal(sendMessage(f.store, 'child', 'grandchild', 'stop', undefined, 'shutdown').mode, 'followUp');
  assert.throws(() => sendMessage(f.store, 'peer', 'child', 'no'), /Unrelated/);
  assert.throws(() => sendMessage(f.store, 'grandchild', 'parent', 'no', 'followUp', 'shutdown'), /Shutdown/);
  assert.throws(() => sendMessage(f.store, 'parent', 'grandchild', 'no', 'followUp', 'shutdown'), /Shutdown/);
  sendMessage(f.store, 'child', 'grandchild', 'stop', 'followUp', 'shutdown');
  sendMessage(f.store, 'coord', 'grandchild', 'stop', 'followUp', 'shutdown');
  assert.throws(() => sendMessage(f.store, 'parent', 'child', 'x'.repeat(16385)), /body/);
  assert.throws(() => sendMessage(f.store, 'parent', 'child', '🦊'.repeat(4097)), /body/);
  assert.throws(() => sendMessage(f.store, 'parent', 'child', 'no', 'keys'), /mode/);
  assert.throws(() => sendMessage(f.store, 'parent', 'child', 'no', 'steer', 'keystrokes'), /kind/);
  f.store.transact((s) => { s.agents.child.lifecycle = 'exited'; });
  assert.throws(() => sendMessage(f.store, 'parent', 'child', 'no'), /active/);
});

test('malformed/truncated grants fail schema validation without partial persistence', t => {
  const f = fixture(t); f.ready(); f.verify(); f.authorize();
  const original = f.store.read();
  const mutations = [
    g => { delete g.id; }, g => { g.scope = []; }, g => { g.scope[0].action = 'all'; },
    g => { g.scope[0].planHash = 'truncated'; }, g => { g.scope[0].taskId = 'future'; },
    g => { delete g.confirmation; }, g => { g.confirmation.kind = 'rpc'; },
    g => { g.confirmation.at = -1; }, g => { delete g.confirmation.branchAnchor; },
    g => { g.confirmation.digest = 'a'.repeat(64); }, g => { g.scope[0].action = 'merge'; },
    g => { g.continuation = {}; }, g => { g.scope[2].deploymentTarget = undefined; },
  ];
  for (const mutate of mutations) {
    assert.throws(() => f.store.transact(s => mutate(s.releaseGrants[0])), /schema/);
    assert.deepEqual(f.store.read(), original);
  }
  assert.throws(() => f.store.transact(s => { s.releaseGrants.push(s.releaseGrants[0]); }), /schema/);
  const reopened = openStore(f.store.root, false); assert.deepEqual(reopened.read().releaseGrants, original.releaseGrants); reopened.close();
});

test('grants confirmed with the older JSON displays still load; other display text does not', t => {
  const f = fixture(t); f.ready(); f.verify(); f.authorize();
  const restamp = (g, text) => {
    g.confirmation.displayedScope = text;
    g.confirmation.digest = createHash('sha256').update(text).digest('hex');
  };
  for (const layout of [0, 2]) {
    f.store.transact(s => { const g = s.releaseGrants[0]; restamp(g, displayReleaseScope(g.root, g.scope, g.source, layout)); });
    const reopened = openStore(f.store.root, false); assert.equal(reopened.read().releaseGrants.length, 1); reopened.close();
  }
  assert.throws(() => f.store.transact(s => { const g = s.releaseGrants[0]; restamp(g, `${g.confirmation.displayedScope} extra`); }), /^Error: Invalid registry schema at releaseGrants\[0\]$/);
  assert.throws(() => f.store.transact(s => { s.tasks.task.state = 'nonsense'; }), /^Error: Invalid registry schema at tasks\.task$/, 'failures name the entry');
});

test('copied grant cannot authorize a sibling registry even for identical task IDs/plans', t => {
  const a = fixture(t), b = fixture(t); a.ready(); a.verify(); a.authorize();
  // The exact same plan bytes and task ID are deliberately used across these isolated registries.
  b.ready(); b.verify();
  b.store.transact(s => { s.tasks.task.planPath = a.store.read().tasks.task.planPath; s.releaseGrants = a.store.read().releaseGrants; });
  assert.throws(() => releaseAction(b.store, 'coord', { action: 'claim', taskId: 'task' }), /authorization required/);
  assert.equal(b.store.read().releaseLock, undefined);
});

test('strict pre-action check preserves lock, role, token, stage and full-SHA deployment gates', t => {
  const f = fixture(t); f.ready(); f.verify(); f.authorize();
  const release = releaseAction(f.store, 'coord', { action: 'claim', taskId: 'task' });
  const check = operation => releaseAction(f.store, 'coord', { action: 'check', taskId: 'task', token: release.token, operation, deploymentTarget: 'synthetic' });
  assert.equal(check('pr').allowed, true);
  assert.throws(() => check('merge'), /advance in order/);
  assert.throws(() => releaseAction(f.store, 'worker-task', { action: 'check', taskId: 'task', token: release.token, operation: 'pr' }), /Release role/);
  f.record(release, 'pr', { pr: 'https://example.test/pull/1' }); assert.equal(check('merge').allowed, true);
  f.record(release, 'merged', { mergedCommit: SHA }); assert.equal(check('deploy').allowed, true);
  assert.throws(() => f.record(release, 'deployed', { deployedCommit: OTHER_SHA }), /equal merged SHA/);
  releaseAction(f.store, 'coord', { action: 'unlock', taskId: 'task', token: release.token, reason: 'reconcile' });
  assert.throws(() => check('deploy'), /lock owner/);
});

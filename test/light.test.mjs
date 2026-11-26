import test from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.ts';
import { releaseAction, resourceAction, sendMessage, taskAction, releaseScope, displayReleaseScope } from '../src/workflow.ts';
import { spawnAgent } from '../src/runtime.ts';
import { notices } from '../src/bridge.ts';
import { alerts, board, counts, statusLine } from '../src/board.ts';
import { preflight } from '../src/preflight.ts';
import { LIMITS } from '../src/contracts.ts';

const SHA = 'a'.repeat(40);
const NEXT = 'b'.repeat(40);
const MAIN = 'c'.repeat(40);

// Synthetic light registry: coordinator, feature owners and helpers; no processes or network.
function fixture(t, profile = 'light') {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'orchestrator-light-test-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const plan = join(dir, 'plan.md'); const report = join(dir, 'report.md'); const proof = join(dir, 'smoke.log');
  writeFileSync(plan, 'Feature plan\n'); writeFileSync(report, 'Owner report\n'); writeFileSync(proof, 'Isolated smoke passed\n');
  const store = openStore(join(dir, 'registry'));
  t.after(() => store.close());
  store.transact((s) => { if (profile) s.profile = profile; });
  const agent = (id, role = 'implementer', taskId, parentId = 'coord', extra = {}) => store.transact((s) => {
    s.agents[id] = { id, role, ...(parentId ? { parentId } : {}), ...(taskId ? { taskId } : {}), model: 'openai-codex/gpt-6-astra',
      generation: `${id}-g1`, lifecycle: 'running', worktree: join(dir, id), sessionDir: join(dir, 'sessions', id), piSessionId: `${id}-session`, ...extra };
  });
  agent('coord', 'coordinator', undefined, null);
  const create = (id, extra = {}) => taskAction(store, 'coord', { action: 'create', id, title: id, planPath: plan, ...extra });
  const start = (id, who = `owner-${id}`) => taskAction(store, who, { action: 'start', id });
  const ready = (id, who = `owner-${id}`, commit = SHA) => taskAction(store, who, { action: 'result', id, status: 'ready', commit, report, evidence: [proof] });
  const verify = (id, who = `owner-${id}`, commit = SHA) => taskAction(store, who, { action: 'verify', id, commit, evidence: [proof] });
  const owner = (id) => { create(id); agent(`owner-${id}`, 'implementer', id); start(id); ready(id); return verify(id); };
  const authorize = (proposals = Object.keys(store.read().tasks).flatMap(taskId => ['pr', 'merge', 'deploy'].map(action => ({ taskId, action, ...(action === 'deploy' ? { deploymentTarget: 'synthetic' } : {}) })))) => store.transact((s) => {
    const scope = releaseScope(s, proposals), displayedScope = displayReleaseScope(store.root, scope);
    (s.releaseGrants ??= []).push({ id: `synthetic-${s.revision}`, root: store.root, scope, confirmation: {
      kind: 'tui', coordinator: 'coord', generation: 'coord-g1', sessionId: 'coord-session', sessionFile: join(dir, 'session.jsonl'), branchAnchor: null,
      origin: 'tool', toolCallId: 'synthetic-call', at: Date.now(), displayedScope, digest: createHash('sha256').update(displayedScope).digest('hex'),
    } });
  });
  const record = (release, stage, fields = {}) => releaseAction(store, release.owner, { action: 'record', taskId: release.taskId, token: release.token, stage, deploymentTarget: 'synthetic', evidence: [proof], ...fields });
  return { dir, plan, report, proof, store, agent, create, start, ready, verify, owner, authorize, record };
}

for (const profile of ['light', 'strict']) for (const submitted of ['ready', 'verified']) {
  test(`explicit start reopens ${submitted} for corrections without losing the submitted candidate (${profile})`, t => {
    const f = fixture(t, profile);
    f.create('feature'); f.agent('owner-feature', 'implementer', 'feature');
    if (profile === 'strict') taskAction(f.store, 'coord', { action: 'approve', id: 'feature', source: 'synthetic approval' });
    f.start('feature'); f.ready('feature');
    if (submitted === 'verified') f.verify('feature', profile === 'strict' ? 'coord' : 'owner-feature');
    const prior = f.store.read().tasks.feature;
    assert.equal(counts(f.store.read()).ready, 1);
    const rework = f.start('feature');
    assert.equal(rework.state, 'implementing');
    assert.deepEqual(rework.result, prior.result);
    assert.equal(readFileSync(rework.result.report, 'utf8'), 'Owner report\n');
    assert.equal(readFileSync(rework.result.evidence[0], 'utf8'), 'Isolated smoke passed\n');
    assert.deepEqual(rework.history.slice(0, -1), prior.history);
    assert.match(rework.history.at(-1).note, /Rework.*owner-feature/);
    assert.equal(rework.verification, undefined, 'old acceptance must not authorize release');
    assert.equal(counts(f.store.read()).ready, 0);
    assert.equal(counts(f.store.read()).building, 1);
    assert.match(statusLine(f.store.read()), /1 building/);
    assert.doesNotMatch(statusLine(f.store.read()), /1 ready/);
    assert.deepEqual(f.start('feature'), rework, 'repeated start remains idempotent');
    assert.throws(() => f.verify('feature', 'coord'), /Ready result required/);
    f.authorize();
    assert.throws(() => releaseAction(f.store, 'coord', { action: 'claim', taskId: 'feature' }), /must be verified/);
    const correctedReport = join(f.dir, 'corrected.md'); writeFileSync(correctedReport, 'Corrected candidate\n');
    taskAction(f.store, 'owner-feature', { action: 'result', id: 'feature', status: 'ready', commit: NEXT, report: correctedReport, evidence: [f.proof] });
    const corrected = f.store.read().tasks.feature;
    assert.equal(corrected.state, 'ready'); assert.equal(corrected.result.commit, NEXT);
    assert.deepEqual(corrected.history.slice(0, rework.history.length), rework.history);
    assert.equal(readFileSync(prior.result.report, 'utf8'), 'Owner report\n');
    assert.equal(counts(f.store.read()).ready, 1); assert.equal(counts(f.store.read()).building, 0);
    assert.equal(f.verify('feature', profile === 'strict' ? 'coord' : 'owner-feature', NEXT).state, 'verified');
  });
}

for (const profile of ['light', 'strict']) test(`rework dependencies and current plan gates remain enforced (${profile})`, t => {
  const f = fixture(t, profile);
  f.create('feature'); f.agent('owner-feature', 'implementer', 'feature');
  const approve = id => taskAction(f.store, 'coord', { action: 'approve', id, source: 'synthetic approval' });
  if (profile === 'strict') approve('feature');
  f.start('feature'); f.ready('feature');
  if (profile === 'strict') f.verify('feature', 'coord');
  f.create('consumer', { dependencies: ['feature'] }); f.agent('owner-consumer', 'implementer', 'consumer');
  if (profile === 'strict') approve('consumer');
  f.start('feature');
  assert.throws(() => f.start('consumer'), /Dependency/);
  f.ready('feature');
  if (profile === 'strict') {
    assert.throws(() => f.start('consumer'), /Dependency/);
    f.verify('feature', 'coord');
  }
  assert.equal(f.start('consumer').state, 'implementing');
  if (profile === 'strict') {
    writeFileSync(f.plan, 'changed scope\n');
    const before = f.store.read().tasks.feature;
    assert.throws(() => f.start('feature'), /not approved/);
    assert.deepEqual(f.store.read().tasks.feature, before);
  }
});

test('reopening non-shipping work removes its done count until resubmitted', t => {
  const f = fixture(t); f.create('review', { ships: false }); f.agent('reviewer', 'reviewer', 'review');
  f.start('review', 'reviewer');
  const result = { action: 'result', id: 'review', status: 'ready', report: f.report, evidence: [f.proof] };
  taskAction(f.store, 'reviewer', result);
  assert.equal(counts(f.store.read()).done, 1);
  f.start('review', 'reviewer');
  assert.equal(counts(f.store.read()).done, 0); assert.equal(counts(f.store.read()).building, 1);
  taskAction(f.store, 'reviewer', result);
  assert.equal(counts(f.store.read()).done, 1);
  assert.match(f.store.read().tasks.review.history.at(-1).note, /Repeated result/);
});

test('strict release claims continue to freeze explicit rework', t => {
  const f = fixture(t, 'strict');
  f.create('feature'); f.agent('owner-feature', 'implementer', 'feature');
  taskAction(f.store, 'coord', { action: 'approve', id: 'feature', source: 'synthetic approval' });
  f.start('feature'); f.ready('feature'); f.verify('feature', 'coord'); f.authorize();
  releaseAction(f.store, 'coord', { action: 'claim', taskId: 'feature' });
  const prior = f.store.read().tasks.feature;
  assert.throws(() => f.start('feature'), /frozen/);
  assert.deepEqual(f.store.read().tasks.feature, prior);
});

test('busy review, review messages and notes leave a submitted task ready until explicit start', t => {
  const f = fixture(t); f.create('feature'); f.agent('owner-feature', 'implementer', 'feature'); f.start('feature'); f.ready('feature');
  f.agent('reviewer', 'reviewer', 'feature', 'owner-feature', { activity: 'busy', activityAt: Date.now() });
  f.store.transact(s => { s.agents['owner-feature'].activity = 'busy'; });
  sendMessage(f.store, 'reviewer', 'owner-feature', 'Blocking finding: fix it.');
  taskAction(f.store, 'owner-feature', { action: 'note', id: 'feature', summary: 'Fixing blocking review findings' });
  const prior = f.store.read().tasks.feature;
  assert.throws(() => f.start('feature', 'reviewer'), /own ships: false task/);
  assert.deepEqual(f.store.read().tasks.feature, prior);
  assert.equal(prior.state, 'ready'); assert.equal(counts(f.store.read()).ready, 1);
  assert.equal(counts(f.store.read()).building, 0);
});

test('shipping result and verification errors identify the missing commit without changing state', (t) => {
  const f = fixture(t);
  f.create('feature'); f.agent('owner-feature', 'implementer', 'feature'); f.start('feature');
  let before = f.store.read();
  assert.throws(() => taskAction(f.store, 'owner-feature', {
    action: 'result', id: 'feature', status: 'ready', report: f.report,
  }), /ready shipping result requires commit/);
  assert.deepEqual(f.store.read(), before);
  f.ready('feature'); before = f.store.read();
  assert.throws(() => taskAction(f.store, 'owner-feature', {
    action: 'verify', id: 'feature', evidence: [f.proof],
  }), /verify requires commit\. Repeat the commit from the ready result/);
  assert.deepEqual(f.store.read(), before);
  assert.equal(f.verify('feature').verification.commit, SHA);
});

test('commitless research verification explicitly requires no commit', (t) => {
  const f = fixture(t);
  f.create('research', { ships: false }); f.start('research', 'coord');
  taskAction(f.store, 'coord', { action: 'result', id: 'research', status: 'ready', report: f.report });
  const before = f.store.read();
  assert.throws(() => taskAction(f.store, 'coord', {
    action: 'verify', id: 'research', commit: SHA, evidence: [f.proof],
  }), /Omit commit when you verify this result/);
  assert.deepEqual(f.store.read(), before);
  assert.equal(taskAction(f.store, 'coord', {
    action: 'verify', id: 'research', evidence: [f.proof],
  }).state, 'verified');
});

test('resource release errors require the returned reservation id', (t) => {
  const f = fixture(t); f.create('feature');
  const reservation = resourceAction(f.store, 'coord', {
    action: 'reserve', kind: 'port', value: '23100-23115', taskId: 'feature',
  });
  const before = f.store.read();
  assert.throws(() => resourceAction(f.store, 'coord', {
    action: 'release', kind: 'port', value: '23100-23115', taskId: 'feature',
  }), /release requires id\. Use the reservation id/);
  assert.deepEqual(f.store.read(), before);
  assert.ok(resourceAction(f.store, 'coord', { action: 'release', id: reservation.id }).releasedAt);
});

test('ordinary claim omits operation and PR records require existing evidence files', (t) => {
  const f = fixture(t); f.owner('feature'); f.authorize();
  let before = f.store.read();
  for (const operation of ['pr', 'merge', 'deploy']) {
    assert.throws(() => releaseAction(f.store, 'owner-feature', {
      action: 'claim', taskId: 'feature', operation,
    }), /Ordinary claim requires no operation field/);
    assert.deepEqual(f.store.read(), before);
  }
  const release = releaseAction(f.store, 'owner-feature', { action: 'claim', taskId: 'feature' });
  assert.equal(release.next.operation, 'pr');
  before = f.store.read();
  const record = { action: 'record', taskId: 'feature', stage: 'pr', pr: 'https://example.test/pull/1' };
  for (const evidence of [undefined, []]) {
    assert.throws(() => releaseAction(f.store, 'owner-feature', { ...record, evidence }), /Pass 1 to 256 existing file paths/);
    assert.deepEqual(f.store.read(), before);
  }
  assert.throws(() => releaseAction(f.store, 'owner-feature', {
    ...record, evidence: [join(f.dir, 'not-created.json')],
  }), /Create the file before this call, not in a parallel call/);
  assert.deepEqual(f.store.read(), before);
  assert.equal(releaseAction(f.store, 'owner-feature', { ...record, evidence: [f.proof] }).stage, 'pr');
});

test('new light registries skip per-task approval; the owner verifies and ships its own work', (t) => {
  const f = fixture(t);
  f.create('feature'); f.agent('owner-feature', 'implementer', 'feature');
  assert.equal(f.start('feature').state, 'implementing');
  f.ready('feature');
  assert.equal(f.verify('feature').state, 'verified');
  f.authorize();
  const release = releaseAction(f.store, 'owner-feature', { action: 'claim', taskId: 'feature' });
  assert.equal(f.store.read().releaseLock, undefined, 'claim does not serialize light PR/merge work');
  // A direct merge may record the PR URL at merge time.
  f.record(release, 'merged', { mergedCommit: MAIN, pr: 'https://example.test/pull/7' });
  const state = f.store.read();
  assert.equal(state.tasks.feature.state, 'merged');
  assert.equal(state.releases.feature.pr, 'https://example.test/pull/7');
});

test('light deploy lock covers merged main only, is exclusive, and allows batched deployed commits', (t) => {
  const f = fixture(t);
  f.owner('one'); f.owner('two'); f.authorize();
  const one = releaseAction(f.store, 'owner-one', { action: 'claim', taskId: 'one' });
  const two = releaseAction(f.store, 'owner-two', { action: 'claim', taskId: 'two' });
  assert.throws(() => releaseAction(f.store, 'owner-one', { action: 'lock', taskId: 'one', token: one.token, deploymentTarget: 'synthetic' }), /merge first/i);
  f.record(one, 'pr', { pr: 'https://example.test/pull/1' }); f.record(one, 'merged', { mergedCommit: SHA });
  f.record(two, 'merged', { mergedCommit: NEXT, pr: 'https://example.test/pull/2' });
  releaseAction(f.store, 'owner-one', { action: 'lock', taskId: 'one', token: one.token, deploymentTarget: 'synthetic' });
  assert.equal(releaseAction(f.store, 'owner-one', { action: 'lock', taskId: 'one', token: one.token, deploymentTarget: 'synthetic' }).token, one.token, 'relock is idempotent');
  assert.throws(() => releaseAction(f.store, 'owner-two', { action: 'lock', taskId: 'two', token: two.token, deploymentTarget: 'synthetic' }), /already held/);
  assert.equal(check(f, one, 'deploy', 'synthetic').allowed, true, 'only the lock holder may execute deployment');
  assert.throws(() => check(f, two, 'deploy', 'synthetic'), /lock owner\/token mismatch/i);
  // Main now contains both merges; one deployment serves both tasks.
  // The second owner may attest that batch, but may not execute a competing deployment.
  f.record(one, 'deployed', { deployedCommit: MAIN });
  f.record(two, 'deployed', { deployedCommit: MAIN });
  releaseAction(f.store, 'owner-one', { action: 'unlock', taskId: 'one', token: one.token, reason: 'deploy + smoke done' });
  assert.equal(f.store.read().releaseLock, undefined);
  assert.equal(f.store.read().tasks.two.state, 'deployed');
  f.record(two, 'cleaned');
});

test('deploy execution check matches the locked task and token even for the same owner', t => {
  const f = fixture(t); f.owner('one'); f.owner('two'); f.authorize();
  const one = releaseAction(f.store, 'coord', { action: 'claim', taskId: 'one' });
  const two = releaseAction(f.store, 'coord', { action: 'claim', taskId: 'two' });
  f.record(one, 'merged', { mergedCommit: SHA }); f.record(two, 'merged', { mergedCommit: NEXT });
  releaseAction(f.store, 'coord', { action: 'lock', taskId: 'one', token: one.token, deploymentTarget: 'synthetic' });
  assert.equal(check(f, one, 'deploy', 'synthetic').allowed, true);
  assert.throws(() => check(f, two, 'deploy', 'synthetic'), /lock owner\/token mismatch/i);
  f.record(one, 'deployed', { deployedCommit: MAIN }); f.record(two, 'deployed', { deployedCommit: MAIN });
});

test('light owners keep fixing an open PR; only the recorded merge freezes the task', (t) => {
  const f = fixture(t); f.owner('feature'); f.authorize();
  const release = releaseAction(f.store, 'owner-feature', { action: 'claim', taskId: 'feature' });
  f.record(release, 'pr', { pr: 'https://example.test/pull/9' });
  f.start('feature');
  const executionCheck = operation => releaseAction(f.store, 'owner-feature', { action: 'check', taskId: 'feature', operation });
  for (const operation of ['pr', 'merge']) assert.throws(() => executionCheck(operation), /must be verified/);
  assert.throws(() => f.record(release, 'merged', { mergedCommit: MAIN }), /must be verified/);
  f.ready('feature', 'owner-feature', NEXT);
  assert.throws(() => executionCheck('merge'), /must be verified/);
  f.verify('feature', 'owner-feature', NEXT);
  assert.equal(executionCheck('merge').allowed, true);
  assert.equal(f.store.read().releases.feature.commit, NEXT, 'the open release follows the latest verified commit');
  f.record(release, 'merged', { mergedCommit: MAIN });
  assert.throws(() => f.ready('feature', 'owner-feature', SHA), /Terminal|frozen/);
  assert.throws(() => f.start('feature'), /Terminal/);
});

test('risky light tasks keep human plan approval and independent verification', (t) => {
  const f = fixture(t);
  f.create('schema', { risky: true }); f.agent('owner-schema', 'implementer', 'schema');
  assert.throws(() => f.start('schema'), /not approved/);
  taskAction(f.store, 'coord', { action: 'approve', id: 'schema', source: 'Synthetic human confirmation' });
  f.start('schema'); f.ready('schema');
  assert.throws(() => f.verify('schema'), /Coordinator/);
  assert.equal(taskAction(f.store, 'coord', { action: 'verify', id: 'schema', commit: SHA, evidence: [f.proof] }).state, 'verified');
  // Risk is inherited by nested scope.
  taskAction(f.store, 'owner-schema', { action: 'create', id: 'schema-part', title: 'part', planPath: f.plan, parentTask: 'schema' });
  f.agent('helper', 'implementer', 'schema-part', 'owner-schema');
  assert.throws(() => taskAction(f.store, 'helper', { action: 'start', id: 'schema-part' }), /not approved/);
});

test('light consumers stack on a ready dependency; risky dependencies must be verified', (t) => {
  const f = fixture(t);
  f.create('base'); f.agent('owner-base', 'implementer', 'base');
  f.create('consumer', { dependencies: ['base'] }); f.agent('owner-consumer', 'implementer', 'consumer');
  assert.throws(() => f.start('consumer'), /ready result/);
  f.start('base'); f.ready('base');
  assert.equal(f.start('consumer').state, 'implementing');
  f.create('migration', { risky: true }); taskAction(f.store, 'coord', { action: 'approve', id: 'migration', source: 'Synthetic human confirmation' });
  f.agent('owner-migration', 'implementer', 'migration'); f.start('migration'); f.ready('migration');
  f.create('reader', { dependencies: ['migration'] }); f.agent('owner-reader', 'implementer', 'reader');
  assert.throws(() => f.start('reader'), /must be verified/);
  taskAction(f.store, 'coord', { action: 'verify', id: 'migration', commit: SHA, evidence: [f.proof] });
  assert.equal(f.start('reader').state, 'implementing');
});

// A repository and a linked worktree, laid out as `git worktree add` does, without running Git.
function linkedWorktree(primary, worktree, name = 'linked') {
  const gitdir = join(primary, '.git', 'worktrees', name);
  mkdirSync(gitdir, { recursive: true }); writeFileSync(join(gitdir, 'commondir'), '../..\n');
  mkdirSync(worktree, { recursive: true }); writeFileSync(join(worktree, '.git'), `gitdir: ${gitdir}\n`);
  for (const root of [primary, worktree]) mkdirSync(join(root, 'db', 'migrations'), { recursive: true });
}

test('light releases are not queued behind lower migration reservations; collisions conflict across worktrees', (t) => {
  const f = fixture(t); f.owner('lower'); f.owner('higher'); f.authorize();
  linkedWorktree(join(f.dir, 'owner-lower'), join(f.dir, 'owner-higher'));
  // Each owner names the directory relative to its own worktree, as real owners do.
  const reserve = (taskId, value, scope = 'db/migrations') => resourceAction(f.store, `owner-${taskId}`, { action: 'reserve', taskId, kind: 'migration', scope, value });
  const lower = reserve('lower', '12'); reserve('higher', '13');
  assert.match(lower.scope, /\.git:db\/migrations$/);
  assert.throws(() => reserve('higher', '12'), /conflicts.*held by task lower/);
  assert.throws(() => reserve('higher', '12', join(f.dir, 'owner-higher', 'db', 'migrations')), /held by task lower/);
  assert.throws(() => reserve('higher', '14', 'sample core migrations'), /Migration directory not found/);
  const higher = releaseAction(f.store, 'owner-higher', { action: 'claim', taskId: 'higher' });
  assert.equal(higher.stage, 'claimed');
});

test('helpers cannot release slices; the coordinator may adopt an exited owner release', (t) => {
  const f = fixture(t); f.owner('feature'); f.authorize();
  taskAction(f.store, 'owner-feature', { action: 'create', id: 'slice', title: 'slice', planPath: f.plan, parentTask: 'feature' });
  f.agent('helper', 'implementer', 'slice', 'owner-feature');
  taskAction(f.store, 'helper', { action: 'start', id: 'slice' }); taskAction(f.store, 'helper', { action: 'result', id: 'slice', status: 'ready', commit: SHA, report: f.report });
  taskAction(f.store, 'helper', { action: 'verify', id: 'slice', commit: SHA, evidence: [f.proof] });
  assert.throws(() => releaseAction(f.store, 'helper', { action: 'claim', taskId: 'slice' }), /Release role/);
  assert.throws(() => releaseAction(f.store, 'owner-feature', { action: 'check', taskId: 'feature', operation: 'pr' }), /claim it first/);
  const release = releaseAction(f.store, 'owner-feature', { action: 'claim', taskId: 'feature' });
  // The owner may omit its claim token; anyone else learns who owns the release.
  assert.equal(releaseAction(f.store, 'owner-feature', { action: 'check', taskId: 'feature', operation: 'pr' }).allowed, true);
  assert.throws(() => releaseAction(f.store, 'coord', { action: 'check', taskId: 'feature', operation: 'pr' }), /owned by owner-feature/);
  assert.throws(() => releaseAction(f.store, 'owner-feature', { action: 'check', taskId: 'feature', operation: 'pr', token: 'stale-token' }), /mismatch/);
  f.record(release, 'pr', { pr: 'https://example.test/pull/3' });
  assert.throws(() => releaseAction(f.store, 'coord', { action: 'claim', taskId: 'feature' }), /Release is owned by owner-feature \(running\); a coordinator may adopt it only after that owner exits/);
  f.store.transact((s) => { s.agents['owner-feature'].lifecycle = 'exited'; });
  const adopted = releaseAction(f.store, 'coord', { action: 'claim', taskId: 'feature' });
  assert.equal(adopted.owner, 'coord'); assert.equal(adopted.stage, 'pr'); assert.notEqual(adopted.token, release.token);
});

test('an exited owner holding the deploy lock is adopted, not stolen', (t) => {
  const f = fixture(t); f.owner('feature'); f.owner('other'); f.authorize();
  const release = releaseAction(f.store, 'owner-feature', { action: 'claim', taskId: 'feature' });
  f.record(release, 'merged', { mergedCommit: MAIN, pr: 'https://example.test/pull/4' });
  releaseAction(f.store, 'owner-feature', { action: 'lock', taskId: 'feature', token: release.token, deploymentTarget: 'synthetic' });
  assert.throws(() => releaseAction(f.store, 'owner-feature', { action: 'claim', taskId: 'feature' }), /use its token/);
  assert.throws(() => releaseAction(f.store, 'coord', { action: 'claim', taskId: 'feature' }), /Release is owned by owner-feature \(running\)/, 'live owner keeps the lock');
  f.store.transact((s) => { s.agents['owner-feature'].lifecycle = 'exited'; });
  const adopted = releaseAction(f.store, 'coord', { action: 'claim', taskId: 'feature' });
  assert.deepEqual(f.store.read().releaseLock, { owner: 'coord', token: adopted.token, taskId: 'feature' });
  releaseAction(f.store, 'coord', { action: 'unlock', taskId: 'feature', token: adopted.token, reason: 'reconciled: deploy never started' });
  const other = releaseAction(f.store, 'owner-other', { action: 'claim', taskId: 'other' });
  f.record(other, 'merged', { mergedCommit: NEXT });
  releaseAction(f.store, 'owner-other', { action: 'lock', taskId: 'other', token: other.token, deploymentTarget: 'synthetic' });
});

test('light siblings message directly; cousins still route through a parent', (t) => {
  const f = fixture(t);
  f.create('a'); f.create('b');
  f.agent('owner-a', 'implementer', 'a'); f.agent('owner-b', 'implementer', 'b');
  f.agent('helper-a', 'implementer', undefined, 'owner-a');
  sendMessage(f.store, 'owner-a', 'owner-b', 'I am renumbering my migration after rebase');
  assert.throws(() => sendMessage(f.store, 'helper-a', 'owner-b', 'hi'), /Unrelated/);
});

test('notes are owner/coordinator status, never a state change', (t) => {
  const f = fixture(t); f.create('feature'); f.agent('owner-feature', 'implementer', 'feature'); f.agent('other', 'implementer', undefined);
  const noted = taskAction(f.store, 'owner-feature', { action: 'note', id: 'feature', summary: 'Waiting on\nyour call:  keep CI?', needsHuman: true });
  assert.deepEqual([noted.state, noted.summary.text, noted.summary.needsHuman], ['planned', 'Waiting on your call: keep CI?', true]);
  assert.throws(() => taskAction(f.store, 'other', { action: 'note', id: 'feature', summary: 'hijack' }), /owner/);
  assert.throws(() => taskAction(f.store, 'owner-feature', { action: 'note', id: 'feature', summary: '' }), /summary/);
  assert.equal(taskAction(f.store, 'coord', { action: 'note', id: 'feature', summary: 'Answered: drop CI' }).summary.needsHuman, false);
});

test('pre-profile registries stay strict and reject light shortcuts at the store boundary', (t) => {
  const f = fixture(t, null);
  f.create('feature'); f.agent('owner-feature', 'implementer', 'feature');
  assert.throws(() => f.start('feature'), /not approved/);
  assert.throws(() => f.store.transact((s) => { s.profile = 'loose'; }), /schema/);
  // A verification without matching approval is only valid for light non-risky work.
  assert.throws(() => f.store.transact((s) => {
    s.tasks.feature.state = 'ready';
    s.tasks.feature.result = { id: 'r1', status: 'ready', commit: SHA, report: f.report, evidence: [], createdAt: Date.now() };
    s.tasks.feature.verification = { commit: SHA, planHash: s.tasks.feature.planHash, evidence: [f.proof], at: Date.now() };
    s.tasks.feature.state = 'verified';
  }), /schema/);
});

test('spawn caps live subagents per orchestrator at 10, helpers included, and helpers cannot recruit', async (t) => {
  const f = fixture(t);
  const repo = join(f.dir, 'repo'); mkdirSync(join(repo, '.git'), { recursive: true });
  const extension = join(f.dir, 'extension.ts'); writeFileSync(extension, '// never loaded\n');
  const failing = async () => { throw Object.assign(new Error('synthetic runner'), { code: 1 }); };
  const spawn = (parent, id, taskId) => spawnAgent(f.store, parent, { id, taskId, role: 'implementer', repo, base: 'HEAD', branch: `agents/${id}`, worktree: join(f.dir, `wt-${id}`), prompt: 'Synthetic' }, extension, failing);
  const running = (id) => f.store.transact((s) => { s.agents[id].lifecycle = 'running'; delete s.agents[id].launchError; });
  for (let i = 0; i < LIMITS.agents - 1; i++) {
    f.create(`t${i}`);
    const agent = await spawn('coord', `o${i}`, `t${i}`);
    assert.match(agent.launchError, /model availability/, 'unapproved light task passes authorization and reaches preflight');
    running(`o${i}`);
  }
  taskAction(f.store, 'o0', { action: 'create', id: 'slice', title: 'slice', planPath: f.plan, parentTask: 't0' });
  const helper = await spawn('o0', 'helper', 'slice'); running('helper');
  assert.equal(helper.parentId, 'o0');
  f.create('extra');
  await assert.rejects(spawn('coord', 'o-extra', 'extra'), /at most 10 subagents/);
  taskAction(f.store, 'helper', { action: 'create', id: 'sub', title: 'sub', planPath: f.plan, parentTask: 'slice' });
  await assert.rejects(spawn('helper', 'deep', 'sub'), /helpers cannot spawn/);
  // Closing one frees a slot.
  f.store.transact((s) => { s.agents.o1.lifecycle = 'closed'; });
  assert.match((await spawn('coord', 'o-extra', 'extra')).launchError, /model availability/);
});

test('idle owners nudge the parent once per idle episode; waits and human questions are respected', (t) => {
  const f = fixture(t); f.create('feature');
  const now = Date.now();
  f.agent('owner-feature', 'implementer', 'feature', 'coord', { activity: 'idle', activityAt: now - LIMITS.idleMs - 1, heartbeatAt: now, pid: process.pid });
  const coord = f.store.read().agents.coord;
  const idle = () => notices(f.store.read(), coord, now).filter((n) => n.key.startsWith('idle:'));
  assert.equal(idle().length, 1);
  assert.match(idle()[0].text, /no blocker recorded/);
  taskAction(f.store, 'owner-feature', { action: 'note', id: 'feature', summary: 'Which auth provider?', needsHuman: true });
  assert.equal(idle().length, 0);
  assert.ok(notices(f.store.read(), coord, now).some((n) => n.key.startsWith('human:feature:')));
  f.store.transact((s) => { s.notifications.coord = [notices(s, coord, now).find((n) => n.key.startsWith('human:')).key]; });
  assert.equal(notices(f.store.read(), coord, now).filter((n) => n.key.startsWith('human:')).length, 0, 'acknowledged once');
});

test('a busy owner stuck in one tool call is reported once per episode to the coordinator, the human and the board', (t) => {
  const f = fixture(t); f.create('feature');
  const now = Date.now();
  const since = now - LIMITS.stallMs - 2 * 60_000;
  f.agent('owner-feature', 'implementer', 'feature', 'coord', { activity: 'busy', activityAt: since - 60_000, heartbeatAt: now, pid: process.pid,
    progressAt: since, currentTool: { name: 'ask_user', since } });
  const coord = f.store.read().agents.coord;
  const stuck = () => notices(f.store.read(), coord, now).filter((n) => n.key.startsWith('stuck:'));
  assert.equal(stuck().length, 1);
  assert.match(stuck()[0].text, /owner-feature: blocked in ask_user 12m on feature/);
  assert.match(stuck()[0].text, /NOT proof of failure/);
  const ui = alerts(f.store.read(), now).filter((a) => a.key.startsWith('ui:stuck:owner-feature:'));
  assert.equal(ui.length, 1); assert.equal(ui[0].level, 'warning');
  assert.match(board(f.store.read(), now).find((line) => line.includes('feature')), /owner-feature in ask_user 12m/);
  assert.match(statusLine(f.store.read(), now), /1 stuck/);
  assert.equal(f.store.read().tasks.feature.state, 'planned', 'observation only; no failure transition');
  // Acknowledged once; new progress ends the episode and a later stall is a new one.
  const key = stuck()[0].key;
  f.store.transact((s) => { s.notifications.coord = [key]; });
  assert.equal(stuck().length, 0);
  f.store.transact((s) => { s.agents['owner-feature'].progressAt = now - 60_000; s.agents['owner-feature'].heartbeatAt = now + LIMITS.stallMs; delete s.agents['owner-feature'].currentTool; });
  assert.equal(stuck().length, 0, 'recent progress is not a stall');
  assert.equal(notices(f.store.read(), coord, now + LIMITS.stallMs).filter((n) => n.key.startsWith('stuck:')).length, 1);
  assert.match(notices(f.store.read(), coord, now + LIMITS.stallMs).find((n) => n.key.startsWith('stuck:')).text, /busy 11m without progress/);
});

test('a long tool call within its declared timeout is not a stall; past it, or without one, it still alerts', (t) => {
  const f = fixture(t); f.create('feature');
  const now = Date.now();
  const since = now - LIMITS.stallMs - 2 * 60_000;
  f.agent('owner-feature', 'implementer', 'feature', 'coord', { activity: 'busy', activityAt: since, heartbeatAt: now, pid: process.pid,
    progressAt: since, currentTool: { name: 'wait_for', since, until: since + 30 * 60_000 } });
  const coord = f.store.read().agents.coord;
  const stuck = (at) => notices(f.store.read(), coord, at).filter((n) => n.key.startsWith('stuck:'));
  assert.deepEqual(stuck(now), [], 'wait_for within its timeout_s is legitimate');
  assert.deepEqual(alerts(f.store.read(), now).filter((a) => a.key.startsWith('ui:stuck:')), []);
  assert.doesNotMatch(board(f.store.read(), now).join('\n'), /in wait_for/);
  assert.doesNotMatch(statusLine(f.store.read(), now), /stuck/);
  // Once its own budget has passed, normal stall detection resumes.
  f.store.transact((s) => { s.agents['owner-feature'].heartbeatAt = since + 30 * 60_000; });
  assert.match(stuck(since + 30 * 60_000)[0].text, /blocked in wait_for 30m/);
  // An interactive prompt declares no timeout and still alerts at once.
  f.store.transact((s) => { s.agents['owner-feature'].currentTool = { name: 'ask_user', since }; });
  assert.match(stuck(now)[0].text, /blocked in ask_user 12m on feature; inspect its pane/);
  assert.ok(alerts(f.store.read(), now).some((a) => a.key.startsWith('ui:stuck:owner-feature:')));
});

test('stall notices do not claim an interactive prompt as fact', (t) => {
  const f = fixture(t); f.create('feature');
  const now = Date.now(), since = now - LIMITS.stallMs - 60_000;
  f.agent('owner-feature', 'implementer', 'feature', 'coord', { activity: 'busy', activityAt: since, heartbeatAt: now, pid: process.pid,
    progressAt: since, currentTool: { name: 'bash', since } });
  const [notice] = notices(f.store.read(), f.store.read().agents.coord, now).filter((n) => n.key.startsWith('stuck:'));
  assert.doesNotMatch(notice.text, /an interactive prompt waits for the human/);
  assert.match(notice.text, /may be waiting at an interactive prompt/);
});

test('a worker awaiting verification is not idle; its parent cannot reach it yet', (t) => {
  const f = fixture(t); f.create('feature');
  const now = Date.now();
  f.agent('owner-feature', 'implementer', 'feature', 'coord', { lifecycle: 'starting', activity: 'idle', activityAt: now - LIMITS.escalateMs - 1, heartbeatAt: now, pid: process.pid });
  const coord = f.store.read().agents.coord;
  assert.deepEqual(notices(f.store.read(), coord, now).filter((n) => n.key.startsWith('idle:')), []);
  assert.deepEqual(alerts(f.store.read(), now).filter((a) => a.key.startsWith('ui:stalled:')), []);
  assert.doesNotMatch(statusLine(f.store.read(), now), /idle/);
  f.store.transact((s) => { s.agents['owner-feature'].lifecycle = 'running'; });
  assert.equal(notices(f.store.read(), coord, now).filter((n) => n.key.startsWith('idle:')).length, 1, 'a genuinely idle running owner still nudges');
});

test('busy agents without progress tracking and idle agents are never reported as stuck', (t) => {
  const f = fixture(t); f.create('a'); f.create('b');
  const now = Date.now(), old = now - LIMITS.escalateMs - 1;
  f.agent('owner-a', 'implementer', 'a', 'coord', { activity: 'busy', activityAt: old, heartbeatAt: now, pid: process.pid });
  f.agent('owner-b', 'implementer', 'b', 'coord', { activity: 'idle', activityAt: now, progressAt: old, heartbeatAt: now, pid: process.pid });
  const coord = f.store.read().agents.coord;
  assert.deepEqual(notices(f.store.read(), coord, now).filter((n) => n.key.startsWith('stuck:')), []);
  assert.deepEqual(alerts(f.store.read(), now).filter((a) => a.key.startsWith('ui:stuck:')), []);
});

test('a delivered but unacknowledged steer alerts its sender and the human once', (t) => {
  const f = fixture(t); f.create('feature');
  const now = Date.now();
  f.agent('owner-feature', 'implementer', 'feature', 'coord', { activity: 'busy', activityAt: now, heartbeatAt: now, pid: process.pid });
  const message = sendMessage(f.store, 'coord', 'owner-feature', 'Rebase on main', 'steer');
  const coord = f.store.read().agents.coord;
  const unacked = (at) => notices(f.store.read(), coord, at).filter((n) => n.key.startsWith('unacked:'));
  assert.equal(unacked(now + LIMITS.ackMs).length, 0, 'undelivered messages are pending, not unacknowledged');
  f.store.transact((s) => { s.messages.find((m) => m.id === message.id).deliveredAt = now; });
  assert.equal(unacked(now + LIMITS.ackMs - 1).length, 0);
  assert.equal(unacked(now + LIMITS.ackMs).length, 1);
  assert.match(unacked(now + LIMITS.ackMs)[0].text, /owner-feature: steer message from coord delivered 5m ago and still unacknowledged/);
  assert.ok(alerts(f.store.read(), now + LIMITS.ackMs).some((a) => a.key === `ui:unacked:${message.id}` && a.level === 'warning'));
  // Another owner only hears about its own messages.
  f.agent('owner-other', 'implementer', undefined, 'coord');
  assert.equal(notices(f.store.read(), f.store.read().agents['owner-other'], now + LIMITS.ackMs).filter((n) => n.key.startsWith('unacked:')).length, 0);
  f.store.transact((s) => { s.messages.find((m) => m.id === message.id).acknowledgedAt = now + 1; });
  assert.equal(unacked(now + LIMITS.ackMs).length, 0);
});

test('strict coordinators are re-woken for ready work they have not verified', (t) => {
  const f = fixture(t, 'strict');
  f.create('feature'); taskAction(f.store, 'coord', { action: 'approve', id: 'feature', source: 'Synthetic human confirmation' });
  f.agent('owner-feature', 'implementer', 'feature'); f.start('feature'); f.ready('feature');
  const coord = f.store.read().agents.coord;
  const later = Date.now() + LIMITS.idleMs + 1;
  assert.equal(notices(f.store.read(), coord, Date.now()).filter((n) => n.key.startsWith('waiting:')).length, 0);
  assert.equal(notices(f.store.read(), coord, later).filter((n) => n.key.startsWith('waiting:')).length, 1);
});

test('board and status line summarize owners, PRs, notes and human asks', (t) => {
  const f = fixture(t); f.owner('shipped'); f.create('stuck'); f.authorize();
  const now = Date.now();
  f.agent('owner-stuck', 'implementer', 'stuck', 'coord', { activity: 'idle', activityAt: now - LIMITS.escalateMs - 1 });
  const release = releaseAction(f.store, 'owner-shipped', { action: 'claim', taskId: 'shipped' });
  f.record(release, 'merged', { mergedCommit: MAIN, pr: 'https://example.test/pull/112' });
  taskAction(f.store, 'owner-shipped', { action: 'note', id: 'shipped', summary: 'Deployed via batch' });
  const state = f.store.read();
  const lines = board(state, now);
  assert.match(lines[0], /light 1\/2 shipped/);
  assert.match(lines.find((line) => line.startsWith('✓ shipped')), /#112 .*Deployed via batch/);
  assert.match(lines.find((line) => line.includes('stuck')), /owner-stuck idle \d+m/);
  assert.match(statusLine(state, now), /1 idle/);
  const keys = alerts(state, now).map((alert) => alert.key);
  assert.ok(keys.some((key) => key.startsWith('ui:merged:shipped:')));
  assert.ok(keys.some((key) => key.startsWith('ui:stalled:owner-stuck:')));
  taskAction(f.store, 'owner-stuck', { action: 'note', id: 'stuck', summary: 'Need Android emulator approval', needsHuman: true });
  assert.match(statusLine(f.store.read(), now), /⚠ 1 need you/);
  assert.ok(board(f.store.read(), now)[1].startsWith('⚠ stuck'));
});

test('child tasks ship with their top-level task, so shipped counts only top-level tasks', (t) => {
  const f = fixture(t);
  const task = (id, state, parentTask) => ({ id, title: id, state, planPath: f.plan, planHash: 'h', dependencies: [], ...(parentTask ? { parentTask } : {}), history: [] });
  // The views only read a registry, so build the state in memory rather than through the store's schema.
  const state = structuredClone(f.store.read());
  Object.assign(state.tasks, {
    parent: task('parent', 'merged'),
    helper: task('helper', 'verified', 'parent'),
    grandchild: task('grandchild', 'ready', 'helper'),
    open: task('open', 'implementing'),
    'open-helper': task('open-helper', 'verified', 'open'),
    dropped: task('dropped', 'skipped', 'open'),
    abandoned: task('abandoned', 'skipped', 'parent'),
  });
  // Top-level: parent shipped, open still building. The open task's verified helper still awaits integration.
  assert.equal(statusLine(state), '\u2699 light 1/2 shipped \u00b7 1 building \u00b7 1 ready');
  const lines = board(state);
  for (const id of ['parent', 'helper', 'grandchild']) assert.ok(lines.some((line) => line.startsWith(`\u2713 ${id} `)), id);
  assert.ok(lines.some((line) => line.startsWith('\u25cf open-helper ')));
  assert.ok(lines.some((line) => line.startsWith('\u2013 abandoned ')), 'skipped work is never shown as shipped');
});

test('idle owners of ready or verified child tasks are not nagged; their parent integrates the work', (t) => {
  const f = fixture(t);
  const now = Date.now();
  const idleSince = now - LIMITS.escalateMs - 1;
  const task = (id, state, parentTask) => ({ id, title: id, state, planPath: f.plan, planHash: 'h', dependencies: [], ...(parentTask ? { parentTask } : {}), history: [] });
  const owner = (id, taskId) => ({ id, role: 'implementer', parentId: 'coord', taskId, model: 'openai-codex/gpt-6-astra', generation: `${id}-g1`,
    lifecycle: 'running', worktree: join(f.dir, id), sessionDir: join(f.dir, 'sessions', id), piSessionId: `${id}-session`, activity: 'idle', activityAt: idleSince });
  // The views only read a registry, so build the state in memory rather than through the store's schema.
  const state = structuredClone(f.store.read());
  Object.assign(state.tasks, { parent: task('parent', 'verified'), helper: task('helper', 'verified', 'parent') });
  Object.assign(state.agents, { 'owner-parent': owner('owner-parent', 'parent'), 'helper-agent': owner('helper-agent', 'helper') });
  // The unmerged top-level task still needs its owner to ship it; the verified helper needs nothing.
  assert.match(statusLine(state, now), /1 idle/);
  const stalled = alerts(state, now).map((alert) => alert.key).filter((key) => key.startsWith('ui:stalled:'));
  assert.deepEqual(stalled.map((key) => key.split(':')[2]), ['owner-parent']);
  const nudged = notices(state, state.agents.coord, now).filter((notice) => /helper/.test(JSON.stringify(notice)));
  assert.deepEqual(nudged, []);
});

test('preflight uses literal argv, tests real signing, and reports failures without output', async () => {
  const calls = [];
  const runner = async (command, args, options) => {
    calls.push([command, ...args].join(' '));
    if (command === 'git' && args[0] === 'config') return { stdout: 'true\n', stderr: '' };
    if (command === 'git' && args[0] === 'commit-tree') throw Object.assign(new Error('x'), { code: 1, stderr: 'error: 1Password: agent locked\nsecret-free detail' });
    if (command === 'gh') throw Object.assign(new Error('x'), { killed: true, signal: 'SIGTERM' });
    return { stdout: command === 'zellij' ? 'zellij 0.44.0\n' : '/repo\n', stderr: '' };
  };
  const result = await preflight('/repo', runner);
  assert.equal(result.ok, false);
  assert.ok(calls.includes('git commit-tree -S -m orchestrator preflight HEAD^{tree}'));
  assert.ok(result.lines.includes('FAIL Commit signing without a prompt: error: 1Password: agent locked'));
  assert.ok(result.lines.some((line) => line.startsWith('FAIL GitHub CLI authenticated: timed out')));
  assert.ok(result.lines.includes('PASS Zellij available: zellij 0.44.0'));
  const unsigned = await preflight('/repo', async (command, args) => {
    if (args[0] === 'config') throw Object.assign(new Error('unset'), { code: 1 });
    return { stdout: 'ok\n', stderr: '' };
  });
  assert.equal(unsigned.ok, true);
  assert.ok(unsigned.lines.includes('SKIP Commit signing: commit.gpgsign is not enabled'));
  const local = await preflight('/repo', async (command, args) => {
    if (args[0] === 'config' || args[0] === 'remote') throw Object.assign(new Error('absent'), { code: 2 });
    if (args[0] === 'ls-remote') throw new Error('must not probe a missing remote');
    return { stdout: 'ok\n', stderr: '' };
  });
  assert.equal(local.ok, true);
  assert.ok(local.lines.includes('SKIP Remote: no origin remote configured'));
});

const check = (f, release, operation, deploymentTarget) => releaseAction(f.store, release.owner, {
  action: 'check', taskId: release.taskId, token: release.token, operation, ...(deploymentTarget ? { deploymentTarget } : {}),
});

test('PR-only grant conveys ownership, not merge/deploy permission; checks are read-only', t => {
  const f = fixture(t); f.owner('feature'); f.owner('other');
  f.authorize([{ taskId: 'feature', action: 'pr' }]);
  const release = releaseAction(f.store, 'owner-feature', { action: 'claim', taskId: 'feature' });
  const before = f.store.read();
  assert.equal(check(f, release, 'pr').allowed, true); assert.deepEqual(f.store.read(), before);
  assert.throws(() => check(f, release, 'merge'), /authorization required/);
  assert.throws(() => check(f, release, 'deploy', 'synthetic'), /authorization required/);
  assert.throws(() => releaseAction(f.store, 'owner-other', { action: 'claim', taskId: 'other' }), /authorization required/);
  f.record(release, 'pr', { pr: 'https://example.test/pull/one' });
  assert.equal(check(f, release, 'pr').allowed, true, 'an authorized update push to an open PR remains possible');
  assert.throws(() => f.record(release, 'merged', { mergedCommit: SHA }), /authorization required/);
  assert.throws(() => releaseAction(f.store, 'owner-feature', { action: 'lock', taskId: 'feature', token: release.token, deploymentTarget: 'synthetic' }), /authorization required/);
});

test('merge-only and deploy-only scope never imply PR or each other; target is enforced throughout', t => {
  const f = fixture(t); f.owner('feature');
  f.authorize([{ taskId: 'feature', action: 'merge' }]);
  const release = releaseAction(f.store, 'owner-feature', { action: 'claim', taskId: 'feature' });
  assert.throws(() => check(f, release, 'pr'), /authorization required/);
  assert.throws(() => f.record(release, 'pr', { pr: 'https://example.test/pull/one' }), /authorization required/);
  assert.equal(check(f, release, 'merge').allowed, true);
  f.record(release, 'merged', { mergedCommit: SHA });
  f.store.transact(s => { s.releaseGrants = []; });
  f.authorize([{ taskId: 'feature', action: 'deploy', deploymentTarget: 'staging' }]);
  assert.throws(() => check(f, release, 'merge'), /authorization required/);
  assert.throws(() => check(f, release, 'deploy', 'staging'), /Deploy lock required/);
  for (const deploymentTarget of [undefined, 'production']) {
    assert.throws(() => releaseAction(f.store, 'owner-feature', { action: 'lock', taskId: 'feature', token: release.token, deploymentTarget }), /target|authorization/);
    assert.throws(() => check(f, release, 'deploy', deploymentTarget), /target|authorization/);
    assert.throws(() => f.record(release, 'deployed', { deployedCommit: MAIN, deploymentTarget }), /target|authorization/);
  }
  releaseAction(f.store, 'owner-feature', { action: 'lock', taskId: 'feature', token: release.token, deploymentTarget: 'staging' });
  assert.equal(check(f, release, 'deploy', 'staging').allowed, true);
  assert.throws(() => check(f, { ...release, token: 'wrong-token' }, 'deploy', 'staging'), /mismatch/);
  f.record(release, 'deployed', { deployedCommit: MAIN, deploymentTarget: 'staging' });
  f.store.transact(s => { delete s.releaseGrants; });
  releaseAction(f.store, 'owner-feature', { action: 'unlock', taskId: 'feature', token: release.token, reason: 'Synthetic smoke complete' });
  assert.equal(f.record(release, 'cleaned').stage, 'cleaned', 'cleanup checkpoint is bookkeeping, not new destructive permission');
});

test('different pairs do not form cross-products, cover future/child tasks, or authorize a batched ungranted deployment', t => {
  const f = fixture(t); f.owner('one'); f.owner('two');
  f.authorize([{ taskId: 'one', action: 'pr' }, { taskId: 'two', action: 'merge' }]);
  const one = releaseAction(f.store, 'owner-one', { action: 'claim', taskId: 'one' });
  const two = releaseAction(f.store, 'owner-two', { action: 'claim', taskId: 'two' });
  assert.throws(() => check(f, one, 'merge'), /authorization required/);
  assert.throws(() => check(f, two, 'pr'), /authorization required/);
  f.owner('future');
  f.create('child', { parentTask: 'one' }); f.agent('owner-child', 'implementer', 'child'); f.start('child'); f.ready('child'); f.verify('child');
  for (const taskId of ['future', 'child']) assert.throws(() => releaseAction(f.store, `owner-${taskId}`, { action: 'claim', taskId }), /authorization required/);
  f.authorize([{ taskId: 'one', action: 'merge' }, { taskId: 'one', action: 'deploy', deploymentTarget: 'synthetic' }]);
  f.record(one, 'merged', { mergedCommit: SHA }); f.record(two, 'merged', { mergedCommit: NEXT });
  releaseAction(f.store, 'owner-one', { action: 'lock', taskId: 'one', token: one.token, deploymentTarget: 'synthetic' });
  f.record(one, 'deployed', { deployedCommit: MAIN });
  assert.throws(() => f.record(two, 'deployed', { deployedCommit: MAIN }), /authorization required/);
  assert.throws(() => check(f, two, 'deploy', 'synthetic'), /authorization required/);
});

test('legacy wildcard is historical only; current plan/hash scope and independent verification still gate claims', t => {
  const f = fixture(t); f.owner('feature');
  f.store.transact(s => { s.releaseAuthorization = { source: 'legacy all releases', at: Date.now() }; });
  assert.throws(() => releaseAction(f.store, 'owner-feature', { action: 'claim', taskId: 'feature' }), /authorization required/);
  f.authorize([{ taskId: 'feature', action: 'pr' }]);
  const release = releaseAction(f.store, 'owner-feature', { action: 'claim', taskId: 'feature' });
  writeFileSync(f.plan, 'Changed release plan\n');
  assert.throws(() => check(f, release, 'pr'), /authorization required/);
  assert.throws(() => f.record(release, 'pr', { pr: 'https://example.test/pull/one' }), /authorization required/);
  // Safe failure reporting remains possible despite missing authority or plan drift.
  f.store.transact(s => { delete s.releaseGrants; });
  assert.equal(f.record(release, 'blocked').stage, 'blocked');
});

test('deploy-only grant permits a claim but cannot authorize the earlier merge or PR', t => {
  const f = fixture(t); f.owner('feature');
  f.authorize([{ taskId: 'feature', action: 'deploy', deploymentTarget: 'synthetic' }]);
  const release = releaseAction(f.store, 'owner-feature', { action: 'claim', taskId: 'feature' });
  assert.equal(release.stage, 'claimed');
  assert.throws(() => check(f, release, 'pr'), /authorization required/);
  assert.throws(() => check(f, release, 'merge'), /authorization required/);
  assert.throws(() => f.record(release, 'merged', { mergedCommit: SHA }), /authorization required/);
  assert.throws(() => releaseAction(f.store, 'owner-feature', { action: 'lock', taskId: 'feature', token: release.token, deploymentTarget: 'synthetic' }), /merge first/);
});

test('authorization never promotes readiness or risky implementation approval/verification', t => {
  const f = fixture(t); f.create('risky', { risky: true }); f.agent('owner-risky', 'implementer', 'risky');
  f.authorize([{ taskId: 'risky', action: 'pr' }]);
  assert.throws(() => f.start('risky'), /not approved/);
  taskAction(f.store, 'coord', { action: 'approve', id: 'risky', source: 'Synthetic confirmation' });
  f.start('risky'); f.ready('risky');
  assert.throws(() => f.verify('risky'), /Coordinator/);
  assert.throws(() => releaseAction(f.store, 'owner-risky', { action: 'claim', taskId: 'risky' }), /must be verified/);
  f.verify('risky', 'coord');
  const release = releaseAction(f.store, 'owner-risky', { action: 'claim', taskId: 'risky' });
  assert.equal(check(f, release, 'pr').allowed, true);
  f.ready('risky', 'owner-risky', NEXT);
  assert.throws(() => check(f, release, 'pr'), /must be verified/);
  f.store.transact(s => { delete s.releaseGrants; });
  assert.equal(f.record(release, 'blocked').stage, 'blocked', 'safe reporting survives a changed unverified candidate and missing grant');
});

test('non-shipping tasks are done once ready (light) or verified (gated), never released or nagged', async (t) => {
  const { statusDigest, sessionClosure } = await import('../src/board.ts');
  const f = fixture(t);
  f.owner('feature');
  assert.throws(() => f.create('bad', { ships: 'no' }), /Invalid ships flag/);
  f.create('design', { ships: false }); f.agent('owner-design', 'planner', 'design'); f.start('design', 'coord'); f.ready('design', 'coord');
  assert.equal(f.store.read().tasks.design.ships, false);
  assert.equal(f.store.read().tasks.feature.ships, undefined, 'shipping tasks record nothing');
  assert.equal(statusLine(f.store.read()), '⚙ light 0/1 shipped · 1 done · 1 ready', 'the design task leaves the ready count and the shipped total');
  assert.match(board(f.store.read()).find((line) => line.includes('design')), /^✓/);
  assert.throws(() => releaseScope(f.store.read(), [{ taskId: 'design', action: 'pr' }]), /nothing to release/);
  // An idle owner of finished non-shipping work is not nudged.
  f.store.transact((s) => Object.assign(s.agents['owner-design'], { activity: 'idle', activityAt: Date.now() - LIMITS.escalateMs - 1 }));
  const now = Date.now();
  assert.ok(!alerts(f.store.read(), now).some((a) => a.text.includes('owner-design')));
  assert.ok(!notices(f.store.read(), f.store.read().agents.coord, now, new Map()).some((n) => n.text.includes('owner-design')));
  const sections = Object.fromEntries(statusDigest(f.store.read(), now).map((s) => [s.title, s.lines]));
  assert.deepEqual(sections['Done, nothing to ship'], [`design · ${f.report}`]);
  assert.ok(!sections['Ready to ship'].some((line) => line.startsWith('design')));
  // Risky (gated) non-shipping work waits for verification first.
  f.create('audit', { ships: false, risky: true });
  f.store.transact((s) => { s.tasks.audit.state = 'ready'; s.tasks.audit.result = { id: 'r', status: 'ready', commit: SHA, report: f.report, evidence: [], createdAt: now }; });
  assert.ok(Object.fromEntries(statusDigest(f.store.read(), now).map((s) => [s.title, s.lines]))['In flight'].some((line) => line.startsWith('audit · ready, awaits verification')));
  // Session closure counts finished non-shipping work as ended.
  f.store.transact((s) => { s.sharedSession = { name: 'piorch-aaaaaa-bbbbbb', ownerId: 'coord' }; for (const a of Object.values(s.agents)) if (a.role !== 'coordinator') a.lifecycle = 'closed';
    s.tasks.feature.state = 'merged'; s.tasks.audit.state = 'skipped'; });
  assert.ok(sessionClosure(f.store.read()));
});

test('tasks sharing one PR and deploy release together, all or nothing, with the next step returned each time', (t) => {
  const f = fixture(t);
  f.owner('one'); f.owner('two'); f.authorize();
  // Claim both in one call; each task keeps its own release and token.
  const claimed = releaseAction(f.store, 'coord', { action: 'claim', taskIds: ['one', 'two'] });
  assert.deepEqual(claimed.map((r) => r.taskId), ['one', 'two']);
  assert.notEqual(claimed[0].token, claimed[1].token);
  assert.deepEqual(claimed[0].next, { action: 'check', operation: 'pr', allowed: true }, 'claim already ran the pr check');
  const checks = releaseAction(f.store, 'coord', { action: 'check', taskIds: ['one', 'two'], operation: 'pr' });
  assert.ok(checks.every((c) => c.allowed && /without re-checking/.test(c.validUntil)));
  const pr = 'https://example.test/pull/252';
  const opened = releaseAction(f.store, 'coord', { action: 'record', taskIds: ['one', 'two'], stage: 'pr', pr, evidence: [f.proof] });
  assert.ok(opened.every((r) => r.pr === pr && r.next.operation === 'merge' && r.next.allowed));
  const merged = releaseAction(f.store, 'coord', { action: 'record', taskIds: ['one', 'two'], stage: 'merged', mergedCommit: MAIN, evidence: [f.proof] });
  assert.deepEqual(merged[0].next, { action: 'lock', deploymentTarget: 'synthetic' }, 'merged work names the lock and its authorized target');
  // One history entry per recorded stage.
  assert.equal(f.store.read().tasks.one.history.filter((h) => /Merge attested|merged attested/.test(h.note)).length, 1);
  const locked = releaseAction(f.store, 'coord', { action: 'lock', taskId: 'one', deploymentTarget: 'synthetic' });
  assert.deepEqual(locked.next, { action: 'check', operation: 'deploy', deploymentTarget: 'synthetic', allowed: true });
  assert.match(releaseAction(f.store, 'coord', { action: 'claim', taskId: 'two' }).next.reason ?? '', /Deploy lock is held by coord for one/);
  const deployed = releaseAction(f.store, 'coord', { action: 'record', taskIds: ['one', 'two'], stage: 'deployed', deploymentTarget: 'synthetic', deployedCommit: MAIN, evidence: [f.proof] });
  assert.deepEqual(deployed.map((r) => r.stage), ['deployed', 'deployed']);
  assert.equal(deployed[0].next.action, 'unlock');
});

test('a failing task rolls back the whole batch; batches are light-only and exclusive with taskId', (t) => {
  const f = fixture(t);
  f.owner('one'); f.create('two'); f.agent('owner-two', 'implementer', 'two'); f.start('two'); f.ready('two'); f.authorize();
  const before = f.store.read();
  assert.throws(() => releaseAction(f.store, 'coord', { action: 'claim', taskIds: ['one', 'two'] }), /must be verified before claiming; it is ready/);
  assert.deepEqual(f.store.read().releases, before.releases, 'the verified task was not claimed alone');
  assert.throws(() => releaseAction(f.store, 'coord', { action: 'claim', taskId: 'one', taskIds: ['one'] }), /either taskId/);
  assert.throws(() => releaseAction(f.store, 'coord', { action: 'lock', taskIds: ['one'] }), /check, claim and record only/);
  assert.throws(() => releaseAction(f.store, 'coord', { action: 'claim', taskIds: ['one', 'one'] }), /distinct/);
  const strict = fixture(t, 'strict');
  assert.throws(() => releaseAction(strict.store, 'coord', { action: 'claim', taskIds: ['x'] }), /light profile/);
});

test('release errors name the next call or the reason, including a re-claim after merge', (t) => {
  const f = fixture(t);
  f.owner('feature');
  assert.throws(() => releaseAction(f.store, 'owner-feature', { action: 'claim', taskId: 'feature' }), /request-authorization scope \[\{"taskId":"feature"\}\]/);
  f.authorize();
  releaseAction(f.store, 'owner-feature', { action: 'claim', taskId: 'feature' });
  assert.throws(() => releaseAction(f.store, 'owner-feature', { action: 'record', taskId: 'feature', stage: 'deployed', deploymentTarget: 'synthetic', deployedCommit: MAIN, evidence: [f.proof] }),
    /must advance in order: it is at claimed; next allowed: pr or merged/);
  releaseAction(f.store, 'owner-feature', { action: 'record', taskId: 'feature', stage: 'merged', mergedCommit: MAIN, pr: 'https://example.test/pull/9', evidence: [f.proof] });
  f.store.transact((s) => { s.tasks.feature.state = 'verified'; s.tasks.feature.result.commit = NEXT; s.tasks.feature.verification.commit = NEXT; });
  assert.throws(() => releaseAction(f.store, 'owner-feature', { action: 'claim', taskId: 'feature' }), /its merge is recorded; ship further changes as a new task/);
  writeFileSync(f.plan, 'Edited plan\n');
  assert.throws(() => releaseScope(f.store.read(), [{ taskId: 'feature', action: 'pr' }]), /Plan drift: .*plan\.md changed since it was registered.*\/o approve feature\)/);
});

test('create takes planText in one call, never overwrites a plan and names a missing plan', async (t) => {
  const { readFileSync } = await import('node:fs');
  const f = fixture(t);
  assert.throws(() => taskAction(f.store, 'coord', { action: 'create', id: 'none', title: 'none' }), /create requires planPath .* or planText/);
  assert.throws(() => taskAction(f.store, 'coord', { action: 'create', id: 'both', title: 'both', planPath: f.plan, planText: 'x' }), /either planPath .* or planText/);
  const task = taskAction(f.store, 'coord', { action: 'create', id: 'inline', title: 'inline', planText: '# Plan\nDo it.' });
  const path = join(f.store.root, 'plans', 'inline.md');
  assert.equal(task.planPath, realpathSync(path));
  assert.equal(readFileSync(path, 'utf8'), '# Plan\nDo it.\n');
  assert.equal(task.planHash, createHash('sha256').update('# Plan\nDo it.\n').digest('hex'));
  // A leftover plan file of the same name is never replaced.
  writeFileSync(join(f.store.root, 'plans', 'leftover.md'), 'Registered elsewhere\n');
  assert.throws(() => taskAction(f.store, 'coord', { action: 'create', id: 'leftover', title: 'leftover', planText: 'x' }), /already exists; pass it as planPath/);
  assert.equal(readFileSync(join(f.store.root, 'plans', 'leftover.md'), 'utf8'), 'Registered elsewhere\n');
});

test('an ask_user needsHuman flag clears on a reply or a ready result, not on blocked or unrelated messages', (t) => {
  const f = fixture(t);
  const ask = (id) => taskAction(f.store, `owner-${id}`, { action: 'note', id, summary: 'Question for the human: Blue or green?', needsHuman: true });
  for (const id of ['reply', 'ready', 'blocked', 'manual']) { f.create(id, { ships: false }); f.agent(`owner-${id}`, 'implementer', id); f.start(id); }
  ask('reply'); ask('ready'); ask('blocked');
  taskAction(f.store, 'owner-manual', { action: 'note', id: 'manual', summary: '1Password is locked', needsHuman: true });
  sendMessage(f.store, 'coord', 'owner-reply', 'Blue');
  assert.deepEqual(f.store.read().tasks.reply.summary, { ...f.store.read().tasks.reply.summary, text: 'Answered by coord: Blue or green?', needsHuman: false, by: 'coord' });
  sendMessage(f.store, 'coord', 'owner-manual', 'Unlocked?');
  assert.equal(f.store.read().tasks.manual.summary.needsHuman, true, 'only ask_user questions clear on a reply');
  taskAction(f.store, 'owner-ready', { action: 'result', id: 'ready', status: 'ready', reportText: 'done' });
  assert.equal(f.store.read().tasks.ready.summary.needsHuman, false);
  taskAction(f.store, 'owner-blocked', { action: 'result', id: 'blocked', status: 'blocked', reportText: 'waiting' });
  assert.equal(f.store.read().tasks.blocked.summary.needsHuman, true, 'a blocked task still needs the human');
});

test('planners and reviewers report on their own non-shipping task, but never on a shipping one', async (t) => {
  const { existsSync, readFileSync, statSync } = await import('node:fs');
  const f = fixture(t);
  f.create('design', { ships: false }); f.agent('planner', 'planner', 'design');
  f.create('feature'); f.agent('owner-feature', 'implementer', 'feature'); f.agent('feature-reviewer', 'reviewer', 'feature');
  assert.equal(taskAction(f.store, 'planner', { action: 'start', id: 'design' }).state, 'implementing');
  taskAction(f.store, 'planner', { action: 'note', id: 'design', summary: 'Comparing three index layouts' });
  assert.throws(() => taskAction(f.store, 'planner', { action: 'result', id: 'design', status: 'ready', report: f.report, reportText: 'x' }), /either report .* or reportText/);
  const task = taskAction(f.store, 'planner', { action: 'result', id: 'design', status: 'ready', reportText: '# Design\nUse layout B.' });
  const path = join(f.store.root, 'reports', 'design', 'report.md');
  assert.equal(task.result.report, realpathSync(path));
  assert.equal(task.result.commit, undefined, 'design work is ready without a commit');
  assert.equal(readFileSync(path, 'utf8'), '# Design\nUse layout B.\n');
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statusLine(f.store.read()), '⚙ light 0/1 shipped · 1 done · 1 building', 'done at ready in light');
  // A reviewer attached to a shipping task cannot start it or replace its owner's result.
  assert.throws(() => taskAction(f.store, 'feature-reviewer', { action: 'start', id: 'feature' }), /own ships: false task/);
  f.start('feature'); f.ready('feature');
  assert.throws(() => taskAction(f.store, 'feature-reviewer', { action: 'result', id: 'feature', status: 'ready', reportText: 'LGTM' }), /own ships: false task/);
  assert.throws(() => taskAction(f.store, 'planner', { action: 'result', id: 'feature', status: 'ready', reportText: 'x' }), /own ships: false task/);
  // Gated non-shipping work is verified by the coordinator, without a commit.
  f.create('audit', { ships: false, risky: true }); f.agent('auditor', 'reviewer', 'audit');
  f.store.transact((s) => { s.tasks.audit.state = 'approved'; s.tasks.audit.approval = { hash: s.tasks.audit.planHash, source: 'synthetic', at: Date.now() }; });
  taskAction(f.store, 'auditor', { action: 'start', id: 'audit' });
  taskAction(f.store, 'auditor', { action: 'result', id: 'audit', status: 'ready', reportText: 'No findings.' });
  assert.throws(() => taskAction(f.store, 'auditor', { action: 'verify', id: 'audit', evidence: [f.proof] }), /Coordinator|coordinator/);
  assert.throws(() => taskAction(f.store, 'coord', { action: 'verify', id: 'audit', commit: SHA, evidence: [f.proof] }), /Omit commit when you verify this result/);
  const verified = taskAction(f.store, 'coord', { action: 'verify', id: 'audit', evidence: [f.proof] });
  assert.equal(verified.state, 'verified'); assert.equal(verified.verification.commit, undefined);
  assert.ok(existsSync(join(f.store.root, 'reports', 'audit', 'report.md')));
  // Shipping work still needs its commit.
  assert.throws(() => taskAction(f.store, 'owner-feature', { action: 'result', id: 'feature', status: 'ready', reportText: 'no commit' }), /SHA|sha|commit/i);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.ts';
import { releaseAction, releaseScope, displayReleaseScope, taskAction } from '../src/workflow.ts';
import { board, counts, ownerActionable, sessionClosure, statusDigest, statusLine } from '../src/board.ts';
import { taskDetails } from '../src/board-view.ts';
import { ended } from '../src/cleanup.ts';
import { spawnAgent } from '../src/runtime.ts';

// Synthetic, isolated registries only: no real repository, installation or provider is touched.
const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40), I = 'd'.repeat(40), X = 'e'.repeat(40);

export function fixture(t, { profile = 'light', riskyIncluded = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'orchestrator-bundle-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = openStore(join(dir, 'registry'));
  t.after(() => store.close());
  const report = join(dir, 'report.md'), proof = join(dir, 'proof.log'), target = join(dir, 'installed');
  writeFileSync(report, 'Synthetic report\n'); writeFileSync(proof, 'Synthetic evidence; nothing installed\n');
  const agent = (id, role, taskId, parentId = 'coord') => store.transact((s) => {
    s.agents[id] = { id, role, ...(parentId ? { parentId } : {}), ...(taskId ? { taskId } : {}), model: 'synthetic/model',
      generation: `${id}-g1`, lifecycle: 'running', worktree: dir, sessionDir: join(dir, id), piSessionId: `${id}-session`, sessionFile: join(dir, `${id}.jsonl`) };
  });
  agent('coord', 'coordinator', undefined, null);
  store.transact((s) => { s.profile = profile; });
  const plans = {};
  const create = (id, extra = {}) => {
    plans[id] = join(dir, `${id}.md`); writeFileSync(plans[id], `# ${id}\n`);
    taskAction(store, 'coord', { action: 'create', id, title: `Synthetic ${id}`, planPath: plans[id], ...extra });
    taskAction(store, 'coord', { action: 'approve', id, source: 'Synthetic human plan approval' });
  };
  // Owners publish; the coordinator verifies, which is also independent for risky tasks.
  const ship = (id, commit, extra = {}) => {
    create(id, extra); agent(`owner-${id}`, 'implementer', id);
    taskAction(store, `owner-${id}`, { action: 'start', id });
    taskAction(store, `owner-${id}`, { action: 'result', id, status: 'ready', commit, report, evidence: [proof] });
    taskAction(store, 'coord', { action: 'verify', id, commit, evidence: [proof] });
  };
  const review = (id) => {
    create(id, { ships: false }); agent(`reviewer-${id}`, 'reviewer', id);
    taskAction(store, `reviewer-${id}`, { action: 'start', id });
    taskAction(store, `reviewer-${id}`, { action: 'result', id, status: 'ready', reportText: `Synthetic ${id} findings` });
  };
  ship('alpha', A, { risky: riskyIncluded.includes('alpha') });
  ship('beta', B, { risky: riskyIncluded.includes('beta') });
  ship('gamma', C, { risky: riskyIncluded.includes('gamma') });
  ship('integration', I);
  review('review-one'); review('review-two');
  // Mirrors the runtime's confirmation write without a TUI; bridge tests cover the genuine dialog.
  const authorize = (proposals) => store.transact((s) => {
    const scope = releaseScope(s, proposals), displayedScope = displayReleaseScope(store.root, scope);
    if (scope.some((pair) => pair.includes)) s.version = Math.max(s.version, 3);
    const id = `grant-${s.revision}`;
    (s.releaseGrants ??= []).push({ id, root: store.root, scope, confirmation: { kind: 'tui', coordinator: 'coord', generation: 'coord-g1',
      sessionId: 'coord-session', sessionFile: join(dir, 'coord.jsonl'), branchAnchor: null, origin: 'tool', toolCallId: 'synthetic-call',
      at: Date.now(), displayedScope, digest: createHash('sha256').update(displayedScope).digest('hex') } });
    return id;
  });
  const include = (...ids) => ids.map((id) => ({ taskId: id, resultId: store.read().tasks[id].result.id, commit: store.read().tasks[id].result.commit }));
  const install = { taskId: 'integration', action: 'local-install', commit: I, installationTarget: target };
  const claim = (includes) => releaseAction(store, 'coord', { action: 'claim', taskId: 'integration', operation: 'local-install', commit: I, installationTarget: target, ...(includes ? { includes } : {}) });
  const installed = () => releaseAction(store, 'coord', { action: 'record', taskId: 'integration', stage: 'installed', installedCommit: I, installationTarget: target, evidence: [proof] });
  return { dir, store, report, proof, target, plans, agent, create, ship, authorize, include, install, claim, installed };
}

test('regression: a singleton receipt for an integrated candidate leaves its predecessors ready', (t) => {
  const f = fixture(t);
  f.authorize([f.install]); f.claim(); f.installed();
  assert.equal(statusLine(f.store.read()), '⚙ light 1/4 shipped · 2 done · 3 ready');
});

test('an explicit bundle receipt ships every included result once, keeps reviews separate and fabricates nothing', (t) => {
  const f = fixture(t);
  const includes = f.include('alpha', 'beta', 'gamma');
  f.authorize([{ ...f.install, repoPath: f.dir, includes }]);
  f.claim(includes); f.installed();
  const state = f.store.read();
  assert.equal(statusLine(state), '⚙ light 4/4 shipped · 2 done');
  assert.equal(counts(state).ready, 0);
  // No per-task releases, PRs, merges or installations are invented for included tasks.
  assert.deepEqual(Object.keys(state.releases), ['integration']);
  for (const id of ['alpha', 'beta', 'gamma']) assert.equal(state.tasks[id].state, 'verified');
  assert.equal(state.tasks.integration.state, 'deployed');
  const shipped = statusDigest(state).find((s) => s.title === 'Shipped').lines;
  assert.equal(shipped.length, 4);
  assert.ok(shipped.some((line) => /^alpha · delivered by integration local install d{7}/.test(line)), shipped.join('\n'));
  assert.ok(shipped.some((line) => /^integration · deployed · local install d{7} \+3 bundled/.test(line)), shipped.join('\n'));
  assert.equal(statusDigest(state).find((s) => s.title === 'Done, nothing to ship').lines.length, 2);
  assert.equal(statusDigest(state).find((s) => s.title === 'Ready to ship'), undefined);
  assert.match(board(state).join('\n'), /✓ alpha\s+delivered/);
});


const keys = (included) => included.map(({ taskId, resultId, commit }) => ({ taskId, resultId, commit }));

test('direct singleton and bundled deliveries coexist without double counting', (t) => {
  const f = fixture(t);
  f.ship('solo', X);
  const includes = f.include('alpha', 'beta');
  f.authorize([{ ...f.install, repoPath: f.dir, includes }]);
  f.claim(includes); f.installed();
  releaseAction(f.store, 'coord', { action: 'unlock', taskId: 'integration', reason: 'Synthetic bundle attested' });
  const solo = { taskId: 'solo', action: 'local-install', commit: X, installationTarget: f.target + '-solo' };
  f.authorize([solo]);
  releaseAction(f.store, 'coord', { action: 'claim', taskId: 'solo', operation: 'local-install', commit: X, installationTarget: solo.installationTarget });
  releaseAction(f.store, 'coord', { action: 'record', taskId: 'solo', stage: 'installed', installedCommit: X, installationTarget: solo.installationTarget, evidence: [f.proof] });
  const state = f.store.read();
  // gamma was not named, so it stays ready: nothing is inferred.
  assert.equal(statusLine(state), '⚙ light 4/5 shipped · 2 done · 1 ready');
  assert.equal(state.releases.solo.included, undefined);
  assert.match(taskDetails(state, state.tasks.alpha), /Delivered by: integration local install d{40}/);
  assert.match(taskDetails(state, state.tasks.integration), /Bundle \(delivered\): alpha a{12}, beta b{12}/);
  assert.doesNotMatch(taskDetails(state, state.tasks.solo), /Bundle|Delivered by/);
  assert.match(taskDetails(state, state.tasks.gamma), /^gamma · verified/);
  for (const id of ['alpha', 'beta', 'integration', 'solo']) assert.equal(ended(state, state.tasks[id]), true, id);
  assert.equal(ended(state, state.tasks.gamma), false);
  assert.equal(ownerActionable(state, state.tasks.alpha), false);
  assert.equal(ownerActionable(state, state.tasks.gamma), true);
});

test('invalid inclusions are rejected before any confirmation is recorded', (t) => {
  const f = fixture(t);
  f.create('planned-only');
  f.ship('skipped', X); taskAction(f.store, 'coord', { action: 'skip', id: 'skipped', reason: 'Synthetic' });
  f.create('child', { parentTask: 'alpha' });
  f.ship('ready-only', X); f.store.transact((s) => { delete s.tasks['ready-only'].verification; s.tasks['ready-only'].state = 'ready'; });
  f.ship('unapproved', X); f.store.transact((s) => { delete s.tasks.unapproved.approval; });
  const [alpha] = f.include('alpha');
  const reviewResult = f.store.read().tasks['review-one'].result;
  const cases = {
    'non-shipping review': [{ taskId: 'review-one', resultId: reviewResult.id, commit: A }],
    skipped: f.include('skipped'),
    foreign: [{ taskId: 'nobody', resultId: alpha.resultId, commit: A }],
    duplicate: [alpha, alpha],
    self: f.include('integration'),
    'child task': [{ taskId: 'child', resultId: alpha.resultId, commit: A }],
    unverified: f.include('ready-only'),
    unapproved: f.include('unapproved'),
    planned: [{ taskId: 'planned-only', resultId: alpha.resultId, commit: A }],
    'stale result id': [{ ...alpha, resultId: 'other-result' }],
    'wrong commit': [{ ...alpha, commit: X }],
    'uppercase commit': [{ ...alpha, commit: A.toUpperCase() }],
    'extra field': [{ ...alpha, verified: true }],
    empty: [],
    'too many': Array.from({ length: 21 }, () => alpha),
  };
  for (const [name, includes] of Object.entries(cases)) assert.throws(() => f.authorize([{ ...f.install, repoPath: f.dir, includes }]), Error, name);
  assert.throws(() => f.authorize([{ ...f.install, includes: [alpha] }]), /repoPath/);
  assert.throws(() => f.authorize([{ ...f.install, repoPath: 'relative', includes: [alpha] }]), /repoPath/);
  assert.throws(() => f.authorize([{ ...f.install, repoPath: f.dir }]), /includes/);
  assert.throws(() => f.authorize([{ taskId: 'integration', action: 'pr', repoPath: f.dir, includes: [alpha] }]), /only apply/);
  assert.throws(() => f.authorize([{ ...f.install, repoPath: f.dir, includes: [alpha] }, { taskId: 'alpha', action: 'pr' }]), /own release pair/);
  f.ship('other', X);
  assert.throws(() => f.authorize([{ ...f.install, repoPath: f.dir, includes: [alpha] },
    { taskId: 'other', action: 'local-install', commit: X, installationTarget: f.target, repoPath: f.dir, includes: [alpha] }]), /only one installation/);
  assert.equal(f.store.read().releaseGrants, undefined);
  assert.equal(f.store.read().version, 1);
});

test('risky included work needs independent current verification', (t) => {
  const f = fixture(t, { riskyIncluded: ['alpha'] });
  // The risky owner cannot verify itself; an unverified risky result cannot be bundled.
  taskAction(f.store, 'coord', { action: 'start', id: 'alpha' });
  taskAction(f.store, 'owner-alpha', { action: 'result', id: 'alpha', status: 'ready', commit: A, report: f.report, evidence: [f.proof] });
  assert.throws(() => taskAction(f.store, 'owner-alpha', { action: 'verify', id: 'alpha', commit: A, evidence: [f.proof] }), /Coordinator required|Self-verification/);
  assert.throws(() => f.authorize([{ ...f.install, repoPath: f.dir, includes: f.include('alpha') }]), /verified/);
  taskAction(f.store, 'coord', { action: 'verify', id: 'alpha', commit: A, evidence: [f.proof] });
  f.authorize([{ ...f.install, repoPath: f.dir, includes: f.include('alpha') }]);
  // A stale gated verification (plan re-approved since) is not current.
  f.store.transact((s) => { s.tasks.alpha.verification.planHash = 'f'.repeat(64); s.tasks.alpha.approval.hash = 'f'.repeat(64); });
  assert.throws(() => f.claim(f.include('alpha')), /approv|verif/i);
});

test('result, plan and verification drift after confirmation fails closed at claim, check and record', (t) => {
  const drifts = {
    rework: (f) => {
      taskAction(f.store, 'coord', { action: 'start', id: 'beta' });
      taskAction(f.store, 'owner-beta', { action: 'result', id: 'beta', status: 'ready', commit: B, report: f.report, evidence: [f.proof, f.report] });
      taskAction(f.store, 'coord', { action: 'verify', id: 'beta', commit: B, evidence: [f.proof] });
    },
    plan: (f) => writeFileSync(f.plans.beta, '# changed\n'),
    verification: (f) => f.store.transact((s) => { delete s.tasks.beta.verification; s.tasks.beta.state = 'ready'; }),
    candidate: (f) => f.store.transact((s) => { s.tasks.integration.result.commit = X; s.tasks.integration.verification.commit = X; }),
  };
  for (const [name, drift] of Object.entries(drifts)) t.test(name, (tt) => {
    const f = fixture(tt);
    const includes = f.include('alpha', 'beta');
    f.authorize([{ ...f.install, repoPath: f.dir, includes }]);
    drift(f);
    assert.throws(() => f.claim(includes), Error, name);
    // A fresh current snapshot may differ, but never reuses the old grant.
    if (name === 'rework') assert.throws(() => f.claim(f.include('alpha', 'beta')), /authorization/);
    assert.equal(f.store.read().releases.integration, undefined);
  });
  t.test('after claim', (tt) => {
    const f = fixture(tt);
    const includes = f.include('alpha', 'beta');
    f.authorize([{ ...f.install, repoPath: f.dir, includes }]);
    f.claim(includes);
    writeFileSync(f.plans.beta, '# changed after claim\n');
    const check = { action: 'check', taskId: 'integration', operation: 'local-install', commit: I, installationTarget: f.target };
    assert.throws(() => releaseAction(f.store, 'coord', check), /authorization|drift|plan bytes/i);
    assert.throws(() => f.installed(), /authorization|drift|plan bytes/i);
    writeFileSync(f.plans.beta, '# beta\n');
    assert.equal(releaseAction(f.store, 'coord', check).allowed, true);
  });
});

test('singleton and bundle grants never satisfy each other; changed bundles need new confirmation', (t) => {
  const f = fixture(t);
  const includes = f.include('alpha', 'beta');
  f.authorize([f.install]);
  assert.throws(() => f.claim(includes), /authorization/);
  f.authorize([{ ...f.install, repoPath: f.dir, includes: f.include('alpha') }]);
  assert.throws(() => f.claim(includes), /authorization/);
  assert.throws(() => f.claim(f.include('alpha', 'beta', 'gamma')), /authorization/);
  f.authorize([{ ...f.install, repoPath: f.dir, includes }]);
  const release = f.claim(includes);
  assert.deepEqual(keys(release.included), includes);
  assert.equal(release.next.allowed, true);
  assert.equal(f.store.read().version, 3);
  // The claimed candidate is frozen: re-claim cannot change its bundle.
  releaseAction(f.store, 'coord', { action: 'record', taskId: 'integration', stage: 'blocked', evidence: [f.proof] });
  releaseAction(f.store, 'coord', { action: 'unlock', taskId: 'integration', reason: 'Synthetic interruption' });
  assert.throws(() => f.claim(), /Bundle differs/);
  assert.throws(() => f.claim(f.include('alpha')), /authorization|Bundle differs/);
  assert.equal(f.claim(includes).stage, 'blocked');
});

test('bundled tasks are frozen and get no separate release, before and after installation', (t) => {
  const f = fixture(t);
  const includes = f.include('alpha', 'beta');
  f.authorize([{ ...f.install, repoPath: f.dir, includes }]);
  f.authorize([{ taskId: 'alpha', action: 'local-install', commit: A, installationTarget: f.target }]);
  f.claim(includes);
  for (const phase of ['claimed', 'installed']) {
    const before = f.store.read().tasks.alpha;
    assert.throws(() => taskAction(f.store, 'owner-alpha', { action: 'start', id: 'alpha' }), /frozen by the local-install bundle/, phase);
    assert.throws(() => taskAction(f.store, 'coord', { action: 'skip', id: 'alpha', reason: 'x' }), /frozen/, phase);
    assert.throws(() => taskAction(f.store, 'owner-alpha', { action: 'result', id: 'alpha', status: 'ready', commit: X, report: f.report, evidence: [] }), /frozen/, phase);
    assert.throws(() => releaseAction(f.store, 'coord', { action: 'claim', taskId: 'alpha', operation: 'local-install', commit: A, installationTarget: f.target }), /delivered through/, phase);
    assert.throws(() => f.authorize([{ taskId: 'alpha', action: 'pr' }]), /delivered through/, phase);
    assert.deepEqual(f.store.read().tasks.alpha, before);
    if (phase === 'claimed') {
      // Claimed but not yet installed: frozen, yet not shipped.
      assert.equal(statusLine(f.store.read()), '⚙ light 0/4 shipped · 2 done · 4 ready');
      assert.match(taskDetails(f.store.read(), f.store.read().tasks.alpha), /Bundled in: integration local-install claim/);
      assert.equal(ended(f.store.read(), f.store.read().tasks.alpha), false);
      f.installed();
    }
  }
  const history = f.store.read().tasks.alpha.history.map((h) => h.note).join('\n');
  assert.match(history, /Included in the local-install claim of integration/);
  assert.match(history, /Delivered by the local installation of integration/);
});

test('bundle claims share the single serial lock with every other release', (t) => {
  const f = fixture(t);
  const includes = f.include('alpha');
  f.authorize([{ ...f.install, repoPath: f.dir, includes }]);
  f.ship('solo', X);
  const solo = { taskId: 'solo', action: 'local-install', commit: X, installationTarget: f.target + '-solo' };
  f.authorize([solo]);
  releaseAction(f.store, 'coord', { action: 'claim', taskId: 'solo', operation: 'local-install', commit: X, installationTarget: solo.installationTarget });
  const before = f.store.read();
  assert.throws(() => f.claim(includes), /already held/);
  assert.deepEqual(f.store.read().releases, before.releases);
  assert.deepEqual(f.store.read().tasks, before.tasks);
  assert.throws(() => releaseAction(f.store, 'coord', { action: 'claim', taskIds: ['integration'], operation: 'local-install', commit: I, installationTarget: f.target, includes }), /taskIds|Unexpected/);
});

function reconcileFixture(t) {
  const f = fixture(t);
  f.authorize([f.install]); f.claim(); f.installed();
  releaseAction(f.store, 'coord', { action: 'unlock', taskId: 'integration', reason: 'Synthetic singleton install' });
  const includes = f.include('alpha', 'beta', 'gamma');
  const pair = { taskId: 'integration', action: 'reconcile-install', commit: I, installationTarget: f.target, repoPath: f.dir, includes };
  const reconcile = (grantId, fields = {}) => releaseAction(f.store, 'coord', { action: 'reconcile', taskId: 'integration', grantId, includes, evidence: [f.proof], ...fields });
  return { ...f, includes, pair, reconcile };
}

test('historical reconciliation attaches confirmed results to the original receipt with zero execution authority', (t) => {
  const f = reconcileFixture(t);
  const grantId = f.authorize([f.pair]);
  const display = f.store.read().releaseGrants.at(-1).confirmation.displayedScope;
  assert.match(display, /RECONCILE-INSTALL integration/);
  assert.match(display, /executes, replays and authorizes nothing/);
  for (const id of ['alpha', 'beta', 'gamma']) assert.ok(display.includes(`- ${id} result ${f.store.read().tasks[id].result.id}`));
  // The grant authorizes no operation for the receipt task or any included task.
  for (const taskId of ['integration', 'alpha']) {
    assert.throws(() => releaseAction(f.store, 'coord', { action: 'claim', taskId }));
    for (const operation of ['pr', 'merge', 'deploy', 'local-install']) {
      assert.throws(() => releaseAction(f.store, 'coord', { action: 'check', taskId, operation, ...(operation === 'local-install' ? { commit: I, installationTarget: f.target } : {}), ...(operation === 'deploy' ? { deploymentTarget: 'x' } : {}) }));
    }
  }
  assert.equal(statusLine(f.store.read()), '⚙ light 1/4 shipped · 2 done · 3 ready', 'a grant alone records nothing');
  assert.throws(() => f.reconcile(grantId, { evidence: [] }), /evidence/);
  assert.throws(() => f.reconcile(grantId, { evidence: [join(f.dir, 'missing')] }), /not found/);
  assert.throws(() => f.reconcile(grantId, { includes: f.include('alpha', 'beta') }), /differ/);
  assert.throws(() => f.reconcile(grantId, { includes: [...f.include('alpha', 'beta'), { ...f.include('gamma')[0], commit: X }] }), /differ/);
  const before = f.store.read();
  const release = f.reconcile(grantId);
  const after = f.store.read();
  assert.equal(after.version, 3);
  assert.equal(statusLine(after), '⚙ light 4/4 shipped · 2 done');
  assert.equal(release.stage, before.releases.integration.stage);
  assert.equal(release.installedCommit, I);
  assert.deepEqual(release.evidence, before.releases.integration.evidence);
  assert.equal(after.releaseLock, undefined);
  assert.equal(release.reconciliation.grantId, grantId);
  assert.deepEqual(Object.keys(after.releases), ['integration']);
  assert.match(statusDigest(after).find((s) => s.title === 'Shipped').lines.join('\n'), /alpha · delivered by integration local install d{7} \(reconciled\)/);
  assert.match(taskDetails(after, after.tasks.integration), /reconciled historically under grant/);
  // Exact retry is idempotent; conflicting evidence or a fresh grant never overwrites history.
  assert.deepEqual(keys(f.reconcile(grantId).included), f.includes);
  assert.equal(f.store.read().releases.integration.reconciliation.at, release.reconciliation.at);
  assert.throws(() => f.reconcile(grantId, { evidence: [f.proof, f.report] }), /Conflicting/);
  assert.throws(() => f.authorize([f.pair]), /already records its bundle|delivered through/);
  assert.throws(() => taskAction(f.store, 'owner-alpha', { action: 'start', id: 'alpha' }), /frozen/);
});

test('reconciliation rejects unbound receipts, stale snapshots, supersession and foreign coordinators', (t) => {
  t.test('requires an installed receipt', (tt) => {
    const f = fixture(tt);
    const pair = { taskId: 'integration', action: 'reconcile-install', commit: I, installationTarget: f.target, repoPath: f.dir, includes: f.include('alpha') };
    assert.throws(() => f.authorize([pair]), /attested local-install receipt/);
    f.authorize([f.install]); f.claim();
    assert.throws(() => f.authorize([pair]), /attested local-install receipt/);
  });
  t.test('binds exact commit and destination', (tt) => {
    const f = reconcileFixture(tt);
    assert.throws(() => f.authorize([{ ...f.pair, commit: X }]), /exact installed commit/);
    assert.throws(() => f.authorize([{ ...f.pair, installationTarget: f.target + '-other' }]), /exact installed commit/);
    assert.throws(() => f.authorize([{ ...f.pair, includes: undefined }]), /requires includes/);
  });
  t.test('stale snapshot after confirmation', (tt) => {
    const f = reconcileFixture(tt);
    const grantId = f.authorize([f.pair]);
    writeFileSync(f.plans.gamma, '# changed\n');
    assert.throws(() => f.reconcile(grantId), /changed since confirmation|approv|drift/i);
    writeFileSync(f.plans.gamma, '# gamma\n');
    taskAction(f.store, 'coord', { action: 'start', id: 'gamma' });
    taskAction(f.store, 'owner-gamma', { action: 'result', id: 'gamma', status: 'ready', commit: C, report: f.report, evidence: [f.report] });
    taskAction(f.store, 'coord', { action: 'verify', id: 'gamma', commit: C, evidence: [f.proof] });
    assert.throws(() => f.reconcile(grantId), /verified result|changed since confirmation/);
    assert.equal(f.store.read().releases.integration.included, undefined);
  });
  t.test('superseded grant', (tt) => {
    const f = reconcileFixture(tt);
    const first = f.authorize([f.pair]);
    const second = f.authorize([f.pair]);
    assert.throws(() => f.reconcile(first), /superseded/);
    f.reconcile(second);
    assert.throws(() => f.reconcile(first), /Conflicting/);
  });
  t.test('foreign coordinator generation', (tt) => {
    const f = reconcileFixture(tt);
    const grantId = f.authorize([f.pair]);
    f.store.transact((s) => { s.agents.coord.generation = 'replacement-g2'; });
    assert.throws(() => f.reconcile(grantId), /current-coordinator/);
    f.store.transact((s) => { s.agents.coord.generation = 'coord-g1'; });
    assert.throws(() => releaseAction(f.store, 'owner-integration', { action: 'reconcile', taskId: 'integration', grantId, includes: f.includes, evidence: [f.proof] }), /Coordinator required/);
  });
});

test('persisted bundles need the bundle-aware schema and stay consistent', (t) => {
  const f = fixture(t);
  const includes = f.include('alpha');
  f.authorize([{ ...f.install, repoPath: f.dir, includes }]);
  assert.throws(() => f.store.transact((s) => { s.version = 2; }), /downgrade/);
  f.claim(includes); f.installed();
  for (const mutate of [
    (s) => { s.releases.integration.included[0].taskId = 'integration'; },
    (s) => { s.releases.integration.included.push({ ...s.releases.integration.included[0] }); },
    (s) => { s.releases.alpha = { ...s.releases.integration, taskId: 'alpha', included: undefined }; delete s.releases.alpha.included; },
    (s) => { s.releases.integration.included[0].extra = true; },
    (s) => { s.releases.integration.reconciliation = { grantId: 'missing', by: 'coord', at: 1, evidence: [f.proof] }; },
  ]) assert.throws(() => f.store.transact(mutate), /schema|Conflicting/);
});

test('delivered bundle tasks are terminal for implementers and inspection', async (t) => {
  const f = fixture(t);
  const includes = f.include('alpha');
  f.authorize([{ ...f.install, repoPath: f.dir, includes }]);
  f.claim(includes); f.installed();
  const real = realpathSync(f.dir), repo = join(real, 'repo'); mkdirSync(repo);
  execFileSync('git', ['init', '-q', repo]);
  const extension = join(real, 'extension.ts'); writeFileSync(extension, '// synthetic\n');
  f.store.transact((s) => { s.agents['owner-alpha'].lifecycle = 'exited'; });
  for (const role of ['implementer', 'reviewer']) {
    await assert.rejects(spawnAgent(f.store, 'coord', { id: `late-${role}`, taskId: 'alpha', role, repo, base: 'HEAD', branch: `late-${role}`, worktree: join(real, `wt-${role}`), prompt: 'synthetic' }, extension,
      async () => { throw new Error('no process may run'); }), /delivered through a local-install bundle|cannot be inspected/);
  }
  assert.equal(f.store.read().agents['late-implementer'], undefined);
});

test('session closure counts bundle-delivered tasks as ended', (t) => {
  const f = fixture(t);
  const includes = f.include('alpha', 'beta', 'gamma');
  f.authorize([{ ...f.install, repoPath: f.dir, includes }]);
  f.claim(includes); f.installed();
  f.store.transact((s) => {
    s.sharedSession = { name: 'synthetic-session', ownerId: 'coord' };
    for (const agent of Object.values(s.agents)) if (agent.role !== 'coordinator') agent.lifecycle = 'closed';
  });
  assert.match(sessionClosure(f.store.read())?.text ?? '', /All tasks ended/);
});

// Copy the actual pre-bundle runtime into the isolated test directory.
function oldRuntime(dir) {
  const legacy = join(dir, 'legacy');
  cpSync(new URL('./fixtures/legacy-runtime/pre-bundle/', import.meta.url), legacy, { recursive: true });
  return legacy;
}

test('old runtime fails closed on bundle snapshots instead of reading or installing them as singletons', async (t) => {
  const f = fixture(t);
  const legacy = oldRuntime(f.dir);
  const old = await import(pathToFileURL(join(legacy, 'store.ts')).href);
  const oldWorkflow = await import(pathToFileURL(join(legacy, 'workflow.ts')).href);
  const oldBoard = await import(pathToFileURL(join(legacy, 'board.ts')).href);
  const handle = old.openStore(f.store.root, false);
  t.after(() => handle.close());
  assert.equal(handle.read().version, 1, 'pre-bundle registries stay readable by the old runtime');
  // The old runtime cannot even propose a bundle.
  assert.throws(() => handle.transact((s) => oldWorkflow.releaseScope(s, [{ ...f.install, repoPath: f.dir, includes: f.include('alpha') }])), /Unknown release proposal field/);
  const includes = f.include('alpha', 'beta', 'gamma');
  f.authorize([{ ...f.install, repoPath: f.dir, includes }]);
  assert.throws(() => handle.read(), /Unsupported registry schema version/);
  assert.throws(() => handle.transact((s) => { s.notifications.stale = ['bad']; }), /Unsupported registry schema version/);
  // Its release path cannot load the snapshot, so no singleton claim or install is possible.
  assert.throws(() => oldWorkflow.releaseAction(handle, 'coord', { action: 'claim', taskId: 'integration', operation: 'local-install', commit: I, installationTarget: f.target }), /Unsupported registry schema version/);
  const script = `import { openStore } from ${JSON.stringify(join(legacy, 'store.ts'))}; const db=openStore(process.argv[1],false); db.transact(s=>{s.notifications.stale=['bad'];});`;
  assert.throws(() => execFileSync(process.execPath, ['--input-type=module', '-e', script, f.store.root], { stdio: 'pipe' }), /Unsupported registry schema version/);
  f.claim(includes); f.installed();
  assert.throws(() => handle.read(), /Unsupported registry schema version/);
  assert.equal(f.store.read().notifications.stale, undefined);
  assert.equal(statusLine(f.store.read()), '⚙ light 4/4 shipped · 2 done');
  void oldBoard;
});

test('new runtime reads an old-runtime singleton receipt unchanged', async (t) => {
  const f = fixture(t);
  const legacy = oldRuntime(f.dir);
  const old = await import(pathToFileURL(join(legacy, 'store.ts')).href);
  const oldWorkflow = await import(pathToFileURL(join(legacy, 'workflow.ts')).href);
  const oldBoard = await import(pathToFileURL(join(legacy, 'board.ts')).href);
  const handle = old.openStore(f.store.root, false);
  t.after(() => handle.close());
  // The old runtime writes its own singleton grant, claim and receipt.
  handle.transact((s) => {
    const scope = oldWorkflow.releaseScope(s, [f.install]), displayedScope = oldWorkflow.displayReleaseScope(handle.root, scope);
    (s.releaseGrants ??= []).push({ id: 'old-grant', root: handle.root, scope, confirmation: { kind: 'tui', coordinator: 'coord', generation: 'coord-g1',
      sessionId: 'coord-session', sessionFile: join(f.dir, 'coord.jsonl'), branchAnchor: null, origin: 'tool', toolCallId: 'old-call', at: Date.now(), displayedScope,
      digest: createHash('sha256').update(displayedScope).digest('hex') } });
  });
  oldWorkflow.releaseAction(handle, 'coord', { action: 'claim', taskId: 'integration', operation: 'local-install', commit: I, installationTarget: f.target });
  oldWorkflow.releaseAction(handle, 'coord', { action: 'record', taskId: 'integration', stage: 'installed', installedCommit: I, installationTarget: f.target, evidence: [f.proof] });
  const state = f.store.read();
  assert.equal(state.version, 1);
  assert.equal(statusLine(state), oldBoard.statusLine(handle.read()));
  assert.equal(statusLine(state), '⚙ light 1/4 shipped · 2 done · 3 ready');
  assert.equal(displayReleaseScope(f.store.root, state.releaseGrants[0].scope), state.releaseGrants[0].confirmation.displayedScope);
});

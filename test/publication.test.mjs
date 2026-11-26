import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openStore } from '../src/store.ts';
import { publicationAction, publicationScope, displayPublicationScope } from '../src/publication.ts';
import { releaseAction, taskAction, releaseScope, displayReleaseScope } from '../src/workflow.ts';
import { counts, board } from '../src/board.ts';
import { taskDetails } from '../src/board-view.ts';

const SHA = 'a'.repeat(40), OTHER = 'b'.repeat(40);
function fixture(t, profile = 'light', risky = true) {
  const dir = mkdtempSync(join(tmpdir(), 'wip-isolated-'));
  const plan = join(dir, 'plan.md'), report = join(dir, 'report.md'), proof = join(dir, 'proof.json');
  writeFileSync(plan, 'Synthetic approved scope'); writeFileSync(report, 'Unresolved independent review'); writeFileSync(proof, 'Synthetic observed draft PR state');
  const store = openStore(join(dir, 'registry'));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.transact(s => {
    s.profile = profile;
    for (const [id, role] of [['coord', 'coordinator'], ['worker', 'implementer']]) s.agents[id] = {
      id, role, generation: `${id}-generation`, lifecycle: 'running', model: 'synthetic/model', worktree: dir,
      sessionDir: dir, piSessionId: `${id}-session`, sessionFile: join(dir, 'session.jsonl'), ...(id === 'worker' ? { parentId: 'coord' } : {}),
    };
  });
  taskAction(store, 'coord', { action: 'create', id: 'task', title: 'Synthetic WIP task', planPath: plan, risky });
  store.transact(s => { s.agents.worker.taskId = 'task'; });
  taskAction(store, 'coord', { action: 'approve', id: 'task', source: 'Synthetic TUI plan approval' });
  taskAction(store, 'worker', { action: 'start', id: 'task' });
  const proposal = { taskId: 'task', operation: 'create', commit: SHA, repoPath: dir, repository: 'example/synthetic', headBranch: 'wip/task', baseBranch: 'main', draft: true, findings: 'Independent review unresolved; tests are synthetic; no completeness claim.' };
  const observed = { commit: SHA, repository: proposal.repository, headBranch: proposal.headBranch, baseBranch: 'main', pr: 'https://github.com/example/synthetic/pull/1', draft: true };
  function grant(p = proposal) {
    return store.transact(s => {
      const scope = publicationScope(s, p), displayedScope = displayPublicationScope(store.root, scope), id = `grant-${s.revision}`;
      s.version = 2;
      (s.publicationGrants ??= []).push({ id, root: store.root, scope, confirmation: { kind: 'tui', coordinator: 'coord', generation: 'coord-generation', sessionId: 'coord-session', sessionFile: join(dir, 'session.jsonl'), branchAnchor: null, origin: 'tool', toolCallId: 'synthetic-call', at: Date.now(), displayedScope, digest: createHash('sha256').update(displayedScope).digest('hex') } });
      return id;
    });
  }
  return { dir, store, plan, report, proof, proposal, observed, grant,
    check: (grantId, scope = proposal, who = 'coord') => publicationAction(store, who, { action: 'check', grantId, scope }),
    record: (grantId, scope = proposal, o = observed, evidence = [proof]) => publicationAction(store, 'coord', { action: 'record', grantId, scope, observed: o, evidence }),
  };
}

for (const profile of ['light', 'strict']) for (const risky of [false, true]) for (const state of ['implementing', 'ready', 'blocked']) {
  test(`exact draft create/update leaves lifecycle and ordinary release intact (${profile}, risky=${risky}, ${state})`, t => {
    const f = fixture(t, profile, risky);
    if (state !== 'implementing') taskAction(f.store, 'worker', { action: 'result', id: 'task', status: state === 'ready' ? 'ready' : 'blocked', commit: SHA, report: f.report, evidence: [f.proof] });
    // Existing verification attestations and normal releases are not adopted or advanced by WIP.
    f.store.transact(s => {
      if (state === 'ready') s.tasks.task.verification = { commit: SHA, planHash: s.tasks.task.planHash, evidence: [f.proof], at: Date.now() };
      s.releases.task = { taskId: 'task', owner: 'coord', token: 'normal-token', commit: OTHER, stage: 'blocked', evidence: [f.proof], updatedAt: Date.now() };
      s.releaseLock = { owner: 'coord', token: 'normal-token', taskId: 'task' };
    });
    const before = f.store.read();
    const id = f.grant();
    assert.equal(f.check(id).allowed, true); const revision = f.store.read().revision;
    assert.equal(f.check(id).allowed, true); assert.equal(f.store.read().revision, revision, 'check is read-only');
    const record = f.record(id);
    assert.deepEqual(f.record(id), record, 'exact retry is idempotent');
    assert.equal(f.check(id).allowed, false, 'recorded scope must not re-execute create/update');
    const update = { ...f.proposal, operation: 'update', pr: f.observed.pr, commit: OTHER, findings: 'New snapshot; independent review remains unresolved.' };
    assert.throws(() => f.check(id, update), /changed/);
    const updateId = f.grant(update);
    assert.throws(() => f.check(id), /superseded/);
    assert.equal(f.check(updateId, update).allowed, true);
    f.record(updateId, update, { ...f.observed, commit: OTHER });
    const after = f.store.read();
    for (const key of ['tasks', 'releases', 'releaseLock', 'releaseGrants', 'resources', 'agents']) assert.deepEqual(after[key], before[key], key);
    assert.equal(counts(after).shipped, 0); assert.equal(counts(after).done, 0);
    assert.match(board(after).join('\n'), new RegExp(`WIP UNVERIFIED ${OTHER}`));
    assert.match(taskDetails(after, after.tasks.task), /UNVERIFIED \/ WIP draft snapshot/);
    assert.match(taskDetails(after, after.tasks.task), /New snapshot; independent review/);
    assert.match(after.publicationGrants[0].confirmation.displayedScope, /Independent review unresolved/);
    assert.match(after.publicationGrants[0].confirmation.displayedScope, /not automated discovery/);
    assert.match(after.publicationGrants[0].confirmation.displayedScope, new RegExp(state));
  });
}

test('exact current approval required even for light non-risky; no planned/nonshipping/terminal publication', t => {
  const f = fixture(t, 'light', false);
  f.store.transact(s => { delete s.tasks.task.approval; });
  assert.throws(() => f.grant(), /approval/);
  taskAction(f.store, 'coord', { action: 'approve', id: 'task', source: 'Synthetic approval' });
  for (const state of ['planned', 'approved', 'skipped']) {
    f.store.transact(s => { s.tasks.task.state = state; });
    assert.throws(() => f.grant(), /shipping task/);
  }
  f.store.transact(s => { s.tasks.task.state = 'implementing'; s.tasks.task.ships = false; });
  assert.throws(() => f.grant(), /shipping task/);
});

for (const profile of ['light', 'strict']) for (const risky of [false, true]) test(`WIP never authorizes ordinary releases, verification or non-draft (${profile}, risky=${risky})`, t => {
  const f = fixture(t, profile, risky); const id = f.grant();
  for (const operation of ['pr', 'merge', 'deploy', 'local-install']) {
    assert.throws(() => releaseAction(f.store, 'coord', { action: 'claim', taskId: 'task', ...(operation === 'local-install' ? { operation, commit: SHA, installationTarget: join(f.dir, 'install') } : {}) }));
    assert.throws(() => releaseAction(f.store, 'coord', { action: 'check', taskId: 'task', operation }));
    assert.throws(() => f.check(id, { ...f.proposal, operation }));
  }
  assert.throws(() => taskAction(f.store, 'worker', { action: 'verify', id: 'task', commit: SHA, evidence: [f.proof] }));
  assert.throws(() => f.check(id, { ...f.proposal, draft: false }), /draft/);
  assert.throws(() => f.record(id, f.proposal, { ...f.observed, draft: false }), /draft/);
  assert.throws(() => f.check(id, f.proposal, 'worker'), /coordinator/);
  assert.equal(f.store.read().tasks.task.verification, undefined);
});

test('mixed ordinary grants do not widen WIP or bypass ordinary verification', t => {
  const f = fixture(t), id = f.grant();
  f.store.transact(s => {
    const scope = releaseScope(s, [{ taskId: 'task', action: 'pr' }]); const displayedScope = displayReleaseScope(f.store.root, scope);
    s.releaseGrants = [{ id: 'normal-grant', root: f.store.root, scope, confirmation: { kind: 'tui', coordinator: 'coord', generation: 'coord-generation', sessionId: 'coord-session', sessionFile: '/synthetic/session.jsonl', branchAnchor: null, origin: 'tool', toolCallId: 'synthetic-normal-call', at: Date.now(), displayedScope, digest: createHash('sha256').update(displayedScope).digest('hex') } }];
  });
  assert.throws(() => releaseAction(f.store, 'coord', { action: 'claim', taskId: 'task' }), /verif/i);
  assert.throws(() => f.check('normal-grant'), /WIP grant/);
  assert.throws(() => f.check(id, { ...f.proposal, operation: 'merge' }));
});

test('proposal drift invalidates all calls; task context or approval drift invalidates execution only', t => {
  const f = fixture(t), id = f.grant();
  for (const fields of [{ commit: OTHER }, { repoPath: f.dir + '/other' }, { repository: 'other/repo' }, { headBranch: 'wip/other' }, { baseBranch: 'next' }, { findings: 'Different limitations' }, { operation: 'update', pr: f.observed.pr }]) {
    assert.throws(() => f.check(id, { ...f.proposal, ...fields }), /changed/);
    assert.throws(() => f.record(id, { ...f.proposal, ...fields }));
  }
  f.store.transact(s => { s.tasks.task.summary = { text: 'Review failed: unresolved blocker', needsHuman: true, by: 'coord', at: Date.now() }; });
  assert.throws(() => f.check(id), /context changed/);
  assert.equal(f.record(id).observed.commit, SHA, 'historical recording does not require current execution authority');
  assert.throws(() => f.check(id), /context changed/);
  const next = f.grant();
  assert.match(f.store.read().publicationGrants.at(-1).scope.blockers, /Review failed/);
  writeFileSync(f.plan, 'Unapproved plan drift');
  assert.throws(() => f.check(next), /approval/);
});

test('WIP never freezes correction/start/resubmission or clears blockers/verifications', t => {
  const f = fixture(t);
  taskAction(f.store, 'worker', { action: 'result', id: 'task', status: 'ready', commit: SHA, report: f.report, evidence: [f.proof] });
  const id = f.grant(); f.record(id);
  taskAction(f.store, 'worker', { action: 'start', id: 'task' });
  assert.equal(f.store.read().tasks.task.state, 'implementing');
  assert.equal(f.store.read().tasks.task.result.commit, SHA);
  assert.throws(() => f.check(id), /context changed/);
  taskAction(f.store, 'worker', { action: 'result', id: 'task', status: 'ready', commit: OTHER, report: f.report, evidence: [f.proof] });
  taskAction(f.store, 'coord', { action: 'verify', id: 'task', commit: OTHER, evidence: [f.proof] });
  assert.equal(f.store.read().tasks.task.verification.commit, OTHER);
  assert.throws(() => f.grant(), /shipping task/);
  const verified = f.store.read().tasks.task;
  taskAction(f.store, 'worker', { action: 'start', id: 'task' });
  const next = f.grant({ ...f.proposal, commit: OTHER });
  assert.equal(f.store.read().tasks.task.result.id, verified.result.id);
  assert.equal(f.check(next, { ...f.proposal, commit: OTHER }).allowed, true);
});

test('observed facts/evidence must match; conflicts never overwrite audit and interrupted record can reconcile', t => {
  const f = fixture(t), id = f.grant();
  assert.throws(() => f.record(id, f.proposal, f.observed, []), /evidence/);
  assert.throws(() => f.record(id, f.proposal, f.observed, [join(f.dir, 'missing')]));
  assert.throws(() => f.record(id, f.proposal, f.observed, [f.dir]), /regular/);
  for (const fields of [{ commit: OTHER }, { repository: 'other/repo' }, { headBranch: 'wrong' }, { baseBranch: 'wrong' }, { pr: 'https://github.com/other/repo/pull/1' }, { draft: false }]) assert.throws(() => f.record(id, f.proposal, { ...f.observed, ...fields }));
  assert.equal(f.store.read().publications, undefined);
  // No replay of an external action: the operator supplies independently reconciled observed evidence.
  assert.equal(f.check(id).recorded, null);
  const record = f.record(id);
  assert.throws(() => f.record(id, f.proposal, { ...f.observed, pr: 'https://github.com/example/synthetic/pull/2' }), /Conflicting/);
  assert.deepEqual(f.record(id, f.proposal, Object.fromEntries(Object.entries(f.observed).reverse())), record);
  const update = { ...f.proposal, operation: 'update', pr: f.observed.pr }, updateId = f.grant(update);
  assert.throws(() => f.record(updateId, update, { ...f.observed, pr: 'https://github.com/example/synthetic/pull/2' }), /update destination/);
});

test('historical evidence recording and exact retry survive corrections, plan drift and supersession without restoring authority', t => {
  const f = fixture(t);
  taskAction(f.store, 'worker', { action: 'result', id: 'task', status: 'ready', commit: SHA, report: f.report, evidence: [f.proof] });
  const original = f.grant();
  taskAction(f.store, 'worker', { action: 'start', id: 'task' });
  taskAction(f.store, 'worker', { action: 'result', id: 'task', status: 'ready', commit: OTHER, report: f.report, evidence: [f.proof] });
  const before = f.store.read().tasks.task;
  assert.throws(() => f.check(original), /context changed/);
  const record = f.record(original);
  assert.deepEqual(f.store.read().tasks.task, before);
  taskAction(f.store, 'worker', { action: 'start', id: 'task' });
  taskAction(f.store, 'coord', { action: 'note', id: 'task', summary: 'New unresolved review blocker' });
  assert.deepEqual(f.record(original), record);
  const newer = f.grant({ ...f.proposal, commit: OTHER });
  assert.throws(() => f.check(original), /superseded/);
  assert.deepEqual(f.record(original), record);
  writeFileSync(f.plan, 'Plan changed after publication');
  assert.throws(() => f.check(newer, { ...f.proposal, commit: OTHER }), /approval/);
  assert.deepEqual(f.record(original), record);
  for (const fields of [{ commit: OTHER }, { repository: 'other/repo' }, { headBranch: 'other' }, { baseBranch: 'other' }, { findings: 'rewritten findings' }]) assert.throws(() => f.record(original, { ...f.proposal, ...fields }), /original/);
  assert.throws(() => f.record(original, f.proposal, { ...f.observed, pr: 'https://github.com/example/synthetic/pull/2' }), /Conflicting/);
  for (const field of ['piSessionId', 'sessionFile', 'generation']) {
    const prior = f.store.read().agents.coord[field];
    f.store.transact(s => { s.agents.coord[field] = 'replacement-identity'; });
    assert.throws(() => f.record(original), /current-coordinator/);
    f.store.transact(s => { s.agents.coord[field] = prior; });
  }
});

test('legacy schema remains readable; WIP promotion cannot downgrade or be written by legacy runtime', async t => {
  const f = fixture(t);
  assert.equal(f.store.read().version, 1);
  assert.throws(() => f.store.transact(s => { s.publicationGrants = []; }), /publication-aware/);
  // Exercise the actual base runtime's reader AND transaction load, not a simulated version predicate.
  const legacy = join(f.dir, 'legacy');
  cpSync(new URL('./fixtures/legacy-runtime/pre-publication/', import.meta.url), legacy, { recursive: true });
  const { openStore: legacyOpen } = await import(pathToFileURL(join(legacy, 'store.ts')).href);
  const oldHandle = legacyOpen(f.store.root, false);
  assert.equal(oldHandle.read().version, 1);
  f.grant(); assert.equal(f.store.read().version, 2);
  assert.throws(() => oldHandle.read(), /Unsupported registry schema version/);
  assert.throws(() => oldHandle.transact(s => { s.notifications.stale = ['bad']; }), /Unsupported registry schema version/);
  oldHandle.close();
  assert.throws(() => f.store.transact(s => { s.version = 1; delete s.publicationGrants; delete s.publications; }), /downgrade/);
  const script = `import { openStore } from ${JSON.stringify(join(legacy, 'store.ts'))}; const db=openStore(process.argv[1],false); db.transact(s=>{s.notifications.stale=['bad'];});`;
  assert.throws(() => execFileSync(process.execPath, ['--input-type=module', '-e', script, f.store.root], { stdio: 'pipe' }), /Unsupported registry schema version/);
  const current = openStore(f.store.root, false);
  assert.equal(current.read().version, 2); assert.equal(current.read().notifications.stale, undefined); current.close();
});

test('malformed historical ledger fails closed and copied grants cannot cross registries or generations', t => {
  const f = fixture(t), id = f.grant();
  assert.throws(() => f.store.transact(s => { s.publicationGrants[0].confirmation.digest = '0'.repeat(64); }), /digest/);
  assert.throws(() => f.store.transact(s => { s.publicationGrants[0].scope.draft = false; }), /draft/);
  f.store.transact(s => { s.publicationGrants[0].root = '/other-registry'; const g = s.publicationGrants[0]; g.confirmation.displayedScope = displayPublicationScope(g.root, g.scope); g.confirmation.digest = createHash('sha256').update(g.confirmation.displayedScope).digest('hex'); });
  assert.throws(() => f.check(id), /WIP grant/);
  f.store.transact(s => { s.agents.coord.generation = 'new-generation'; });
  assert.throws(() => f.check(id), /WIP grant/);
});

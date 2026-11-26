import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.ts';
import { displayReleaseScope, hashPlan, releaseAction, releaseScope, retainsOnApproval, taskAction } from '../src/workflow.ts';
import { approvalTag, board, needsPlanApproval } from '../src/board.ts';
import { taskDetails } from '../src/board-view.ts';

// Synthetic, isolated registries only: late plan approval in light mode, with nothing installed or published.
const A = 'a'.repeat(40), B = 'b'.repeat(40), I = 'd'.repeat(40);

function fixture(t, profile = 'light') {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'orchestrator-retention-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = openStore(join(dir, 'registry'));
  t.after(() => store.close());
  const report = join(dir, 'report.md'), proof = join(dir, 'proof.log'), target = join(dir, 'installed');
  writeFileSync(report, 'Synthetic report\n'); writeFileSync(proof, 'Synthetic evidence; nothing installed\n');
  store.transact((s) => { s.profile = profile; });
  const agent = (id, role, taskId, parentId = 'coord') => store.transact((s) => {
    s.agents[id] = { id, role, ...(parentId ? { parentId } : {}), ...(taskId ? { taskId } : {}), model: 'synthetic/model',
      generation: `${id}-g1`, lifecycle: 'running', worktree: dir, sessionDir: join(dir, id), piSessionId: `${id}-session`, sessionFile: join(dir, `${id}.jsonl`) };
  });
  agent('coord', 'coordinator', undefined, null);
  const plans = {};
  const create = (id, extra = {}) => {
    plans[id] = join(dir, `${id}.md`); writeFileSync(plans[id], `# ${id}\n`);
    taskAction(store, 'coord', { action: 'create', id, title: `Synthetic ${id}`, planPath: plans[id], ...extra });
    agent(`owner-${id}`, 'implementer', id);
  };
  const start = (id) => taskAction(store, `owner-${id}`, { action: 'start', id });
  const ready = (id, commit = A) => taskAction(store, `owner-${id}`, { action: 'result', id, status: 'ready', commit, report, evidence: [proof] });
  const verify = (id, commit = A, who = `owner-${id}`) => taskAction(store, who, { action: 'verify', id, commit, evidence: [proof] });
  // Shipped without any plan approval, as light mode allows.
  const ship = (id, commit = A, extra = {}) => { create(id, extra); start(id); ready(id, commit); return verify(id, commit); };
  // What the human dialog records: approval bound to the hash it displayed.
  const approve = (id, expectedHash = hashPlan(plans[id])) => taskAction(store, 'coord', { action: 'approve', id, source: 'Synthetic human confirmation', ...(expectedHash === null ? {} : { expectedHash }) });
  const authorize = (proposals) => store.transact((s) => {
    const scope = releaseScope(s, proposals), displayedScope = displayReleaseScope(store.root, scope);
    if (scope.some((pair) => pair.includes)) s.version = Math.max(s.version, 3);
    (s.releaseGrants ??= []).push({ id: `grant-${s.revision}`, root: store.root, scope, confirmation: { kind: 'tui', coordinator: 'coord', generation: 'coord-g1',
      sessionId: 'coord-session', sessionFile: join(dir, 'coord.jsonl'), branchAnchor: null, origin: 'tool', toolCallId: 'synthetic-call',
      at: Date.now(), displayedScope, digest: createHash('sha256').update(displayedScope).digest('hex') } });
  });
  return { dir, store, report, proof, target, plans, agent, create, start, ready, verify, ship, approve, authorize };
}

test('late approval keeps a light verified result only under four-way hash equality', (t) => {
  const f = fixture(t);
  const before = f.ship('kept');
  const after = f.approve('kept');
  assert.equal(after.state, 'verified');
  assert.deepEqual(after.result, before.result);
  assert.deepEqual(after.verification, before.verification);
  assert.deepEqual(after.approval.retained, { resultId: before.result.id, commit: A, verifiedAt: before.verification.at });
  assert.equal(after.approval.hash, after.planHash);
  assert.equal(after.history.at(-1).state, 'verified');
  assert.match(after.history.at(-1).note, new RegExp(`plan approved after verification, retained result ${before.result.id} commit ${A} \\(Verified by owner-kept at .*\\); not a review or re-verification`));
  assert.equal(f.store.read().version, 4);
  // Repeating the approval keeps it again; nothing else changes.
  assert.deepEqual(f.approve('kept').approval.retained, after.approval.retained);
});

test('late approval clears the result on any hash drift or without the dialog hash', async (t) => {
  const f = fixture(t);
  const cases = {
    // The file changed: the approved bytes are not what was verified.
    file: (id) => { writeFileSync(f.plans[id], '# revised\n'); },
    // The registered plan hash drifted from the verification.
    planHash: (id) => { f.store.transact((s) => { s.tasks[id].planHash = 'f'.repeat(64); }); },
    // The verification was recorded against other bytes.
    verification: (id) => { f.store.transact((s) => { s.tasks[id].verification.planHash = 'f'.repeat(64); }); },
  };
  for (const [name, drift] of Object.entries(cases)) {
    f.ship(name); drift(name);
    const task = f.approve(name);
    assert.equal(task.state, 'implementing', name);
    assert.equal(task.result, undefined, name); assert.equal(task.verification, undefined, name);
    assert.equal(task.approval.retained, undefined, name);
  }
  f.ship('no-dialog');
  const silent = f.approve('no-dialog', null);
  assert.equal(silent.result, undefined, 'approval without expectedHash never retains');
  f.ship('mismatch');
  assert.throws(() => f.approve('mismatch', 'f'.repeat(64)), /Plan changed since human confirmation/);
  assert.ok(f.store.read().tasks.mismatch.verification, 'a mismatched dialog hash changes nothing');
  assert.equal(f.store.read().version, 1, 'no retention, no schema advance');
});

test('light approval clears ready, implementing and blocked results and keeps owners working', (t) => {
  const f = fixture(t);
  f.create('ready'); f.start('ready'); f.ready('ready');
  f.create('implementing'); f.start('implementing');
  f.create('blocked'); f.start('blocked');
  taskAction(f.store, 'owner-blocked', { action: 'result', id: 'blocked', status: 'blocked', report: f.report, evidence: [] });
  f.create('planned');
  const expected = { ready: 'implementing', implementing: 'implementing', blocked: 'blocked', planned: 'approved' };
  for (const [id, state] of Object.entries(expected)) {
    assert.equal(retainsOnApproval(f.store.read(), f.store.read().tasks[id], hashPlan(f.plans[id])), false, id);
    const task = f.approve(id);
    assert.equal(task.state, state, id);
    assert.equal(task.result, undefined, id); assert.equal(task.verification, undefined, id);
    assert.equal(task.approval.retained, undefined, id);
  }
  // The running owner's next result succeeds without a restart.
  for (const id of ['ready', 'implementing', 'blocked']) assert.equal(f.ready(id, B).state, 'ready', id);
});

test('gated tasks never retain, keep today\'s reset, and the store rejects a retained marker on them', (t) => {
  const f = fixture(t);
  f.create('risky', { risky: true });
  f.approve('risky'); f.start('risky'); f.ready('risky'); f.verify('risky', A, 'coord');
  const reapproved = f.approve('risky');
  assert.equal(reapproved.state, 'approved');
  assert.equal(reapproved.result, undefined); assert.equal(reapproved.approval.retained, undefined);
  f.start('risky'); f.ready('risky'); const verified = f.verify('risky', A, 'coord');
  assert.throws(() => f.store.transact((s) => {
    s.version = 4;
    s.tasks.risky.approval.retained = { resultId: verified.result.id, commit: A, verifiedAt: verified.verification.at };
  }), /Invalid registry schema/);

  const strict = fixture(t, 'strict');
  strict.create('feature'); strict.approve('feature'); strict.start('feature'); strict.ready('feature'); strict.verify('feature', A, 'coord');
  const task = strict.approve('feature');
  assert.equal(task.state, 'approved'); assert.equal(task.result, undefined);
});

test('the store binds a retained approval to the exact current result and schema', (t) => {
  const f = fixture(t);
  const before = f.ship('kept'); f.approve('kept');
  const corrupt = (fn) => assert.throws(() => f.store.transact((s) => fn(s.tasks.kept.approval.retained, s)), /Invalid registry schema|retention-aware/);
  corrupt((kept) => { kept.resultId = 'other'; });
  corrupt((kept) => { kept.commit = B; });
  corrupt((kept) => { kept.verifiedAt += 1; });
  corrupt((kept) => { kept.extra = true; });
  corrupt((_kept, s) => { delete s.tasks.kept.verification; s.tasks.kept.state = 'ready'; });
  assert.deepEqual(f.store.read().tasks.kept.approval.retained.resultId, before.result.id, 'rejected writes change nothing');
});

test('a retained approval lapses with its result or verification', (t) => {
  const f = fixture(t);
  f.ship('rework'); f.approve('rework');
  const reworked = f.start('rework');
  assert.equal(reworked.approval.retained, undefined, 'rework clears verification and the retention marker');
  assert.ok(reworked.result, 'the submitted candidate stays for reference');
  assert.equal(reworked.approval.hash, reworked.planHash, 'the approval itself remains current');
  f.ready('rework', B); const fresh = f.verify('rework', B);
  assert.equal(fresh.approval.retained, undefined, 'approval now precedes the new verification');
  f.ship('skipped'); f.approve('skipped');
  assert.equal(taskAction(f.store, 'coord', { action: 'skip', id: 'skipped', reason: 'synthetic' }).approval.retained, undefined);
});

test('a retained result is locally installable and bundleable under its retained result id', (t) => {
  const f = fixture(t);
  const alpha = f.ship('alpha', A); f.ship('integration', I);
  for (const id of ['alpha', 'integration']) f.approve(id);
  assert.equal(f.store.read().tasks.alpha.approval.retained.resultId, alpha.result.id);
  const includes = [{ taskId: 'alpha', resultId: alpha.result.id, commit: A }];
  const install = { taskId: 'integration', action: 'local-install', commit: I, installationTarget: f.target, repoPath: f.dir, includes };
  f.authorize([install]);
  const claimed = releaseAction(f.store, 'coord', { action: 'claim', taskId: 'integration', operation: 'local-install', commit: I, installationTarget: f.target, includes });
  assert.equal(claimed.included[0].resultId, alpha.result.id);
  assert.equal(f.store.read().version, 4, 'bundles remain valid on the retention-aware schema');
});

test('unapproved light shipping work is tagged on the board, and retained approvals are labelled', (t) => {
  const f = fixture(t);
  f.ship('verified'); f.create('planned'); f.create('review', { ships: false });
  const lines = board(f.store.read()).join('\n');
  for (const id of ['verified', 'planned']) assert.match(lines, new RegExp(`${id} .*\\[${approvalTag.replace(/[()]/g, '\\$&')}\\]`));
  assert.doesNotMatch(lines.split('\n').find((line) => line.includes(' review ')), /no plan approval/);
  f.approve('verified');
  const state = f.store.read();
  assert.equal(needsPlanApproval(state, state.tasks.verified), false);
  assert.doesNotMatch(board(state).join('\n').split('\n').find((line) => line.includes(' verified ')), /no plan approval/);
  assert.match(taskDetails(state, state.tasks.verified), new RegExp(`Plan approved after verification: kept result ${state.tasks.verified.result.id} commit ${A} \\(not a review or re-verification\\)`));
  f.create('working'); f.start('working'); f.ready('working');
  const working = f.store.read();
  assert.match(taskDetails(working, working.tasks.working), /No plan approval \(needed for local install, bundle or WIP\); approving clears this result and verification, so it needs republishing and fresh verification \(not permission to install\)/);
  const strict = fixture(t, 'strict');
  strict.create('gated');
  assert.equal(needsPlanApproval(strict.store.read(), strict.store.read().tasks.gated), false, 'gated work already requires approval before start');
});

// Exercise the actual pre-retention runtime, not a simulated predicate.
test('the pre-retention runtime fails closed on a registry recording a retained approval', async (t) => {
  const f = fixture(t);
  const legacy = join(f.dir, 'legacy');
  cpSync(new URL('./fixtures/legacy-runtime/pre-retention/', import.meta.url), legacy, { recursive: true });
  const old = await import(pathToFileURL(join(legacy, 'store.ts')).href);
  const oldWorkflow = await import(pathToFileURL(join(legacy, 'workflow.ts')).href);
  const handle = old.openStore(f.store.root, false);
  t.after(() => handle.close());
  f.ship('kept');
  assert.equal(handle.read().tasks.kept.state, 'verified', 'unretained registries stay readable by the old runtime');
  f.approve('kept');
  assert.throws(() => handle.read(), /Unsupported registry schema version/);
  // It can neither replace the kept result nor restart it while the retention marker survives.
  assert.throws(() => oldWorkflow.taskAction(handle, 'owner-kept', { action: 'start', id: 'kept' }), /Unsupported registry schema version/);
  assert.equal(f.store.read().tasks.kept.state, 'verified');
});

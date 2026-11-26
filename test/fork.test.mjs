import test from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.ts';
import { releaseAction, taskAction, releaseScope, displayReleaseScope } from '../src/workflow.ts';
import { forkOrchestrator } from '../src/runtime.ts';
import { notices } from '../src/bridge.ts';
import { board } from '../src/board.ts';
import { acquireDeploy, ensureFamily, familyMembers, readDeploy, releaseDeploy, reserveMember } from '../src/family.ts';

const SHA = 'a'.repeat(40);
const MAIN = 'c'.repeat(40);

// Synthetic parent orchestrator plus forks; the runner is injected, so no Zellij or Pi process starts.
function fixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'orchestrator-fork-test-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo'); mkdirSync(repo);
  const extension = join(dir, 'extension.ts'); writeFileSync(extension, '// never loaded\n');
  const plan = join(dir, 'plan.md'); const report = join(dir, 'report.md'); const proof = join(dir, 'smoke.log');
  writeFileSync(plan, 'Plan\n'); writeFileSync(report, 'Report\n'); writeFileSync(proof, 'Smoke\n');
  const root = join(dir, 'registry');
  const store = openStore(root);
  t.after(() => store.close());
  store.transact((s) => {
    s.profile = 'light';
    s.agents.coord = { id: 'coord', role: 'coordinator', model: 'openai-codex/gpt-6-astra', generation: 'coord-g1', lifecycle: 'running',
      worktree: repo, sessionDir: join(dir, 'coord-sessions'), piSessionId: 'coord-session' };
  });
  const calls = [];
  let nextTab = 7;
  const runner = async (command, args) => { calls.push([command, ...args]); return { stdout: command === 'pi' ? `${store.read().agents.coord.model}\n` : `${nextTab++}\n`, stderr: '' }; };
  const fork = (name, extra = {}) => forkOrchestrator(store, 'coord', { name, request: `Build ${name} end to end.`, ...extra },
    extension, 'kind-test', runner, undefined, dir);
  return { dir, repo, extension, plan, report, proof, store, calls, runner, fork };
}

// A light owner that has merged its task and may now take the (family) deploy lock.
function merged(store, paths, task, owner) {
  taskAction(store, 'coord', { action: 'create', id: task, title: task, planPath: paths.plan });
  store.transact((s) => {
    s.agents[owner] = { id: owner, role: 'implementer', parentId: 'coord', taskId: task, model: 'openai-codex/gpt-6-astra', generation: `${owner}-g1`,
      lifecycle: 'running', worktree: join(paths.dir, owner), sessionDir: join(paths.dir, 'sessions', owner), piSessionId: `${owner}-session` };
    const scope = releaseScope(s, ['merge', 'deploy'].map(action => ({ taskId: task, action, ...(action === 'deploy' ? { deploymentTarget: 'synthetic' } : {}) })));
    const displayedScope = displayReleaseScope(store.root, scope);
    (s.releaseGrants ??= []).push({ id: `synthetic-${s.revision}`, root: store.root, scope, confirmation: {
      kind: 'tui', coordinator: 'coord', generation: 'coord-g1', sessionId: 'coord-session', sessionFile: join(paths.dir, 'session.jsonl'), branchAnchor: null,
      origin: 'tool', toolCallId: 'synthetic-call', at: Date.now(), displayedScope, digest: createHash('sha256').update(displayedScope).digest('hex'),
    } });
  });
  taskAction(store, owner, { action: 'start', id: task });
  taskAction(store, owner, { action: 'result', id: task, status: 'ready', commit: SHA, report: paths.report, evidence: [paths.proof] });
  taskAction(store, owner, { action: 'verify', id: task, commit: SHA, evidence: [paths.proof] });
  const release = releaseAction(store, owner, { action: 'claim', taskId: task });
  releaseAction(store, owner, { action: 'record', taskId: task, token: release.token, stage: 'merged', mergedCommit: MAIN, evidence: [paths.proof] });
  return release;
}
function coordinator(store) {
  store.transact((s) => {
    s.agents.coord ??= { id: 'coord', role: 'coordinator', model: 'openai-codex/gpt-6-astra', generation: 'coord-g1', lifecycle: 'running',
      worktree: '/unused', sessionDir: '/unused', piSessionId: 'fork-coord-session' };
  });
}

test('a fork opens an independent orchestrator tab in the human session and records only a pointer', async (t) => {
  const f = fixture(t);
  const fork = await f.fork('alpha');
  const family = `${f.store.root}.family`;
  assert.equal(fork.root, join(family, 'alpha'));
  assert.equal(lstatSync(family).mode & 0o777, 0o700);
  assert.equal(readFileSync(join(family, 'origin'), 'utf8'), f.store.root);
  const child = openStore(fork.root, false);
  assert.deepEqual([child.read().profile, child.read().family, Object.keys(child.read().agents).length], ['light', family, 0]);
  child.close();
  const prompt = readFileSync(join(fork.root, 'fork-prompt.md'), 'utf8');
  assert.match(prompt, /do not report to, or take instructions from/);
  assert.match(prompt, /confirm it with the human before spawning/);
  assert.match(prompt, /close-session/);
  assert.match(prompt, /Build alpha end to end\./);
  assert.deepEqual(f.calls, [['pi', '--list-models'], ['zellij', '--session', 'kind-test', 'action', 'new-tab', '--name', 'alpha', '--cwd', f.repo, '--',
    'pi', '--provider', 'openai-codex', '--model', 'gpt-6-astra', '--thinking', 'high', '--extension', f.extension, '--orchestrator-coordinate', fork.root, `@${join(fork.root, 'fork-prompt.md')}`]]);
  assert.ok(!f.calls.some((call) => call.includes('go-to-tab') || call.includes('go-to-tab-by-id')), 'focus stays on the new tab');
  const parent = f.store.read();
  assert.equal(parent.family, family);
  assert.deepEqual(parent.forks.map((x) => [x.name, x.session, x.tabId]), [['alpha', 'kind-test', 7]]);
  assert.ok(board(parent).includes('⑂ forked alpha → tab 7 in kind-test'));
});

test('forks use implementation thinking for a non-judgement parent model and accept an override', async (t) => {
  const f = fixture(t);
  f.store.transact(s => { s.agents.coord.model = 'other-provider/parent-model'; });
  writeFileSync(join(f.dir, 'model-roles.json'), JSON.stringify({
    judgement: 'other-provider/judgement-model', implementationThinking: 'low', judgementThinking: 'xhigh',
  }));
  await f.fork('alpha');
  await f.fork('beta', { thinking: 'off' });
  const [alpha, beta] = f.calls.filter(call => call[0] === 'zellij');
  assert.equal(alpha[alpha.indexOf('--provider') + 1], 'other-provider');
  assert.equal(alpha[alpha.indexOf('--model') + 1], 'parent-model');
  assert.equal(alpha[alpha.indexOf('--thinking') + 1], 'low');
  assert.equal(beta[beta.indexOf('--thinking') + 1], 'off');
});

test('forks select an explicit model ahead of current and recorded parent models and use its thinking setting', async (t) => {
  for (const thinking of [undefined, 'high']) {
    const f = fixture(t);
    const runner = async (command, args) => {
      if (command === 'pi') { f.calls.push([command, ...args]); return { stdout: 'custom-provider chosen/model\n', stderr: '' }; }
      return f.runner(command, args);
    };
    writeFileSync(join(f.dir, 'model-roles.json'), JSON.stringify({
      judgement: 'custom-provider/chosen/model', implementationThinking: 'low', judgementThinking: 'xhigh',
    }));
    await forkOrchestrator(f.store, 'coord', { name: 'alpha', request: 'Synthetic work', model: 'custom-provider/chosen/model', thinking },
      f.extension, 'kind-test', runner, 'other-provider/current-parent', f.dir);
    const argv = f.calls.find(call => call[0] === 'zellij');
    assert.equal(argv[argv.indexOf('--provider') + 1], 'custom-provider');
    assert.equal(argv[argv.indexOf('--model') + 1], 'chosen/model');
    assert.equal(argv[argv.indexOf('--thinking') + 1], thinking ?? 'xhigh');
    assert.equal(f.store.read().agents.coord.model, 'openai-codex/gpt-6-astra');
  }
});

test('unavailable or malformed explicit fork models fail before family or tab creation', async (t) => {
  for (const model of ['missing/model', '', 'bare-model', 'provider/model with spaces']) {
    const f = fixture(t);
    await assert.rejects(f.fork('alpha', { model }), /Required model unavailable|Invalid model/);
    assert.equal(f.store.read().family, undefined);
    assert.equal(f.store.read().forks, undefined);
    assert.equal(existsSync(`${f.store.root}.family`), false);
    assert.equal(f.calls.some(call => call[0] === 'zellij'), false);
  }
});

test('forks are bounded to three orchestrators per family and need a coordinator inside Zellij', async (t) => {
  const f = fixture(t);
  await f.fork('alpha');
  const beta = await f.fork('beta', { profile: 'strict' });
  const child = openStore(beta.root, false); assert.equal(child.read().profile, 'strict'); child.close();
  await assert.rejects(f.fork('gamma'), /allows 3 orchestrators/);
  assert.equal(existsSync(join(`${f.store.root}.family`, 'gamma')), false, 'rejected slot is released');
  assert.equal(familyMembers(`${f.store.root}.family`).length, 3);
  await assert.rejects(f.fork('alpha'), /EEXIST/);
  await assert.rejects(forkOrchestrator(f.store, 'coord', { name: 'x', request: 'y' }, f.extension, undefined, f.runner), /not running inside Zellij/);
  f.store.transact((s) => { s.agents.worker = { ...s.agents.coord, id: 'worker', role: 'implementer', piSessionId: 'w' }; });
  await assert.rejects(forkOrchestrator(f.store, 'worker', { name: 'x', request: 'y' }, f.extension, 'kind-test', f.runner), /Only a coordinator/);
});

test('a failed tab launch keeps the prepared registry and says so', async (t) => {
  const f = fixture(t);
  await assert.rejects(forkOrchestrator(f.store, 'coord', { name: 'alpha', request: 'y' }, f.extension, 'kind-test', async (command) => { if (command === 'pi') return { stdout: 'openai-codex/gpt-6-astra\n', stderr: '' }; throw new Error('zellij down'); }),
    /prepared at .*alpha.*retry with a new name/);
  assert.equal(f.store.read().forks, undefined);
});

test('family members share one deploy lock across registries; merges stay concurrent', async (t) => {
  const f = fixture(t);
  const { root } = await f.fork('alpha');
  const child = openStore(root, false); t.after(() => child.close());
  coordinator(child);
  const parentRelease = merged(f.store, f, 'parent-task', 'owner-p');
  const childRelease = merged(child, f, 'child-task', 'owner-c');
  releaseAction(f.store, 'owner-p', { action: 'lock', taskId: 'parent-task', token: parentRelease.token, deploymentTarget: 'synthetic' });
  assert.equal(readDeploy(`${f.store.root}.family`).root, f.store.root);
  assert.throws(() => releaseAction(child, 'owner-c', { action: 'lock', taskId: 'child-task', token: childRelease.token, deploymentTarget: 'synthetic' }), /already held by orchestrator registry task parent-task/);
  assert.equal(child.read().releaseLock, undefined, 'the rejected registry did not record a lock');
  releaseAction(f.store, 'owner-p', { action: 'unlock', taskId: 'parent-task', token: parentRelease.token, reason: 'deployed and smoked' });
  assert.equal(readDeploy(`${f.store.root}.family`), undefined);
  releaseAction(child, 'owner-c', { action: 'lock', taskId: 'child-task', token: childRelease.token, deploymentTarget: 'synthetic' });
  assert.equal(readDeploy(`${f.store.root}.family`).taskId, 'child-task');
});

test('coordinator adoption carries the family lock to its new token', async (t) => {
  const f = fixture(t); await f.fork('alpha');
  const release = merged(f.store, f, 'task', 'owner');
  releaseAction(f.store, 'owner', { action: 'lock', taskId: 'task', token: release.token, deploymentTarget: 'synthetic' });
  f.store.transact((s) => { s.agents.owner.lifecycle = 'exited'; });
  const adopted = releaseAction(f.store, 'coord', { action: 'claim', taskId: 'task' });
  assert.equal(readDeploy(`${f.store.root}.family`).token, adopted.token);
  releaseAction(f.store, 'coord', { action: 'unlock', taskId: 'task', token: adopted.token, reason: 'reconciled' });
  assert.equal(readDeploy(`${f.store.root}.family`), undefined);
});

test('family lock primitives are exclusive, idempotent and never release another holder', (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'orchestrator-family-test-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const family = join(dir, 'x.family'); ensureFamily(family, join(dir, 'x'));
  const a = { root: '/a', taskId: 't', token: 'one', owner: 'o' };
  const b = { root: '/b', taskId: 't', token: 'two', owner: 'o' };
  acquireDeploy(family, a); acquireDeploy(family, a);
  assert.throws(() => acquireDeploy(family, b), /already held/);
  releaseDeploy(family, b); assert.equal(readDeploy(family).root, '/a');
  releaseDeploy(family, a); assert.equal(readDeploy(family), undefined);
  reserveMember(family, 'one'); reserveMember(family, 'two');
  assert.throws(() => reserveMember(family, 'three'), /allows 3/);
});

test('the coordinator is reminded to close its worker session once all work has ended', (t) => {
  const f = fixture(t);
  taskAction(f.store, 'coord', { action: 'create', id: 'done', title: 'done', planPath: f.plan });
  f.store.transact((s) => {
    s.agents.w = { id: 'w', role: 'implementer', parentId: 'coord', taskId: 'done', model: 'openai-codex/gpt-6-astra', generation: 'w-g1',
      lifecycle: 'closed', worktree: join(f.dir, 'w'), sessionDir: join(f.dir, 'w-s'), piSessionId: 'w-session', zellijSession: 'piorch-abcdef-123456' };
    s.sharedSession = { name: 'piorch-abcdef-123456', ownerId: 'w' };
  });
  const coord = f.store.read().agents.coord;
  const reminder = () => notices(f.store.read(), coord, Date.now()).filter((n) => n.key.startsWith('session-done:'));
  assert.equal(reminder().length, 0, 'a planned task is still pending');
  taskAction(f.store, 'coord', { action: 'skip', id: 'done', reason: 'synthetic' });
  assert.match(reminder()[0].text, /close-session/);
  f.store.transact((s) => { s.sharedSession.closedAt = Date.now(); });
  assert.equal(reminder().length, 0);
});

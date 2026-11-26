import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ABANDONED_MS, abandoned, cleanupInventory, cleanupText, releaseEnded, runEnded } from '../src/cleanup.ts';
import { checklistView } from '../src/board-view.ts';

// Synthetic registry and a fake runner answering git/docker reads; nothing is executed.
function scene(t) {
  const dir = mkdtempSync(join(tmpdir(), 'piorch-cleanup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tree = (name) => { const path = join(dir, name); mkdirSync(path); return path; };
  const agent = (id, taskId, extra = {}) => ({ id, role: 'implementer', parentId: 'coord', taskId, model: 'm', generation: `${id}-g`, lifecycle: 'closed',
    repo: join(dir, 'repo'), branch: `agents/${id}`, worktree: tree(id), sessionDir: '/s', piSessionId: `${id}-p`, zellijSession: 'piorch-aaaaaa-bbbbbb', ...extra });
  const task = (id, state, extra = {}) => ({ id, title: id, state, planPath: '/p', planHash: 'h', dependencies: [], history: [], ...extra });
  const state = { version: 1, revision: 1, createdAt: 0, profile: 'light', messages: [], releases: {}, notifications: {},
    tasks: { shipped: task('shipped', 'merged'), open: task('open', 'implementing'), squashed: task('squashed', 'deployed'), design: task('design', 'ready', { ships: false, result: { status: 'ready' } }) },
    agents: { coord: { id: 'coord', role: 'coordinator', model: 'm', generation: 'g', lifecycle: 'running', worktree: dir, sessionDir: '/s', piSessionId: 'c' } },
    resources: [
      { id: 'r1', kind: 'compose', scope: 'x', value: 'proj-done', taskId: 'shipped' },
      { id: 'r2', kind: 'compose', scope: 'x', value: 'proj-open', taskId: 'open' },
      { id: 'r3', kind: 'port', scope: 'x', value: '23100', taskId: 'shipped' },
      { id: 'r4', kind: 'port', scope: 'x', value: '23101', taskId: 'open' },
      { id: 'r5', kind: 'migration', scope: 'x', value: '50', taskId: 'squashed', releasedAt: 1 },
    ],
    sharedSession: { name: 'piorch-aaaaaa-bbbbbb', ownerId: 'merged-owner' } };
  for (const a of [agent('merged-owner', 'shipped'), agent('dirty-owner', 'squashed'), agent('live-owner', 'open', { lifecycle: 'running' }), agent('squash-owner', 'squashed'), agent('design-owner', 'design')]) state.agents[a.id] = a;
  const answers = { dirty: new Set([state.agents['dirty-owner'].worktree]), merged: new Set([state.agents['merged-owner'].worktree]), identical: new Set(), dockerDown: false };
  const calls = [];
  const runner = async (command, args) => {
    calls.push([command, ...args]);
    const fail = () => { throw Object.assign(new Error('exit 1'), { code: 1 }); };
    if (command === 'zellij') return { stdout: 'piorch-aaaaaa-bbbbbb [Created 1h ago]\n', stderr: '' };
    if (command === 'git') {
      if (args.includes('symbolic-ref')) return { stdout: 'origin/main\n', stderr: '' };
      if (args.includes('status')) return { stdout: answers.dirty.has(args[1]) ? ' M file.ts\n?? new.ts\n' : '', stderr: '' };
      if (args.includes('merge-base')) return answers.merged.has(args[1]) ? { stdout: '', stderr: '' } : fail();
      if (args.includes('HEAD^{tree}')) return { stdout: `${'a'.repeat(40)}\n${(answers.identical.has(args[1]) ? 'a' : 'b').repeat(40)}\n`, stderr: '' };
    }
    if (command === 'docker') {
      if (answers.dockerDown) fail();
      const project = args.find((a) => a.startsWith('label=')).split('=')[2];
      if (args[0] === 'ps') return { stdout: { 'proj-done': 'running\nexited\n', 'proj-open': 'running\n' }[project] ?? '', stderr: '' };
      if (args[0] === 'volume') return { stdout: { 'proj-done': 'proj-done_pg\nproj-done_s3\n', 'proj-open': 'proj-open_pg\n' }[project] ?? '', stderr: '' };
    }
    assert.fail(`unexpected ${command} ${args.join(' ')}`);
  };
  return { dir, state, answers, calls, runner };
}

test('inventory marks what is safe to remove and says why the rest is kept', async (t) => {
  const s = scene(t);
  const items = Object.fromEntries((await cleanupInventory(s.state, s.runner)).map((i) => [i.id.replace(s.dir, ''), i]));
  assert.equal(items['session:piorch-aaaaaa-bbbbbb'].removable, false);
  assert.match(items['session:piorch-aaaaaa-bbbbbb'].detail, /agents not closed: live-owner; retire them first \(orchestrator_agent retire\)$/);
  assert.deepEqual([items['worktree:/merged-owner'].removable, items['worktree:/merged-owner'].suggested], [true, true]);
  assert.match(items['worktree:/merged-owner'].detail, /merged into origin\/main; clean; branch kept/);
  assert.match(items['worktree:/dirty-owner'].detail, /^2 uncommitted changes$/);
  assert.match(items['worktree:/live-owner'].detail, /agent live-owner is running; not merged into origin\/main and task open is implementing/);
  assert.equal(items['worktree:/squash-owner'].removable, true, 'a squash-merged (deployed) task counts as integrated');
  assert.equal(items['worktree:/design-owner'].removable, true, 'done non-shipping work counts as ended');
  assert.match(items['compose:proj-done'].detail, /^2 containers \(1 running\); down keeps volumes$/);
  assert.deepEqual([items['volumes:proj-done'].removable, items['volumes:proj-done'].suggested], [true, true], 'removable volumes are pre-selected');
  assert.equal(items['compose:proj-open'].removable, false);
  assert.match(items['compose:proj-open'].detail, /task open still open/);
  assert.deepEqual(items.reservations.target.resourceIds, ['r1', 'r3'], 'only unreleased reservations of ended tasks');
  assert.ok(!s.calls.some(([command, ...args]) => command === 'docker' && !['ps', 'volume'].includes(args[0])), 'listing only reads');
  assert.match(cleanupText(Object.values(items)), /■ compose proj-open: .* \(keep\)/);
});

test('automatic inventory requires Git integration rather than ended-task attestations', async t => {
  const s = scene(t);
  s.answers.identical.add(s.state.agents['squash-owner'].worktree);
  const items = Object.fromEntries((await cleanupInventory(s.state, s.runner, { automatic: true })).map((i) => [i.id.replace(s.dir, ''), i]));
  assert.equal(items['worktree:/merged-owner'].removable, true);
  assert.equal(items['worktree:/squash-owner'].removable, true);
  assert.match(items['worktree:/squash-owner'].detail, /tree matches origin\/main/);
  assert.equal(items['worktree:/design-owner'].removable, false, 'a done design task does not prove integration');
  assert.match(items['worktree:/design-owner'].detail, /integration .* is unproven/);
});

test('an unavailable docker keeps Compose items and still lists the rest', async (t) => {
  const s = scene(t); s.answers.dockerDown = true;
  const items = await cleanupInventory(s.state, s.runner);
  assert.ok(items.filter((i) => i.kind === 'compose').every((i) => !i.removable && i.detail === 'docker unavailable'));
  assert.ok(items.some((i) => i.kind === 'worktree' && i.removable));
});

test('checklist toggles only removable items and returns the selection without removing anything', () => {
  const keys = { 'tui.select.up': 'up', 'tui.select.down': 'down', 'tui.select.cancel': 'escape', 'tui.select.confirm': 'enter' };
  const kb = { matches: (data, key) => data === keys[key] };
  const wrap = (text, width) => text.split('\n').map((line) => line.slice(0, width));
  const results = [];
  const items = [{ label: 'a', detail: 'x', removable: true, checked: true }, { label: 'b', detail: 'y', removable: false, checked: true }, { label: 'c', detail: 'z', removable: true, checked: false }];
  const view = checklistView('Clean up', items, { terminal: { rows: 12 }, requestRender() {} }, { fg: (_c, l) => l }, kb, (v) => results.push(v), wrap);
  const lines = view.render(60);
  assert.equal(lines.length, 12);
  assert.deepEqual(lines.slice(0, 4), ['Clean up — 1 selected', '› [x] a', '  ■ b', '  [ ] c']);
  view.handleInput('down'); view.handleInput(' ');
  view.handleInput('down'); view.handleInput(' ');
  view.handleInput('enter');
  assert.deepEqual(results, [[0, 2]], 'the kept item stays unselected');
});

test('large cleanup lists keep the selection, detail and controls inside the viewport', () => {
  const kb = { matches: (data, key) => data === key };
  const wrap = (text, width) => text.split('\n').flatMap(line => line.match(new RegExp(`.{1,${width}}`, 'g')) ?? ['']);
  const items = Array.from({ length: 105 }, (_, i) => ({ label: `worktree-${i}`, detail: `COMMIT-${i} retained by integration`, removable: true, checked: true }));
  const view = checklistView('Cleanup', items, { terminal: { rows: 15 }, requestRender() {} }, { fg: (_c, text) => text }, kb, () => {}, wrap);
  let lines = view.render(100);
  assert.equal(lines.length, 15);
  assert.ok(lines.some(line => line.includes('COMMIT-0')));
  assert.match(lines.at(-1), /esc cancel/);
  for (let i = 0; i < 104; i++) view.handleInput('tui.select.down');
  lines = view.render(100);
  assert.equal(lines.length, 15);
  assert.ok(lines.some(line => line.includes('› [x] worktree-104')));
  assert.ok(lines.some(line => line.includes('COMMIT-104')));
  assert.match(lines.at(-1), /esc cancel/);
});

test('a coordinator is abandoned by heartbeat age, never by a live PID', () => {
  const now = 10 * ABANDONED_MS;
  const run = (coordinator) => ({ agents: coordinator ? { c: { id: 'c', role: 'coordinator', lifecycle: 'running', pid: process.pid, ...coordinator } } : {} });
  assert.equal(abandoned(run({ heartbeatAt: now - 5_000 }), now), false, 'a heartbeating coordinator is attached');
  assert.equal(abandoned(run({ heartbeatAt: now - ABANDONED_MS - 1 }), now), true, 'its PID is live, but the session moved on');
  assert.equal(abandoned(run({ lifecycle: 'closed', heartbeatAt: now }), now), true);
  assert.equal(abandoned(run(undefined), now), false, 'a registry without a coordinator is not treated as a finished run');
});

test('ended tasks release their reservations; open tasks keep theirs', (t) => {
  const s = scene(t);
  assert.equal(runEnded(s.state), false, 'one task is still implementing');
  assert.equal(releaseEnded(s.state, 42), 2);
  assert.deepEqual(s.state.resources.map((r) => [r.id, r.releasedAt]), [['r1', 42], ['r2', undefined], ['r3', 42], ['r4', undefined], ['r5', 1]]);
  assert.equal(releaseEnded(s.state, 43), 0, 'releasing again changes nothing');
});

test('records of gone agents with ended work are closable, and stop blocking their worktree and session', async (t) => {
  const s = scene(t);
  s.state.tasks.open.state = 'deployed';
  const dead = 4242, live = 4343;
  const isAlive = (pid) => pid === live;
  // A record left "running" by a process that is gone, as when a worker exits without retiring.
  Object.assign(s.state.agents['live-owner'], { lifecycle: 'running', pid: dead });
  s.state.agents['squash-owner'].lifecycle = 'collected';
  s.state.agents['design-owner'] = { ...s.state.agents['design-owner'], lifecycle: 'running', pid: live };
  s.answers.merged.add(s.state.agents['live-owner'].worktree);
  let items = Object.fromEntries((await cleanupInventory(s.state, s.runner, { isAlive })).map((i) => [i.id.replace(s.dir, ''), i]));
  assert.deepEqual(items.records.target.agentIds, ['live-owner', 'squash-owner'], 'the live process is never closed');
  assert.doesNotMatch(items.records.detail, /coordinator/);
  assert.equal(items['worktree:/live-owner'].removable, true, 'a gone process does not protect a clean merged worktree');
  assert.equal(items['worktree:/design-owner'].removable, false);
  assert.match(items['session:piorch-aaaaaa-bbbbbb'].detail, /agents not closed: design-owner/, 'only the live agent still blocks the session');
  s.state.agents['design-owner'].lifecycle = 'closed';
  items = Object.fromEntries((await cleanupInventory(s.state, s.runner, { isAlive })).map((i) => [i.id.replace(s.dir, ''), i]));
  assert.equal(items['session:piorch-aaaaaa-bbbbbb'].removable, true, 'closing the gone records first frees the session');
  // An abandoned, finished run may close its coordinator record as well.
  items = Object.fromEntries((await cleanupInventory(s.state, s.runner, { isAlive, abandoned: true })).map((i) => [i.id.replace(s.dir, ''), i]));
  assert.deepEqual(items.records.target.agentIds, ['live-owner', 'squash-owner', 'coord']);
  assert.match(items.records.detail, /coordinator cannot be resumed afterwards/);
});

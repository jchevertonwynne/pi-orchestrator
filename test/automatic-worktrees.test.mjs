import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupInventory } from '../src/cleanup.ts';

// Real Git proof in disposable repositories; no installed runtime or external services.
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'piorch-auto-worktree-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo'), tree = join(dir, 'worker');
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['init', '--initial-branch=main', repo], { stdio: 'pipe' });
  git(repo, 'config', 'user.email', 'test@example.invalid');
  git(repo, 'config', 'user.name', 'Synthetic cleanup test');
  writeFileSync(join(repo, 'file'), 'base\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-m', 'base');
  git(repo, 'worktree', 'add', '-b', 'worker', tree);
  const state = { agents: { worker: { id: 'worker', role: 'implementer', lifecycle: 'closed', taskId: 'task', repo, worktree: tree, branch: 'worker' } },
    tasks: { task: { id: 'task', state: 'skipped' } }, resources: [] };
  const runner = async (command, args) => ({ stdout: execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), stderr: '' });
  const inventory = async (run = runner) => (await cleanupInventory(state, run, { automatic: true }))[0];
  const commit = (cwd, file, content) => { writeFileSync(join(cwd, file), content); git(cwd, 'add', '.'); git(cwd, 'commit', '-m', file); };
  return { repo, tree, git, state, inventory, commit, runner };
}

test('automatic worktree cleanup proves ancestry, preserves branches and keeps dirty trees', async t => {
  const f = fixture(t);
  f.commit(f.tree, 'feature', 'feature\n');
  assert.equal((await f.inventory()).removable, false, 'a skipped task with unique work is not integrated');
  assert.match((await f.inventory()).detail, /integration into main is unproven/);
  f.git(f.repo, 'merge', '--ff-only', 'worker');
  assert.equal((await f.inventory()).removable, true);
  assert.match((await f.inventory()).detail, /merged into main; clean; branch kept/);
  f.commit(f.repo, 'later', 'main advanced\n');
  assert.equal((await f.inventory()).removable, true, 'ancestry still proves integration after main advances');
  writeFileSync(join(f.tree, 'scratch'), 'untracked work\n');
  assert.equal((await f.inventory()).removable, false);
  assert.match((await f.inventory()).detail, /1 uncommitted change/);
  assert.equal(f.git(f.repo, 'rev-parse', 'worker'), f.git(f.tree, 'rev-parse', 'HEAD'), 'inventory keeps the branch and moves no refs');
});

test('automatic cleanup accepts an identical squash tree, but keeps uncertain later-main comparisons', async t => {
  const f = fixture(t);
  f.commit(f.tree, 'first', 'first\n'); f.commit(f.tree, 'second', 'second\n');
  f.git(f.repo, 'merge', '--squash', 'worker'); f.git(f.repo, 'commit', '-m', 'squashed feature');
  assert.throws(() => f.git(f.repo, 'merge-base', '--is-ancestor', 'worker', 'main'));
  assert.equal((await f.inventory()).removable, true);
  assert.match((await f.inventory()).detail, /tree matches main; clean; branch kept/);
  f.commit(f.repo, 'later', 'later\n');
  assert.equal((await f.inventory()).removable, false, 'no inference from ended task state when squash integration is uncertain');
});

test('automatic cleanup keeps open, missing-task and live-process worktrees even when integrated', async t => {
  const f = fixture(t);
  f.state.tasks.task.state = 'implementing';
  assert.equal((await f.inventory()).removable, false);
  delete f.state.tasks.task;
  assert.match((await f.inventory()).detail, /no task/);
  f.state.tasks.task = { id: 'task', state: 'skipped' };
  f.state.agents.worker.pid = process.pid;
  assert.match((await f.inventory()).detail, /process is still alive/);
  assert.equal((await f.inventory()).removable, false, 'a closed record cannot override a live PID');
});

test('automatic cleanup fails closed on unknown default branches and failed Git reads', async t => {
  const f = fixture(t);
  f.git(f.repo, 'branch', '-m', 'main', 'trunk');
  assert.equal((await f.inventory()).removable, false, 'HEAD is not a substitute for a known default branch');
  assert.match((await f.inventory()).detail, /default branch is unknown/);
  f.git(f.repo, 'branch', '-m', 'trunk', 'main');
  for (const failAt of ['status', 'merge-base', 'HEAD^{tree}']) {
    const runner = async (command, args) => {
      if (args.includes(failAt) || (failAt === 'merge-base' && args.includes('HEAD^{tree}'))) throw new Error('synthetic Git failure');
      return f.runner(command, args);
    };
    // A tree-ID failure matters only when ancestry cannot prove integration.
    if (failAt === 'HEAD^{tree}') f.commit(f.tree, 'unique', 'unique\n');
    assert.equal((await f.inventory(runner)).removable, false, failAt);
  }
});

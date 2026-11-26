import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync, rmSync, existsSync, symlinkSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectWorktree, removeReviewedWorktree } from '../src/explicit-cleanup.ts';
import { run } from '../src/runtime.ts';

function scene(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'explicit-cleanup-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo'), tree = join(dir, 'worker');
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main', repo);
  git('-C', repo, 'config', 'user.name', 'Test'); git('-C', repo, 'config', 'user.email', 'test@example.invalid');
  writeFileSync(join(repo, 'file'), 'base'); git('-C', repo, 'add', '.');
  git('-C', repo, '-c', 'commit.gpgsign=false', 'commit', '-m', 'base');
  git('-C', repo, 'worktree', 'add', '-b', 'worker', tree);
  writeFileSync(join(tree, 'file'), 'candidate'); git('-C', tree, 'add', '.');
  git('-C', tree, '-c', 'commit.gpgsign=false', 'commit', '-m', 'candidate');
  git('-C', repo, 'branch', 'retained', 'worker');
  const input = { repoPath: repo, worktreePath: tree, retainedRef: 'refs/heads/retained' };
  const calls = []; let openFiles = '';
  const runner = async (command, args) => {
    calls.push([command, ...args]);
    if (command === 'lsof') return { stdout: openFiles, stderr: '' };
    return { stdout: git(...args), stderr: '' };
  };
  return { dir, repo, tree, input, calls, runner, git, setOpen: value => { openFiles = value; } };
}

test('unregistered worktree preserved on an integration branch is removable; branches remain', async t => {
  const s = scene(t);
  const item = await inspectWorktree(s.input, s.runner);
  assert.equal(item.removable, true, item.detail);
  assert.equal(s.git('-C', s.repo, 'merge-base', '--is-ancestor', item.head, 'retained'), '');
  await removeReviewedWorktree(item, s.runner);
  assert.equal(existsSync(s.tree), false);
  assert.equal(s.git('-C', s.repo, 'rev-parse', 'worker'), item.head);
  assert.equal(s.git('-C', s.repo, 'rev-parse', 'retained'), item.retainedCommit);
  assert.deepEqual(s.calls.filter(c => c.includes('remove')), [['git', '-C', s.repo, 'worktree', 'remove', s.tree]]);
});

for (const kind of ['tracked', 'untracked', 'ignored', 'locked', 'primary', 'nested', 'symlink', 'wrong-repo', 'unpreserved', 'self-ref', 'cwd', 'extension', 'live-agent', 'open-file', 'unsafe-ref']) {
  test(`explicit cleanup keeps ${kind}`, async t => {
    const s = scene(t), input = { ...s.input }, safety = {};
    if (kind === 'tracked') writeFileSync(join(s.tree, 'file'), 'dirty');
    if (kind === 'untracked') writeFileSync(join(s.tree, 'new'), 'keep');
    if (kind === 'ignored') { writeFileSync(join(s.tree, '.gitignore'), 'generated\n'); s.git('-C', s.tree, 'add', '.gitignore'); s.git('-C', s.tree, '-c', 'commit.gpgsign=false', 'commit', '-m', 'ignore'); s.git('-C', s.repo, 'branch', '-f', 'retained', 'worker'); writeFileSync(join(s.tree, 'generated'), 'keep'); }
    if (kind === 'locked') s.git('-C', s.repo, 'worktree', 'lock', s.tree);
    if (kind === 'primary') input.worktreePath = s.repo;
    if (kind === 'nested') input.worktreePath = join(s.tree, 'file');
    if (kind === 'symlink') { symlinkSync(s.tree, join(s.dir, 'alias')); input.worktreePath = join(s.dir, 'alias'); }
    if (kind === 'wrong-repo') input.repoPath = s.tree;
    if (kind === 'unpreserved') input.retainedRef = 'refs/heads/main';
    if (kind === 'self-ref') input.retainedRef = 'refs/heads/worker';
    if (kind === 'cwd') safety.protectedPaths = [s.tree];
    if (kind === 'extension') safety.protectedPaths = [join(s.tree, 'src', 'extension.ts')];
    if (kind === 'live-agent') safety.liveWorktrees = [s.tree];
    if (kind === 'open-file') s.setOpen(`p123\nn${s.tree}/file\n`);
    if (kind === 'unsafe-ref') input.retainedRef = 'refs/heads/retained\nmisleading';
    const item = await inspectWorktree(input, s.runner, safety);
    assert.equal(item.removable, false, kind);
    assert.ok(item.detail.length);
    assert.ok(!s.calls.some(c => c.includes('remove')));
  });
}

for (const drift of ['head', 'retained-ref', 'dirty', 'ignored', 'open-file', 'live-agent', 'replacement']) {
  test(`post-confirmation ${drift} drift prevents removal`, async t => {
    const s = scene(t);
    const item = await inspectWorktree(s.input, s.runner);
    assert.equal(item.removable, true);
    if (drift === 'head') { writeFileSync(join(s.tree, 'file'), 'new'); s.git('-C', s.tree, 'add', '.'); s.git('-C', s.tree, '-c', 'commit.gpgsign=false', 'commit', '-m', 'new'); }
    if (drift === 'retained-ref') s.git('-C', s.repo, 'branch', '-f', 'retained', 'main');
    if (drift === 'dirty') writeFileSync(join(s.tree, 'new'), 'new');
    if (drift === 'ignored') { writeFileSync(join(s.repo, '.git', 'info', 'exclude'), 'generated\n'); writeFileSync(join(s.tree, 'generated'), 'keep'); }
    if (drift === 'open-file') s.setOpen(`p123\nn${s.tree}/file\n`);
    if (drift === 'replacement') { s.git('-C', s.repo, 'worktree', 'remove', s.tree); s.git('-C', s.repo, 'worktree', 'add', s.tree, 'worker'); }
    await assert.rejects(removeReviewedWorktree(item, s.runner, drift === 'live-agent' ? { liveWorktrees: [s.tree] } : {}));
    assert.ok(existsSync(s.tree));
    assert.ok(!s.calls.some(c => c.includes('remove')));
  });
}

for (const flag of ['--assume-unchanged', '--skip-worktree']) test(`hidden ${flag} edits are kept`, async t => {
  const s = scene(t);
  s.git('-C', s.tree, 'update-index', flag, 'file');
  writeFileSync(join(s.tree, 'file'), 'hidden edit');
  assert.equal(s.git('-C', s.tree, 'status', '--porcelain'), '');
  const item = await inspectWorktree(s.input, s.runner);
  assert.equal(item.removable, false);
  assert.match(item.detail, /hidden edits/);
});

for (const state of ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG', 'sequencer']) test(`interrupted ${state} is kept`, async t => {
  const s = scene(t);
  const gitDir = s.git('-C', s.tree, 'rev-parse', '--absolute-git-dir');
  if (['rebase-merge', 'rebase-apply', 'sequencer'].includes(state)) mkdirSync(join(gitDir, state));
  else writeFileSync(join(gitDir, state), s.git('-C', s.tree, 'rev-parse', 'HEAD'));
  const item = await inspectWorktree(s.input, s.runner);
  assert.equal(item.removable, false);
  assert.match(item.detail, /interrupted Git operation/);
});

for (const ref of ['refs/worktree/keep', 'refs/bisect/good', 'refs/rewritten/keep']) test(`${ref} prevents loss of worktree-local refs`, async t => {
  const s = scene(t);
  s.git('-C', s.tree, 'update-ref', ref, 'HEAD');
  const item = await inspectWorktree(s.input, s.runner);
  assert.equal(item.removable, false);
  assert.match(item.detail, /Worktree-local refs/);
});

test('unretained HEAD reflog history is listed explicitly in the reviewed removal scope', async t => {
  const s = scene(t);
  writeFileSync(join(s.tree, 'file'), 'reflog only'); s.git('-C', s.tree, 'add', '.');
  s.git('-C', s.tree, '-c', 'commit.gpgsign=false', 'commit', '-m', 'reflog only');
  const oldCommit = s.git('-C', s.tree, 'rev-parse', 'HEAD');
  s.git('-C', s.tree, 'reset', '--hard', 'HEAD~1');
  const item = await inspectWorktree(s.input, s.runner);
  assert.equal(item.removable, true, item.detail);
  assert.deepEqual(item.unretainedReflogCommits, [oldCommit]);
  assert.match(item.detail, /Discard worktree-local HEAD reflog/);
  assert.ok(item.detail.includes(oldCommit));
  await removeReviewedWorktree(item, s.runner);
  assert.equal(existsSync(s.tree), false);
  assert.equal(s.git('-C', s.repo, 'rev-parse', 'worker'), s.git('-C', s.repo, 'rev-parse', 'retained'));
});

for (const operation of ['amend', 'rebase']) test(`a routinely ${operation === 'amend' ? 'amended' : 'rebased'} worktree can be reviewed and removed while current commits and branches survive`, async t => {
  const s = scene(t), oldCommit = s.git('-C', s.tree, 'rev-parse', 'HEAD');
  if (operation === 'amend') {
    writeFileSync(join(s.tree, 'file'), 'amended'); s.git('-C', s.tree, 'add', '.');
    s.git('-C', s.tree, '-c', 'commit.gpgsign=false', 'commit', '--amend', '--no-edit');
  } else {
    writeFileSync(join(s.repo, 'upstream'), 'upstream'); s.git('-C', s.repo, 'add', '.');
    s.git('-C', s.repo, '-c', 'commit.gpgsign=false', 'commit', '-m', 'upstream');
    s.git('-C', s.tree, '-c', 'commit.gpgsign=false', 'rebase', 'main');
  }
  s.git('-C', s.repo, 'branch', '-f', 'retained', 'worker');
  const item = await inspectWorktree(s.input, s.runner);
  assert.equal(item.removable, true, item.detail);
  assert.ok(item.unretainedReflogCommits.includes(oldCommit));
  assert.ok(item.detail.includes(oldCommit));
  await removeReviewedWorktree(item, s.runner);
  assert.equal(existsSync(s.tree), false);
  assert.equal(s.git('-C', s.repo, 'rev-parse', 'worker'), item.head);
  assert.equal(s.git('-C', s.repo, 'rev-parse', 'retained'), item.head);
});

test('new unretained reflog history invalidates confirmation even when HEAD and branches are unchanged', async t => {
  const s = scene(t), item = await inspectWorktree(s.input, s.runner);
  writeFileSync(join(s.tree, 'file'), 'new undo history'); s.git('-C', s.tree, 'add', '.');
  s.git('-C', s.tree, '-c', 'commit.gpgsign=false', 'commit', '-m', 'undo history');
  s.git('-C', s.tree, 'reset', '--hard', 'HEAD~1');
  await assert.rejects(removeReviewedWorktree(item, s.runner), /changed during review/);
  assert.ok(existsSync(s.tree));
});

test('a differently spelled loose ref is not an independent retained branch', async t => {
  const s = scene(t);
  const item = await inspectWorktree({ ...s.input, retainedRef: 'refs/heads/WORKER' }, s.runner);
  assert.equal(item.removable, false);
  assert.match(item.detail, /exact spelling/);
});

test('a differently cased loose ref cannot substitute for the exact packed retained ref', async t => {
  const s = scene(t);
  s.git('-C', s.repo, 'worktree', 'remove', s.tree);
  s.git('-C', s.repo, 'branch', '-D', 'worker');
  s.git('-C', s.repo, 'branch', 'Worker', 'main');
  s.git('-C', s.repo, 'pack-refs', '--all');
  s.git('-C', s.repo, 'worktree', 'add', '-b', 'worker', s.tree, 'retained');
  const item = await inspectWorktree({ ...s.input, retainedRef: 'refs/heads/Worker' }, s.runner);
  assert.equal(item.removable, false, item.detail);
  assert.match(item.detail, /preserved|enumerated/);
  assert.ok(existsSync(s.tree));
});

for (const check of ['status', 'ls-files']) test(`Git ${check} warnings fail closed before active-use inspection`, async t => {
  const s = scene(t);
  let lsof = false;
  const item = await inspectWorktree(s.input, async (command, args) => {
    if (command === 'lsof') lsof = true;
    const result = await s.runner(command, args);
    return args.includes(check) ? { ...result, stderr: 'warning: cannot inspect unreadable directory' } : result;
  });
  assert.equal(item.removable, false);
  assert.match(item.detail, /reported warnings/);
  assert.equal(lsof, false);
});

test('a symbolic alias of the removed branch is not an independent retained branch', async t => {
  const s = scene(t);
  s.git('-C', s.repo, 'symbolic-ref', 'refs/heads/alias', 'refs/heads/worker');
  const item = await inspectWorktree({ ...s.input, retainedRef: 'refs/heads/alias' }, s.runner);
  assert.equal(item.removable, false);
  assert.match(item.detail, /symbolic-ref alias/);
});

test('the real bounded runner handles lsof no-match exit 1, and detects an open file', { skip: spawnSync('which', ['lsof']).status !== 0 }, async t => {
  const s = scene(t);
  let item = await inspectWorktree(s.input, run);
  assert.equal(item.removable, true, item.detail);
  const fd = openSync(join(s.tree, 'file'), 'r');
  try {
    item = await inspectWorktree(s.input, run);
    assert.equal(item.removable, false);
    assert.match(item.detail, /open files/);
  } finally { closeSync(fd); }
});

test('fresh context check runs immediately before the non-force removal', async t => {
  const s = scene(t), item = await inspectWorktree(s.input, s.runner);
  await assert.rejects(removeReviewedWorktree(item, s.runner, { assertCurrent: () => { throw new Error('aborted'); } }), /aborted/);
  assert.ok(existsSync(s.tree));
});

test('a real Git index larger than 1 MiB is fully inspected, including hidden flags at the end', async t => {
  const s = scene(t), names = Array.from({ length: 7000 }, (_, i) => `file-${String(i).padStart(5, '0')}-${'x'.repeat(155)}`);
  for (const name of names) writeFileSync(join(s.tree, name), 'tracked');
  s.git('-C', s.tree, 'add', '.');
  s.git('-C', s.tree, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'large synthetic index');
  s.git('-C', s.repo, 'branch', '-f', 'retained', 'worker');
  const args = ['-C', s.tree, 'ls-files', '-v', '-z'];
  await assert.rejects(run('git', args), /maxBuffer/, 'the real default runner reproduces the host failure');
  const budgets = [];
  const runner = (command, args, options) => {
    if (command === 'lsof') return Promise.resolve({ stdout: '', stderr: '' });
    if (args.includes('ls-files')) budgets.push(options?.maxBuffer);
    return run(command, args, options);
  };
  let item = await inspectWorktree(s.input, runner);
  assert.equal(item.removable, true, item.detail);
  assert.ok(budgets.every(value => value === 16 * 1024 * 1024));
  s.git('-C', s.tree, 'update-index', '--assume-unchanged', names.at(-1));
  writeFileSync(join(s.tree, names.at(-1)), 'hidden edit');
  item = await inspectWorktree(s.input, runner);
  assert.equal(item.removable, false);
  assert.match(item.detail, /hidden edits/);
});

test('failed active-use inspection fails closed', async t => {
  const s = scene(t);
  const item = await inspectWorktree(s.input, async (cmd, args) => {
    if (cmd === 'lsof') throw new Error('not available');
    return s.runner(cmd, args);
  });
  assert.equal(item.removable, false);
  assert.match(item.detail, /active use|lsof/);
});

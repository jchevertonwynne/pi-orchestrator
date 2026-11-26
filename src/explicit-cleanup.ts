import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, normalize, relative, sep } from 'node:path';
import type { ProcessRunner } from './contracts.ts';

export type WorktreeRequest = { repoPath: string; worktreePath: string; retainedRef: string };
export type WorktreeSafety = { protectedPaths?: string[]; liveWorktrees?: string[]; assertCurrent?: () => void };
export type ReviewedWorktree = WorktreeRequest & {
  removable: boolean; detail: string; head?: string; branch?: string;
  retainedCommit?: string; identity?: string; unretainedReflogCommits?: string[];
};

const contains = (root: string, path: string) => path === root || (!relative(root, path).startsWith(`..${sep}`) && relative(root, path) !== '..' && !isAbsolute(relative(root, path)));
const safeText = (text: string) => typeof text === 'string' && text.length > 0 && !/[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u.test(text);
function canonicalDirectory(path: string) {
  if (!safeText(path) || !isAbsolute(path) || normalize(path) !== path || realpathSync(path) !== path || !lstatSync(path).isDirectory()) {
    throw new Error('Use an absolute canonical directory, without symlinks or path aliases');
  }
}
const identity = (path: string) => {
  const stat = lstatSync(path, { bigint: true });
  return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
};

// Explicit requests prove preservation independently of registry task state.
// A snapshot is only a proposal; removal re-reads all safety checks after human confirmation.
export async function inspectWorktree(request: WorktreeRequest, runner: ProcessRunner, safety: WorktreeSafety = {}): Promise<ReviewedWorktree> {
  const item: ReviewedWorktree = { ...request, removable: false, detail: '' };
  try {
    canonicalDirectory(request.repoPath);
    canonicalDirectory(request.worktreePath);
    if (!safeText(request.retainedRef) || !request.retainedRef.startsWith('refs/heads/')) throw new Error('retainedRef must name a full local branch ref (refs/heads/...)');
    const git = async (path: string, ...args: string[]) => {
      const result = await runner('git', ['-C', path, ...args], args[0] === 'ls-files' ? { maxBuffer: 16 * 1024 * 1024 } : undefined);
      if (result.stderr.trim()) throw new Error(`Git ${args[0]} reported warnings; cleanup stopped`);
      return result.stdout.trim();
    };
    try { await git(request.repoPath, 'check-ref-format', request.retainedRef); }
    catch { throw new Error('retainedRef is not a valid local branch ref'); }
    try {
      await git(request.repoPath, 'symbolic-ref', '--quiet', request.retainedRef);
      throw new Error('retainedRef must be an independent branch, not a symbolic-ref alias');
    } catch (error: any) {
      if ((error.code ?? error.status) !== 1) throw error;
    }
    const retainedLine = (await git(request.repoPath, 'for-each-ref', '--format=%(refname) %(objectname)', request.retainedRef))
      .split('\n').find(line => line.split(' ')[0] === request.retainedRef);
    const enumeratedRetainedCommit = retainedLine?.split(' ')[1];
    if (!enumeratedRetainedCommit || !/^[0-9a-f]{40,64}$/.test(enumeratedRetainedCommit)) {
      throw new Error('retainedRef does not name an existing local branch with this exact spelling');
    }
    const records = (await git(request.repoPath, 'worktree', 'list', '--porcelain', '-z')).split('\0\0').filter(Boolean)
      .map(record => Object.fromEntries(record.split('\0').filter(Boolean).map(field => { const i = field.indexOf(' '); return i < 0 ? [field, ''] : [field.slice(0, i), field.slice(i + 1)]; })));
    if (!records.length || realpathSync(records[0].worktree) !== request.repoPath) throw new Error('repoPath must be the primary checkout');
    const record = records.find(record => record.worktree === request.worktreePath);
    if (!record || record === records[0]) throw new Error('Only a registered linked worktree root can be removed, never the primary checkout');
    if ('locked' in record || 'prunable' in record) throw new Error('Locked or prunable worktree must be investigated separately');
    if (record.branch === request.retainedRef) throw new Error('retainedRef must be a different branch from the worktree being removed');
    for (const path of [...(safety.protectedPaths ?? []), ...(safety.liveWorktrees ?? [])]) {
      if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('Cannot inspect malformed protected path or live-agent record');
      let resolved = path;
      try { resolved = realpathSync(path); } catch { /* Protect supplied descendants even before they exist. */ }
      if (contains(request.worktreePath, resolved)) throw new Error('Worktree contains the current session, loaded extension or a live agent');
    }
    if (await git(request.worktreePath, 'rev-parse', '--show-toplevel') !== request.worktreePath) throw new Error('Worktree root mismatch');
    const repoCommon = await git(request.repoPath, 'rev-parse', '--path-format=absolute', '--git-common-dir');
    const treeCommon = await git(request.worktreePath, 'rev-parse', '--path-format=absolute', '--git-common-dir');
    if (realpathSync(repoCommon) !== realpathSync(treeCommon)) throw new Error('Repository identity mismatch');
    const gitDir = await git(request.worktreePath, 'rev-parse', '--absolute-git-dir');
    if (['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG', 'sequencer'].some(name => existsSync(join(gitDir, name)))) {
      throw new Error('Worktree has an interrupted Git operation; finish or abort it before cleanup');
    }
    if (await git(request.worktreePath, 'for-each-ref', '--format=%(refname)', 'refs/worktree', 'refs/bisect', 'refs/rewritten')) throw new Error('Worktree-local refs must be preserved or cleared before cleanup');
    if ((await git(request.worktreePath, 'ls-files', '-v', '-z')).split('\0').some(entry => /^[a-zS]/.test(entry))) throw new Error('Index has assume-unchanged or skip-worktree files; hidden edits cannot be ruled out');
    item.head = await git(request.worktreePath, 'rev-parse', '--verify', 'HEAD');
    item.branch = record.branch;
    item.retainedCommit = await git(request.repoPath, 'rev-parse', '--verify', `${request.retainedRef}^{commit}`);
    if (item.retainedCommit !== enumeratedRetainedCommit) throw new Error('retainedRef resolution disagrees with the enumerated branch; cleanup stopped');
    try { await git(request.repoPath, 'merge-base', '--is-ancestor', item.head, item.retainedCommit); }
    catch { throw new Error(`Cannot prove HEAD ${item.head} is preserved by ${request.retainedRef}`); }
    const reflog = [...new Set((await git(request.worktreePath, 'reflog', 'show', '--format=%H', 'HEAD')).split('\n').filter(Boolean))];
    if (reflog.some(commit => !/^[0-9a-f]{40,64}$/.test(commit))) throw new Error('Cannot inspect HEAD reflog commits');
    item.unretainedReflogCommits = reflog.length ? (await git(request.repoPath, 'rev-list', ...reflog, '--not', item.retainedCommit)).split('\n').filter(Boolean).sort() : [];
    if (item.unretainedReflogCommits.some(commit => !/^[0-9a-f]{40,64}$/.test(commit))) throw new Error('Cannot inspect unretained HEAD reflog commits');
    if (await git(request.worktreePath, '-c', 'core.fsmonitor=false', 'status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none')) throw new Error('Worktree has local changes');
    if (await git(request.worktreePath, 'ls-files', '--others', '--ignored', '--exclude-standard')) throw new Error('Worktree contains ignored files; review them separately');
    let opened: string;
    try {
      const result = await runner('lsof', ['-nP', '-Fn', '+D', request.worktreePath]);
      if (result.stderr.trim()) throw new Error('lsof reported incomplete inspection');
      opened = result.stdout;
    } catch (error: any) {
      if (error.code === 1 && typeof error.stdout === 'string' && error.stderr === '') opened = error.stdout;
      else throw new Error('Cannot inspect active use (lsof failed); no removal');
    }
    if (opened.split('\n').some(line => line.startsWith('n') && contains(request.worktreePath, line.slice(1)))) throw new Error('Worktree has open files or an active process working directory');
    if (opened.trim()) throw new Error('Cannot inspect active use (unexpected lsof output); no removal');
    item.identity = [identity(request.repoPath), identity(repoCommon), identity(request.worktreePath), identity(gitDir)].join('|');
    item.detail = `${item.head} preserved by ${request.retainedRef} at ${item.retainedCommit}; clean; branches kept`;
    if (item.unretainedReflogCommits.length) {
      item.detail += `\nDiscard worktree-local HEAD reflog: ${item.unretainedReflogCommits.length} commits outside retainedRef.\nThese may be superseded commits or recoverable unfinished work. Confirm discarding this undo history:\n${item.unretainedReflogCommits.join('\n')}`;
    }
    item.removable = true;
  } catch (error: any) {
    item.detail = String(error.message).split('\n')[0];
  }
  return item;
}

export async function removeReviewedWorktree(reviewed: ReviewedWorktree, runner: ProcessRunner, safety: WorktreeSafety = {}): Promise<void> {
  if (!reviewed.removable || !reviewed.head || !reviewed.identity || !reviewed.retainedCommit) throw new Error('No removable reviewed snapshot');
  const fresh = await inspectWorktree(reviewed, runner, safety);
  if (!fresh.removable) throw new Error(fresh.detail);
  if (fresh.head !== reviewed.head || fresh.branch !== reviewed.branch || fresh.retainedCommit !== reviewed.retainedCommit || fresh.identity !== reviewed.identity
    || JSON.stringify(fresh.unretainedReflogCommits) !== JSON.stringify(reviewed.unretainedReflogCommits)) {
    throw new Error('Worktree, retained branch or reflog history changed during review; request fresh confirmation');
  }
  safety.assertCurrent?.();
  await runner('git', ['-C', reviewed.repoPath, 'worktree', 'remove', reviewed.worktreePath]);
}

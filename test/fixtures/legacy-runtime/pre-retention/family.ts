import { closeSync, constants, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { LIMITS } from './contracts.ts';

// A fork family is the originating orchestrator plus the independent orchestrators forked from it.
// Members share only what is genuinely shared: one deploy lock and read-only visibility.
//
// <origin registry>.family/        private directory
//   origin                         absolute path of the originating registry root
//   deploy.lock                    JSON holder while any member deploys
//   <fork name>/                   a forked orchestrator's registry root

export type Holder = { root: string; taskId: string; token: string; owner: string };

function check(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
function present(path: string): boolean {
  try { lstatSync(path); return true; } catch (error: any) { if (error.code === 'ENOENT') return false; throw error; }
}
function privateDirectory(path: string): void {
  if (!present(path)) {
    try { mkdirSync(path, { mode: 0o700 }); } catch (error: any) { if (error.code !== 'EEXIST') throw error; }
  }
  const stat = lstatSync(path);
  check(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0
    && (!process.getuid || stat.uid === process.getuid()), `Family directory must be private: ${path}`);
}
function readText(path: string): string {
  const stat = lstatSync(path);
  check(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 64 * 1024, `Unsafe family file: ${path}`);
  return readFileSync(path, 'utf8');
}

export function familyRootFor(registryRoot: string): string {
  return `${registryRoot}.family`;
}

export function ensureFamily(root: string, originRoot: string): void {
  privateDirectory(root);
  const origin = join(root, 'origin');
  try { writeFileSync(origin, originRoot, { flag: 'wx', mode: 0o600 }); }
  catch (error: any) { if (error.code !== 'EEXIST') throw error; }
}

export function familyMembers(root: string): string[] {
  const origin = readText(join(root, 'origin')).trim();
  const forks = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && present(join(root, entry.name, 'registry.sqlite')))
    .map((entry) => join(root, entry.name)).sort();
  return [origin, ...forks];
}

// mkdir is the atomic name/slot reservation; the count is rechecked after it.
export function reserveMember(root: string, name: string): string {
  const path = join(root, name);
  mkdirSync(path, { mode: 0o700 });
  const count = 1 + readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length;
  if (count > LIMITS.family) {
    rmdirSync(path);
    throw new Error(`A fork family allows ${LIMITS.family} orchestrators; finish one first`);
  }
  return path;
}

const lockPath = (root: string) => join(root, 'deploy.lock');
const same = (a: Holder, b: Holder) => a.root === b.root && a.taskId === b.taskId && a.token === b.token;

export function readDeploy(root: string): Holder | undefined {
  if (!present(lockPath(root))) return undefined;
  const value = JSON.parse(readText(lockPath(root)));
  check(value && typeof value.root === 'string' && typeof value.taskId === 'string' && typeof value.token === 'string'
    && typeof value.owner === 'string', 'Invalid family deploy lock');
  return value;
}

// Exclusive create; re-acquiring the same holder is idempotent so a crash between file and registry heals.
export function acquireDeploy(root: string, holder: Holder): void {
  let fd: number;
  try { fd = openSync(lockPath(root), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error: any) {
    if (error.code !== 'EEXIST') throw error;
    const current = readDeploy(root);
    check(current && same(current, holder), `Deploy lock is already held by orchestrator ${basename(current?.root ?? '?')} task ${current?.taskId ?? '?'}`);
    return;
  }
  try { writeFileSync(fd, JSON.stringify({ ...holder, at: Date.now() })); } finally { closeSync(fd); }
}

// Releasing never removes another member's lock.
export function releaseDeploy(root: string, holder: Holder): void {
  const current = readDeploy(root);
  if (current && same(current, holder)) unlinkSync(lockPath(root));
}

// Coordinator adoption of an exited owner's release carries its family lock to the new token.
export function adoptDeploy(root: string, previous: Holder, next: Holder): void {
  const current = readDeploy(root);
  if (!current) return acquireDeploy(root, next);
  check(same(current, previous) || same(current, next), 'Family deploy lock is held by a different release');
  const temporary = `${lockPath(root)}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({ ...next, at: Date.now() }), { flag: 'wx', mode: 0o600 });
  renameSync(temporary, lockPath(root));
}

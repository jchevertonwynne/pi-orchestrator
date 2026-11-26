import type { ProcessRunner } from './contracts.ts';

// Checks worth running before leaving agents unattended.
// Credential prompts (for example a locked 1Password signing agent) previously stalled work overnight.
// Uses literal argv only; prints the first stderr line, never command output that could hold secrets.

function reason(error: any): string {
  if (error?.killed || error?.signal === 'SIGTERM') return 'timed out; possibly waiting for an approval prompt';
  const line = String(error?.stderr ?? '').split('\n').map((value) => value.trim()).find(Boolean)
    ?? (error?.code === 'ENOENT' ? 'command not found' : `exit ${error?.code ?? 'unknown'}`);
  return line.slice(0, 160);
}

export async function preflight(repo: string, runner: ProcessRunner): Promise<{ ok: boolean; lines: string[] }> {
  const lines: string[] = [];
  let ok = true;
  const check = async (label: string, command: string, args: string[], timeout: number, detail?: (stdout: string) => string) => {
    try {
      const { stdout } = await runner(command, args, { cwd: repo, timeout });
      lines.push(`PASS ${label}${detail ? `: ${detail(stdout)}` : ''}`);
      return true;
    } catch (error) {
      ok = false;
      lines.push(`FAIL ${label}: ${reason(error)}`);
      return false;
    }
  };
  if (!await check('Git checkout', 'git', ['rev-parse', '--show-toplevel'], 10_000, (stdout) => stdout.trim())) return { ok, lines };
  let signing = '';
  try { signing = (await runner('git', ['config', '--bool', 'commit.gpgsign'], { cwd: repo, timeout: 10_000 })).stdout.trim(); }
  catch { /* Unset configuration exits non-zero. */ }
  if (signing === 'true') {
    // commit-tree exercises the real signing program; it writes one unreferenced object and moves no ref.
    await check('Commit signing without a prompt', 'git', ['commit-tree', '-S', '-m', 'orchestrator preflight', 'HEAD^{tree}'], 30_000);
  } else lines.push('SKIP Commit signing: commit.gpgsign is not enabled');
  let remote = false;
  try { remote = Boolean((await runner('git', ['remote', 'get-url', 'origin'], { cwd: repo, timeout: 10_000 })).stdout.trim()); }
  catch { /* No origin remote. */ }
  if (remote) await check('Remote reachable with current credentials', 'git', ['ls-remote', '--exit-code', 'origin', 'HEAD'], 20_000);
  else lines.push('SKIP Remote: no origin remote configured');
  await check('GitHub CLI authenticated', 'gh', ['auth', 'status'], 20_000);
  await check('Zellij available', 'zellij', ['--version'], 10_000, (stdout) => stdout.trim());
  lines.push(ok ? 'Ready to leave agents unattended for these checks.' : 'Fix the failures before leaving agents unattended.');
  return { ok, lines };
}

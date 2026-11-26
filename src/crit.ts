import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { appendFileSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Crit 0.20.2 blocks until Finish, then exits zero with an `approved:` stderr line
// and the rendered finish prompt on stdout. The owned global prompt makes that
// payload JSON; neither Crit's approval indicator nor its prose grants authority.
// See Crit's docs/agent-prompts.md and internal/daemon/client.go.
export function startCrit(directory: string, body: string, spawnProcess = spawn) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  directory = realpathSync(directory);
  const home = join(directory, 'home'), cwd = join(directory, 'work');
  mkdirSync(home, { mode: 0o700 }); mkdirSync(cwd, { mode: 0o700 });
  const snapshot = join(cwd, 'plan.md');
  writeFileSync(snapshot, body, { mode: 0o600 });
  const prompt = 'inline:{"comments":{{.comments_unresolved_json}}}';
  writeFileSync(join(home, '.crit.config.json'), JSON.stringify({
    share_targets: [], no_update_check: true, no_integration_check: true, cleanup_on_approve: false,
    prompts: { on_finish_unresolved: prompt, on_finish_approved: prompt },
  }), { mode: 0o600 });
  // Deliberately do not inherit ambient Crit, Git, XDG, hook, proxy or agent settings.
  // HOME owns daemon discovery as well as config; cwd is outside the repository.
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, USERPROFILE: home, GIT_CEILING_DIRECTORIES: directory,
    CRIT_HOST: '127.0.0.1', CRIT_SHARE_URL: '', CRIT_NO_UPDATE_CHECK: '1', CRIT_NO_INTEGRATION_CHECK: '1' };
  const options = { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'], shell: false };
  let child: ReturnType<typeof spawn> | undefined, stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    child?.kill('SIGTERM');
    // Exact owned cwd + snapshot + isolated HOME: never discover or stop another review.
    try { const stop = spawnProcess('crit', ['stop', snapshot], options); stop.on('error', () => {}); }
    catch { /* The review artifacts remain available even if Crit disappeared. */ }
  };
  let cancelled = false;
  const completion = new Promise<{ comments?: unknown[]; error?: string }>((resolve) => {
    let stdout = '', stderr = '', settled = false, overflow = false;
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
    const finish = (value: { comments?: unknown[]; error?: string }) => {
      if (settled) return;
      settled = true; resolve(value);
    };
    try {
      child = spawnProcess('crit', ['--host', '127.0.0.1', '--port', '0', '--share-url', '', '--output', join(home, '.crit'), snapshot], options);
      const capture = (kind: 'stdout' | 'stderr', chunk: Buffer | string) => {
        try { appendFileSync(join(directory, kind + '.txt'), chunk, { mode: 0o600 }); }
        catch (error: any) { finish({ error: `Could not retain Crit feedback: ${error.message}` }); stop(); return; }
        if (settled) return;
        const text = decoders[kind].write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        if (kind === 'stdout') stdout += text; else stderr += text;
        if (stdout.length + stderr.length > 1024 * 1024 && !overflow) {
          overflow = true; finish({ error: 'Crit output exceeded 1 MiB; feedback retained on disk.' }); stop();
        }
      };
      child.stdout!.on('data', chunk => capture('stdout', chunk));
      child.stderr!.on('data', chunk => capture('stderr', chunk));
      child.on('error', error => { finish({ error: `Could not run optional Crit: ${error.message}. Install Crit or use a approve.` }); stop(); });
      child.on('close', (code, signal) => {
        stdout += decoders.stdout.end(); stderr += decoders.stderr.end();
        if (cancelled || signal || code !== 0) finish({ error: `Crit review cancelled or failed (${signal ?? code}); use c to retry or a approve.` });
        else if (!/^approved: (?:true|false)\r?$/m.test(stderr)) finish({ error: 'Crit exited without a completed-review signal; no revision requested.' });
        else {
          try {
            const payload = JSON.parse(stdout);
            if (!Array.isArray(payload?.comments) || payload.comments.some((comment: any) => !comment || typeof comment.body !== 'string' || !comment.body.trim()))
              throw new Error('invalid comments array');
            finish({ comments: payload.comments.filter((comment: any) => comment?.resolved !== true) });
          } catch { finish({ error: 'Crit completed with unreadable feedback; no revision requested. Check retained artifacts.' }); }
        }
        stop();
      });
    } catch (error: any) { finish({ error: `Could not launch optional Crit: ${error.message}. Use a approve or retry c.` }); stop(); }
  });
  return { directory, completion, cancel() { cancelled = true; stop(); } };
}

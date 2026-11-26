import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, existsSync, lstatSync, symlinkSync, rmSync, chmodSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { run, spawnAgent, inspectAgent, goToAgent, goToCoordinator, resumeAgent, collectAgent, closeAgent, retireAgent, closeTaskSession } from '../src/runtime.ts';
import { sendMessage } from '../src/workflow.ts';
import { openStore } from '../src/store.ts';
import { LIMITS } from '../src/contracts.ts';

const sha = body => createHash('sha256').update(body).digest('hex');
const output = stdout => ({ stdout, stderr: '' });
const chrome = (tab, name) => ['zellij:tab-bar', 'zellij:status-bar'].map((url, index) => ({
  id: tab * 2 + index + 100, is_plugin: true, tab_id: tab, tab_name: name, title: url, exited: false, plugin_url: url,
}));

async function fixture(options = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'piorch-runtime-')));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  await run('git', ['-c', 'init.templateDir=', 'init', '-q', repo]);
  writeFileSync(join(repo, 'tracked.txt'), 'Initial tracked contents\n');
  await run('git', ['add', 'tracked.txt'], { cwd: repo });
  await run('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Synthetic',
    '-c', 'user.email=synthetic@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'fixture'], { cwd: repo });
  const plan = join(root, 'plan.md');
  writeFileSync(plan, 'Synthetic approved plan\n');
  const extension = join(root, 'extension.ts');
  writeFileSync(extension, '// Synthetic fixture; never loaded\n');
  let state = { version: 1, revision: 0, createdAt: Date.now(), tasks: {
    task: { id: 'task', title: 'Synthetic task', state: 'approved', planPath: plan, planHash: sha(readFileSync(plan)),
      approval: { hash: sha(readFileSync(plan)), source: 'synthetic user', at: Date.now() }, dependencies: [], history: [] },
  }, agents: { root: { id: 'root', role: 'coordinator', model: 'openai-codex/gpt-6-astra', generation: 'root-gen', lifecycle: 'running',
    worktree: repo, sessionDir: join(root, 'root-sessions'), piSessionId: 'root-session' } }, messages: [], resources: [], releases: {}, notifications: {} };
  const store = options.sqlite ? openStore(root, true) : { root, read: () => structuredClone(state), transact(fn) {
    const draft = structuredClone(state);
    const result = fn(draft);
    draft.revision++;
    state = draft;
    return structuredClone(result);
  }, close() {} };
  if (options.sqlite) store.transact(s => { s.tasks = state.tasks; s.agents = state.agents; });
  const input = { id: 'worker', taskId: 'task', role: 'implementer', repo, base: 'HEAD', branch: 'agents/worker',
    worktree: join(root, 'worktree with spaces;$literal'), prompt: 'Do synthetic work. $(do-not-execute)\nReport evidence.' };
  const calls = [];
  const active = new Set();
  const inventories = new Map();
  const alivePids = new Set();
  let nextPid = 123456;
  let nextTab = 5;
  // Real background sessions always start with at least one layout pane.
  const controls = { handshake: options.handshake ?? false, fail: undefined,
    initial: [{ id: 0, is_plugin: false, tab_id: 0, tab_name: 'workers', title: 'shell', exited: false, pane_command: '/bin/zsh', pane_cwd: root }, ...chrome(0, 'workers')], models: 'provider model\nopenai-codex gpt-6-astra 1M\n',
    screen: 'π synthetic Pi TUI gpt-6-astra', exitedSessions: new Set(), alive: (value, pid) => {
      if (pid !== undefined) { if (value) alivePids.add(pid); else alivePids.delete(pid); }
      else if (!value) alivePids.clear();
    } };
  const handshake = (agentId = 'worker') => {
    const worker = store.read().agents[agentId];
    const file = worker.sessionFile ?? join(worker.sessionDir, `${worker.piSessionId}.jsonl`);
    if (!existsSync(file)) writeFileSync(file, JSON.stringify({ type: 'session', version: 3, id: worker.piSessionId, cwd: worker.worktree }) + '\n');
    const pid = nextPid++;
    store.transact(s => Object.assign(s.agents[worker.id], { sessionFile: file, heartbeatAt: Date.now(), pid, activity: 'idle' }));
    alivePids.add(pid);
  };
  const runner = async (command, args, opts) => {
    if (command === 'zellij' && args.includes('attach')) {
      assert.equal(args[0], '--new-session-with-layout', 'Never inherit the personal layout or add tabs to the human session');
      assert.equal(readFileSync(args[1], 'utf8'), 'layout {\n    default_tab_template {\n        pane borderless=true size=1 {\n            plugin location="zellij:tab-bar"\n        }\n        pane\n        pane borderless=true size=2 {\n            plugin location="zellij:status-bar"\n        }\n    }\n    tab name="workers"\n}\n');
      args = args.slice(2);
    }
    calls.push({ command, args: [...args], options: opts });
    if (controls.fail?.(command, args)) throw Object.assign(new Error('SECRET must not reach registry'), { code: 2 });
    if (command === 'git') return run(command, args, opts);
    if (command === 'pi') { assert.deepEqual(args, ['--list-models']); return output(controls.models); }
    if (command === 'ps') {
      assert.equal(args[0], '-p'); assert.deepEqual(args.slice(2), ['-o', 'pid=']);
      const pid = Number(args[1]); assert.ok(Number.isSafeInteger(pid) && pid > 1);
      return output(alivePids.has(pid) ? ` ${pid}\n` : '');
    }
    assert.equal(command, 'zellij');
    if (args[0] === 'list-sessions') {
      assert.deepEqual(args, ['list-sessions', '--no-formatting']);
      if (!active.size && !controls.exitedSessions.size) {
        throw Object.assign(new Error('Command failed: zellij list-sessions --no-formatting'), {
          code: 1, stdout: '', stderr: 'No active zellij sessions found.\n', killed: false, signal: null,
        });
      }
      return output([...active].map(name => `${name} [Created 10s ago]`).concat(
        [...controls.exitedSessions].map(name => `${name} [Created 1h ago] (EXITED - attach to resurrect)`)).join('\n'));
    }
    if (args[0] === 'attach') {
      assert.equal(args[1], '--create-background');
      active.add(args[2]); inventories.set(args[2], structuredClone(controls.initial));
      return output('');
    }
    if (args[0] === 'kill-session') { active.delete(args[1]); return output(''); }
    if (args[0] === 'delete-session') { assert.ok(!active.has(args[1]), 'Delete only after kill'); return output(''); }
    assert.equal(args[0], '--session');
    assert.ok(active.has(args[1]), 'Explicitly target an active owned session');
    assert.equal(args[2], 'action');
    const inventory = inventories.get(args[1]);
    if (args[3] === 'list-panes') {
      assert.deepEqual(args.slice(3), ['list-panes', '--json', '--all']);
      if (controls.layoutDelay > 0) { controls.layoutDelay--; return output('[]'); }
      return output(JSON.stringify(inventory));
    }
    if (args[3] === 'new-tab') {
      assert.equal(args[4], '--name'); assert.equal(args[6], '--cwd'); assert.equal(args[8], '--'); assert.equal(args[9], 'pi');
      const tab = nextTab++;
      inventory.push({ id: tab + 20, is_plugin: false, tab_id: tab, tab_name: args[5], title: 'π - synthetic',
        exited: false, terminal_command: args.slice(9).join(' '), pane_cwd: args[7] });
      inventory.push({ id: tab + 1000, is_plugin: true, is_suppressed: true, plugin_url: 'zellij:link',
        tab_id: tab, tab_name: args[5], title: '(.) - zellij:link', exited: false });
      if (controls.chrome !== false) inventory.push(...chrome(tab, args[5]));
      if (controls.handshake) handshake(args[5]);
      if (controls.workerPanes) inventories.set(args[1], controls.workerPanes(inventory, tab));
      return output(`${tab}\n`);
    }
    if (args[3] === 'dump-screen') {
      assert.equal(args[4], '--pane-id');
      assert.ok(inventory.some(p => `terminal_${p.id}` === args[5]));
      assert.equal(args.length, 6);
      return output(controls.screen);
    }
    if (args[3] === 'close-tab') {
      assert.equal(args[4], '--tab-id');
      inventories.set(args[1], inventory.filter(p => p.tab_id !== Number(args[5])));
      return output('');
    }
    assert.fail(`Unexpected synthetic command: ${command} ${JSON.stringify(args)}`);
  };
  const spawn = () => spawnAgent(store, 'root', input, extension, runner);
  const workerPane = () => inventories.get(store.read().agents.worker.zellijSession).find(p => p.tab_name === 'worker');
  return { root, repo, plan, extension, store, input, calls, active, inventories, controls, runner, spawn, workerPane, handshake };
}

test('missing spawn fields name the required argument before any launch effect', async t => {
  const f = await fixture();
  t.after(() => { f.store.close(); rmSync(f.root, { recursive: true, force: true }); });
  const before = f.store.read();
  for (const [field, message] of [
    ['taskId', /spawn requires taskId/], ['repo', /spawn requires repo/],
    ['base', /spawn requires a valid base/], ['branch', /spawn requires a new branch name/],
    ['prompt', /spawn requires prompt text/], ['role', /spawn requires role/],
  ]) {
    const input = { ...f.input }; delete input[field];
    await assert.rejects(spawnAgent(f.store, 'root', input, f.extension, f.runner), message);
    assert.deepEqual(f.store.read(), before);
    assert.deepEqual(f.calls, []);
    assert.equal(existsSync(f.input.worktree), false);
  }
});

test('collect names its required report argument without changing the agent', async t => {
  const f = await fixture();
  t.after(() => { f.store.close(); rmSync(f.root, { recursive: true, force: true }); });
  const before = f.store.read();
  assert.throws(() => collectAgent(f.store, 'root', 'worker'), /collect requires report/);
  assert.deepEqual(f.store.read(), before);
});

for (const sqlite of [false, true]) {
  test(`empty session inventory permits first launch but still gates task delivery (${sqlite ? 'SQLite' : 'memory'})`, async t => {
    const f = await fixture({ sqlite });
    t.after(() => { f.store.close(); rmSync(f.root, { recursive: true, force: true }); });
    const agent = await f.spawn();
    assert.equal(f.calls.filter(c => c.args[0] === 'attach').length, 1);
    assert.equal(f.calls.filter(c => c.args[3] === 'new-tab').length, 1);
    assert.equal(agent.lifecycle, 'starting');
    assert.equal(f.store.read().messages.length, 0);
    f.handshake();
    assert.equal((await inspectAgent(f.store, agent.id, f.runner)).agent.lifecycle, 'running');
    await inspectAgent(f.store, agent.id, f.runner);
    assert.equal(f.store.read().messages.length, 1);
    assert.equal(f.store.read().messages[0].generation, agent.generation);
  });
}

test('empty session inventory handling does not hide other listing failures', async t => {
  const valid = { code: 1, stdout: '', stderr: 'No active zellij sessions found.\n', killed: false, signal: null };
  const cases = [
    { code: 2 }, { code: '1' }, { code: 'ENOENT' }, { code: 'ETIMEDOUT' },
    { stdout: 'unexpected session output' }, { stdout: undefined },
    { stderr: 'Error occurred: PermissionDenied\n' }, { stderr: 'Error occurred: I/O failure\n' },
    { stderr: 'No active zellij sessions found.\nextra diagnostic\n' }, { stderr: undefined },
    { killed: true }, { signal: 'SIGTERM' }, { killed: 'false' }, { signal: '' },
  ];
  for (const fields of cases) {
    const f = await fixture();
    t.after(() => { f.store.close(); rmSync(f.root, { recursive: true, force: true }); });
    const runner = async (command, args, options) => {
      if (command === 'zellij' && args[0] === 'list-sessions') {
        throw Object.assign(new Error('Synthetic listing failure'), valid, fields);
      }
      return f.runner(command, args, options);
    };
    const agent = await spawnAgent(f.store, 'root', f.input, f.extension, runner);
    assert.equal(agent.lifecycle, 'starting', JSON.stringify(fields));
    assert.match(agent.launchError, /shared task-session readiness/);
    assert.equal(f.calls.some(c => c.args[0] === 'attach' || c.args[3] === 'new-tab'), false);
    assert.equal(f.store.read().messages.length, 0);
    assert.equal(existsSync(join(f.root, 'runtime', 'task-sessions', `${agent.zellijSession}.json`)), false);
  }
});

test('empty session inventory handling preserves active and exited name collision checks', async t => {
  for (const suffix of ['[Created 1s ago]', '[Created 1h ago] (EXITED - attach to resurrect)']) {
    const f = await fixture();
    t.after(() => { f.store.close(); rmSync(f.root, { recursive: true, force: true }); });
    const runner = async (command, args, options) => {
      if (command === 'zellij' && args[0] === 'list-sessions') {
        return output(`${f.store.read().agents.worker.zellijSession} ${suffix}\n`);
      }
      return f.runner(command, args, options);
    };
    const agent = await spawnAgent(f.store, 'root', f.input, f.extension, runner);
    assert.equal(agent.lifecycle, 'starting');
    assert.match(agent.launchError, /shared task-session readiness/);
    assert.equal(f.calls.some(c => c.args[0] === 'attach'), false);
    assert.equal(f.store.read().messages.length, 0);
  }
});

for (const sqlite of [false, true]) {
  test(`coordinator inspection rejects without commands or mutations (${sqlite ? 'SQLite' : 'memory'})`, async (t) => {
    const f = await fixture({ sqlite });
    t.after(() => { f.store.close(); rmSync(f.root, { recursive: true, force: true }); });
    for (const lifecycle of ['running', 'registered', 'starting', 'exited', 'collected', 'closed']) {
      f.store.transact(s => Object.assign(s.agents.root, { lifecycle, pid: process.pid,
        sessionFile: join(f.root, 'coordinator.jsonl'), heartbeatAt: Date.now() }));
      const before = f.store.read();
      let transactions = 0, commands = 0, error;
      const store = { root: f.root, read: () => f.store.read(), transact: fn => {
        transactions++;
        return f.store.transact(fn);
      } };
      try {
        await inspectAgent(store, 'root', async () => { commands++; throw new Error('No runner call expected'); });
      } catch (caught) { error = caught; }
      assert.deepEqual(f.store.read(), before, 'coordinator identity, lifecycle and approval state remain unchanged');
      assert.equal(transactions, 0);
      assert.equal(commands, 0);
      assert.match(error?.message ?? '', /Cannot inspect a coordinator.*orchestrator_status/);
    }
  });
}

test('concurrent workers share one task session and per-tab cleanup/resume preserves peers', async () => {
  const f = await fixture({ handshake: true });
  f.store.transact(s => { s.tasks.peerTask = { ...structuredClone(s.tasks.task), id: 'peerTask' }; });
  const peerInput = { ...f.input, id: 'peer', taskId: 'peerTask', branch: 'agents/peer', worktree: join(f.root, 'peer-worktree') };
  const [worker, peer] = await Promise.all([f.spawn(), spawnAgent(f.store, 'root', peerInput, f.extension, f.runner)]);
  assert.equal(worker.lifecycle, 'running'); assert.equal(peer.lifecycle, 'running');
  assert.equal(worker.zellijSession, peer.zellijSession);
  assert.match(worker.zellijSession, /^piorch-[a-f0-9]{6}-[a-f0-9]{6}$/);
  assert.ok(worker.zellijSession.length <= 20, 'Keep the macOS Zellij socket path within its limit');
  assert.notEqual(worker.tabId, peer.tabId); assert.notEqual(worker.paneId, peer.paneId);
  assert.notEqual(worker.sessionDir, peer.sessionDir); assert.notEqual(worker.piSessionId, peer.piSessionId);
  assert.equal(f.calls.filter(c => c.command === 'zellij' && c.args[0] === 'attach').length, 1);
  const beforePeer = structuredClone(f.inventories.get(peer.zellijSession).find(p => p.tab_id === peer.tabId));
  const report = join(f.root, 'worker-report.md'); writeFileSync(report, 'Synthetic collected report');
  collectAgent(f.store, 'root', 'worker', report);
  f.workerPane().exited = true; f.controls.alive(false, worker.pid);
  assert.equal((await closeAgent(f.store, 'root', 'worker', f.runner)).lifecycle, 'closed');
  assert.deepEqual(f.inventories.get(peer.zellijSession).find(p => p.tab_id === peer.tabId), beforePeer);
  assert.equal(f.store.read().agents.peer.lifecycle, 'running');
  const resumed = await resumeAgent(f.store, 'root', 'worker', f.extension, f.runner);
  assert.equal(resumed.lifecycle, 'running'); assert.equal(resumed.zellijSession, peer.zellijSession);
  assert.notEqual(resumed.tabId, worker.tabId); assert.equal(resumed.sessionFile, worker.sessionFile);
  assert.deepEqual(f.inventories.get(peer.zellijSession).find(p => p.tab_id === peer.tabId), beforePeer);
  assert.equal(f.calls.filter(c => c.command === 'zellij' && c.args[0] === 'attach').length, 1);
  assert.ok(!f.calls.some(c => c.args[0] === 'kill-session'));
});

test('EXITED session recovery uses a fresh session after proving every old worker PID dead', async () => {
  const f = await fixture({ handshake: true });
  f.store.transact(s => { s.tasks.peerTask = { ...structuredClone(s.tasks.task), id: 'peerTask' }; });
  const worker = await f.spawn();
  const peer = await spawnAgent(f.store, 'root', { ...f.input, id: 'peer', taskId: 'peerTask', branch: 'peer', worktree: join(f.root, 'peer') }, f.extension, f.runner);
  const oldManifest = join(f.root, 'runtime', 'worker', `${worker.generation}.json`);
  const oldContents = readFileSync(oldManifest, 'utf8');
  f.active.clear(); f.controls.exitedSessions.add(worker.zellijSession);
  f.controls.alive(false, worker.pid);
  await assert.rejects(resumeAgent(f.store, 'root', 'worker', f.extension, f.runner), /Old shared-session worker is still live/);
  assert.equal(f.calls.filter(c => c.args[0] === 'attach').length, 1);
  f.controls.alive(false, peer.pid);
  const resumed = await resumeAgent(f.store, 'root', 'worker', f.extension, f.runner);
  assert.equal(resumed.lifecycle, 'running'); assert.notEqual(resumed.zellijSession, worker.zellijSession);
  assert.equal(resumed.sessionFile, worker.sessionFile); assert.equal(resumed.piSessionId, worker.piSessionId);
  assert.equal(f.store.read().sharedSession.name, resumed.zellijSession);
  assert.equal(f.store.read().agents.peer.zellijSession, peer.zellijSession, 'Historical sessions are not retargeted');
  assert.equal(readFileSync(oldManifest, 'utf8'), oldContents);
  const resumedPeer = await resumeAgent(f.store, 'root', 'peer', f.extension, f.runner);
  assert.equal(resumedPeer.zellijSession, resumed.zellijSession);
  assert.equal(resumedPeer.lifecycle, 'running');
  const attaches = f.calls.filter(c => c.args[0] === 'attach');
  assert.equal(attaches.length, 2);
  assert.equal(attaches[1].args[2], resumed.zellijSession);
  assert.notEqual(attaches[1].args[2], worker.zellijSession, 'Never resurrect old commands');
});

test('failed session creator can be explicitly retried with a new worker and fresh short session', async () => {
  const f = await fixture({ handshake: true });
  f.controls.fail = (command, args) => command === 'zellij' && args[0] === 'attach';
  const failed = await f.spawn();
  assert.match(failed.launchError, /shared task-session readiness/);
  const originalManifest = join(f.root, 'runtime', failed.id, `${failed.generation}.json`);
  // Reproduce the parent's prior long-name failure without changing real sessions.
  const legacyName = `piorch-task-${sha(f.root).slice(0, 16)}-${failed.generation}`;
  const legacyManifest = JSON.parse(readFileSync(originalManifest, 'utf8'));
  legacyManifest.session = legacyName; delete legacyManifest.tabLaunchAttempted;
  writeFileSync(originalManifest, JSON.stringify(legacyManifest));
  writeFileSync(join(f.root, 'runtime', 'shared-session.json'), JSON.stringify({ session: legacyName, ownerId: failed.id, initial: [], ready: false }));
  f.store.transact(s => { s.agents.worker.zellijSession = legacyName; delete s.sharedSession; });
  const contents = readFileSync(originalManifest, 'utf8');
  f.controls.fail = undefined;
  const retried = await spawnAgent(f.store, 'root', { ...f.input, id: 'retry', worktree: join(f.root, 'retry'), branch: 'retry' }, f.extension, f.runner);
  assert.equal(retried.lifecycle, 'running');
  assert.notEqual(retried.zellijSession, failed.zellijSession);
  assert.ok(retried.zellijSession.length <= 20);
  assert.equal(f.store.read().agents.worker.lifecycle, 'exited');
  assert.equal(f.store.read().sharedSession.name, retried.zellijSession);
  assert.equal(readFileSync(originalManifest, 'utf8'), contents);
  assert.ok(existsSync(failed.worktree));
  assert.ok(!f.calls.some(c => c.args[0] === 'kill-session' || c.args.includes('reset') || c.args.includes('clean')));
});

for (const phase of ['Git preflight', 'artifacts']) {
  test(`retry recovers a ${phase} failure before its manifest exists`, async () => {
    const f = await fixture({ handshake: true });
    if (phase === 'Git preflight') {
      f.controls.fail = command => command === 'git';
    } else {
      mkdirSync(join(f.root, 'runtime'), { mode: 0o755 });
      chmodSync(join(f.root, 'runtime'), 0o755);
    }
    const failed = await f.spawn();
    assert.ok(failed.launchError.startsWith(`Launch incomplete during ${phase};`));
    if (phase === 'artifacts') assert.match(failed.launchError, /Cause: Runtime directory must be private$/, 'the coordinator sees why');
    else assert.doesNotMatch(failed.launchError, /Cause:/, 'command phases stay generic');
    assert.equal(existsSync(join(f.root, 'runtime', failed.id, `${failed.generation}.json`)), false);
    assert.equal(f.calls.some(c => c.command === 'zellij'), false);
    f.controls.fail = undefined;
    if (phase === 'artifacts') chmodSync(join(f.root, 'runtime'), 0o700);
    const retried = await spawnAgent(f.store, 'root', {
      ...f.input, id: 'retry', worktree: join(f.root, 'retry'), branch: 'retry',
    }, f.extension, f.runner);
    assert.equal(retried.lifecycle, 'running');
    assert.equal(f.store.read().agents.worker.lifecycle, 'exited');
    assert.notEqual(retried.zellijSession, failed.zellijSession);
    assert.equal(f.calls.filter(c => c.args[0] === 'attach').length, 1);
    assert.ok(!f.calls.some(c => c.args[0] === 'kill-session'));
  });
}

for (const evidence of ['pid', 'tabId', 'paneId', 'sessionFile', 'heartbeatAt', 'corruptManifest', 'laterPhase']) {
  test(`missing-manifest recovery refuses ${evidence}`, async () => {
    const f = await fixture({ handshake: true });
    f.controls.fail = (command, args) => command === 'zellij' && args[0] === 'attach';
    const failed = await f.spawn();
    const manifest = join(f.root, 'runtime', failed.id, `${failed.generation}.json`);
    if (evidence === 'corruptManifest') writeFileSync(manifest, '{broken');
    else unlinkSync(manifest);
    f.store.transact(s => {
      s.agents.worker.launchError = evidence === 'laterPhase'
        ? 'Launch incomplete during tab creation; artifacts retained. Inspect before retrying.'
        : 'Launch incomplete during artifacts; artifacts retained. Inspect before retrying.';
      if (['pid', 'tabId', 'heartbeatAt'].includes(evidence)) s.agents.worker[evidence] = 123;
      if (['paneId', 'sessionFile'].includes(evidence)) s.agents.worker[evidence] = 'present';
    });
    f.controls.fail = undefined;
    await assert.rejects(spawnAgent(f.store, 'root', {
      ...f.input, id: 'retry', worktree: join(f.root, 'retry'), branch: 'retry',
    }, f.extension, f.runner), /live agent/);
    assert.equal(f.store.read().agents.worker.lifecycle, 'starting');
  });
}

test('concurrent group resumes elect one fresh shared session', async () => {
  const f = await fixture({ handshake: true });
  f.store.transact(s => { s.tasks.peerTask = { ...structuredClone(s.tasks.task), id: 'peerTask' }; });
  const worker = await f.spawn();
  await spawnAgent(f.store, 'root', { ...f.input, id: 'peer', taskId: 'peerTask', branch: 'peer', worktree: join(f.root, 'peer') }, f.extension, f.runner);
  f.controls.alive(false); f.active.clear(); f.controls.exitedSessions.add(worker.zellijSession);
  const [a, b] = await Promise.all([
    resumeAgent(f.store, 'root', 'worker', f.extension, f.runner),
    resumeAgent(f.store, 'root', 'peer', f.extension, f.runner),
  ]);
  assert.equal(a.lifecycle, 'running'); assert.equal(b.lifecycle, 'running');
  assert.equal(a.zellijSession, b.zellijSession); assert.notEqual(a.zellijSession, worker.zellijSession);
  assert.equal(f.calls.filter(c => c.args[0] === 'attach').length, 2);
});

test('lost shared-session recovery refuses unknown worker PID identity', async () => {
  const f = await fixture({ handshake: true }); const worker = await f.spawn();
  f.active.clear(); f.controls.exitedSessions.add(worker.zellijSession); f.controls.alive(false);
  f.store.transact(s => { s.agents.worker.pid = undefined; });
  await assert.rejects(resumeAgent(f.store, 'root', 'worker', f.extension, f.runner), /without a PID handshake/);
  assert.equal(f.calls.filter(c => c.args[0] === 'attach').length, 1);
});

test('run uses literal argv, enforces bounded output and timeout', async () => {
  const literal = 'spaces ; $(echo should-not-run) *';
  assert.equal((await run(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', literal])).stdout, literal);
  await assert.rejects(run(process.execPath, ['-e', 'process.stdout.write("x".repeat(2 * 1024 * 1024))']), /maxBuffer/);
  await assert.rejects(run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeout: 20 }));
  await assert.rejects(run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeout: 0 }), /positive integer/);
});

test('run accepts an explicit bounded output budget without relaxing its default', async () => {
  const script = 'process.stdout.write("x".repeat(2 * 1024 * 1024))';
  assert.equal((await run(process.execPath, ['-e', script], { maxBuffer: 3 * 1024 * 1024 })).stdout.length, 2 * 1024 * 1024);
  await assert.rejects(run(process.execPath, ['-e', script]), /maxBuffer/);
  await assert.rejects(run(process.execPath, ['-e', script], { maxBuffer: 1024 }), /maxBuffer/);
  for (const maxBuffer of [0, -1, 1.5, NaN, Infinity, 16 * 1024 * 1024 + 1]) {
    await assert.rejects(run(process.execPath, ['-e', 'throw new Error("must not execute")'], { maxBuffer }), /Output budget/);
  }
});

test('spawn reserves before commands, creates a real Git worktree and exact interactive launch argv', async () => {
  const f = await fixture();
  const runner = async (...args) => {
    assert.equal(f.store.read().agents.worker.lifecycle, 'starting');
    return f.runner(...args);
  };
  const agent = await spawnAgent(f.store, 'root', f.input, f.extension, runner);
  assert.equal(agent.lifecycle, 'starting', 'No handshake must not be promoted to running');
  assert.equal(agent.paneId, 'terminal_25'); assert.equal(agent.tabId, 5);
  const launch = f.calls.find(c => c.args[3] === 'new-tab');
  assert.deepEqual(launch.args.slice(0, 10), ['--session', agent.zellijSession, 'action', 'new-tab', '--name', 'worker', '--cwd', f.input.worktree, '--', 'pi']);
  assert.deepEqual(launch.args.slice(10), ['--approve', '--provider', 'openai-codex', '--model', 'gpt-6-astra', '--thinking', 'high', '--extension', f.extension,
    '--session-dir', agent.sessionDir, '--session-id', agent.piSessionId,
    '--orchestrator-root', f.root, '--orchestrator-agent', 'worker', '--orchestrator-generation', agent.generation,
    `@${join(f.root, 'runtime', 'worker', `${agent.generation}.bootstrap.md`)}`]);
  assert.ok(!launch.args.some(v => ['--print', '-p', '--mode', '|', '>', 'sh', 'bash'].includes(v)));
  const worktree = f.calls.find(c => c.command === 'git' && c.args[1] === 'add');
  assert.deepEqual(worktree.args, ['worktree', 'add', '-b', f.input.branch, f.input.worktree, agent.base]);
  assert.equal((await run('git', ['branch', '--show-current'], { cwd: f.input.worktree })).stdout.trim(), f.input.branch);
  const prompt = launch.args.at(-1).slice(1);
  assert.match(readFileSync(prompt, 'utf8'), /startup check only/);
  assert.doesNotMatch(readFileSync(prompt, 'utf8'), /Parent: root|Task: task|\$\(do-not-execute\)/);
  const taskPrompt = join(f.root, 'runtime', 'worker', `${agent.generation}.md`);
  assert.match(readFileSync(taskPrompt, 'utf8'), /Parent: root\nTask: task\nRole: implementer/);
  assert.match(readFileSync(taskPrompt, 'utf8'), /Before correcting your ready or verified task, call orchestrator_task start/);
  assert.match(readFileSync(taskPrompt, 'utf8'), /publish the corrected result when done and obtain fresh verification before release/);
  assert.match(readFileSync(taskPrompt, 'utf8'), /\$\(do-not-execute\)/);
  assert.equal(f.store.read().messages.length, 0, 'no task delivery before the handshake');
  assert.equal(lstatSync(taskPrompt).mode & 0o777, 0o600);
  assert.equal(lstatSync(prompt).mode & 0o777, 0o600);
  assert.equal(lstatSync(agent.sessionDir).mode & 0o777, 0o700);
});

test('spawn inherits the parent model with high thinking unless explicitly overridden', async () => {
  for (const thinking of [undefined, 'off']) {
    const f = await fixture();
    f.store.transact(s => { s.agents.root.model = 'other-provider/parent-model'; });
    f.controls.models = 'other-provider parent-model 1M\n';
    const agent = await spawnAgent(f.store, 'root', { ...f.input, thinking }, f.extension, f.runner);
    assert.equal(agent.model, 'other-provider/parent-model');
    assert.equal(agent.thinking, thinking ?? 'high');
    const argv = f.calls.find(c => c.args[3] === 'new-tab').args;
    assert.equal(argv[argv.indexOf('--provider') + 1], 'other-provider');
    assert.equal(argv[argv.indexOf('--model') + 1], 'parent-model');
    assert.equal(argv[argv.indexOf('--thinking') + 1], thinking ?? 'high');
  }
});

test('spawn selects thinking by the selected model, not the worker role or parent model', async () => {
  for (const [judgement, judgementThinking, thinking, expected] of [
    ['custom-provider/chosen/model', 'xhigh', undefined, 'xhigh'],
    ['other-provider/chosen/model', 'xhigh', undefined, 'low'],
    ['custom-provider/chosen/model', undefined, undefined, 'high'],
    ['custom-provider/chosen/model', 'xhigh', 'off', 'off'],
  ]) {
    const f = await fixture();
    f.controls.models = 'custom-provider chosen/model 1M\n';
    writeFileSync(join(f.root, 'model-roles.json'), JSON.stringify({ judgement, judgementThinking, implementationThinking: 'low' }));
    const agent = await spawnAgent(f.store, 'root', { ...f.input, model: 'custom-provider/chosen/model', thinking },
      f.extension, f.runner, 'other-provider/current-parent', f.root);
    assert.equal(agent.model, 'custom-provider/chosen/model');
    assert.equal(f.store.read().agents.worker.model, agent.model);
    assert.equal(f.store.read().agents.worker.thinking, expected);
    assert.equal(f.store.read().agents.root.model, 'openai-codex/gpt-6-astra');
    const argv = f.calls.find(c => c.args[3] === 'new-tab').args;
    assert.equal(argv[argv.indexOf('--provider') + 1], 'custom-provider');
    assert.equal(argv[argv.indexOf('--model') + 1], 'chosen/model');
    assert.equal(argv[argv.indexOf('--thinking') + 1], expected);
  }
});

test('invalid thinking configuration prevents spawn before reservation or process launch', async () => {
  const f = await fixture();
  const configPath = join(f.root, 'model-roles.json');
  for (const [contents, error] of [
    ['{', /Cannot read model roles from .*model-roles\.json/],
    ['null', /Expected a JSON object/],
    ['{"implementationThinking":"typo"}', /Invalid thinking level for implementationThinking/],
  ]) {
    writeFileSync(configPath, contents);
    await assert.rejects(spawnAgent(f.store, 'root', f.input, f.extension, f.runner, undefined, f.root), error);
    assert.equal(f.store.read().agents.worker, undefined);
    assert.equal(f.calls.length, 0);
  }
});

test('unavailable or malformed explicit worker models never fall back to the parent', async () => {
  for (const model of ['missing/model', '', 'bare-model', 'provider/model with spaces']) {
    const f = await fixture();
    const agent = await spawnAgent(f.store, 'root', { ...f.input, model }, f.extension, f.runner);
    assert.match(agent.launchError, /model availability/);
    assert.equal(agent.model, model);
    assert.equal(existsSync(f.input.worktree), false);
    assert.equal(f.calls.some(c => c.command === 'git' || c.command === 'zellij'), false);
  }
});

test('Pi title alone and missing handshake do not establish running', async () => {
  const f = await fixture();
  const agent = await f.spawn();
  assert.equal(agent.lifecycle, 'starting');
  assert.match((await inspectAgent(f.store, 'worker', f.runner)).observation, /unverified/);
  f.workerPane().terminal_command = 'pi --session-id somebody-else';
  const before = f.calls.filter(c => c.args[3] === 'dump-screen').length;
  assert.match((await inspectAgent(f.store, 'worker', f.runner)).observation, /unverified/);
  assert.equal(f.calls.filter(c => c.args[3] === 'dump-screen').length, before);
});

test('late handshake queues exactly one generation-bound task across repeated and concurrent inspections', async () => {
  const f = await fixture(); const agent = await f.spawn();
  assert.equal(agent.lifecycle, 'starting'); assert.equal(f.store.read().messages.length, 0);
  f.handshake();
  const observed = await Promise.all([inspectAgent(f.store, 'worker', f.runner), inspectAgent(f.store, 'worker', f.runner)]);
  assert.ok(observed.every(x => x.agent.lifecycle === 'running'));
  await inspectAgent(f.store, 'worker', f.runner);
  const messages = f.store.read().messages;
  const record = JSON.parse(readFileSync(join(f.root, 'runtime', 'worker', `${agent.generation}.json`)));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, record.taskMessageId);
  assert.equal(messages[0].generation, agent.generation);
  assert.equal(messages[0].mode, 'followUp');
  assert.equal(messages[0].acknowledgedAt, undefined, 'queueing is not a persisted delivery receipt');
  assert.match(messages[0].body, /\$\(do-not-execute\)/);
  // The task body routes spawned workers to the package's worker reference, never the bootstrap.
  const guide = join(dirname(dirname(f.extension)), 'skills', 'orchestrate-work', 'references', 'worker.md');
  assert.ok(messages[0].body.includes(`\n\nRead ${guide} from the orchestrator package before starting. It replaces orchestrate-work/SKILL.md`));
  assert.ok(messages[0].body.indexOf(guide) < messages[0].body.indexOf('Stay within this task and role.'));
  assert.doesNotMatch(readFileSync(join(f.root, 'runtime', 'worker', `${agent.generation}.bootstrap.md`), 'utf8'), /worker\.md/);
});

test('task intent survives registry reopen and is not duplicated by another inspection', async t => {
  const f = await fixture({ handshake: true, sqlite: true });
  t.after(() => f.store.close());
  const agent = await f.spawn(); assert.equal(agent.lifecycle, 'running');
  const intent = f.store.read().messages[0];
  f.store.close();
  const reopened = openStore(f.root, false); t.after(() => reopened.close());
  await inspectAgent(reopened, 'worker', f.runner);
  assert.deepEqual(reopened.read().messages, [intent]);
});

test('failed inspection revokes readiness without duplicating the existing task intent on recovery', async () => {
  const f = await fixture({ handshake: true }); const agent = await f.spawn();
  const command = f.workerPane().terminal_command;
  f.workerPane().terminal_command = 'unrelated command';
  const failed = await inspectAgent(f.store, 'worker', f.runner);
  assert.equal(failed.agent.lifecycle, 'starting'); assert.ok(failed.agent.launchError);
  assert.equal(f.store.read().messages.length, 1);
  f.workerPane().terminal_command = command;
  assert.equal((await inspectAgent(f.store, 'worker', f.runner)).agent.lifecycle, 'running');
  assert.equal(f.store.read().messages.length, 1);
  f.store.transact(s => { s.tasks.task.state = 'merged'; });
  assert.equal((await inspectAgent(f.store, 'worker', f.runner)).agent.lifecycle, 'running', 'inspection after shipping does not re-authorize an already-queued task');
  assert.equal(f.store.read().messages[0].generation, agent.generation);
});

// A busy worker's screen can scroll Pi's markers away, and Zellij can fail transiently after host sleep.
// Neither is identity evidence, so a verified worker with a fresh heartbeat keeps its readiness.
for (const shape of ['tool output screen', 'blank screen', 'retitled pane', 'zero viewport', 'pane listing failure', 'screen dump failure']) {
  test(`verified busy worker with stale activity survives inspection with ${shape}`, async () => {
    const f = await fixture({ handshake: true }); const agent = await f.spawn();
    assert.equal(agent.lifecycle, 'running');
    f.store.transact(s => Object.assign(s.agents.worker, { activity: 'busy', activityAt: Date.now() - 51 * 60_000,
      progressAt: Date.now(), heartbeatAt: Date.now() }));
    if (shape === 'tool output screen') f.controls.screen = '$ npm test\n# tests 412\n# pass 412\n';
    if (shape === 'blank screen') f.controls.screen = '';
    if (shape === 'retitled pane') f.workerPane().title = 'npm test';
    if (shape === 'zero viewport') { f.workerPane().pane_content_rows = 0; f.workerPane().pane_content_columns = 0; }
    if (shape === 'pane listing failure') f.controls.fail = (command, args) => args[3] === 'list-panes';
    if (shape === 'screen dump failure') f.controls.fail = (command, args) => args[3] === 'dump-screen';
    const result = await inspectAgent(f.store, 'worker', f.runner);
    const worker = f.store.read().agents.worker;
    assert.equal(worker.lifecycle, 'running'); assert.equal(worker.launchError, undefined);
    assert.equal(result.agent.lifecycle, 'running');
    assert.match(result.observation, /readiness retained/);
    assert.doesNotMatch(JSON.stringify(worker), /SECRET/);
    assert.equal(f.store.read().messages.length, 1);
  });
}

test('verified worker with a stale heartbeat still loses readiness on an unverifiable screen', async () => {
  const f = await fixture({ handshake: true }); await f.spawn();
  f.store.transact(s => { s.agents.worker.heartbeatAt = Date.now() - 120_000; });
  f.controls.screen = '';
  await inspectAgent(f.store, 'worker', f.runner);
  const worker = f.store.read().agents.worker;
  assert.equal(worker.lifecycle, 'starting'); assert.match(worker.launchError, /startup identity\/handshake; task withheld/);
});

test('re-verification restarts an idle worker\'s idle clock so no stale idle nudge fires at once', async () => {
  const f = await fixture({ handshake: true }); await f.spawn();
  const command = f.workerPane().terminal_command;
  f.workerPane().terminal_command = 'unrelated command';
  assert.equal((await inspectAgent(f.store, 'worker', f.runner)).agent.lifecycle, 'starting');
  // Idle long before re-verification, as during a verification lapse.
  const old = Date.now() - LIMITS.idleMs - 60_000;
  f.store.transact(s => { Object.assign(s.agents.worker, { activity: 'idle', activityAt: old }); });
  f.workerPane().terminal_command = command;
  const before = Date.now();
  const verified = await inspectAgent(f.store, 'worker', f.runner);
  assert.equal(verified.agent.lifecycle, 'running');
  assert.ok(verified.agent.activityAt >= before, 'idle clock restarts at re-verification');
  // An already-running worker's inspection leaves its genuine idle clock alone.
  f.store.transact(s => { s.agents.worker.activityAt = old; });
  await inspectAgent(f.store, 'worker', f.runner);
  assert.equal(f.store.read().agents.worker.activityAt, old);
});

for (const shape of ['empty tab', 'plugins only', 'wrong command', 'zero viewport', 'suppressed', 'blank screen']) {
  test(`live idle Pi with ${shape} cannot receive its task`, async () => {
    const f = await fixture({ handshake: true });
    f.controls.workerPanes = (inventory, tab) => {
      if (shape === 'empty tab') return inventory.filter(p => p.tab_id !== tab);
      if (shape === 'plugins only') return inventory.filter(p => p.tab_id !== tab || p.is_plugin);
      const pane = inventory.find(p => p.tab_id === tab && !p.is_plugin);
      if (shape === 'wrong command') pane.terminal_command = 'pi --session-id somebody-else';
      if (shape === 'zero viewport') { pane.pane_content_rows = 0; pane.pane_content_columns = 0; }
      if (shape === 'suppressed') pane.is_suppressed = true;
      return inventory;
    };
    if (shape === 'blank screen') f.controls.screen = '';
    const agent = await f.spawn();
    assert.ok(agent.pid && agent.heartbeatAt, 'process handshake alone is insufficient');
    assert.equal(agent.lifecycle, 'starting');
    assert.equal(f.store.read().messages.length, 0);
    assert.match((await inspectAgent(f.store, 'worker', f.runner)).observation, /unverified/);
    assert.equal(f.store.read().messages.length, 0);
    const bootstrap = f.calls.find(c => c.args[3] === 'new-tab').args.at(-1).slice(1);
    assert.doesNotMatch(readFileSync(bootstrap, 'utf8'), /Do synthetic work|Report evidence/);
    assert.ok(existsSync(join(f.root, 'runtime', 'worker', `${agent.generation}.md`)));
    assert.ok(!f.calls.some(c => c.args[0] === 'kill-session'));
  });
}

for (const change of ['plan', 'prompt', 'generation']) {
  test(`readiness rejects changed ${change} without queueing task instructions`, async () => {
    const f = await fixture(); const agent = await f.spawn(); f.handshake();
    if (change === 'plan') writeFileSync(f.plan, 'Changed approved scope');
    if (change === 'prompt') writeFileSync(join(f.root, 'runtime', 'worker', `${agent.generation}.md`), 'Changed instructions');
    const runner = async (...args) => {
      const result = await f.runner(...args);
      if (change === 'generation' && args[1][3] === 'dump-screen') f.store.transact(s => { s.agents.worker.generation = 'replacement-generation'; });
      return result;
    };
    assert.match((await inspectAgent(f.store, 'worker', runner)).observation, /unverified/);
    assert.equal(f.store.read().messages.length, 0);
    assert.equal(f.store.read().agents.worker.lifecycle, 'starting');
  });
}

test('resume bootstraps the exact transcript without delivering continuation before the new handshake', async () => {
  const f = await fixture({ handshake: true }); const original = await f.spawn();
  f.controls.alive(false); f.workerPane().exited = true; f.controls.handshake = false;
  const resumed = await resumeAgent(f.store, 'root', 'worker', f.extension, f.runner);
  assert.equal(resumed.lifecycle, 'starting'); assert.equal(resumed.sessionFile, original.sessionFile);
  assert.equal(f.store.read().messages.filter(m => m.generation === resumed.generation).length, 0);
  const bootstrap = f.calls.filter(c => c.args[3] === 'new-tab').at(-1).args.at(-1).slice(1);
  assert.doesNotMatch(readFileSync(bootstrap, 'utf8'), /Continue the original task|Plan:|Plan hash:/);
  f.handshake(); await inspectAgent(f.store, 'worker', f.runner);
  const continuation = f.store.read().messages.filter(m => m.generation === resumed.generation);
  assert.equal(continuation.length, 1); assert.match(continuation[0].body, /Continue the original task/);
  assert.equal(f.store.read().messages[0].generation, original.generation, 'old task message was not retargeted');
});

test('handshake establishes running, stale heartbeat is unresponsive, process exit is observed', async () => {
  const f = await fixture({ handshake: true });
  const agent = await f.spawn();
  assert.equal(agent.lifecycle, 'running');
  const manifest = join(f.root, 'runtime', 'worker', `${agent.generation}.json`);
  const record = JSON.parse(readFileSync(manifest)); record.createdAt = Date.now() - 120_000;
  writeFileSync(manifest, JSON.stringify(record));
  f.store.transact(s => { s.agents.worker.heartbeatAt = Date.now() - 90_000; });
  const stale = await inspectAgent(f.store, 'worker', f.runner);
  assert.equal(stale.agent.lifecycle, 'running'); assert.match(stale.observation, /unresponsive/);
  assert.equal(f.calls.filter(c => c.args[0] === 'kill-session').length, 0);
  f.controls.alive(false); f.workerPane().exited = true;
  assert.equal((await inspectAgent(f.store, 'worker', f.runner)).agent.lifecycle, 'exited');
});

test('model absence is explicit, retained and never substituted or retried under the same ID', async () => {
  const f = await fixture();
  f.controls.models = 'openai-codex gpt-6-astra-other\nother gpt-6-astra\n';
  const agent = await f.spawn();
  assert.equal(agent.lifecycle, 'starting'); assert.match(agent.launchError, /model availability/);
  assert.equal(f.calls.length, 1);
  assert.ok(!existsSync(f.input.worktree));
  await assert.rejects(f.spawn(), /already reserved/);
});

test('startup errors preserve worktree, prompt, manifest and reservation without secret logs or rollback', async () => {
  const f = await fixture();
  f.controls.fail = (command, args) => command === 'zellij' && args[3] === 'new-tab';
  const agent = await f.spawn();
  assert.match(agent.launchError, /tab creation/); assert.doesNotMatch(agent.launchError, /SECRET/);
  assert.ok(existsSync(f.input.worktree));
  assert.ok(existsSync(join(f.root, 'runtime', 'worker', `${agent.generation}.json`)));
  assert.ok(existsSync(join(f.root, 'runtime', 'worker', `${agent.generation}.md`)));
  assert.ok(!f.calls.some(c => c.args.includes('remove') || c.args.includes('reset') || c.args[0] === 'kill-session'));
  assert.equal(f.store.read().agents.worker.generation, agent.generation);
});

test('invalid IDs, paths, option injection, existing paths and symlink destinations are rejected before commands', async () => {
  const f = await fixture();
  for (const changes of [{ id: '../worker' }, { taskId: '--task' }, { base: '--help' }, { branch: '--help' },
    { worktree: f.repo }, { worktree: 'relative' }, { repo: `${f.repo}/../repo` }]) {
    await assert.rejects(spawnAgent(f.store, 'root', { ...f.input, ...changes }, f.extension, f.runner));
  }
  const link = join(f.root, 'link'); symlinkSync(join(f.root, 'absent'), link);
  await assert.rejects(spawnAgent(f.store, 'root', { ...f.input, worktree: link }, f.extension, f.runner), /Symlink/);
  const parentLink = join(f.root, 'parent-link'); symlinkSync(f.root, parentLink);
  await assert.rejects(spawnAgent(f.store, 'root', { ...f.input, worktree: join(parentLink, 'child') }, f.extension, f.runner), /Symlink/);
  assert.equal(f.calls.length, 0);
});

test('a non-Git coordinator cwd does not reserve nested worker worktrees', async () => {
  const f = await fixture({ handshake: true });
  const worktrees = join(f.root, '.local', 'share', 'pi-orchestrator', 'worktrees');
  mkdirSync(worktrees, { recursive: true });
  f.input.worktree = join(worktrees, 'worker');
  f.store.transact(s => { s.agents.root.worktree = f.root; });
  const agent = await f.spawn();
  assert.equal(agent.lifecycle, 'running');
  assert.equal(agent.launchError, undefined);
  assert.equal(agent.worktree, f.input.worktree);
  assert.ok(lstatSync(join(agent.worktree, '.git')).isFile());
  assert.equal(f.store.read().agents.root.worktree, f.root);
});

test('coordinator Git checkouts still reserve nested paths before commands', async t => {
  for (const kind of ['primary', 'linked']) await t.test(kind, async () => {
    const f = await fixture();
    const checkout = join(f.root, 'coordinator-checkout');
    if (kind === 'primary') await run('git', ['-c', 'init.templateDir=', 'init', '-q', checkout]);
    else await run('git', ['worktree', 'add', '-q', '-b', 'coordinator', checkout, 'HEAD'], { cwd: f.repo });
    f.store.transact(s => { s.agents.root.worktree = checkout; });
    f.input.worktree = join(checkout, 'nested-worker');
    await assert.rejects(f.spawn(), /Worktree\/branch already reserved/);
    assert.equal(f.calls.length, 0);
    assert.equal(f.store.read().agents.worker, undefined);
  });
});

test('worker worktree and branch reservations still reject conflicts with a non-Git coordinator cwd', async t => {
  for (const kind of ['nested', 'ancestor', 'branch']) await t.test(kind, async () => {
    const f = await fixture();
    const reserved = kind === 'nested' ? f.root : kind === 'ancestor' ? join(f.input.worktree, 'child') : join(f.root, 'peer');
    f.store.transact(s => {
      s.agents.root.worktree = f.root;
      s.agents.peer = { ...structuredClone(s.agents.root), id: 'peer', role: 'planner', parentId: 'root',
        worktree: reserved, repo: f.repo, branch: kind === 'branch' ? f.input.branch : 'agents/peer' };
    });
    await assert.rejects(f.spawn(), /Worktree\/branch already reserved/);
    assert.equal(f.calls.length, 0);
    assert.equal(f.store.read().agents.worker, undefined);
  });
});

test('dirty source checkout is preserved while the target is clean at the resolved base', async () => {
  const f = await fixture();
  writeFileSync(join(f.repo, 'tracked.txt'), 'Unrelated tracked edits\n');
  writeFileSync(join(f.repo, 'untracked.txt'), 'Unrelated untracked work\n');
  const before = await run('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: f.repo });
  const base = (await run('git', ['rev-parse', 'HEAD'], { cwd: f.repo })).stdout.trim();
  const agent = await f.spawn();
  assert.match(agent.launchError, /startup identity\/handshake; task withheld/); assert.equal(agent.base, base);
  assert.equal(readFileSync(join(f.repo, 'tracked.txt'), 'utf8'), 'Unrelated tracked edits\n');
  assert.equal(readFileSync(join(f.repo, 'untracked.txt'), 'utf8'), 'Unrelated untracked work\n');
  assert.equal((await run('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: f.repo })).stdout, before.stdout);
  assert.equal(readFileSync(join(agent.worktree, 'tracked.txt'), 'utf8'), 'Initial tracked contents\n');
  assert.ok(!existsSync(join(agent.worktree, 'untracked.txt')));
  assert.equal((await run('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: agent.worktree })).stdout, '');
  assert.ok(!f.calls.some(c => c.command === 'git' && (c.args.includes('reset') || c.args.includes('clean'))));
});

test('real Git preflight rejects existing branch, invalid branch and unresolved base', async t => {
  for (const kind of ['branch', 'invalid', 'base']) await t.test(kind, async () => {
    const f = await fixture();
    if (kind === 'branch') await run('git', ['branch', f.input.branch], { cwd: f.repo });
    if (kind === 'invalid') f.input.branch = 'invalid..branch';
    if (kind === 'base') f.input.base = 'absent-base';
    const agent = await f.spawn();
    assert.match(agent.launchError, /Git preflight/);
    assert.ok(!existsSync(f.input.worktree));
    assert.ok(!f.calls.some(c => c.command === 'zellij'));
  });
});

test('transaction reservation serializes concurrent task/worktree ownership', async () => {
  const f = await fixture();
  let unblock;
  const gate = new Promise(resolve => { unblock = resolve; });
  const first = spawnAgent(f.store, 'root', f.input, f.extension, async (...args) => { await gate; return f.runner(...args); });
  await assert.rejects(spawnAgent(f.store, 'root', { ...f.input, id: 'other' }, f.extension, f.runner), /already reserved/);
  await assert.rejects(spawnAgent(f.store, 'root', { ...f.input, id: 'other', worktree: join(f.root, 'other'), branch: 'other' }, f.extension, f.runner), /live agent/);
  unblock(); await first;
});

test('write roles require current approval and verified dependencies; planner is read-only', async () => {
  const f = await fixture();
  writeFileSync(f.plan, 'changed');
  await assert.rejects(f.spawn(), /Current plan approval/);
  f.store.transact(s => { s.tasks.task.state = 'planned'; });
  const planner = await spawnAgent(f.store, 'root', { ...f.input, role: 'planner' }, f.extension, f.runner);
  assert.equal(planner.role, 'planner');
  const launch = f.calls.find(c => c.args[3] === 'new-tab');
  const tools = launch.args[launch.args.indexOf('--tools') + 1];
  // ask_user is the orchestrator's non-blocking stand-in in workers, so planners may still escalate questions.
  assert.equal(tools, 'read,bash,grep,find,ls,orchestrator_status,orchestrator_message,orchestrator_agent,orchestrator_task,ask_user');
  assert.ok(!tools.split(',').some((tool) => ['write', 'edit'].includes(tool)), 'planners never get file-editing tools');
  const g = await fixture();
  g.store.transact(s => {
    s.tasks.dep = { ...structuredClone(s.tasks.task), id: 'dep', state: 'ready' };
    s.tasks.task.dependencies = ['dep'];
  });
  await assert.rejects(g.spawn(), /Verified current dependencies/);
  g.store.transact(s => {
    s.tasks.dep.state = 'verified';
    s.tasks.dep.result = { commit: 'a'.repeat(40), status: 'ready' };
    s.tasks.dep.verification = { commit: 'a'.repeat(40), planHash: s.tasks.dep.planHash };
  });
  assert.equal((await g.spawn()).lifecycle, 'starting');
});

test('planner and reviewer launches get bash without edit/write on spawn and resume, with the read-only shell boundary', async t => {
  const readOnlyTools = 'read,bash,grep,find,ls,orchestrator_status,orchestrator_message,orchestrator_agent,orchestrator_task,ask_user';
  const boundary = 'Planner/reviewer roles have no repository write authorization. Their bash is not a sandbox: use it only for read-only Git inspection and task-relevant tests in your own worktree. Disclose any tracked changes tests generate; never reset, clean or fix them. Source edits, destructive commands, dependency installation, credential changes and release actions stay unauthorized.\n';
  const toolsOf = launch => { const at = launch.args.indexOf('--tools'); return at < 0 ? undefined : launch.args[at + 1]; };
  for (const role of ['planner', 'reviewer', 'implementer']) await t.test(role, async () => {
    const f = await fixture({ handshake: true });
    const original = await spawnAgent(f.store, 'root', { ...f.input, role }, f.extension, f.runner);
    assert.equal(original.role, role);
    f.controls.alive(false); f.workerPane().exited = true; f.controls.handshake = false;
    const resumed = await resumeAgent(f.store, 'root', 'worker', f.extension, f.runner);
    f.handshake(); await inspectAgent(f.store, 'worker', f.runner);
    const launches = f.calls.filter(c => c.args[3] === 'new-tab');
    assert.equal(launches.length, 2, 'one spawn and one resume launch');
    assert.ok(launches[1].args.includes('--session'), 'second launch resumes the original transcript');
    for (const launch of launches) {
      const tools = toolsOf(launch);
      if (role === 'implementer') { assert.equal(tools, undefined, 'implementers keep default tools'); continue; }
      assert.equal(tools, readOnlyTools);
      assert.ok(!tools.split(',').some(tool => ['edit', 'write'].includes(tool)), `${role} never gets file-editing tools`);
    }
    for (const generation of [original.generation, resumed.generation]) {
      const body = readFileSync(join(f.root, 'runtime', 'worker', `${generation}.md`), 'utf8');
      assert.ok(body.includes(boundary), `${generation} prompt states the read-only shell boundary`);
      assert.doesNotMatch(body, /inspect only/);
    }
  });
});

test('write authorization rejects stale ancestor approvals and prototype task names', async () => {
  const f = await fixture();
  await assert.rejects(spawnAgent(f.store, 'root', { ...f.input, role: 'planner', taskId: 'toString' }, f.extension, f.runner), /Unknown task/);
  const ancestorPlan = join(f.root, 'ancestor-plan.md'); writeFileSync(ancestorPlan, 'Ancestor scope');
  f.store.transact(s => {
    s.tasks.ancestor = { ...structuredClone(s.tasks.task), id: 'ancestor', planPath: ancestorPlan, planHash: sha('Ancestor scope'),
      approval: { hash: sha('Ancestor scope'), source: 'synthetic user', at: Date.now() } };
    s.tasks.task.parentTask = 'ancestor';
  });
  writeFileSync(ancestorPlan, 'Changed ancestor scope');
  await assert.rejects(f.spawn(), /parent scope/);
  assert.equal(f.calls.length, 0);
});

test('only authorized parent scope can launch nested agents without read-only role escalation', async () => {
  const f = await fixture();
  await assert.rejects(spawnAgent(f.store, 'unknown', f.input, f.extension, f.runner), /Parent/);
  f.store.transact(s => {
    s.agents.parent = { ...s.agents.root, id: 'parent', role: 'planner', taskId: 'parent-task', worktree: join(f.root, 'parent-worktree') };
    s.tasks['parent-task'] = { ...s.tasks.task, id: 'parent-task' };
  });
  await assert.rejects(spawnAgent(f.store, 'parent', f.input, f.extension, f.runner), /descend/);
  f.store.transact(s => { s.tasks.task.parentTask = 'parent-task'; });
  await assert.rejects(spawnAgent(f.store, 'parent', f.input, f.extension, f.runner), /Read-only parent/);
  const agent = await spawnAgent(f.store, 'parent', { ...f.input, role: 'reviewer' }, f.extension, f.runner);
  assert.equal(agent.parentId, 'parent');
});

test('resume refuses live PID, live original pane, and shared transcript ownership', async () => {
  const f = await fixture({ handshake: true });
  const original = await f.spawn();
  await assert.rejects(resumeAgent(f.store, 'root', 'worker', f.extension, f.runner), /still live/);
  f.controls.alive(false);
  await assert.rejects(resumeAgent(f.store, 'root', 'worker', f.extension, f.runner), /pane is still live/);
  f.workerPane().exited = true;
  f.store.transact(s => { s.agents.foreign = { ...s.agents.worker, id: 'foreign', taskId: undefined }; });
  await assert.rejects(resumeAgent(f.store, 'root', 'worker', f.extension, f.runner), /Shared transcript/);
  assert.equal(f.store.read().agents.worker.generation, original.generation);
});

test('resume propagates exact existing transcript, fences generation and preserves queued message target', async () => {
  const f = await fixture({ handshake: true });
  f.store.transact(s => { s.agents.root.model = 'other-provider/parent-model'; });
  f.controls.models = 'custom-provider chosen-model 1M\n';
  const configPath = join(f.root, 'model-roles.json');
  writeFileSync(configPath, '{"implementationThinking":"low"}');
  const original = await spawnAgent(f.store, 'root', { ...f.input, model: 'custom-provider/chosen-model' },
    f.extension, f.runner, undefined, f.root);
  writeFileSync(configPath, '{"implementationThinking":"xhigh"}');
  f.store.transact(s => { s.agents.root.model = 'changed-provider/changed-model'; });
  f.controls.alive(false); f.workerPane().exited = true;
  f.store.transact(s => { s.messages.push({ id: 'old', from: 'root', to: 'worker', generation: original.generation, body: 'old', kind: 'message', mode: 'followUp', createdAt: Date.now() }); });
  const resumed = await resumeAgent(f.store, 'root', 'worker', f.extension, f.runner);
  assert.notEqual(resumed.generation, original.generation); assert.equal(resumed.zellijSession, original.zellijSession);
  for (const key of ['model', 'thinking', 'worktree', 'repo', 'branch', 'base', 'sessionDir', 'sessionFile', 'piSessionId', 'taskId', 'role']) assert.equal(resumed[key], original[key]);
  const launch = f.calls.filter(c => c.args[3] === 'new-tab').at(-1);
  const argv = launch.args.slice(10);
  assert.deepEqual(argv, ['--approve', '--provider', 'custom-provider', '--model', 'chosen-model', '--thinking', 'low',
    '--extension', f.extension, '--session-dir', original.sessionDir, '--session', original.sessionFile,
    '--orchestrator-root', f.root, '--orchestrator-agent', 'worker', '--orchestrator-generation', resumed.generation,
    `@${join(f.root, 'runtime', 'worker', `${resumed.generation}.bootstrap.md`)}`]);
  assert.match(readFileSync(argv.at(-1).slice(1), 'utf8'), /startup check only/);
  assert.doesNotMatch(readFileSync(argv.at(-1).slice(1), 'utf8'), /resumed generation|Do synthetic work/);
  assert.equal(f.store.read().messages[0].generation, original.generation);
  assert.deepEqual(f.store.read().notifications, {}, 'Acknowledged notification keys must not be used as a pending queue');
  assert.match((await inspectAgent(f.store, 'worker', f.runner)).observation, /resend explicitly/);
  assert.equal(resumed.lifecycle, 'running');
});

test('uncertain PID or session probes never authorize resume or cleanup', async () => {
  const f = await fixture({ handshake: true });
  const original = await f.spawn();
  const report = join(f.root, 'report.md'); writeFileSync(report, 'Synthetic results');
  collectAgent(f.store, 'root', 'worker', report);
  f.controls.fail = command => command === 'ps';
  await assert.rejects(resumeAgent(f.store, 'root', 'worker', f.extension, f.runner));
  await assert.rejects(closeAgent(f.store, 'root', 'worker', f.runner));
  f.controls.fail = (command, args) => command === 'zellij' && args[0] === 'list-sessions';
  f.controls.alive(false);
  await assert.rejects(resumeAgent(f.store, 'root', 'worker', f.extension, f.runner));
  assert.equal(f.store.read().agents.worker.generation, original.generation);
  assert.ok(!f.calls.some(c => c.args[0] === 'kill-session'));
});

test('a dead handshake PID is observed as exited even while pane state lags', async () => {
  const f = await fixture({ handshake: true }); await f.spawn();
  f.controls.alive(false);
  const observed = await inspectAgent(f.store, 'worker', f.runner);
  assert.equal(observed.agent.lifecycle, 'exited');
  assert.match(observed.observation, /PID no longer exists/);
});

test('authorization is rechecked immediately before launching Pi', async () => {
  const f = await fixture();
  const runner = async (command, args, options) => {
    const result = await f.runner(command, args, options);
    if (command === 'zellij' && args[3] === 'list-panes') writeFileSync(f.plan, 'Changed after reservation');
    return result;
  };
  const agent = await spawnAgent(f.store, 'root', f.input, f.extension, runner);
  assert.match(agent.launchError, /tab creation/);
  assert.ok(existsSync(agent.worktree));
  assert.ok(!f.calls.some(c => c.args[3] === 'new-tab'));
});

test('resume rejects missing or mismatched persisted transcript and mutated role identity', async () => {
  const f = await fixture(); await f.spawn();
  await assert.rejects(resumeAgent(f.store, 'root', 'worker', f.extension, f.runner), /session-file handshake/);
  const g = await fixture({ handshake: true }); await g.spawn();
  g.controls.alive(false); g.active.clear();
  g.store.transact(s => { s.agents.worker.role = 'release'; });
  await assert.rejects(resumeAgent(g.store, 'root', 'worker', g.extension, g.runner), /launch identity/);
});

test('collect only records existing report; cleanup requires collection and worker exit', async () => {
  const f = await fixture({ handshake: true });
  await f.spawn();
  await assert.rejects(closeAgent(f.store, 'root', 'worker', f.runner), /Collect/);
  assert.throws(() => collectAgent(f.store, 'root', 'worker', join(f.root, 'absent')));
  const report = join(f.root, 'report.md'); writeFileSync(report, 'Synthetic results');
  const task = f.store.read().tasks.task;
  const agent = collectAgent(f.store, 'root', 'worker', report);
  assert.equal(agent.lifecycle, 'running'); assert.deepEqual(f.store.read().tasks.task, task);
  assert.equal((await inspectAgent(f.store, 'worker', f.runner)).agent.lifecycle, 'running');
  assert.equal(sendMessage(f.store, 'root', 'worker', 'Orderly stop after collection', 'followUp', 'shutdown').kind, 'shutdown');
  await assert.rejects(closeAgent(f.store, 'root', 'worker', f.runner), /PID is live/);
  f.controls.alive(false);
  await assert.rejects(closeAgent(f.store, 'root', 'worker', f.runner), /must have exited/);
  f.workerPane().exited = true;
  delete f.workerPane().pane_cwd;
  assert.equal((await inspectAgent(f.store, 'worker', f.runner)).agent.lifecycle, 'collected');
  assert.equal((await closeAgent(f.store, 'root', 'worker', f.runner)).lifecycle, 'closed');
  assert.ok(existsSync(agent.worktree)); assert.ok(existsSync(agent.sessionFile)); assert.ok(existsSync(report));
  assert.deepEqual(f.calls.find(c => c.args[3] === 'close-tab').args, ['--session', agent.zellijSession, 'action', 'close-tab', '--tab-id', '5']);
  assert.ok(!f.calls.some(c => c.args[0] === 'kill-session'));
  assert.ok(f.active.has(agent.zellijSession), 'Task session remains available for peers');
  const resumed = await resumeAgent(f.store, 'root', 'worker', f.extension, f.runner);
  assert.equal(resumed.lifecycle, 'running');
  assert.equal(resumed.sessionFile, agent.sessionFile);
  assert.equal(resumed.collectedReport, undefined, 'A resumed generation requires fresh collection before closing');
});

test('cleanup closes the owned tab with whatever else is in it, but never an unverified or another agent\'s pane', async t => {
  for (const scenario of ['foreign', 'replaced', 'initial-shell', 'foreign-plugin', 'unsuppressed-link', 'peer-agent', 'plugin-sharing-peer-number', 'closed-peer']) await t.test(scenario, async () => {
    const f = await fixture({ handshake: true });
    const shell = { id: 1, is_plugin: false, tab_id: 0, tab_name: 'default', title: 'shell', exited: false, pane_command: '/bin/zsh', pane_cwd: f.root };
    if (scenario === 'initial-shell') f.controls.initial[0] = shell;
    const agent = await f.spawn(); f.controls.alive(false); f.workerPane().exited = true;
    const report = join(f.root, 'report.md'); writeFileSync(report, 'Synthetic results'); collectAgent(f.store, 'root', 'worker', report);
    if (scenario === 'foreign') f.inventories.get(agent.zellijSession).push({ ...shell, tab_id: agent.tabId });
    if (scenario === 'foreign-plugin') f.inventories.get(agent.zellijSession).push({ ...shell, tab_id: agent.tabId, is_plugin: true, plugin_url: 'foreign' });
    if (scenario === 'replaced') f.workerPane().terminal_command = 'unrelated';
    if (scenario === 'unsuppressed-link') f.inventories.get(agent.zellijSession).find(p => p.tab_id === agent.tabId && p.is_plugin).is_suppressed = false;
    if (scenario === 'peer-agent') {
      f.inventories.get(agent.zellijSession).push({ ...shell, id: 77, tab_id: agent.tabId });
      f.store.transact(s => { s.agents.peer = { ...structuredClone(s.agents.worker), id: 'peer', paneId: 'terminal_77' }; });
    }
    // Plugin and terminal panes are numbered separately, so plugin_77 is not the peer's terminal_77.
    if (scenario === 'plugin-sharing-peer-number') {
      f.inventories.get(agent.zellijSession).push({ ...shell, id: 77, tab_id: agent.tabId, is_plugin: true, plugin_url: 'zellij:session-manager' });
      f.store.transact(s => { s.agents.peer = { ...structuredClone(s.agents.worker), id: 'peer', paneId: 'terminal_77' }; });
    }
    if (scenario === 'closed-peer') {
      f.inventories.get(agent.zellijSession).push({ ...shell, id: 77, tab_id: agent.tabId, exited: true });
      f.store.transact(s => { s.agents.peer = { ...structuredClone(s.agents.worker), id: 'peer', paneId: 'terminal_77', lifecycle: 'closed' }; });
    }
    if (scenario === 'replaced' || scenario === 'peer-agent') {
      await assert.rejects(closeAgent(f.store, 'root', 'worker', f.runner), scenario === 'replaced' ? /identity is unverified/ : /Another agent's pane/);
      assert.ok(!f.calls.some(c => c.args[3] === 'close-tab'));
    } else {
      assert.equal((await closeAgent(f.store, 'root', 'worker', f.runner)).lifecycle, 'closed');
      assert.ok(!f.inventories.get(agent.zellijSession).some(p => p.tab_id === agent.tabId));
      if (scenario === 'initial-shell') assert.deepEqual(f.inventories.get(agent.zellijSession), f.controls.initial);
    }
    assert.ok(!f.calls.some(c => c.args[0] === 'kill-session'));
  });
});

test('the coordinator closes its worker session only after every agent is closed; later spawns get a fresh one', async () => {
  const f = await fixture({ handshake: true });
  const agent = await f.spawn();
  const session = agent.zellijSession;
  await assert.rejects(closeTaskSession(f.store, 'root', session, f.runner), /Retire every agent first: worker/);
  const report = join(f.root, 'report.md'); writeFileSync(report, 'Synthetic results'); collectAgent(f.store, 'root', 'worker', report);
  f.controls.alive(false); f.workerPane().exited = true;
  await closeAgent(f.store, 'root', 'worker', f.runner);
  assert.ok(f.active.has(session), 'closing the last worker alone does not kill the session');
  await assert.rejects(closeTaskSession(f.store, 'worker', session, f.runner), /Only the coordinator/);
  await assert.rejects(closeTaskSession(f.store, 'root', 'piorch-000000-000000', f.runner), /Not this orchestrator/);
  assert.equal((await closeTaskSession(f.store, 'root', session, f.runner)).observation, 'killed');
  assert.ok(!f.active.has(session));
  assert.ok(f.calls.some(c => c.args[0] === 'delete-session' && c.args[1] === session));
  assert.ok(f.store.read().sharedSession.closedAt);
  assert.equal((await closeTaskSession(f.store, 'root', session, f.runner)).observation, 'already closed');
  f.store.transact(s => { s.tasks.next = { ...structuredClone(s.tasks.task), id: 'next' }; });
  const next = await spawnAgent(f.store, 'root', { ...f.input, id: 'next', taskId: 'next', branch: 'agents/next', worktree: join(f.root, 'next-worktree') }, f.extension, f.runner);
  assert.equal(next.lifecycle, 'running');
  assert.notEqual(next.zellijSession, session);
  assert.equal(f.calls.filter(c => c.args[0] === 'attach').length, 2);
});

test('close-session kills the disposable worker session even with panes it did not create', async () => {
  const f = await fixture({ handshake: true });
  const agent = await f.spawn();
  const report = join(f.root, 'report.md'); writeFileSync(report, 'Synthetic results'); collectAgent(f.store, 'root', 'worker', report);
  f.controls.alive(false); f.workerPane().exited = true;
  await closeAgent(f.store, 'root', 'worker', f.runner);
  f.inventories.get(agent.zellijSession).push({ id: 99, is_plugin: false, tab_id: 42, tab_name: 'human', title: 'shell', exited: false, pane_command: '/bin/zsh', pane_cwd: f.root });
  assert.equal((await closeTaskSession(f.store, 'root', agent.zellijSession, f.runner)).observation, 'killed');
  assert.ok(!f.active.has(agent.zellijSession));
});

test('the initial layout is recorded only once the background session has built it', async () => {
  const f = await fixture({ handshake: true });
  f.controls.layoutDelay = 2;
  const agent = await f.spawn();
  const record = JSON.parse(readFileSync(join(f.root, 'runtime', 'task-sessions', `${agent.zellijSession}.json`), 'utf8'));
  assert.equal(record.initial.length, 3, 'empty early reads are not mistaken for the layout');
});

test('bootstrap and worker ownership wait for delayed bars even after the terminal settles', async () => {
  const f = await fixture({ handshake: true });
  const reads = new Map();
  const runner = async (command, args, options) => {
    const result = await f.runner(command, args, options);
    if (command !== 'zellij' || args[3] !== 'list-panes') return result;
    const inventory = JSON.parse(result.stdout);
    for (const tab of new Set(inventory.map(p => p.tab_id))) reads.set(tab, (reads.get(tab) ?? 0) + 1);
    return output(JSON.stringify(inventory.filter(p => !p.is_plugin || p.plugin_url === 'zellij:link' || reads.get(p.tab_id) > 3)));
  };
  const agent = await spawnAgent(f.store, 'root', f.input, f.extension, runner);
  assert.equal(agent.lifecycle, 'running');
  const manifest = JSON.parse(readFileSync(join(f.root, 'runtime', agent.id, `${agent.generation}.json`)));
  const session = JSON.parse(readFileSync(join(f.root, 'runtime', 'task-sessions', `${agent.zellijSession}.json`)));
  assert.equal(manifest.tabChrome.length, 2);
  assert.equal(session.initial.length, 3);
  const report = join(f.root, 'report.md'); writeFileSync(report, 'Synthetic results'); collectAgent(f.store, 'root', 'worker', report);
  f.controls.alive(false); f.workerPane().exited = true;
  assert.equal((await closeAgent(f.store, 'root', 'worker', runner)).lifecycle, 'closed');
  assert.equal((await closeTaskSession(f.store, 'root', agent.zellijSession, runner)).observation, 'killed');
});

test('missing bundled chrome fails closed without recording partial ownership', async t => {
  for (const phase of ['bootstrap', 'worker']) await t.test(phase, async () => {
    const f = await fixture({ handshake: true });
    const runner = async (command, args, options) => {
      const result = await f.runner(command, args, options);
      if (command !== 'zellij' || args[3] !== 'list-panes') return result;
      return output(JSON.stringify(JSON.parse(result.stdout).filter(p =>
        p.plugin_url !== 'zellij:status-bar' || (phase === 'bootstrap' ? p.tab_id !== 0 : p.tab_id === 0))));
    };
    const agent = await spawnAgent(f.store, 'root', f.input, f.extension, runner);
    assert.match(agent.launchError, phase === 'bootstrap' ? /shared task-session readiness/ : /tab chrome identity/);
    const manifest = JSON.parse(readFileSync(join(f.root, 'runtime', agent.id, `${agent.generation}.json`)));
    assert.equal(manifest.tabChrome, undefined);
    if (phase === 'bootstrap') {
      const session = JSON.parse(readFileSync(join(f.root, 'runtime', 'task-sessions', `${agent.zellijSession}.json`)));
      assert.equal(session.ready, false);
      assert.deepEqual(session.initial, []);
      assert.ok(!f.calls.some(c => c.args[3] === 'new-tab'));
    } else {
      // A later inspect may verify Pi, but must never adopt the now-visible bars.
      await inspectAgent(f.store, agent.id, f.runner);
      const report = join(f.root, 'report.md'); writeFileSync(report, 'Synthetic results'); collectAgent(f.store, 'root', 'worker', report);
      f.controls.alive(false); f.workerPane().exited = true;
      assert.equal((await closeAgent(f.store, 'root', 'worker', f.runner)).lifecycle, 'closed', 'Late bars are Zellij built-ins and go with the tab');
    }
    assert.ok(!f.calls.some(c => c.args[0] === 'kill-session'));
  });
});

test('cleanup closes the tab whatever chrome or plugins it holds now', async t => {
  for (const scenario of ['added-bar', 'replaced-id', 'replaced-url', 'replaced-terminal', 'legacy-record']) await t.test(scenario, async () => {
    const f = await fixture({ handshake: true }); const agent = await f.spawn();
    const inventory = f.inventories.get(agent.zellijSession);
    const bar = inventory.find(p => p.tab_id === agent.tabId && p.plugin_url === 'zellij:tab-bar');
    if (scenario === 'added-bar') inventory.push({ ...bar, id: 9999 });
    if (scenario === 'replaced-id') bar.id = 9999;
    if (scenario === 'replaced-url') bar.plugin_url = 'zellij:strider';
    if (scenario === 'replaced-terminal') Object.assign(bar, { is_plugin: false, pane_command: '/bin/zsh' });
    if (scenario === 'legacy-record') {
      const path = join(f.root, 'runtime', agent.id, `${agent.generation}.json`);
      const record = JSON.parse(readFileSync(path)); delete record.tabChrome;
      writeFileSync(path, JSON.stringify(record));
    }
    const report = join(f.root, 'report.md'); writeFileSync(report, 'Synthetic results'); collectAgent(f.store, 'root', 'worker', report);
    f.controls.alive(false); f.workerPane().exited = true;
    await inspectAgent(f.store, agent.id, f.runner);
    assert.equal((await closeAgent(f.store, 'root', 'worker', f.runner)).lifecycle, 'closed');
    assert.ok(!f.inventories.get(agent.zellijSession).some(p => p.tab_id === agent.tabId));
    assert.ok(!f.calls.some(c => c.args[0] === 'kill-session'));
  });
});

test('new workers in legacy bare sessions do not require or install chrome', async () => {
  const f = await fixture({ handshake: true }); const original = await f.spawn();
  const path = join(f.root, 'runtime', 'task-sessions', `${original.zellijSession}.json`);
  const session = JSON.parse(readFileSync(path)); delete session.chrome;
  writeFileSync(path, JSON.stringify(session));
  f.controls.chrome = false;
  f.store.transact(s => { s.tasks.peerTask = { ...structuredClone(s.tasks.task), id: 'peerTask' }; });
  const peer = await spawnAgent(f.store, 'root', { ...f.input, id: 'peer', taskId: 'peerTask', branch: 'peer', worktree: join(f.root, 'peer') }, f.extension, f.runner);
  assert.equal(peer.lifecycle, 'running'); assert.equal(peer.zellijSession, original.zellijSession);
  const record = JSON.parse(readFileSync(join(f.root, 'runtime', peer.id, `${peer.generation}.json`)));
  assert.deepEqual(record.tabChrome, []);
  assert.equal(f.calls.filter(c => c.args[0] === 'attach').length, 1);
  assert.equal(readFileSync(path, 'utf8'), JSON.stringify(session), 'Existing session metadata is unchanged');
});

test('a narrow pane with a truncated Pi footer still counts as a visible Pi TUI, a shell does not', async () => {
  const f = await fixture({ handshake: true });
  f.controls.screen = 'Reply PROBE_OK then wait.\n\n PROBE_OK\n────\n/private/tmp/wt (agents/p...\n↑2.2k ↓7 $0.023 (sub) 0.8%/272k (auto)  gpt-6-as\n';
  assert.equal((await f.spawn()).lifecycle, 'running');
  const shell = await fixture({ handshake: true });
  shell.controls.screen = 'tester@host:/private/tmp/wt $ ';
  assert.equal((await shell.spawn()).lifecycle, 'starting');
});

test('pruneWorktrees deletes worktrees and branches idle past the threshold, keeping live, active and dirty ones', async () => {
  const { pruneWorktrees, defaultWorktree } = await import('../src/runtime.ts');
  const { utimesSync, readdirSync } = await import('node:fs');
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'piorch-prune-')));
  const repo = join(base, 'repo'), root = join(base, 'worktrees');
  const git = (cwd, ...args) => run('git', ['-C', cwd, ...args]);
  mkdirSync(repo); await git(repo, 'init', '-q', '-b', 'main');
  // Synthetic commits never use the host's signing setup, which can prompt or fail when its agent is locked.
  await git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'init');
  const make = async (id) => { const wt = defaultWorktree(repo, id, root); await git(repo, 'worktree', 'add', '-q', '-b', id, wt); return wt; };
  const [stale, fresh, live, dirty] = [await make('stale'), await make('fresh'), await make('live'), await make('dirty')];
  const broken = join(root, 'broken'); mkdirSync(broken);
  writeFileSync(join(dirty, 'wip.txt'), 'work');
  const old = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  for (const wt of [stale, live, dirty, broken]) {
    const admin = (await git(wt, 'rev-parse', '--absolute-git-dir').catch(() => ({ stdout: '' }))).stdout.trim();
    if (admin && admin.includes('/worktrees/')) for (const f of ['index', 'HEAD', 'logs/HEAD']) if (existsSync(join(admin, f))) utimesSync(join(admin, f), old, old);
    utimesSync(wt, old, old);
  }
  const removed = await pruneWorktrees([live], run, Date.now(), root);
  assert.deepEqual(removed.sort(), [broken, `${stale} (stale)`].sort());
  assert.deepEqual(readdirSync(root).map((n) => join(root, n)).sort(), [fresh, live, dirty].sort());
  const branches = (await git(repo, 'branch', '--format=%(refname:short)')).stdout.split('\n').filter(Boolean).sort();
  assert.deepEqual(branches, ['dirty', 'fresh', 'live', 'main']);
  assert.ok(!(await git(repo, 'worktree', 'list', '--porcelain')).stdout.includes(stale));
  const liveAdmin = (await git(live, 'rev-parse', '--absolute-git-dir')).stdout.trim();
  await pruneWorktrees([], run, Date.now() - 20 * 24 * 3600 * 1000, root);
  assert.ok(lstatSync(join(liveAdmin, 'index')).mtimeMs < Date.now() - 20 * 24 * 3600 * 1000, 'inspection must not refresh the index');
  assert.deepEqual(await pruneWorktrees([], run, Date.now(), join(base, 'missing')), []);
});

// Failures seen in real runs: the worker is already gone in some way, and close must still finish.
async function stopped(f) {
  const agent = await f.spawn();
  const report = join(f.root, 'report.md'); writeFileSync(report, 'Synthetic results'); collectAgent(f.store, 'root', 'worker', report);
  f.controls.alive(false);
  return agent;
}

test('close finishes for a worker whose session, tab or terminal pane is already gone', async t => {
  await t.test('session absent', async () => {
    const f = await fixture({ handshake: true }); const agent = await stopped(f);
    f.active.delete(agent.zellijSession);
    assert.equal((await closeAgent(f.store, 'root', 'worker', f.runner)).lifecycle, 'closed');
  });
  await t.test('tab gone', async () => {
    const f = await fixture({ handshake: true }); const agent = await stopped(f);
    f.inventories.set(agent.zellijSession, f.inventories.get(agent.zellijSession).filter(p => p.tab_id !== agent.tabId));
    assert.equal((await closeAgent(f.store, 'root', 'worker', f.runner)).lifecycle, 'closed');
    assert.ok(!f.calls.some(c => c.args[3] === 'close-tab'));
  });
  await t.test('only plugins left in the tab', async () => {
    const f = await fixture({ handshake: true }); const agent = await stopped(f);
    const inventory = f.inventories.get(agent.zellijSession);
    inventory.push({ id: 300, is_plugin: true, tab_id: agent.tabId, tab_name: 'worker', title: 'Session Manager', exited: false, plugin_url: 'zellij:session-manager' });
    f.inventories.set(agent.zellijSession, inventory.filter(p => p.is_plugin || p.tab_id !== agent.tabId));
    assert.equal((await closeAgent(f.store, 'root', 'worker', f.runner)).lifecycle, 'closed');
    assert.ok(!f.inventories.get(agent.zellijSession).some(p => p.tab_id === agent.tabId));
  });
  await t.test('still refuses a live PID', async () => {
    const f = await fixture({ handshake: true }); const agent = await stopped(f);
    f.controls.alive(true, agent.pid);
    await assert.rejects(closeAgent(f.store, 'root', 'worker', f.runner), /PID is live; use retire/);
  });
});

test('close finishes for a worker that never launched, but not for one that started', async () => {
  const f = await fixture(); const agent = await f.spawn();
  const report = join(f.root, 'report.md'); writeFileSync(report, 'Synthetic results'); collectAgent(f.store, 'root', 'worker', report);
  rmSync(join(f.root, 'runtime', agent.id), { recursive: true });
  f.store.transact(s => { s.agents.worker.heartbeatAt = Date.now(); });
  await assert.rejects(closeAgent(f.store, 'root', 'worker', f.runner), /Launch record missing/);
  f.store.transact(s => { delete s.agents.worker.heartbeatAt; });
  assert.equal((await closeAgent(f.store, 'root', 'worker', f.runner)).lifecycle, 'closed');
});

test('an empty pane inventory is retried instead of failing on JSON', async () => {
  const f = await fixture({ handshake: true }); const agent = await stopped(f); f.workerPane().exited = true;
  let blanks = 2;
  const runner = async (command, args, options) => (command === 'zellij' && args[3] === 'list-panes' && blanks-- > 0) ? output('') : f.runner(command, args, options);
  assert.equal((await closeAgent(f.store, 'root', 'worker', runner)).lifecycle, 'closed');
  assert.ok(!f.inventories.get(agent.zellijSession).some(p => p.tab_id === agent.tabId));
});

test('retire shuts down, waits, collects the task report and closes; a busy worker is a retry, not an error', async () => {
  const f = await fixture({ handshake: true }); const agent = await f.spawn();
  const report = join(f.root, 'report.md'); writeFileSync(report, 'Synthetic results');
  await assert.rejects(retireAgent(f.store, 'root', 'worker', undefined, async (c, a, o) => {
    const result = await f.runner(c, a, o); if (c === 'ps') f.controls.alive(false); return result;
  }, 50, 1), /no report to collect/);
  f.controls.alive(true, agent.pid);
  const busy = await retireAgent(f.store, 'root', 'worker', undefined, f.runner, 5, 1);
  assert.match(busy.observation, /still mid-turn/);
  assert.equal(f.store.read().messages.filter(m => m.kind === 'shutdown').length, 1);
  f.store.transact(s => { s.tasks.task.result = { id: 'r', status: 'ready', report, createdAt: Date.now() }; });
  let polls = 0;
  const exiting = async (c, a, o) => { if (c === 'ps' && ++polls === 3) { f.controls.alive(false); f.workerPane().exited = true; } return f.runner(c, a, o); };
  const done = await retireAgent(f.store, 'root', 'worker', undefined, exiting, 1000, 1);
  assert.equal(done.agent.lifecycle, 'closed');
  assert.equal(done.agent.collectedReport, report);
  assert.match(done.observation, new RegExp(`last agent in ${agent.zellijSession}`));
  assert.equal(f.store.read().messages.filter(m => m.kind === 'shutdown').length, 1, 'no duplicate shutdown request');
  assert.equal((await retireAgent(f.store, 'root', 'worker', undefined, f.runner)).observation, 'already closed');
});

test('a handshake that lands after spawn is promoted by a later inspection with the same identity checks', async () => {
  const f = await fixture();
  const agent = await f.spawn();
  assert.equal(agent.lifecycle, 'starting', 'spawn inspected before the worker heartbeat');
  // The worker's extension attaches later: transcript, PID and heartbeat of the current generation.
  const file = join(agent.sessionDir, `${agent.piSessionId}.jsonl`);
  writeFileSync(file, JSON.stringify({ type: 'session', version: 3, id: agent.piSessionId, cwd: agent.worktree }) + '\n');
  f.store.transact(s => Object.assign(s.agents.worker, { sessionFile: file, heartbeatAt: Date.now(), pid: 424242, activity: 'busy' }));
  f.controls.alive(true, 424242);
  const promoted = await inspectAgent(f.store, 'worker', f.runner);
  assert.equal(promoted.agent.lifecycle, 'running');
  assert.match(promoted.observation, /handshake verified/);
});

test('goToAgent takes the human to the verified worker pane: new window, this window, or same session', async () => {
  const f = await fixture({ handshake: true });
  const agent = await f.spawn();
  const pane = f.workerPane(); pane.tab_position = 1;
  const jumps = []; let clients = 1;
  const runner = async (command, args, opts) => {
    if (command === 'open') { jumps.push([command, ...args]); clients++; return output(''); }
    if (command === 'zellij' && args.includes('list-clients')) return output(Array.from({ length: clients }, (_, i) => `${i + 1} terminal_0 zellij`).join('\n'));
    if (command === 'zellij' && ['go-to-tab-by-id', 'focus-pane-id', 'switch-session'].some((a) => args.includes(a))) { jumps.push(args); return output(''); }
    return f.runner(command, args, opts);
  };
  const s = agent.zellijSession, id = `terminal_${pane.id}`;
  assert.match(await goToAgent(f.store, 'worker', 'window', 'human', runner), new RegExp(`Opened ${s} › worker in a new Ghostty window`));
  assert.deepEqual(jumps.splice(0), [['open', '-na', 'Ghostty', '--args', '-e', 'zellij', 'attach', s],
    ['--session', s, 'action', 'go-to-tab-by-id', String(pane.tab_id)], ['--session', s, 'action', 'focus-pane-id', id]]);
  assert.match(await goToAgent(f.store, 'worker', 'switch', 'human', runner), /Switched this window to/);
  assert.deepEqual(jumps.splice(0), [['action', 'switch-session', s, '--tab-position', '1', '--pane-id', id]]);
  await goToAgent(f.store, 'worker', 'switch', s, runner);
  assert.deepEqual(jumps.splice(0), [['action', 'go-to-tab-by-id', String(pane.tab_id)], ['action', 'focus-pane-id', id]]);
  f.store.transact((st) => { st.agents.worker.lifecycle = 'closed'; });
  await assert.rejects(goToAgent(f.store, 'worker', 'window', 'human', runner), /worker is closed; it has no live tab/);
});

test('goToCoordinator switches back to the pane the live coordinator recorded, and refuses a stale one', async () => {
  const f = await fixture({ handshake: true });
  await f.spawn();
  const human = [{ id: 42, is_plugin: false, tab_id: 3, tab_name: 'orchestrator', tab_position: 2, title: 'π - coord', exited: false }];
  const jumps = [];
  const runner = async (command, args, opts) => {
    if (command === 'zellij' && args[0] === 'list-sessions') return output(`human [Created 1h ago]\n${(await f.runner(command, args, opts)).stdout}`);
    if (command === 'zellij' && args[1] === 'human') { assert.deepEqual(args.slice(2), ['action', 'list-panes', '--json', '--all']); return output(JSON.stringify(human)); }
    if (command === 'zellij' && ['go-to-tab-by-id', 'focus-pane-id', 'switch-session'].some((a) => args.includes(a))) { jumps.push(args); return output(''); }
    return f.runner(command, args, opts);
  };
  await assert.rejects(goToCoordinator(f.store, 'piorch-x', runner), /recorded no Zellij pane/);
  f.store.transact((s) => { s.agents.root = { ...s.agents.root, homeSession: 'human', homePaneId: 'terminal_42', pid: 777777, lifecycle: 'running' }; });
  await assert.rejects(goToCoordinator(f.store, 'piorch-x', runner), /coordinator process is not running/);
  f.controls.alive(true, 777777);
  assert.match(await goToCoordinator(f.store, 'piorch-x', runner), /Switched this window to human › orchestrator/);
  assert.deepEqual(jumps.splice(0), [['action', 'switch-session', 'human', '--tab-position', '2', '--pane-id', 'terminal_42']]);
  await goToCoordinator(f.store, 'human', runner);
  assert.deepEqual(jumps.splice(0), [['action', 'go-to-tab-by-id', '3'], ['action', 'focus-pane-id', 'terminal_42']]);
  human[0].exited = true;
  await assert.rejects(goToCoordinator(f.store, 'human', runner), /coordinator's pane is gone/);
});

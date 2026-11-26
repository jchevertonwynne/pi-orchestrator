import test from 'node:test';
import assert from 'node:assert/strict';
import { alerts, sessionClosure } from '../src/board.ts';
import { playAlertSound } from '../src/sounds.ts';

const state = () => ({ tasks: {}, agents: {}, releases: {} });

test('attention and completion alerts classify every requested event', () => {
  const s = state();
  s.tasks.human = { id: 'human', summary: { needsHuman: true, at: 1, text: 'Question' } };
  for (const status of ['blocked', 'failed', 'ready']) s.tasks[status] = { id: status, result: { status, id: status, report: '/synthetic' } };
  s.tasks.shipped = { id: 'shipped' };
  s.releases.shipped = { mergedCommit: 'abc', deployedCommit: 'def' };
  s.tasks.idle = { id: 'idle', state: 'implementing' };
  s.agents.owner = { id: 'owner', role: 'implementer', taskId: 'idle', lifecycle: 'running', activity: 'idle', activityAt: 1, generation: 'gen' };
  assert.deepEqual(alerts(s, 1_800_001).map(a => [a.key.split(':')[1], a.level]), [
    ['human', 'warning'], ['blocked', 'warning'], ['failed', 'warning'],
    ['merged', 'info'], ['deployed', 'info'], ['stalled', 'warning'],
  ]);
  assert.equal(sessionClosure(s), undefined);
  s.sharedSession = { name: 'synthetic' };
  assert.equal(sessionClosure(s), undefined);
  for (const task of Object.values(s.tasks)) task.state = 'skipped';
  assert.equal(sessionClosure(s), undefined, 'live worker prevents closure reminder');
  s.agents.owner.lifecycle = 'closed';
  assert.equal(alerts(s).at(-1).key, 'ui:session-done:synthetic');
  assert.equal(alerts(s).at(-1).level, 'info');
  const reminder = sessionClosure(s).text;
  assert.doesNotMatch(reminder, /checklist then opens|dismissed it/i);
  assert.match(reminder, /safe cleanup.*automatically/i);
  assert.match(reminder, /worker PID.*gone/i);
  assert.match(reminder, /volume.*confirmation/i);
  assert.match(reminder, /retained.*earlier/i);
  s.sharedSession.closedAt = 1;
  assert.equal(sessionClosure(s), undefined);
});

test('macOS playback uses literal Ping/Hero argv and a bounded timeout', async () => {
  const calls = [];
  const options = { platform: 'darwin', env: {}, runner: async (...args) => { calls.push(args); return { stdout: '', stderr: '' }; } };
  await playAlertSound('warning', options);
  await playAlertSound('info', options);
  assert.deepEqual(calls, [
    ['/usr/bin/afplay', ['/System/Library/Sounds/Ping.aiff'], { timeout: 5000 }],
    ['/usr/bin/afplay', ['/System/Library/Sounds/Hero.aiff'], { timeout: 5000 }],
  ]);
});

test('opt-out and unsupported platforms never invoke playback', async () => {
  let calls = 0;
  const runner = async () => { calls++; };
  await playAlertSound('warning', { platform: 'darwin', env: { PI_ORCHESTRATOR_SOUNDS: '0' }, runner });
  for (const platform of ['linux', 'win32']) await playAlertSound('info', { platform, env: {}, runner });
  assert.equal(calls, 0);
});

test('missing player, missing sound, failure and timeout fall back silently', async () => {
  for (const code of ['ENOENT', 1, 'ETIMEDOUT']) {
    let calls = 0;
    await assert.doesNotReject(playAlertSound('warning', { platform: 'darwin', env: {}, runner: async () => {
      calls++; throw Object.assign(new Error('Synthetic playback failure'), { code });
    } }));
    assert.equal(calls, 1);
  }
});

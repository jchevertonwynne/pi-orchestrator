import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.ts';
import { notices } from '../src/bridge.ts';
import { alerts } from '../src/board.ts';
import { LIMITS } from '../src/contracts.ts';
import { episodeKey, idleFacts, lastAssistantText, requestDiagnosis } from '../src/diagnosis.ts';

// Synthetic registry with one idle feature owner; no processes, network or Jev.
function fixture(t, idleMs = LIMITS.escalateMs + 1) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'orchestrator-diagnosis-test-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = openStore(join(dir, 'registry'));
  const state = structuredClone(store.read());
  store.close();
  const now = Date.now();
  state.profile = 'light';
  const agent = (id, role, extra = {}) => ({ id, role, model: 'synthetic/model', generation: `${id}-g1`, lifecycle: 'running',
    worktree: join(dir, id), sessionDir: join(dir, 'sessions', id), piSessionId: `${id}-session`, ...extra });
  state.agents.coord = agent('coord', 'coordinator');
  state.agents.owner = agent('owner', 'implementer', { parentId: 'coord', taskId: 'feature', activity: 'idle', activityAt: now - idleMs });
  state.tasks.feature = { id: 'feature', title: 'x'.repeat(500), state: 'implementing', planPath: join(dir, 'plan.md'), planHash: 'h', dependencies: [], history: [] };
  return { dir, state, now, owner: state.agents.owner };
}

test('idle nudges wait for a pending diagnosis, then carry it as advisory text', (t) => {
  const f = fixture(t);
  const idle = (diagnoses) => notices(f.state, f.state.agents.coord, f.now, diagnoses).filter((n) => n.key.startsWith('idle:'));
  assert.equal(idle().length, 1, 'without a diagnosis map nothing is held');
  assert.doesNotMatch(idle()[0].text, /Jev/);
  const diagnoses = new Map();
  assert.equal(idle(diagnoses).length, 0, 'held while pending');
  diagnoses.set(episodeKey(f.owner), null);
  assert.doesNotMatch(idle(diagnoses)[0].text, /Jev/, 'unavailable Jev leaves the text unchanged');
  diagnoses.set(episodeKey(f.owner), { label: 'waiting_on_human', probability: 0.91 });
  assert.match(idle(diagnoses)[0].text, /Jev: likely waiting on human \(p=0\.91\); advisory only\.$/);
  assert.equal(idle(diagnoses)[0].key, idle()[0].key, 'diagnosis never changes the dedupe key');
  const stalled = alerts(f.state, f.now, diagnoses).find((a) => a.key.startsWith('ui:stalled:owner:'));
  assert.match(stalled.text, /Jev: likely waiting on human/);
});

test('requestDiagnosis resolves undefined without a listener, on errors and on timeout', async () => {
  assert.equal(await requestDiagnosis(undefined, {}), undefined);
  const silent = { emit() {} };
  assert.equal(await requestDiagnosis(silent, {}), undefined, 'unaccepted requests finish immediately');
  const failing = { emit(_channel, request) { request.accepted = true; request.reply(new Error('HTTP 401')); } };
  assert.equal(await requestDiagnosis(failing, {}), undefined);
  const hanging = { emit(_channel, request) { request.accepted = true; } };
  assert.equal(await requestDiagnosis(hanging, {}, 10), undefined);
  const unknown = { emit(_channel, request) { request.accepted = true; request.reply(null, { answers: { state: { type: 'choice', choice: 'other', confidence: 1 } } }); } };
  assert.equal(await requestDiagnosis(unknown, {}), undefined, 'labels outside the question are rejected');
});

test('requestDiagnosis sends the facts on jev:classify and parses the chosen label', async () => {
  let seen;
  const bus = { emit(channel, request) {
    seen = { channel, request };
    request.accepted = true;
    setTimeout(() => request.reply(null, { answers: { state: { type: 'choice', choice: 'done_unreported', probabilities: { done_unreported: 0.8 }, confidence: 0.7 } } }), 1);
  } };
  assert.deepEqual(await requestDiagnosis(bus, { idle_minutes: 12 }), { label: 'done_unreported', probability: 0.8 });
  assert.equal(seen.channel, 'jev:classify');
  assert.deepEqual(seen.request.state, { idle_minutes: 12 });
  assert.deepEqual(Object.keys(seen.request.questions.state.criteria), ['waiting_on_human', 'done_unreported', 'blocked_unrecorded', 'paused_midway']);
});

test('idle facts are bounded and include the last assistant message from the transcript tail', (t) => {
  const f = fixture(t);
  const file = join(f.dir, 'session.jsonl');
  writeFileSync(file, [
    JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'older' }] } }),
    JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Tests pass. Should I open the PR?' }, { type: 'toolCall', name: 'x' }] } }),
    JSON.stringify({ type: 'message', message: { role: 'toolResult', content: [{ type: 'text', text: 'ignored' }] } }),
    '{"truncated',
  ].join('\n'));
  assert.equal(lastAssistantText(file), 'Tests pass. Should I open the PR?');
  assert.equal(lastAssistantText(join(f.dir, 'missing.jsonl')), '');
  assert.equal(lastAssistantText(undefined), '');
  const facts = idleFacts(f.state, f.owner, f.state.tasks.feature, LIMITS.idleMs, lastAssistantText(file));
  assert.equal(facts.task_title.length, 200);
  assert.equal(facts.idle_minutes, LIMITS.idleMs / 60_000);
  assert.deepEqual(Object.keys(facts).sort(), ['has_pr', 'idle_minutes', 'last_message', 'latest_note', 'merged', 'recorded_result', 'role', 'task_state', 'task_title']);
});

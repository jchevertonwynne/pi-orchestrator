import test from 'node:test';
import assert from 'node:assert/strict';
import { approvalContent, approvalView, continuationContent, continuationView, inboxContent, inboxView, noticeContent, noticeView, parseInbox } from '../src/transcript-views.ts';

// Synthetic pi-tui: components record their text so the test can read the layout.
class Node { constructor(text) { this.text = text; this.children = []; } addChild(child) { this.children.push(child); } }
const tui = { Box: class extends Node {}, Text: class extends Node {}, Spacer: class extends Node { constructor() { super(''); } } };
const theme = { fg: (_c, t) => t, bg: (_c, t) => t, bold: (t) => t };
const lines = (box) => box.children.map((child) => child.text);

const messages = [
  { id: '95364201-e61a-4ed6-a78d-3287e5ece6df', from: 'pg-teardown-owner', body: 'Done.\n- e1d68cb: deleted stats\n"quoted"' },
  { id: 'abcdef01-0000-4000-8000-000000000000', from: 'reviewer', body: 'LGTM' },
];

test('inbox content round-trips and stays one JSON object per message for the model', () => {
  const content = inboxContent(messages);
  assert.equal(content.split('\n').length, 3);
  assert.deepEqual(parseInbox(content), messages);
});

test('inbox view shows sender, short id and the body with real line breaks', () => {
  const box = inboxView(inboxContent(messages), false, 1, theme, tui);
  assert.deepEqual(lines(box), [
    'Inbox · 2 messages from agents · not human approval',
    '', 'pg-teardown-owner · 95364201', 'Done.\n- e1d68cb: deleted stats\n"quoted"',
    '', 'reviewer · abcdef01', 'LGTM',
  ]);
  assert.equal(lines(inboxView(inboxContent(messages), true, 1, theme, tui))[2], 'pg-teardown-owner · 95364201-e61a-4ed6-a78d-3287e5ece6df');
});

test('inbox view strips terminal controls from untrusted fields', () => {
  const box = inboxView(inboxContent([{ id: 'x', from: 'a\u001b[2Jb', body: 'c\u0007d' }]), false, 1, theme, tui);
  assert.deepEqual(lines(box).slice(2), ['a\ufffd[2Jb · x', 'c\ufffdd']);
});

test('unrecognized content or missing pi-tui falls back to the default renderer', () => {
  assert.equal(inboxView('other text', false, 1, theme, tui), undefined);
  assert.equal(inboxView(inboxContent(messages) + '\nnot json', false, 1, theme, tui), undefined);
  assert.equal(inboxView(inboxContent(messages), false, 1, theme, undefined), undefined);
});

test('model-facing content is byte-for-byte what the bridge sent before the renderers', () => {
  assert.equal(noticeContent(['a: ready', 'b: stale']), 'Orchestration observations; inspect evidence before acting. No result implies verification or release approval.\n'
    + '- a: ready\n- b: stale\nFinish your turn when only waiting. Monitoring makes no model calls until new actionable observations.');
  assert.equal(approvalContent('Human approved t via board.'), 'Human approved t via board.\nContinue with the next orchestration step; read orchestrator_status before acting. This message grants no release authority.');
  assert.equal(continuationContent('g1'), 'Release continuation for grant g1. Read current registry scope and reconcile actual external state before acting. '
    + 'Run orchestrator_release check for each exact next task/action/target. This message grants no authority and must never replay release commands automatically.');
});

test('notice view lists observations with an icon per kind and drops model reminders', () => {
  const box = noticeView(noticeContent(['t: ready; commit abc', 'w: heartbeat is stale', 'x: odd']), ['result:t:1', 'stale:w:g', 'unknown:x'], 1, theme, tui);
  assert.deepEqual(lines(box), ['Orchestrator · 3 observations · inspect evidence before acting', '',
    '◆ t: ready; commit abc', '⚠ w: heartbeat is stale', '• x: odd']);
  assert.equal(noticeView('- not a batch', [], 1, theme, tui), undefined);
});

test('approval and continuation views keep the news and drop the boilerplate', () => {
  assert.deepEqual(lines(approvalView(approvalContent('Human approved t via board (plan SHA256 ab).'), 1, theme, tui)),
    ['Approved · coordinator continuing', '✓ Human approved t via board (plan SHA256 ab).']);
  assert.equal(approvalView('Human approved t.', 1, theme, tui), undefined);
  assert.deepEqual(lines(continuationView(continuationContent('g1'), 'g1', 1, theme, tui)),
    ['Release · coordinator continuing', 'Grant g1 recorded; the coordinator rechecks external state before each action.']);
  assert.equal(continuationView(continuationContent('g1'), 'g2', 1, theme, tui), undefined);
});

test('status card collapses the shipped list until expanded and has a plain-text twin for the model', async () => {
  const { statusText, statusView } = await import('../src/transcript-views.ts');
  const card = { at: 0, line: '⚙ light 1/2 shipped', sections: [
    { title: 'Needs you', tone: 'warning', lines: ['ask: Public?'] },
    { title: 'Shipped', tone: 'dim', lines: ['live · deployed · #255'] },
  ] };
  const collapsed = lines(statusView(card, false, theme, tui));
  assert.match(collapsed[0], /^Status · ⚙ light 1\/2 shipped/);
  assert.deepEqual(collapsed.slice(1), ['', 'Needs you · 1', 'ask: Public?', '', 'Shipped · 1 · expand to list']);
  assert.ok(lines(statusView(card, true, theme, tui)).includes('live · deployed · #255'));
  assert.equal(statusText(card), 'Orchestrator status — ⚙ light 1/2 shipped\nNeeds you:\n  ask: Public?\nShipped:\n  live · deployed · #255');
  assert.equal(statusView({ nope: true }, false, theme, tui), undefined);
});

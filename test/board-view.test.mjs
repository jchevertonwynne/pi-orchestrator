import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { boardView, textView, available, clean, pendingApprovals, retainedApprovals, taskDetails } from '../src/board-view.ts';
import { alerts, approvalTag, board, needsPlanApproval, statusDigest } from '../src/board.ts';
import { notices } from '../src/bridge.ts';

const keys = { 'tui.select.up': 'up', 'tui.select.down': 'down', 'tui.select.pageUp': 'pageUp', 'tui.select.pageDown': 'pageDown', 'tui.select.cancel': 'escape', 'tui.select.confirm': 'enter' };
const kb = { matches: (data, key) => data === keys[key] };
const theme = { fg: (_color, line) => line };
const wrap = (text, width) => text.split('\n').flatMap((line) => { const out = []; for (let i = 0; i < Math.max(1, line.length); i += width) out.push(line.slice(i, i + width)); return out; });
const task = (id, state, extra = {}) => ({ id, title: `Title ${id}`, state, planPath: `/synthetic/${id}.md`, planHash: 'x', dependencies: [], history: [], ...extra });
function registry(tasks, profile = 'strict', agents = {}) {
  return { version: 1, revision: 1, createdAt: 0, profile, tasks: Object.fromEntries(tasks.map((t) => [t.id, t])), agents, messages: [], resources: [], releases: {}, notifications: {} };
}

test('skipped blocker is historical; current blocker and decision still request attention', () => {
  const result = { id: 'r', status: 'blocked', report: '/report' };
  const summary = { text: 'Choose an owner', at: 1, needsHuman: true };
  const old = task('old', 'skipped', { result, summary, history: [{ state: 'skipped', note: 'Skipped by root: Superseded\nby\x1bcurrent' }] });
  const state = registry([old, task('current', 'blocked', { result, summary })]);
  const [, current, historical] = board(state);
  assert.match(current, /^⚠ current .*blocked .*Choose an owner/);
  assert.match(historical, /^– old .*skipped .*Historical: Superseded by current/);
  assert.match(taskDetails(state, old), /Previous note: Choose an owner\nPrevious result: blocked/);
  assert.deepEqual(alerts(state).map(a => a.key), ['ui:human:current:1', 'ui:blocked:current:r']);
  assert.ok(!statusDigest(state).flatMap(s => s.lines).some(line => line.startsWith('old')));
  const wakes = notices(state, { id: 'root', role: 'coordinator' }, 10);
  assert.match(wakes.find(w => w.key === 'result:old:r').text, /historical result/);
  assert.match(wakes.find(w => w.key === 'human:old:1').text, /no current question/);
});

test('interactive board uses spare width for names, activity and notes and responds to resizing', () => {
  const id = 'walkthrough-change-indicator-review';
  const owner = 'walkthrough-indicator-reviewer';
  const note = 'Verified the exact candidate with all suites green; remaining smoke checks cover resize behavior. '.repeat(4);
  const state = registry([task(id, 'implementing', { summary: { text: note } })], 'strict', {
    w: { id: owner, taskId: id, lifecycle: 'running', activity: 'busy' },
  });
  const metrics = {
    visibleWidth: text => text.length,
    truncateToWidth: (text, width) => text.length > width ? text.slice(0, Math.max(0, width - 1)) + '…' : text,
  };
  const tui = { terminal: { columns: 240, rows: 24 }, requestRender() {} };
  const view = boardView(() => state, tui, theme, kb, () => {}, wrap, undefined, false, metrics);
  const row = width => view.render(width).find(line => line.startsWith('›'));
  assert.ok(row(240).includes(id), 'wide board shows full task name');
  assert.ok(row(240).includes(`${owner} busy`), 'wide board shows full owner and activity');
  assert.equal(row(240).length, 240, 'long notes use all remaining width');
  assert.ok(row(240).includes(note.slice(0, 90)), 'notes exceed the compact 42-character limit');
  assert.ok(row(80).length <= 80);
  assert.equal(row(240).length, 240, 'growing again restores the available width');
  assert.ok(!board(state).join('\n').includes(id), 'compact tool output retains its task-name cap');
});

test('responsive board measures native terminal columns and aligns Unicode rows', { skip: !process.env.PI_HOST_PACKAGE }, async () => {
  const host = process.env.PI_HOST_PACKAGE;
  const metrics = await import(pathToFileURL(join(host, '../pi-tui/dist/index.js')).href);
  const { wrapTextWithAnsi, visibleWidth } = metrics;
  const first = 'a-long-task-name-with-a-distinct-suffix';
  const second = 'b-short';
  const state = registry([
    task(first, 'implementing', { summary: { text: 'NOTE ' + '界🙂e\u0301'.repeat(100) } }),
    task(second, 'implementing', { summary: { text: 'NOTE short\n\x1b[2J' } }),
  ], 'strict', { w: { id: 'worker-界🙂', taskId: first, lifecycle: 'running', activity: 'busy' } });
  const tui = { terminal: { columns: 240, rows: 30 }, requestRender() {} };
  const view = boardView(() => state, tui, theme, kb, () => {}, wrapTextWithAnsi, undefined, false, metrics);
  for (const width of [240, 121, 80, 300]) {
    const lines = view.render(width);
    assert.ok(lines.every(line => visibleWidth(line) <= width), `${width} columns`);
    assert.ok(!lines.join('\n').includes('\x1b[2J'));
    if (width >= 240) {
      const rows = lines.slice(1, 3);
      assert.ok(rows[0].includes(first));
      assert.equal(visibleWidth(rows[0].split('NOTE')[0]), visibleWidth(rows[1].split('NOTE')[0]), 'notes align');
      assert.ok(visibleWidth(rows[0]) >= width - 1, 'wide notes fill the viewport to within one wide character');
    }
  }
});

test('local-install task details show the exact revision and destination without a PR', () => {
  const state = registry([task('local', 'deployed')]);
  state.releases.local = { route: 'local-install', stage: 'installed', commit: 'a'.repeat(40), installedCommit: 'a'.repeat(40), installationTarget: '/synthetic/pi-installed' };
  const details = taskDetails(state, state.tasks.local);
  assert.ok(details.includes(`Local install: ${'a'.repeat(40)} -> "/synthetic/pi-installed"`));
  assert.match(details, /Release: installed/); assert.doesNotMatch(details, /PR:/);
});

test('board selection follows the task id across reorders and enter opens details', () => {
  let state = registry([task('alpha', 'planned'), task('beta', 'implementing')]);
  const results = [], tui = { terminal: { columns: 100, rows: 20 }, requestRender() {} };
  const view = boardView(() => state, tui, theme, kb, (c) => results.push(c), wrap);
  // implementing sorts before planned.
  assert.match(view.render(100).find((l) => l.startsWith('›')), /beta/);
  view.handleInput('down');
  assert.match(view.render(100).find((l) => l.startsWith('›')), /alpha/);
  state = registry([task('alpha', 'planned', { summary: { text: 'decide', needsHuman: true, at: 1 } }), task('beta', 'implementing')]);
  assert.match(view.render(100).find((l) => l.startsWith('›')), /alpha/, 'selection survives alpha moving to the top');
  view.handleInput('enter');
  assert.deepEqual(results, [{ action: 'details', taskId: 'alpha' }]);
  view.handleInput('a'); assert.equal(results.length, 1, 'a closed view ignores input');
});

test('board offers only actions valid for the selected task', () => {
  const owner = { id: 'w', role: 'implementer', taskId: 'a', lifecycle: 'running', generation: 'g', model: 'm', worktree: '/w', sessionDir: '/s', piSessionId: 'p' };
  const strict = registry([task('a', 'planned')], 'strict', { w: owner });
  assert.deepEqual([...available(strict, strict.tasks.a)].sort(), ['approve', 'approve-all', 'details', 'inspect', 'message', 'plan', 'resume']);
  const light = registry([task('a', 'implementing', { approval: { hash: 'x', source: 'human', at: 1 } })], 'light', { w: { ...owner, lifecycle: 'closed' } });
  assert.deepEqual([...available(light, light.tasks.a)].sort(), ['details', 'inspect', 'plan']);
  delete light.tasks.a.approval;
  assert.deepEqual([...available(light, light.tasks.a)].sort(), ['approve', 'details', 'inspect', 'plan'], 'unapproved light shipping work may be approved late');
  const placed = registry([task('a', 'implementing')], 'light', { w: { ...owner, zellijSession: 'piorch-x' } });
  assert.ok(['go', 'switch'].every((a) => available(placed, placed.tasks.a).has(a)), 'a live owner with a session can be jumped to');
  assert.deepEqual([...available(strict, strict.tasks.a, true)].sort(), ['details', 'plan'], 'read-only boards drop coordinator actions');
  const home = { id: 'c', role: 'coordinator', lifecycle: 'running', generation: 'g', model: 'm', worktree: '/c', sessionDir: '/s', piSessionId: 'c', homeSession: 'human', homePaneId: 'terminal_1' };
  const withHome = registry([task('a', 'planned')], 'strict', { w: { ...owner, zellijSession: 'piorch-x' }, c: home });
  assert.deepEqual([...available(withHome, withHome.tasks.a, true)].sort(), ['coordinator', 'details', 'go', 'plan', 'switch']);
  assert.ok(!available(withHome, withHome.tasks.a).has('coordinator'), 'the coordinator board has no key to itself');
});

test('recorded PR navigation is offered without a live owner, including read-only boards', () => {
  const tui = { terminal: { columns: 120, rows: 30 }, requestRender() {} };
  for (const lifecycle of [undefined, 'running', 'closed']) {
    const state = registry([task('pr', 'merged')], 'light', lifecycle ? { w: { id: 'w', taskId: 'pr', lifecycle } } : {});
    for (const readOnly of [false, true]) {
      const missing = boardView(() => state, tui, theme, kb, () => assert.fail('no PR'), wrap, 'pr', readOnly);
      assert.ok(!available(state, state.tasks.pr, readOnly).has('open-pr'));
      assert.doesNotMatch(missing.render(120).join('\n'), /o open PR/);
      missing.handleInput('o');
      state.releases.pr = { stage: 'merged', pr: 'https://github.com/example/repo/pull/42' };
      const choices = [];
      const view = boardView(() => state, tui, theme, kb, c => choices.push(c), wrap, 'pr', readOnly);
      assert.ok(available(state, state.tasks.pr, readOnly).has('open-pr'));
      assert.match(view.render(120).join('\n'), /o open PR/);
      view.handleInput('o'); view.handleInput('o');
      assert.deepEqual(choices, [{ action: 'open-pr', taskId: 'pr' }]);
      delete state.releases.pr;
    }
  }
});

test('unsafe and non-PR links never enable board navigation', () => {
  const state = registry([task('pr', 'merged')]);
  const tui = { terminal: { columns: 120, rows: 30 }, requestRender() {} };
  for (const pr of ['', 'not a URL', 'http://github.com/o/r/pull/1', 'javascript:alert(1)', 'file:///tmp/pr',
    'https://github.com/o/r/issues/1', 'https://user:pass@github.com/o/r/pull/1', 'https://github.com/o/r/pull/1\n',
    'https://github.com/o/r/pull/1\x1b', 'https://github.com/o/r/pull/1\u0085', 'https://github.com/o/r/pull/1%0a',
    'https:\\\\github.com/o/r/pull/1', 'https://github.com/o/r/pull/0']) {
    state.releases.pr = { stage: 'pr', pr };
    const view = boardView(() => state, tui, theme, kb, () => assert.fail(pr), wrap);
    assert.ok(!available(state, state.tasks.pr).has('open-pr'), JSON.stringify(pr));
    assert.doesNotMatch(view.render(120).join('\n'), /o open PR/);
    view.handleInput('o');
  }
});

test('all planned tasks offer individual and bulk approval, including optional light approvals', () => {
  for (const profile of ['light', 'strict']) {
    const state = registry([
      task('local-install-prep', 'planned'), task('risky', 'planned', { risky: true }),
      ...['approved', 'implementing', 'blocked', 'ready', 'verified', 'merged', 'deployed', 'skipped'].map((s) => task(s, s)),
    ], profile);
    assert.deepEqual(pendingApprovals(state).map((t) => t.id), ['local-install-prep', 'risky']);
    for (const t of Object.values(state.tasks)) {
      const late = profile === 'light' && !['merged', 'deployed', 'skipped'].includes(t.state);
      assert.equal(available(state, t).has('approve'), late || ['planned', 'verified'].includes(t.state), `${t.id} individual approval`);
      assert.ok(available(state, t).has('approve-all'));
      assert.ok(!available(state, t, true).has('approve'));
      assert.ok(!available(state, t, true).has('approve-all'));
    }
    for (const key of ['a', 'A']) {
      const results = [], tui = { terminal: { columns: 120, rows: 30 }, requestRender() {} };
      const view = boardView(() => state, tui, theme, kb, (c) => results.push(c), wrap, 'local-install-prep');
      assert.match(view.render(120).join('\n'), /a approve · A approve all/);
      view.handleInput(key);
      assert.deepEqual(results, [{ action: key === 'a' ? 'approve' : 'approve-all', taskId: 'local-install-prep' }]);
      const readOnly = boardView(() => state, tui, theme, kb, () => assert.fail('worker approval'), wrap, 'local-install-prep', true);
      assert.doesNotMatch(readOnly.render(120).join('\n'), /a approve|A approve all/);
      readOnly.handleInput(key);
    }
  }
  const state = registry([task('done', 'approved')], 'light');
  assert.equal(pendingApprovals(state).length, 0);
  assert.ok(!available(state, state.tasks.done).has('approve-all'));
});

test('verified tasks without current recorded plan approval offer individual approval only', () => {
  const result = { id: 'r', status: 'ready', commit: 'a'.repeat(40), report: '/synthetic/report.md', evidence: [], by: 'w', at: 1 };
  const verification = { commit: 'a'.repeat(40), planHash: 'x', evidence: ['/synthetic/proof'], at: 2 };
  const verified = (id, extra = {}) => task(id, 'verified', { result, verification, ...extra });
  for (const profile of ['light', 'strict']) {
    const state = registry([
      verified('missing'), verified('stale', { approval: { hash: 'old', source: 'earlier', at: 1 } }),
      verified('current', { approval: { hash: 'x', source: 'human', at: 1 } }),
      verified('frozen'), verified('bundled'), verified('delivered'), verified('host'),
      verified('review', { ships: false }), verified('stale-review', { ships: false, approval: { hash: 'old', source: 'earlier', at: 1 } }),
      ...['merged', 'deployed', 'skipped'].map((s) => task(s, s, { result, verification })),
    ], profile);
    state.releases.frozen = { stage: 'pr', pr: 'https://example.invalid/pr/1' };
    state.releases.host = { route: 'local-install', stage: 'claimed', commit: 'b'.repeat(40), installationTarget: '/synthetic/pi',
      included: [{ taskId: 'bundled', resultId: 'r', commit: 'a'.repeat(40) }] };
    state.releases.other = { route: 'local-install', stage: 'installed', commit: 'c'.repeat(40), installedCommit: 'c'.repeat(40), installationTarget: '/synthetic/pi',
      included: [{ taskId: 'delivered', resultId: 'r', commit: 'a'.repeat(40) }] };
    const offered = Object.values(state.tasks).filter((t) => available(state, t).has('approve')).map((t) => t.id).sort();
    assert.deepEqual(offered, ['missing', 'stale'], profile);
    for (const t of Object.values(state.tasks)) assert.ok(!available(state, t, true).has('approve'), `${t.id} read-only`);
    assert.deepEqual(pendingApprovals(state), [], 'planned approvals cover planned tasks only');
    // Light verified results bound to the registered bytes are kept by late approval, so bulk approval may list them; gated ones never.
    assert.deepEqual(retainedApprovals(state).map((t) => t.id).sort(), profile === 'light' ? ['missing', 'stale'] : [], profile);
    assert.equal(available(state, state.tasks.missing).has('approve-all'), profile === 'light');
    const details = taskDetails(state, state.tasks.missing);
    assert.match(details, /No plan approval \(needed for local install, bundle or WIP\)/);
    if (profile === 'light') {
      assert.match(details, /approving keeps verified result r commit a{40} while the plan bytes are unchanged: retrospective plan approval, not a review or re-verification of the result, and not permission to install/);
      assert.doesNotMatch(details, /clears/);
    } else {
      assert.match(details, /clears this result and verification/);
      assert.match(details, /not permission to install/);
    }
    assert.doesNotMatch(taskDetails(state, state.tasks.current), /No plan approval/);
    assert.doesNotMatch(taskDetails(state, state.tasks.frozen), /No plan approval/);
    for (const id of ['review', 'stale-review']) assert.doesNotMatch(taskDetails(state, state.tasks[id]), /No plan approval/, `${id} is non-shipping`);
    const results = [], tui = { terminal: { columns: 120, rows: 30 }, requestRender() {} };
    const view = boardView(() => state, tui, theme, kb, (c) => results.push(c), wrap, 'current');
    assert.doesNotMatch(view.render(120).join('\n'), /a approve/);
    view.handleInput('a'); assert.deepEqual(results, [], 'current approval ignores a');
    const missing = boardView(() => state, tui, theme, kb, (c) => results.push(c), wrap, 'missing');
    assert.match(missing.render(120).join('\n'), /a approve/);
    missing.handleInput('a'); assert.deepEqual(results, [{ action: 'approve', taskId: 'missing' }]);
    const readOnly = boardView(() => state, tui, theme, kb, () => assert.fail('worker approval'), wrap, 'missing', true);
    assert.doesNotMatch(readOnly.render(120).join('\n'), /a approve/);
    readOnly.handleInput('a');
  }
});

test('board fits the terminal and strips terminal controls from agent text', () => {
  const tasks = Array.from({ length: 40 }, (_, i) => task(`t${String(i).padStart(2, '0')}`, 'planned', i === 0 ? { summary: { text: 'evil\x1b[2J\x07', at: 1 } } : {}));
  const tui = { terminal: { columns: 60, rows: 15 }, requestRender() {} };
  const lines = boardView(() => registry(tasks), tui, theme, kb, () => {}, wrap).render(60);
  assert.ok(lines.length <= 15, `rendered ${lines.length} rows`);
  assert.ok(lines.every((l) => l.length <= 60));
  assert.ok(!lines.join('\n').includes('\x1b'));
  assert.equal(clean('a\tb\x1bc\n'), 'a  b\ufffdc\n');
});

test('text view pages within the terminal and closes on escape', () => {
  const done = [], tui = { terminal: { columns: 40, rows: 6 }, requestRender() {} };
  const view = textView('Plan', Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n'), tui, theme, kb, () => done.push(true), wrap);
  assert.deepEqual(view.render(40).slice(1, 3), ['line 0', 'line 1']);
  view.handleInput('pageDown');
  assert.equal(view.render(40)[1], 'line 4');
  for (let i = 0; i < 50; i++) view.handleInput('down');
  assert.equal(view.render(40)[4], 'line 19', 'scroll stops at the last line');
  view.handleInput('escape'); assert.deepEqual(done, [true]);
});

test('plan actions and navigation hints fit narrow viewports and survive paging, resize and cancellation', () => {
  const tui = { terminal: { columns: 24, rows: 8 }, requestRender() {} }, done = [], position = { top: 0 };
  const body = Array.from({ length: 30 }, (_, i) => `scope ${i}`).join('\n');
  const view = textView('Plan task\x1b[2J', body, tui, theme, kb, action => done.push(action), wrap, { approve: true, position });
  let lines = view.render(24);
  assert.equal(lines.length, 8); assert.ok(lines.every(line => line.length <= 24));
  assert.ok(!lines.join('\n').includes('\x1b'));
  assert.match(lines.join(''), /a approve/); assert.match(lines.join(''), /esc back/);
  view.handleInput('pageDown'); lines = view.render(24);
  assert.notEqual(lines[1], 'scope 0');
  const paged = lines[1];
  tui.terminal.columns = 40; tui.terminal.rows = 10; view.invalidate();
  lines = view.render(40);
  assert.equal(lines.length, 10); assert.ok(lines.every(line => line.length <= 40));
  assert.equal(lines[1], paged, 'resize keeps the review position where possible');
  view.handleInput('a'); assert.deepEqual(done, ['approve']);
  view.handleInput('a'); assert.equal(done.length, 1);
  const resumed = textView('Plan task', body, tui, theme, kb, () => {}, wrap, { approve: true, position });
  assert.equal(resumed.render(40)[1], paged);
});

test('eligible plan viewers select critique once without acquiring approval authority', () => {
  const tui = { terminal: { columns: 60, rows: 10 }, requestRender() {} }, done = [];
  const view = textView('Plan task', 'scope', tui, theme, kb, action => done.push(action), wrap,
    { approve: true, critique: true, position: { top: 0 } });
  assert.match(view.render(60).join('\n'), /a approve · c critique in Crit/);
  view.handleInput('c'); view.handleInput('c');
  assert.deepEqual(done, ['critique']);
});

test('undersized plan viewports stay within bounds and disable approval while preserving escape', () => {
  for (const [columns, rows] of [[11, 8], [40, 3], [1, 1], [2, 2]]) {
    const tui = { terminal: { columns: 60, rows: 24 }, requestRender() {} }, done = [];
    const view = textView('Plan task', 'complete body', tui, theme, kb, action => done.push(action), wrap, { approve: true, critique: true, position: { top: 0 } });
    view.render(60);
    tui.terminal.columns = columns; tui.terminal.rows = rows;
    view.handleInput('c'); view.handleInput('a'); assert.deepEqual(done, [], 'resize disables actions even before repaint');
    const lines = view.render(columns);
    assert.equal(lines.length, rows); assert.ok(lines.every(line => line.length <= columns));
    assert.doesNotMatch(lines.join('\n'), /a approve/);
    view.handleInput('escape'); assert.deepEqual(done, [undefined]);
  }
});

test('critique hint never displaces the back route on small terminals', () => {
  for (const [columns, rows] of [[12, 4], [24, 4], [24, 8], [60, 10]]) {
    const tui = { terminal: { columns, rows }, requestRender() {} }, done = [];
    const view = textView('Plan task', 'scope', tui, theme, kb, action => done.push(action), wrap,
      { approve: true, critique: true, position: { top: 0 } });
    const lines = view.render(columns);
    assert.equal(lines.length, rows); assert.ok(lines.every(line => line.length <= columns));
    assert.match(lines.join(''), /esc back/);
    view.handleInput('escape'); assert.deepEqual(done, [undefined]);
  }
});

test('generic text views never select approval, including task details and inspected screens', () => {
  const tui = { terminal: { columns: 60, rows: 8 }, requestRender() {} }, done = [];
  for (const title of ['Task task', 'worker screen', 'Plan read-only']) {
    const view = textView(title, 'read only', tui, theme, kb, action => done.push(action), wrap);
    assert.doesNotMatch(view.render(60).join('\n'), /a approve|c critique/);
    view.handleInput('c'); view.handleInput('a'); assert.deepEqual(done, []);
    view.handleInput('pageDown'); view.render(60);
    view.dispose();
  }
});

test('board and text views fill the terminal so the transcript never shows through', () => {
  const tui = { terminal: { columns: 60, rows: 30 }, requestRender() {} };
  for (const state of [registry([task('a', 'planned')]), registry([])]) {
    const lines = boardView(() => state, tui, theme, kb, () => {}, wrap).render(60);
    assert.equal(lines.length, 30);
    assert.match(lines.at(-1), /esc close/);
  }
  const lines = textView('Plan', 'short', tui, theme, kb, () => {}, wrap).render(60);
  assert.equal(lines.length, 30);
  assert.deepEqual([lines[1], lines.at(-2)], ['short', '']);
  assert.match(lines.at(-1), /esc back/);
});

test('status digest groups what needs the human, problems, work in flight, ready work and shipped work', async () => {
  const { statusDigest } = await import('../src/board.ts');
  const now = 100 * 60_000;
  const agent = (id, taskId, extra = {}) => ({ id, role: 'implementer', taskId, lifecycle: 'running', generation: 'g', model: 'm', worktree: '/w', sessionDir: '/s', piSessionId: 'p', heartbeatAt: now, ...extra });
  const state = registry([
    task('ask', 'implementing', { summary: { text: 'Public or private?', needsHuman: true, at: now - 5 * 60_000 } }),
    task('plan', 'planned', { risky: true }),
    task('build', 'implementing', { summary: { text: 'half the readers converted', at: now - 2 * 60_000 } }),
    task('stuck', 'implementing'),
    task('broke', 'blocked', { result: { id: 'r', status: 'blocked', report: '/r/broke.md', createdAt: now } }),
    task('done', 'ready', { result: { id: 'r', status: 'ready', report: '/r/done.md', commit: 'abcdef1234567', createdAt: now } }),
    task('live', 'deployed'),
    task('dropped', 'skipped'),
  ], 'light', {
    a1: agent('build-owner', 'build', { activity: 'working' }),
    a2: agent('stuck-owner', 'stuck', { activity: 'idle', activityAt: now - 15 * 60_000 }),
  });
  state.releases.live = { pr: 'https://github.com/o/r/pull/255' };
  const sections = Object.fromEntries(statusDigest(state, now).map((s) => [s.title, s.lines]));
  assert.deepEqual(Object.keys(sections), ['Needs you', 'Problems', 'In flight', 'Ready to ship', 'Shipped']);
  assert.deepEqual(sections['Needs you'], ['ask: Public or private? (5m ago)', 'plan: plan awaits approval → /o approve plan']);
  assert.deepEqual(sections.Problems, ['broke: blocked; report /r/broke.md', 'stuck: stuck-owner idle 15m with no blocker recorded']);
  assert.ok(sections['In flight'].includes('build · implementing · build-owner working · half the readers converted (2m ago)'));
  assert.deepEqual(sections['Ready to ship'], ['done · ready abcdef1']);
  assert.deepEqual(sections.Shipped, ['live · deployed · #255']);
  assert.equal(statusDigest(state, now).at(-1).note, '1 skipped');
  assert.deepEqual(statusDigest(registry([]), now), []);
});

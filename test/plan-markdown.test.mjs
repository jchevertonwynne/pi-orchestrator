import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { clean, textView } from '../src/board-view.ts';

const keys = { 'tui.select.up': 'up', 'tui.select.down': 'down', 'tui.select.pageUp': 'pageUp', 'tui.select.pageDown': 'pageDown', 'tui.select.cancel': 'escape', 'tui.select.confirm': 'enter' };
const kb = { matches: (data, key) => data === keys[key] };
const theme = { fg: (_color, line) => line };
const wrap = (text, width) => text.split('\n').flatMap(line => Array.from({ length: Math.max(1, Math.ceil(line.length / width)) }, (_, i) => line.slice(i * width, (i + 1) * width)));

// This double checks view state/cache behavior, not Markdown parsing or host styling.
test('plan formatting is cached, toggles raw source, retains mode on cancelled approval and invalidates on theme changes', () => {
  let renders = 0, invalidations = 0;
  const markdown = { render(width) { renders++; return wrap('formatted scope\n' + 'more scope\n'.repeat(40), width); }, invalidate() { invalidations++; } };
  const tui = { terminal: { columns: 80, rows: 10 }, requestRender() {} }, results = [], position = { top: 0 };
  const body = '**raw scope**\n' + 'more source\n'.repeat(40);
  const options = { approve: true, critique: true, position, markdown };
  const view = textView('Plan', body, tui, theme, kb, action => results.push(action), wrap, options);
  assert.equal(view.render(80)[1], 'formatted scope');
  view.render(80); assert.equal(renders, 1);
  view.handleInput('pageDown'); view.render(80); assert.equal(renders, 1);
  view.handleInput('m');
  assert.equal(view.render(80)[1], '**raw scope**', 'mode toggle resets scroll');
  assert.match(view.render(80).join(''), /m formatted/);
  assert.deepEqual(results, [], 'mode changes never approve or launch Crit');
  view.handleInput('pageDown'); const paged = view.render(80)[1];
  view.handleInput('a'); assert.deepEqual(results, ['approve']);
  assert.equal(position.raw, true);
  const reopened = textView('Plan', body, tui, theme, kb, () => {}, wrap, options);
  assert.equal(reopened.render(80)[1], paged, 'cancelled approval resumes mode and position');
  reopened.handleInput('m'); assert.equal(reopened.render(80)[1], 'formatted scope');
  reopened.invalidate(); reopened.render(80); assert.equal(invalidations, 1);
  assert.equal(renders, 3);
  reopened.render(60); assert.equal(renders, 4, 'width changes reflow Markdown');
});

test('read-only plans can toggle Markdown without acquiring approval or Crit actions', () => {
  const tui = { terminal: { columns: 80, rows: 10 }, requestRender() {} }, results = [];
  const view = textView('Plan', '**raw**', tui, theme, kb, action => results.push(action), wrap,
    { approve: false, critique: false, position: { top: 0 }, markdown: { render: () => ['formatted'], invalidate() {} } });
  assert.equal(view.render(80)[1], 'formatted');
  view.handleInput('m'); assert.equal(view.render(80)[1], '**raw**');
  view.handleInput('a'); view.handleInput('c'); assert.deepEqual(results, []);
  view.handleInput('escape'); assert.deepEqual(results, [undefined]);
});

test('installed native Markdown formats plans and fits resized viewports in both modes', { skip: !process.env.PI_HOST_PACKAGE }, async () => {
  const host = process.env.PI_HOST_PACKAGE;
  const ui = await import(pathToFileURL(join(host, 'dist/index.js')).href);
  const { Markdown, visibleWidth } = await import(pathToFileURL(join(host, '../pi-tui/dist/index.js')).href);
  ui.initTheme('dark');
  const body = '# Scope\n\nRead **bold** and `code` with [a link](https://example.com).\n\n- Parent\n  - Nested\n\n```ts\nconst queue = 42;\n```\n\n| Name | Value |\n| --- | --- |\n| Unicode | 界🙂 |\n\nBad \x1b[2J control.\n';
  const wrapNative = (text, width) => ui.truncateToVisualLines(text, Number.MAX_SAFE_INTEGER, width).visualLines;
  const tui = { terminal: { columns: 100, rows: 40 }, requestRender() {} }, results = [];
  const view = textView('Plan', body, tui, theme, kb, action => results.push(action), wrapNative,
    { approve: true, critique: true, position: { top: 0 }, markdown: new Markdown(clean(body), 0, 0, ui.getMarkdownTheme()) });
  const dark = view.render(100).join('\n');
  const plain = stripVTControlCharacters(dark);
  assert.match(plain, /Read bold and code/);
  assert.doesNotMatch(plain, /\*\*bold\*\*|`code`/);
  assert.match(plain, /Nested/); assert.match(plain, /const queue = 42/);
  assert.match(plain, /┌─+┬─+┐/);
  assert.match(plain, /a approve · c critique in Crit/);
  assert.ok(!dark.includes('\x1b[2J'), 'source terminal controls are not passed through');
  ui.initTheme('light'); view.invalidate();
  assert.notEqual(view.render(100).join('\n'), dark);
  ui.initTheme('dark'); view.invalidate();
  assert.equal(view.render(100).join('\n'), dark);
  view.handleInput('m'); assert.match(stripVTControlCharacters(view.render(100).join('\n')), /\*\*bold\*\*/);
  for (const raw of [true, false]) {
    if (!raw) view.handleInput('m');
    for (const [columns, rows] of [[60, 24], [24, 8], [12, 4], [2, 2], [1, 1], [100, 40]]) {
      tui.terminal.columns = columns; tui.terminal.rows = rows;
      const lines = view.render(columns);
      assert.equal(lines.length, rows);
      assert.ok(lines.every(line => visibleWidth(line) <= columns), `${columns} columns, raw=${raw}`);
      assert.ok(!lines.join('\n').includes('\x1b[2J'));
    }
  }
  assert.deepEqual(results, []);
});

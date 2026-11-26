import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULTS as LOOP_DEFAULTS, parseReviewLoopArgs as parse, registerReviewLoop, reviewLoopPrompt } from '../src/review-loop.ts';

const DEFAULTS = { ...LOOP_DEFAULTS, reviewer: 'provider/think', fixer: 'provider/routine' };
const agentDir = mkdtempSync(join(tmpdir(), 'pi-review-loop-test-'));
writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'provider', defaultModel: 'routine' }));
writeFileSync(join(agentDir, 'model-roles.json'), JSON.stringify({ judgement: DEFAULTS.reviewer }));
test.after(() => rmSync(agentDir, { recursive: true, force: true }));
const parseReviewLoopArgs = (args) => parse(args, agentDir);

test('defaults use the configured review and fix models with a major threshold and three rounds', () => {
  assert.deepEqual(parseReviewLoopArgs('#42'), { ...DEFAULTS, pr: '42' });
});

test('explicit models bypass missing or malformed defaults, and new invocations read edits', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-review-loop-overrides-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => parse('', dir), /reviewer.*model-roles\.json/);
  assert.throws(() => parse('--reviewer given/model', dir), /fixer.*settings\.json/);
  const roles = join(dir, 'model-roles.json');
  writeFileSync(roles, '{');
  assert.equal(parse('--reviewer given/model --fixer openrouter/~openai/latest', dir).fixer, 'openrouter/~openai/latest');
  writeFileSync(roles, JSON.stringify({ judgement: 'new/think' }));
  assert.equal(parse('--fixer given/model', dir).reviewer, 'new/think');
  writeFileSync(roles, JSON.stringify({ judgement: 'newer/think' }));
  assert.equal(parse('--fixer given/model', dir).reviewer, 'newer/think');
});

test('flags override defaults in either form', () => {
  assert.deepEqual(parseReviewLoopArgs('https://github.com/o/r/pull/7/ --threshold=Minor --rounds 5 --reviewer a/b --fixer c/d-1.2'),
    { pr: 'https://github.com/o/r/pull/7', threshold: 'minor', rounds: 5, reviewer: 'a/b', fixer: 'c/d-1.2' });
});

test('no PR means the local branch, with an optional base', () => {
  assert.deepEqual(parseReviewLoopArgs(''), { ...DEFAULTS });
  assert.deepEqual(parseReviewLoopArgs('--threshold minor --base origin/feat/a'), { ...DEFAULTS, threshold: 'minor', base: 'origin/feat/a' });
  assert.equal(reviewLoopPrompt(parseReviewLoopArgs(''), '/repo'),
    "/skill:review-loop local branch checked out in /repo; base origin's default branch; threshold major; at most 3 fix rounds; reviewer model provider/think; fixer model provider/routine.");
  assert.match(reviewLoopPrompt(parseReviewLoopArgs('--base=HEAD~3'), '/repo'), /in \/repo; base HEAD~3; /);
});

test('invalid input is rejected with usage', () => {
  for (const args of ['42 --base main', '--base', '--base -x', '--base "a b"', '42 --threshold severe', '42 --rounds 0', '42 --rounds 2.5', '42 --rounds',
    '42 --fixer sol', '42 43', 'main', '42 --force']) {
    assert.throws(() => parseReviewLoopArgs(args), /Usage|must|Unknown|Unexpected|needs/, args);
  }
});

test('the prompt invokes the skill with every parameter', () => {
  assert.equal(reviewLoopPrompt(parseReviewLoopArgs('12 --threshold blocker --rounds 2'), '/repo'),
    '/skill:review-loop PR 12; threshold blocker; at most 2 fix rounds; reviewer model provider/think; fixer model provider/routine.');
});

test('the command expands the skill only when idle and reports errors', async () => {
  const commands = {}; const sent = []; const notes = [];
  registerReviewLoop({ registerCommand: (name, command) => { commands[name] = command; }, sendUserMessage: (...args) => sent.push(args) }, agentDir);
  const ctx = (idle) => ({ cwd: '/repo', isIdle: () => idle, ui: { notify: (...args) => notes.push(args) } });
  await commands['review-loop'].handler('42', ctx(true));
  assert.deepEqual(sent, [[reviewLoopPrompt(parseReviewLoopArgs('42'), '/repo'), { expandPromptTemplates: true }]]);
  await commands['review-loop'].handler('42', ctx(false));
  await commands['review-loop'].handler('nope', ctx(true));
  assert.equal(sent.length, 1);
  assert.deepEqual(notes.map(([, level]) => level), ['error', 'error']);
  assert.deepEqual(commands['review-loop'].getArgumentCompletions('--t'), [{ value: '--threshold', label: '--threshold' }]);
  assert.deepEqual(commands['review-loop'].getArgumentCompletions('--b'), [{ value: '--base', label: '--base' }]);
});

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const names = ['orchestrate-work', 'release-work', 'recover-work', 'review-loop'];
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
assert(manifest.pi.skills.includes('./skills'), 'Package must expose ./skills');
const contract = await readFile(join(root, 'src/contracts.ts'), 'utf8');
assert(contract.includes('model?: string; thinking?: Thinking') && !contract.includes('export const MODEL'),
  'Launches expose optional model and thinking overrides');

const workerPath = join(root, 'skills/orchestrate-work/references/worker.md');
const worker = await readFile(workerPath);
assert(worker.byteLength <= 6 * 1024, 'Worker guide must stay within 6 KiB');
const evidence = await readFile(join(root, 'skills/orchestrate-work/references/evidence.md'));
assert(worker.byteLength + evidence.byteLength < 15 * 1024, 'Worker reading path must stay below 15 KiB');
const coordinatorGuide = await readFile(join(root, 'skills/orchestrate-work/SKILL.md'), 'utf8');
const workerRoute = coordinatorGuide.indexOf('(references/worker.md)');
assert(workerRoute >= 0 && workerRoute < coordinatorGuide.indexOf('(references/quickstart.md)'),
  'Route workers before coordinator prerequisites');
console.log(`PASS worker guide: ${worker.byteLength}/6144 bytes; required references ${worker.byteLength + evidence.byteLength}/15360 bytes`);

let caseCount = 0;
let assertionCount = 0;
for (const name of names) {
  const skillPath = join(root, 'skills', name, 'SKILL.md');
  const content = await readFile(skillPath, 'utf8');
  const match = content.match(/^---\n([\s\S]+?)\n---\n\n([\s\S]+)$/);
  assert(match, `${name}: frontmatter and body required`);
  const fields = new Map();
  for (const line of match[1].split('\n')) {
    const field = line.match(/^([a-z-]+): (.+)$/);
    assert(field, `${name}: expected simple portable frontmatter field`);
    assert(!fields.has(field[1]), `${name}: duplicate frontmatter field`);
    fields.set(field[1], field[2]);
  }
  assert.equal(fields.get('name'), name);
  assert(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) && name.length <= 64);
  const description = fields.get('description');
  assert(description && description.length <= 1024, `${name}: invalid description`);
  assert(!description.includes(': '), `${name}: quote YAML-sensitive description`);
  assert(content.split('\n').length < 500, `${name}: keep entry instructions concise`);

  const evalPath = join(root, 'skills', name, 'evals', 'evals.json');
  const suite = JSON.parse(await readFile(evalPath, 'utf8'));
  assert.equal(suite.skill_name, name);
  assert(Array.isArray(suite.evals) && suite.evals.length > 0);
  const ids = new Set();
  for (const entry of suite.evals) {
    assert(Number.isInteger(entry.id) && !ids.has(entry.id), `${name}: invalid/duplicate eval ID`);
    ids.add(entry.id);
    assert(typeof entry.prompt === 'string' && entry.prompt.trim());
    assert(typeof entry.expected_output === 'string' && entry.expected_output.trim());
    assert(Array.isArray(entry.files));
    assert(Array.isArray(entry.expectations) && entry.expectations.length > 0);
    for (const expectation of entry.expectations) {
      assert(typeof expectation === 'string' && expectation.trim());
      assertionCount++;
    }
    for (const file of entry.files) {
      const path = resolve(dirname(skillPath), file);
      assert(path.startsWith(root + sep), `${name}: fixture outside package`);
      assert((await stat(path)).isFile(), `${name}: missing fixture ${file}`);
    }
    caseCount++;
  }
  console.log(`PASS ${relative(root, skillPath)}: frontmatter, manifest discovery, ${suite.evals.length} evals`);
}

async function checkLinks(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await checkLinks(path);
    } else if (entry.name.endsWith('.md')) {
      const content = await readFile(path, 'utf8');
      for (const match of content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
        const target = match[1];
        if (/^(?:https?:|#)/.test(target)) continue;
        const resolved = resolve(dirname(path), target.split('#')[0]);
        assert(resolved.startsWith(root + sep), `Reference outside package: ${target}`);
        assert((await stat(resolved)).isFile(), `Missing reference: ${path} -> ${target}`);
      }
    }
  }
}
await checkLinks(join(root, 'skills'));
await checkLinks(join(root, 'evals'));
console.log('PASS local Markdown reference paths');
console.log(`PASS ${caseCount} synthetic cases, ${assertionCount} assertions (structure only; not executed)`);
console.log(`Contract SHA-256: ${createHash('sha256').update(contract).digest('hex')}`);
console.log('Static validation only; Pi startup and behavioral model evaluations NOT RUN.');

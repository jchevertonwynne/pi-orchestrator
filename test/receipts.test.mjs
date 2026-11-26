import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReceiptIndex } from '../src/receipts.ts';

const entry = id => JSON.stringify({ type: 'custom_message', customType: 'pi-orchestrator-inbox', id });
test('receipt index is incremental, bounded, and waits for complete lines', t => {
  const dir = mkdtempSync(join(tmpdir(), 'piorch-receipts-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'transcript'); const index = new ReceiptIndex();
  writeFileSync(path, entry('one')); index.scan(path); assert.equal(index.has({ id: 'one' }), false);
  appendFileSync(path, '\n'); index.scan(path); assert.equal(index.has({ id: 'one' }), true);
  appendFileSync(path, 'x'.repeat(5 * 1024 * 1024) + '\n' + entry('two') + '\n');
  index.scan(path); assert.equal(index.has({ id: 'two' }), false);
  index.scan(path); assert.equal(index.has({ id: 'two' }), true);
  writeFileSync(path, entry('new') + '\n'); index.scan(path);
  assert.equal(index.has({ id: 'one' }), false); assert.equal(index.has({ id: 'new' }), true);
  rmSync(path); index.scan(path); assert.equal(index.has({ id: 'new' }), false);
  writeFileSync(path, entry('replacement') + '\n'); index.scan(path); assert.equal(index.has({ id: 'replacement' }), true);
  const link = join(dir, 'link'); symlinkSync(path, link); assert.throws(() => index.scan(link));
  assert.equal(index.has({ id: 'replacement' }), false); assert.throws(() => index.scan(dir), /regular/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { planPageBatches } from '../server/batches.js';
const page = (n, count = 1) => ({ file: 'a.pdf', page: n, imagePaths: Array.from({ length: count }, (_, i) => `${n}-${i}.png`) });

test('all physical pages and their tiles occur exactly once across bounded batches', () => {
  const pages = [page(1, 5), ...Array.from({ length: 19 }, (_, i) => page(i + 2))];
  const batches = planPageBatches(pages);
  assert.deepEqual(batches.flatMap(b => b.pages), pages);
  assert.deepEqual(batches.flatMap(b => b.images), pages.flatMap(p => p.imagePaths));
  assert.ok(batches.every(b => b.images.length <= 12 && b.pages.length <= 8));
  assert.equal(batches[0].pages[0].imagePaths.length, 5);
});
test('failed-image pages are retained for text processing and explicit coverage reporting', () => {
  const pages = [page(1, 0), page(2)];
  assert.equal(planPageBatches(pages)[0].pages.length, 2);
});
test('oversized pages and duplicate page identities fail instead of silently dropping content', () => {
  assert.throws(() => planPageBatches([page(1, 13)]), /不能静默丢图/);
  assert.throws(() => planPageBatches([page(1), page(1)]), /重复/);
});

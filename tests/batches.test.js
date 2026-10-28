import test from 'node:test';
import assert from 'node:assert/strict';
import { planPageBatches } from '../server/batches.js';
import { mergeBatchResults } from '../server/pipeline.js';
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
test('batch merging accepts empty front matter and remaps duplicate local IDs without losing requirements', () => {
  const item = n => ({ id: 'REQ-1', category: '材料', requirement: `要求${n}`, sources: [{ file: 'a.pdf', page: n, quote: '要求' }], parameters: [] });
  const merged = mergeBatchResults([{ batch: { id: 'B01', pages: [page(1)] }, result: { requirements: [], warnings: [] } },
    { batch: { id: 'B02', pages: [page(2)] }, result: { requirements: [item(2)], warnings: [] } },
    { batch: { id: 'B03', pages: [page(3)] }, result: { requirements: [item(3)], warnings: [] } }]);
  assert.deepEqual(merged.requirements.map(r => r.id), ['REQ-001', 'REQ-002']);
  assert.equal(merged.origins.length, 2);
  assert.throws(() => mergeBatchResults([{ batch: { id: 'B01', pages: [page(1)] }, result: { requirements: [item(2)], warnings: [] } }]), /不属于负责页/);
});

test('identical cross-page facts merge once while changed scopes or parameters are preserved', () => {
  const shared = { id: 'REQ-1', category: '力学性能', requirement: '硬度应满足要求', scope: '状态A', parameters: [{ name: '硬度', value: '100', unit: 'HBW' }], sources: [{ file: 'a.pdf', page: 1, quote: '要求' }, { file: 'a.pdf', page: 2, quote: '要求' }] };
  const entries = [{ batch: { id: 'B01', pages: [page(1)] }, result: { requirements: [shared], warnings: [] } },
    { batch: { id: 'B02', pages: [page(2)] }, result: { requirements: [shared, { ...shared, id: 'REQ-2', scope: '状态B', parameters: [{ name: '硬度', value: '200', unit: 'HBW' }] }], warnings: [] } }];
  const merged = mergeBatchResults(entries);
  assert.equal(merged.requirements.length, 2);
  assert.equal(merged.origins.filter(o => o.exactDuplicate).length, 1);
  assert.deepEqual(merged.requirements.map(r => r.scope), ['状态A', '状态B']);
});

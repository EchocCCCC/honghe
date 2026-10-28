import test from 'node:test';
import assert from 'node:assert/strict';
import { applyReviewPatch, reviewDrawingResult } from '../server/review.js';

const requirement = (id, text = '原始要求') => ({ id, category: '尺寸与公差', requirement: text, scope: '图纸', parameters: [], sources: [{ file: 'drawing.pdf', page: 1, section: '技术要求', quote: '原始引文' }], review_required: false, review_note: '' });
const input = () => ({ summary: '原始摘要', requirements: [requirement('REQ-1'), requirement('REQ-2'), requirement('REQ-3')], warnings: ['原提示'], run: { model: 'local-test' }, extra: { retained: true } });

test('review applies only permitted replacements and preserves order, unrelated data, and input immutability', () => {
  const original = input();
  original.requirements[1].extraField = 'preserved';
  const patched = applyReviewPatch(original, { replacements: [requirement('REQ-3', '第三条修正'), requirement('REQ-2', '第二条修正')], warnings: ['原提示', '新提示'] }, ['REQ-2', 'REQ-3']);
  assert.deepEqual(patched.requirements.map(r => r.id), ['REQ-1', 'REQ-2', 'REQ-3']);
  assert.deepEqual(patched.requirements.map(r => r.requirement), ['原始要求', '第二条修正', '第三条修正']);
  assert.equal(patched.requirements[1].extraField, 'preserved');
  assert.deepEqual(patched.run, original.run);
  assert.deepEqual(patched.extra, { retained: true });
  assert.deepEqual(patched.warnings, ['原提示']);
  assert.equal(original.requirements[1].requirement, '原始要求');
});

test('review rejects unknown IDs even if accidentally present in the allowed set', () => {
  assert.throws(() => applyReviewPatch(input(), { replacements: [requirement('REQ-new')], warnings: [] }, ['REQ-new']), /非候选编号/);
});

test('review cannot change a real requirement outside the candidate set', () => {
  assert.throws(() => applyReviewPatch(input(), { replacements: [requirement('REQ-1')], warnings: [] }, ['REQ-2']), /非候选编号/);
});

test('review rejects duplicate patch IDs', () => {
  assert.throws(() => applyReviewPatch(input(), { replacements: [requirement('REQ-2'), requirement('REQ-2')], warnings: [] }, ['REQ-2']), /重复编号/);
});

test('review requires complete replacement records and does not repair partial patches', () => {
  const partial = requirement('REQ-2'); delete partial.parameters;
  assert.throws(() => applyReviewPatch(input(), { replacements: [partial], warnings: [] }, ['REQ-2']), /完整要求字段/);
  assert.throws(() => applyReviewPatch(input(), { replacements: [requirement('REQ-2')], additions: [], warnings: [] }, ['REQ-2']), /结构无效/);
});

test('empty review patches preserve the full result', () => {
  assert.deepEqual(applyReviewPatch(input(), { replacements: [], warnings: [] }, ['REQ-2']), input());
});

test('a subset review cannot introduce global missing-coverage claims', () => {
  const original = input();
  const patched = applyReviewPatch(original, { replacements: [], warnings: ['整个清单缺少未在本轮候选中提供的材料要求'] }, ['REQ-2']);
  assert.deepEqual(patched.warnings, original.warnings);
  assert.deepEqual(patched.requirements, original.requirements);
});

test('review skips without invoking Pi when there is no attached short-page drawing', async () => {
  const result = input();
  const reviewed = await reviewDrawingResult({ directory: 'unused', prepared: { documents: [{ name: 'specification.pdf', pages: 13, imagePages: [2, 5] }] }, result, model: 'not-a-real-model' });
  assert.equal(reviewed.review.status, 'skipped');
  assert.equal(reviewed.result, result);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { findUnrepresentedDrawingNumbers } from '../server/numeric-coverage.js';
const page = { file: 'drawing.pdf', page: 1, landscape: true, text: '边缘 -0.2 -0.3 +0.3 +0.2，重量5.85' };
const req = (requirement, parameters = [], quote = '') => ({ requirement, scope: '', parameters, sources: [{ file: 'drawing.pdf', page: 1, quote }] });

test('a broad source quote cannot conceal decimal values omitted from the extracted facts', () => {
  const findings = findUnrepresentedDrawingNumbers([page], { requirements: [req('上偏差0.2，下偏差-0.2，重量5.85', [], page.text)] });
  assert.deepEqual(findings[0].unmatchedDecimalAnnotations, ['-0.3', '+0.3']);
});
test('equivalent decimal notation and parameter values are represented, with signs preserved', () => {
  const result = { requirements: [req('偏差-0.20、-0.30、0.20，重量5.85', [{ name: '另一偏差', value: '0.300', unit: 'mm' }])] };
  assert.deepEqual(findUnrepresentedDrawingNumbers([page], result), []);
});
test('a number on another document/page cannot satisfy drawing coverage', () => {
  const other = req('-0.2 -0.3 +0.3 +0.2 5.85'); other.sources[0].page = 2;
  assert.equal(findUnrepresentedDrawingNumbers([page], { requirements: [other] })[0].unmatchedDecimalAnnotations.length, 5);
  assert.deepEqual(findUnrepresentedDrawingNumbers([{ ...page, landscape: false }], { requirements: [] }), []);
});

test('decimal fragments inside alphanumeric product codes are not treated as dimensions', () => {
  const source = { ...page, text: '产品450C01.02，边缘偏差-0.3' };
  const findings = findUnrepresentedDrawingNumbers([source], { requirements: [] });
  assert.deepEqual(findings[0].unmatchedDecimalAnnotations, ['-0.3']);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { verifyRequirement } from '../server/two-stage-schema.js';

test('the browser does not turn explanatory source notes into review flags', async () => {
  const source = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('  const informationNames = '), end = source.indexOf('  function informationSummary(', start);
  assert.ok(start >= 0 && end > start);
  const { needsReview } = vm.runInNewContext(`(() => {${source.slice(start, end)} return {needsReview};})()`);
  const clear = { informationType: 'quality', review_required: false, review_note: '尺寸来自清晰的整图及局部图视觉识读。', sources: [{ verification: 'visual_review' }] };
  assert.equal(needsReview(clear), false);
  assert.equal(needsReview({ ...clear, review_required: true, review_note: 'k6下偏差看不清' }), true);
  assert.equal(needsReview({ ...clear, classificationPending: true }), true);
  assert.equal(needsReview({ ...clear, informationType: 'unclassified' }), true);
});

const source = { file: 'scan.pdf', page: 1, quote: '膜厚 20~40 μm' };
const clear = () => ({ review_required: false, review_note: '', sources: [{ ...source }] });
const scanned = () => [{ name: 'scan.pdf', pages: 1, textPages: [''], imagePages: [1], needsVisualReview: [] }];

test('clear image-only evidence keeps its visual provenance without a review flag', () => {
  const item = clear(), before = structuredClone(item);
  const checked = verifyRequirement(item, scanned());
  assert.equal(checked.sources[0].verification, 'visual_review');
  assert.equal(checked.review_required, false);
  assert.equal(checked.review_note, '');
  assert.deepEqual(item, before);
  assert.deepEqual(verifyRequirement(checked, scanned()), checked);
});

test('an explicit model reading ambiguity remains flagged for image evidence', () => {
  const item = { ...clear(), review_required: true, review_note: '膜厚末位可能为0或8，待核对。' };
  const checked = verifyRequirement(item, scanned());
  assert.equal(checked.review_required, true);
  assert.equal(checked.review_note, item.review_note);
});

test('retired blanket image notices are removed without clearing an existing model flag', () => {
  const note = '图像证据待人工核对；已提交模型不等于语义正确。';
  const item = { ...clear(), review_required: true, review_note: `引线对应区域不清。 ${note} ${note}` };
  const once = verifyRequirement(item, scanned()), twice = verifyRequirement(once, scanned());
  assert.equal(twice.review_note, '引线对应区域不清。');
  assert.equal(twice.review_required, true);
  assert.deepEqual(twice, once);
  // The normal validator cannot establish why a historical boolean was true.
  const historical = verifyRequirement({ ...clear(), review_required: true, review_note: note }, scanned());
  assert.equal(historical.review_required, true);
  assert.equal(historical.review_note, '');
});

test('an unlocated quote without a submitted page image still requires review', () => {
  const docs = scanned(); docs[0].imagePages = [];
  const once = verifyRequirement(clear(), docs), twice = verifyRequirement(once, docs);
  assert.equal(once.sources[0].verification, 'unmatched_quote');
  assert.equal(once.review_required, true);
  assert.match(once.review_note, /引文未能在文字层定位且该页未提交图像/);
  assert.deepEqual(twice, once);
});

test('incomplete visual page coverage remains a concrete review reason', () => {
  const docs = scanned(); docs[0].needsVisualReview = [1];
  const checked = verifyRequirement(clear(), docs);
  assert.equal(checked.review_required, true);
  assert.match(checked.review_note, /视觉覆盖不完整/);
});

test('matching text evidence does not clear an explicit semantic uncertainty', () => {
  const docs = scanned(); docs[0].textPages = [source.quote];
  const checked = verifyRequirement({ ...clear(), review_required: true, review_note: '该膜厚适用的区域未确认。' }, docs);
  assert.equal(checked.sources[0].verification, 'text_match');
  assert.equal(checked.review_required, true);
  assert.equal(checked.review_note, '该膜厚适用的区域未确认。');
});

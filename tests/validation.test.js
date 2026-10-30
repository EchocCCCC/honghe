import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEvidence } from '../server/validation.js';
import { verifyRequirement, ruleSchema } from '../server/two-stage-schema.js';

const documents = () => [{ name: '采购条件.pdf', pages: 2, textPages: ['铸件应符合规定，硬度不低于 80 HBW。', '图纸标注：不允许钻穿。'], imagePages: [2], needsVisualReview: [] }];
const item = () => ({
  id: 'R001', informationType: 'quality', category: '力学性能', requirement: '硬度不低于80 HBW', scope: '通用',
  parameters: [{ name: '硬度下限', value: '80', unit: 'HBW' }],
  sources: [{ file: '采购条件.pdf', page: 1, section: '3.1', quote: '硬度不低于８０\nHBW。' }],
  review_required: false, review_note: '', strength: 'required', conditions: [], exceptions: [], overridePolicy: '', externalReferences: [],
});

test('current evidence verification normalizes layout whitespace and full-width digits', () => {
  assert.equal(normalizeEvidence('８０\n HBW\u200b'), '80HBW');
  const original = item(), checked = verifyRequirement(original, documents());
  assert.equal(checked.sources[0].verification, 'text_match');
  assert.equal(checked.review_required, false);
  assert.equal(original.sources[0].verification, undefined);
});

test('current evidence verification rejects unknown files and out-of-range physical pages', () => {
  for (const change of [{ file: '不存在.pdf' }, { page: 3 }]) {
    const raw = item(); Object.assign(raw.sources[0], change);
    assert.throws(() => verifyRequirement(raw, documents()), /不属于本次资料|页码越界/);
  }
});

test('visual provenance remains visible without a blanket flag while unsupported quotes require review', () => {
  for (const [page, expected, reviewRequired] of [[1, 'unmatched_quote', true], [2, 'visual_review', false]]) {
    const raw = item(); Object.assign(raw.sources[0], { page, quote: '原文中不存在的数值100℃' });
    const checked = verifyRequirement(raw, documents());
    assert.equal(checked.sources[0].verification, expected);
    assert.equal(checked.review_required, reviewRequired);
    if (reviewRequired) assert.match(checked.review_note, /引文未能在文字层定位且该页未提交图像/);
    else assert.equal(checked.review_note, '');
  }
});

test('a current text match preserves model-declared uncertainty and missing image notices', () => {
  const raw = item(); Object.assign(raw, { review_required: true, review_note: '需确认类别适用性' });
  assert.equal(verifyRequirement(raw, documents()).review_note, '需确认类别适用性');
  const docs = documents(); docs[0].needsVisualReview = [1]; docs[0].imagePages = [];
  const checked = verifyRequirement(item(), docs);
  assert.equal(checked.sources[0].verification, 'text_match');
  assert.equal(checked.review_required, true);
  assert.match(checked.review_note, /视觉覆盖/);
  assert.deepEqual(verifyRequirement(checked, docs), checked);
});

test('current rule contracts reject missing evidence and invalid physical page indices', () => {
  const noEvidence = item(); noEvidence.sources = [];
  assert.equal(ruleSchema.safeParse(noEvidence).success, false);
  for (const page of [0, -1, 1.5, '1']) {
    const raw = item(); raw.sources[0].page = page;
    assert.equal(ruleSchema.safeParse(raw).success, false);
  }
});

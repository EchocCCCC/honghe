import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEvidence, validateResult } from '../server/validation.js';

const prepared = () => ({
  documents: [{ id: 'doc-1', name: '采购条件.pdf', pages: 2, textPages: ['铸件应符合规定，硬度不低于 80 HBW。', '图纸标注：不允许钻穿。'], imagePages: [2] }],
  warnings: ['引用标准全文未提供'],
});
const input = () => ({ requirements: [{
  id: 'REQ-001', category: '力学性能', requirement: '硬度不低于80 HBW', scope: '通用',
  parameters: [{ name: '硬度下限', value: 80, unit: 'HBW' }],
  sources: [{ file: '采购条件.pdf', page: 1, quote: '硬度不低于８０\nHBW。' }],
}], warnings: ['引用标准全文未提供'] });

test('evidence normalizes layout whitespace and full-width digits', () => {
  assert.equal(normalizeEvidence('８０\n HBW\u200b'), '80HBW');
  const original = input(), checked = validateResult(original, prepared());
  assert.equal(checked.requirements[0].sources[0].verification, 'text_match');
  assert.equal(checked.requirements[0].review_required, false);
  assert.equal(checked.requirements[0].parameters[0].value, '80');
  assert.equal(checked.quality.textMatchedSources, 1);
  assert.equal(original.requirements[0].sources[0].verification, undefined);
  assert.deepEqual(checked.warnings, ['引用标准全文未提供']);
});

test('unknown files and out-of-range physical pages are flagged for review', () => {
  for (const change of [{ file: '不存在.pdf' }, { page: 3 }]) {
    const data = input(); Object.assign(data.requirements[0].sources[0], change);
    const checked = validateResult(data, prepared());
    assert.equal(checked.requirements[0].sources[0].verification, 'invalid_location');
    assert.equal(checked.requirements[0].review_required, true);
    assert.equal(checked.quality.textMatchedSources, 0);
  }
});

test('unmatched text evidence and visual evidence remain visibly unverified', () => {
  for (const [page, expected] of [[1, 'unmatched_quote'], [2, 'visual_review']]) {
    const data = input(); Object.assign(data.requirements[0].sources[0], { page, quote: '原文中不存在的数值100℃' });
    const checked = validateResult(data, prepared());
    assert.equal(checked.requirements[0].sources[0].verification, expected);
    assert.equal(checked.requirements[0].review_required, true);
    assert.equal(checked.quality.reviewRequired, 1);
  }
});

test('a text match does not erase model-declared uncertainty', () => {
  const data = input(); Object.assign(data.requirements[0], { review_required: true, review_note: '需确认类别适用性' });
  const checked = validateResult(data, prepared());
  assert.equal(checked.requirements[0].review_required, true);
  assert.equal(checked.requirements[0].review_note, '需确认类别适用性');
});

test('a text match on a drawing page still requires review when no image was supplied', () => {
  const files = prepared();
  files.documents[0].needsVisualReview = [1];
  files.documents[0].imagePages = [];
  const checked = validateResult(input(), files);
  assert.equal(checked.requirements[0].sources[0].verification, 'text_match');
  assert.equal(checked.requirements[0].review_required, true);
  assert.match(checked.requirements[0].review_note, /纯文本模式/);
  assert.equal(checked.quality.textMatchedSources, 1);
  assert.equal(checked.quality.reviewRequired, 1);
});

test('duplicate requirement IDs and missing evidence are rejected', () => {
  const duplicate = input(); duplicate.requirements.push(structuredClone(duplicate.requirements[0]));
  assert.throws(() => validateResult(duplicate, prepared()), /重复编号/);
  const noEvidence = input(); noEvidence.requirements[0].sources = [];
  assert.throws(() => validateResult(noEvidence, prepared()), /结果结构不符合要求/);
});

test('physical page indices must be positive integers and requirements cannot be empty', () => {
  for (const page of [0, -1, 1.5, '1']) {
    const data = input(); data.requirements[0].sources[0].page = page;
    assert.throws(() => validateResult(data, prepared()), /结果结构不符合要求/);
  }
  assert.throws(() => validateResult({ requirements: [] }, prepared()), /结果结构不符合要求/);
});

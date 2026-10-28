import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyRequirement } from '../server/two-stage-schema.js';

test('repeated evidence verification keeps a single notice and preserves the user note', () => {
  const note = '图像证据待人工核对；已提交模型不等于语义正确。';
  const item = { review_required: false, review_note: `原有疑点 ${note} ${note}`, sources: [{ file: 'scan.pdf', page: 1, quote: 'visible label' }] };
  const docs = [{ name: 'scan.pdf', pages: 1, textPages: [''], imagePages: [1] }];
  const once = verifyRequirement(item, docs), twice = verifyRequirement(once, docs);
  assert.equal(twice.review_note, `原有疑点 ${note}`);
  assert.deepEqual(twice, once);
});

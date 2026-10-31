import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const section = (from, to) => {
  const start = source.indexOf(from), end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start); return source.slice(start, end);
};
const helpers = section('  const informationNames = ', '  const uniqueText = ');
const renderer = section('  function renderRequirement(', '  function dispositionPanel(');
const csv = section('  function exportCsv(', '\n  $("spec-file").addEventListener');
const row = (id, processCategory, extra = {}) => ({ id, processCategory, category: id, requirement: '20~40 μm', informationType: 'quality', review_required: false, review_note: '', origin: 'drawing', ruleIds: [], sources: [], ...extra });
function fixture(rows = []) {
  const output = [], state = { filter: 'core', search: '' };
  const node = (tag, cls, text) => ({ tag, className: cls || '', textContent: text, children: [], classList: { add() {} }, append(...children) { this.children.push(...children); }, setAttribute() {} });
  const context = vm.createContext({ state, list: value => Array.isArray(value) ? value : [], str: value => value == null ? '' : String(value), el: node,
    details: title => { const element = node('details', '', title), body = node('div'); element.append(body); return { node: element, body }; },
    parameters: () => null, evidence: () => node('details', '', '来源'), originNames: { drawing: '图纸要求', combined: '规范＋图纸' },
    currentResult: () => ({ scopePolicy: 'drawing-plus-inspection-v1', requirements: rows }), download: (content, filename) => output.push({ content, filename }), scopeNames: {} });
  vm.runInContext(`${helpers}\n${renderer}\n${csv}\nvar actualClassificationExplanation = classificationExplanation; classificationExplanation = () => null;`, context);
  return { context: vm.runInContext('({filteredRequirements, processCategory, drawingScope, conflictKind, renderRequirement, exportCsv})', context), state, output };
}

test('the new scope filters each of the eight categories without treating material as machining', () => {
  const categories = ['铸造', '机加', '热处理', '表面处理', '刻字', '检验', '焊接', '其他'];
  const rows = categories.map((category, i) => row('R' + i, category));
  const { context } = fixture();
  const result = { scopePolicy: 'drawing-plus-inspection-v1', requirements: rows };
  assert.equal(context.filteredRequirements(result, 'core', '').length, 8);
  categories.forEach((category, i) => assert.deepEqual(Array.from(context.filteredRequirements(result, 'process:' + category, ''), r => r.id), ['R' + i]));
  assert.equal(context.processCategory({ processCategory: '材料' }), '待分类');
});

test('actual conflicts, authorized drawing overrides and review flags are independent filters', () => {
  const rows = [row('conflict', '焊接', { conflict: { kind: 'conflict', specificationRequirement: 'EN 15085', reason: '编号不同' } }),
    row('override', '检验', { conflict: { kind: 'drawing_override', specificationRequirement: '3分钟', reason: '采用图纸规定' } }),
    row('pending', '检验', { review_required: true, review_note: '受检区域壁厚缺失' }),
    row('clear', '表面处理', { review_note: '来自清晰图像', dispositions: [{ status: 'not_applicable' }] })];
  const { context } = fixture(); const result = { scopePolicy: 'drawing-plus-inspection-v1', requirements: rows };
  assert.deepEqual(Array.from(context.filteredRequirements(result, 'conflict', ''), r => r.id), ['conflict']);
  assert.deepEqual(Array.from(context.filteredRequirements(result, 'override', ''), r => r.id), ['override']);
  assert.deepEqual(Array.from(context.filteredRequirements(result, 'review', ''), r => r.id), ['pending']);
  assert.equal(context.conflictKind(rows[3]), '');
  assert.equal(context.filteredRequirements(result, 'core', 'EN 15085').length, 1);
});

test('conflict rendering keeps exactly two columns and visible source values', () => {
  const { context } = fixture();
  const item = row('焊接标准', '焊接', { requirement: 'EN 15082-2', conflict: { kind: 'conflict', specificationRequirement: 'EN 15085-2', reason: '标准号字形不同，需核对' } });
  const rendered = context.renderRequirement(item, {});
  assert.equal(rendered.children.length, 2);
  const texts = node => [node.textContent || '', ...node.children.flatMap(child => typeof child === 'string' ? child : texts(child))];
  const visible = texts(rendered).join(' ');
  for (const value of ['焊接', '要求冲突', 'EN 15082-2', 'EN 15085-2', '图纸执行要求', '规范要求']) assert.ok(visible.includes(value), value);
});

test('category-filtered CSV retains the two-column contract and complete current values', () => {
  const rows = [row('膜厚', '表面处理'), row('焊缝', '焊接', { requirement: '不得补焊' })];
  const { context, state, output } = fixture(rows); state.filter = 'process:焊接'; context.exportCsv();
  assert.equal(output[0].content, '\ufeff"工艺要求的名称","量化指标"\r\n"焊缝","不得补焊"');
  assert.ok(output[0].filename.includes('焊接'));
});

test('old results remain filterable through their original information roles', () => {
  const { context } = fixture(); const old = { requirements: [row('old', undefined), row('background', undefined, { informationType: 'context' })] };
  assert.equal(context.drawingScope(old), false);
  assert.deepEqual(Array.from(context.filteredRequirements(old, 'core', ''), r => r.id), ['old']);
});

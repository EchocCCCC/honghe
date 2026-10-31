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
    currentResult: () => ({ scopePolicy: 'drawing-plus-inspection-v1', requirements: rows }), download: (content, filename) => output.push({ content, filename }), scopeNames: {}, statusNames: { failed: '处理失败', completed: '已完成' }, dispositionNames: { not_applicable: '不适用', applicable: '适用', needs_confirmation: '待确认' } });
  vm.runInContext(`${helpers}\n${renderer}\n${csv}\nvar actualClassificationExplanation = classificationExplanation; classificationExplanation = () => null;`, context);
  return { context: vm.runInContext('({filteredRequirements, processCategory, drawingScope, conflictKind, renderRequirement, exportCsv, drawingHasResult, drawingStatusLabel, dispositionDisplayStatus, dispositionDisplayLabel, withPendingDispositions})', context), state, output };
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

test('conflict rendering moves the process category into a third stage column while retaining both source values', () => {
  const { context } = fixture();
  const item = row('焊接标准', '焊接', { requirement: 'EN 15082-2', conflict: { kind: 'conflict', specificationRequirement: 'EN 15085-2', reason: '标准号字形不同，需核对' } });
  const rendered = context.renderRequirement(item, {});
  assert.equal(rendered.children.length, 3);
  assert.equal(rendered.children[2].textContent, '焊接');
  assert.equal(rendered.children[2].className, 'requirement-stage');
  assert.ok(!rendered.children[0].children.some(child => child.className === 'process-tag'));
  const texts = node => [node.textContent || '', ...node.children.flatMap(child => typeof child === 'string' ? child : texts(child))];
  const visible = texts(rendered).join(' ');
  for (const value of ['焊接', '要求冲突', 'EN 15082-2', 'EN 15085-2', '图纸执行要求', '规范要求']) assert.ok(visible.includes(value), value);
});

test('category-filtered CSV includes the process category in the third stage column', () => {
  const rows = [row('膜厚', '表面处理'), row('焊缝', '焊接', { requirement: '不得补焊' })];
  const { context, state, output } = fixture(rows); state.filter = 'process:焊接'; context.exportCsv();
  assert.equal(output[0].content, '\ufeff"工艺要求的名称","量化指标","阶段"\r\n"焊缝","不得补焊","焊接"');
  assert.ok(output[0].filename.includes('焊接'));
});

test('stage uses processCategory and remains searchable without deriving it from production-stage metadata', () => {
  const { context } = fixture();
  const result = { scopePolicy: 'drawing-plus-inspection-v1', stage: 'sample', requirements: [row('R1', '热处理', { stage: '批产' }), row('R2', '焊接')] };
  assert.deepEqual(Array.from(context.filteredRequirements(result, 'core', '热处理'), item => item.id), ['R1']);
  assert.equal(context.renderRequirement(result.requirements[0], {}).children[2].textContent, '热处理');
  assert.equal(context.renderRequirement(row('legacy', undefined), {}).children[2].textContent, '待分类');
});

test('row-review and partial results remain available with explicit labels, but stale or failed results do not', () => {
  const { context } = fixture();
  const requirements = [row('clear', '机加'), row('question', '检验', { review_required: true })];
  const partial = { status: 'completed', attemptId: 'new', result: { requirements, review: { status: 'partial' }, run: { attemptId: 'new' } } };
  assert.equal(context.drawingHasResult(partial), true);
  assert.equal(context.drawingStatusLabel(partial), '部分提取 · 待复核');
  assert.equal(context.drawingStatusLabel({ ...partial, result: { ...partial.result, review: { status: 'needs_review' } } }), '已提取 · 待复核');
  assert.equal(context.drawingStatusLabel({ status: 'completed', result: { requirements: [row('clear', '机加')], review: { status: 'completed' } } }), '已提取清单');
  assert.equal(context.drawingHasResult({ ...partial, status: 'failed' }), false);
  assert.equal(context.drawingHasResult({ ...partial, attemptId: 'other' }), false);
});

test('changed-condition dispositions show a review overlay without overwriting the original not-applicable judgment', () => {
  const { context } = fixture();
  const decisions = [{ ruleId: 'R1', status: 'not_applicable', reason: '原材料形态不适用', evidence: [] }, { ruleId: 'R2', status: 'applicable', reason: '适用', evidence: [] }];
  const before = structuredClone(decisions), result = { review: { pendingRuleIds: ['R1', 'R3'] }, dispositions: decisions };
  const display = context.withPendingDispositions(result, decisions), pending = new Set(result.review.pendingRuleIds);
  assert.equal(context.dispositionDisplayStatus(display[0], pending), 'needs_confirmation');
  assert.equal(context.dispositionDisplayLabel(display[0], pending), '待复核（原模型：不适用）');
  assert.equal(context.dispositionDisplayLabel(display[2], pending), '待复核（尚未匹配）');
  assert.equal(context.dispositionDisplayLabel(display[1], pending), '适用');
  assert.deepEqual(decisions, before);
  assert.deepEqual(Array.from(display, row => row.ruleId), ['R1', 'R2', 'R3']);
});

test('old results remain filterable through their original information roles', () => {
  const { context } = fixture(); const old = { requirements: [row('old', undefined), row('background', undefined, { informationType: 'context' })] };
  assert.equal(context.drawingScope(old), false);
  assert.deepEqual(Array.from(context.filteredRequirements(old, 'core', ''), r => r.id), ['old']);
});

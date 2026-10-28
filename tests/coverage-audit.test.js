import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCoveragePatch } from '../server/coverage-audit.js';
const item = (id, page, requirement = '去毛刺') => ({ id, category: '表面质量', requirement, scope: '本件', parameters: [], sources: [{ file: 'a.pdf', page, section: '技术要求', quote: requirement }], review_required: false, review_note: '' });
const input = () => ({ summary: '摘要', requirements: [item('REQ-001', 1)], warnings: ['保留提示'], run: { model: 'deepseek-flash' } });
const prepared = { documents: [{ id: 'doc-1', name: 'a.pdf', pages: 2, textPages: ['去毛刺', '炉次号指熔炼批号'], imagePages: [1, 2] }], warnings: [] };
const batch = { pages: [{ file: 'a.pdf', page: 2 }] };

test('source-grounded additions recover a wholly missing requirement without altering existing IDs', () => {
  const original = input();
  const patch = { replacements: [], additions: [item('ADD-B02-001', 2, '炉次号指熔炼批号')], warnings: ['不作为全量诊断'] };
  const applied = applyCoveragePatch(original, patch, batch, prepared);
  assert.deepEqual(applied.result.requirements.map(r => r.id), ['REQ-001', 'REQ-002']);
  assert.equal(applied.result.requirements[1].sources[0].verification, 'text_match');
  assert.deepEqual(applied.result.run, original.run);
  assert.deepEqual(applied.result.warnings, original.warnings);
  assert.equal(original.requirements.length, 1);
});
test('coverage patches reject unassigned page sources and fabricated locations', () => {
  assert.throws(() => applyCoveragePatch(input(), { replacements: [], additions: [item('ADD-1', 1)], warnings: [] }, batch, prepared), /不属于本批/);
  const bad = item('ADD-1', 2); bad.sources.push({ file: 'absent.pdf', page: 1, quote: '无' });
  assert.throws(() => applyCoveragePatch(input(), { replacements: [], additions: [bad], warnings: [] }, batch, prepared), /不存在/);
});
test('coverage patches cannot replace non-candidates or smuggle incomplete/duplicate IDs', () => {
  assert.throws(() => applyCoveragePatch(input(), { replacements: [item('REQ-999', 2)], additions: [], warnings: [] }, batch, prepared), /非候选/);
  assert.throws(() => applyCoveragePatch(input(), { replacements: [], additions: [item('REQ-001', 2)], warnings: [] }, batch, prepared), /临时编号重复/);
  const incomplete = item('ADD-1', 2); delete incomplete.scope;
  assert.throws(() => applyCoveragePatch(input(), { replacements: [], additions: [incomplete], warnings: [] }, batch, prepared), /完整条目/);
});

test('equal wording must not collapse distinct scopes and parameter values', () => {
  const a = { ...item('ADD-1', 2, '硬度应满足要求'), scope: '状态A', parameters: [{ name: '硬度', value: '100', unit: 'HBW' }] };
  const b = { ...item('ADD-2', 2, '硬度应满足要求'), scope: '状态B', parameters: [{ name: '硬度', value: '200', unit: 'HBW' }] };
  const applied = applyCoveragePatch(input(), { replacements: [], additions: [a, b], warnings: [] }, batch, prepared);
  assert.equal(applied.addedIds.length, 2);
  assert.deepEqual(applied.result.requirements.slice(1).map(r => r.parameters[0].value), ['100', '200']);
});

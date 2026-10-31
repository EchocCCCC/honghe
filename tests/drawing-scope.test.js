import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import { validateMatching, validateRuleUsage, applyDrawingPatch } from '../server/two-stage-schema.js';
import { mergeRules, applyRulePatch } from '../server/two-stage-pipeline.js';
import { PROCESS_CATEGORIES, SCOPE_POLICY, decorateDispositions } from '../server/information-types.js';
import { guardMaterialSectionDimensions, guardRegionalWallThickness } from '../server/drawing-guards.js';
import { createTwoStageRouter } from '../server/two-stage-routes.js';

const evidence = (file = 'spec.pdf', quote = '原文明确的要求') => ({ file, page: 1, section: '技术要求', quote });
const doc = name => ({ name, pages: 1, textPages: ['原文明确的要求'], imagePages: [1], needsVisualReview: [] });
const specPrepared = { documents: [doc('spec.pdf')] }, drawPrepared = { documents: [doc('part.pdf')] };
const requirement = (id = 'REQ1') => ({ id, category: '硬度验收', informationType: 'quality', processCategory: '检验', requirement: 'HBW≥80', scope: '本件', parameters: [],
  review_required: false, review_note: '', sources: [evidence()], origin: 'specification', ruleIds: ['R1'], conflict: null });
const rule = (id, usage) => ({ ...requirement(id), usage, strength: 'required', conditions: [], exceptions: [], overridePolicy: '', externalReferences: [] });
const specification = () => ({ scopePolicy: SCOPE_POLICY, metadata: { number: 'S', version: '1' }, rules: [rule('R1', 'inspection'), { ...rule('R2', 'comparison'), category: '未注尺寸公差', requirement: '默认CT9' }], warnings: [] });
const drawing = () => ({ partNumber: 'P1', name: 'part', revision: '', material: '', materialForm: '', process: '', castingClass: '', airtightness: 'unspecified', dimensionState: 'unspecified', references: [], facts: [], uncertainties: [] });
const result = () => ({ drawing: drawing(), summary: '', requirements: [requirement()], dispositions: [{ ruleId: 'R1', status: 'applicable', reason: '材料符合', evidence: [evidence()] }], warnings: [] });
const validate = (raw = result(), spec = specification(), dp = drawPrepared, sp = specPrepared) => validateMatching(raw, spec, dp, sp);
const patch = () => ({ drawing: drawing(), summary: '', replacements: [], additions: [], removals: [], dispositionReplacements: [], warnings: [] });

test('inspection rules are mandatory dispositions while comparison clauses stay outside the output', () => {
  const checked = validate();
  assert.equal(checked.scopePolicy, SCOPE_POLICY);
  assert.equal(checked.ruleCoverage.total, 1); assert.equal(checked.ruleCoverage.decided, 1);
  assert.equal(checked.ruleCoverage.comparisonRecords, 1);
  assert.equal(checked.requirements.length, 1);
  const decorated = decorateDispositions(checked, specification());
  assert.equal(decorated.ruleCoverage.total, 1); assert.equal(decorated.ruleCoverage.decided, 1);
  const missing = result(); missing.dispositions = [];
  assert.throws(() => validate(missing), /没有适用性结论/);
});

test('the new policy requires explicit usage and never guesses it from the process category', () => {
  const spec = specification(); delete spec.rules[0].usage;
  assert.throws(() => validate(result(), spec), /缺少检验\/对照用途/);
  assert.throws(() => validateRuleUsage([{ ...rule('R', 'inspection'), informationType: 'context' }]), /背景/);
  const categoryDiffers = specification(); categoryDiffers.rules[0].processCategory = '热处理';
  assert.equal(validate(result(), categoryDiffers).ruleCoverage.total, 1);
});

test('every new final requirement has exactly one of the eight categories', () => {
  for (const processCategory of PROCESS_CATEGORIES) {
    const raw = result(); raw.requirements[0].processCategory = processCategory;
    assert.equal(validate(raw).requirements[0].processCategory, processCategory);
  }
  const missing = result(); delete missing.requirements[0].processCategory;
  assert.throws(() => validate(missing), /缺少八类/);
  const invalid = result(); invalid.requirements[0].processCategory = '材料';
  assert.throws(() => validate(invalid), /结构不符合/);
});

test('comparison manufacturing requirements cannot become specification-only output rows', () => {
  const raw = result(); raw.requirements.push({ ...requirement('REQ2'), category: '未注公差', processCategory: '机加', requirement: 'CT9', ruleIds: ['R2'] });
  assert.throws(() => validate(raw), /非检验规范条款不能独立/);
  raw.requirements[1] = { ...raw.requirements[1], origin: 'combined', requirement: '图纸CT8', sources: [evidence(), evidence('part.pdf')], conflict: { kind: 'drawing_override', specificationRequirement: '默认CT9', reason: '图纸专用要求优先' } };
  const checked = validate(raw);
  assert.equal(checked.requirements[1].requirement, '图纸CT8');
  assert.equal(checked.requirements[1].conflict.specificationRequirement, '默认CT9');
  assert.equal(checked.ruleCoverage.decided, 1);
});

test('conflict display requires both documents and an existing linked specification rule', () => {
  const raw = result(); raw.requirements[0].conflict = { kind: 'conflict', specificationRequirement: '规范值', reason: '双方数值不同' };
  assert.throws(() => validate(raw), /冲突\/覆盖要求缺少/);
  raw.requirements[0].origin = 'combined'; raw.requirements[0].sources.push(evidence('part.pdf'));
  const checked = validate(raw);
  assert.equal(checked.requirements[0].review_required, true);
  assert.match(checked.requirements[0].review_note, /双方数值不同/);
  const foreign = result(); foreign.requirements[0].ruleIds = ['unknown'];
  assert.throws(() => validate(foreign), /未知规则/);
});

test('an authorized drawing override is prominent without creating an uncertainty flag', () => {
  const raw = result(), spec = specification(); spec.rules[0].review_required = true;
  raw.dispositions[0] = { ruleId: 'R1', status: 'overridden', reason: '图纸优先', evidence: [evidence(), evidence('part.pdf')] };
  raw.requirements[0] = { ...raw.requirements[0], origin: 'combined', sources: [evidence(), evidence('part.pdf')], requirement: '图纸给出的值', conflict: { kind: 'drawing_override', specificationRequirement: '规范默认值', reason: '专用图纸覆盖通用要求' } };
  const scans = structuredClone(drawPrepared); scans.documents[0].textPages = [''];
  const checked = validate(raw, spec, scans);
  assert.equal(checked.requirements[0].review_required, false);
  assert.equal(checked.requirements[0].requirement, '图纸给出的值');
  assert.equal(checked.requirements[0].sources[1].verification, 'visual_review');
  delete raw.requirements[0].conflict;
  assert.throws(() => validate(raw, spec), /缺少突出显示/);
});

test('one evidence diagnostic lists missing override documents and every linked-rule page without repairing the candidate', () => {
  const pageTwo = { ...evidence(), page: 2, quote: '第二页的独立检验要求' };
  const sp = { documents: [{ ...doc('spec.pdf'), pages: 2, textPages: ['原文明确的要求', pageTwo.quote], imagePages: [1, 2] }] };
  const spec = specification();
  spec.rules = [rule('R016', 'inspection'), { ...rule('R032', 'inspection'), sources: [pageTwo] }];
  const raw = result();
  raw.requirements = [
    { ...requirement('D-OVERRIDE'), origin: 'combined', ruleIds: ['R016'], sources: [evidence(), evidence('part.pdf')],
      conflict: { kind: 'drawing_override', specificationRequirement: '规范默认要求', reason: '图纸明确覆盖' } },
    { ...requirement('N-OTHER'), ruleIds: ['R032'], sources: [evidence()] },
  ];
  raw.dispositions = [
    { ruleId: 'R016', status: 'overridden', reason: '图纸明确覆盖', evidence: [evidence()] },
    { ruleId: 'R032', status: 'applicable', reason: '本件适用', evidence: [pageTwo] },
  ];
  const original = structuredClone(raw), originalSpec = structuredClone(spec);
  assert.throws(() => validate(raw, spec, drawPrepared, sp), error => {
    assert.match(error.message, /覆盖处置缺少规范和本图双方证据：R016/);
    assert.match(error.message, /要求缺少关联规则所在页的证据：N-OTHER\/R032/);
    return true;
  });
  assert.deepEqual(raw, original);
  assert.deepEqual(spec, originalSpec);

  const onlyOverrideFixed = structuredClone(raw);
  onlyOverrideFixed.dispositions[0].evidence.push(evidence('part.pdf'));
  const overrideFixedSnapshot = structuredClone(onlyOverrideFixed);
  assert.throws(() => validate(onlyOverrideFixed, spec, drawPrepared, sp), /N-OTHER\/R032/);
  assert.deepEqual(onlyOverrideFixed, overrideFixedSnapshot);

  const onlyPageFixed = structuredClone(raw);
  onlyPageFixed.requirements[1].sources.push(structuredClone(pageTwo));
  const pageFixedSnapshot = structuredClone(onlyPageFixed);
  assert.throws(() => validate(onlyPageFixed, spec, drawPrepared, sp), /双方证据：R016/);
  assert.deepEqual(onlyPageFixed, pageFixedSnapshot);

  const fixed = structuredClone(onlyOverrideFixed);
  fixed.requirements[1].sources.push(structuredClone(pageTwo));
  const fixedSnapshot = structuredClone(fixed);
  const checked = validate(fixed, spec, drawPrepared, sp);
  assert.equal(checked.requirements.length, 2);
  assert.equal(checked.requirements[1].sources[1].page, 2);
  assert.deepEqual(fixed, fixedSnapshot);
  assert.deepEqual(raw, original);
  assert.deepEqual(spec, originalSpec);
});

test('evidence preflight skips unknown rule IDs for the original unknown-rule validation', () => {
  const unknownRequirement = result();
  unknownRequirement.requirements[0].ruleIds = ['not-in-specification'];
  const beforeRequirement = structuredClone(unknownRequirement);
  assert.throws(() => validate(unknownRequirement), /要求引用未知规则：not-in-specification/);
  assert.deepEqual(unknownRequirement, beforeRequirement);
  const unknownDisposition = result();
  unknownDisposition.dispositions.push({ ruleId: 'not-in-specification', status: 'overridden', reason: '未知', evidence: [evidence()] });
  const beforeDisposition = structuredClone(unknownDisposition);
  assert.throws(() => validate(unknownDisposition), /未知规则：not-in-specification/);
  assert.deepEqual(unknownDisposition, beforeDisposition);
});

test('evidence aggregation preserves invalid-file, invalid-page and missing-specification-source diagnostics', () => {
  for (const change of [
    value => { value.requirements[0].sources = [evidence('another-part.pdf')]; },
    value => { value.requirements[0].sources = [{ ...evidence(), page: 2 }]; },
    value => { value.dispositions[0].evidence = [evidence('another-part.pdf')]; },
    value => { value.dispositions[0].evidence = [{ ...evidence(), page: 2 }]; },
  ]) {
    const raw = result();
    change(raw);
    const before = structuredClone(raw);
    assert.throws(() => validate(raw), /来源不属于本次资料或页码越界/);
    assert.deepEqual(raw, before);
  }
  const missingNorm = result();
  missingNorm.requirements[0].sources = [evidence('part.pdf')];
  const before = structuredClone(missingNorm);
  assert.throws(() => validate(missingNorm), /规范要求缺少规范原文证据：REQ1/);
  assert.deepEqual(missingNorm, before);
});

test('not-applicable inspection rules cannot be linked back into effective requirements', () => {
  const raw = result(); raw.dispositions[0].status = 'not_applicable';
  assert.throws(() => validate(raw), /不适用规则/);
});

test('audit can remove an out-of-scope comparison row without resurrecting it', () => {
  const raw = result(); raw.requirements.push({ ...requirement('REQ2'), ruleIds: ['R2'] });
  const change = patch(); change.removals = [{ id: 'REQ2', reason: '非检验规范条款不自动进入最终清单', evidence: [evidence()] }];
  const checked = applyDrawingPatch(raw, change, specification(), drawPrepared, specPrepared).result;
  assert.equal(checked.requirements.length, 1); assert.equal(checked.requirements[0].id, 'REQ1');
  const added = patch(); added.additions = [{ ...requirement('ADD1'), origin: 'drawing', ruleIds: [], sources: [evidence('part.pdf')] }]; delete added.additions[0].processCategory;
  assert.throws(() => applyDrawingPatch(result(), added, specification(), drawPrepared, specPrepared), /缺少八类/);
});

test('audit rejects every former specification-only conflict main row instead of labelling its norm value as drawing execution', () => {
  for (const kind of ['conflict', 'drawing_override']) {
    const raw = result();
    raw.requirements.push(requirement('N-SECOND'));
    const change = patch();
    change.replacements = raw.requirements.map(item => ({ ...structuredClone(item), origin: 'combined',
      sources: [...item.sources, evidence('part.pdf')],
      conflict: { kind, specificationRequirement: '原规范值', reason: '图纸另有专用值' } }));
    const before = structuredClone(raw), patchBefore = structuredClone(change);
    assert.throws(() => applyDrawingPatch(raw, change, specification(), drawPrepared, specPrepared), error => {
      assert.match(error.message, /原规范独立要求不能作为冲突\/覆盖主行：REQ1、N-SECOND/);
      assert.match(error.message, /已有图纸要求或真实新增图纸要求/);
      return true;
    });
    assert.deepEqual(raw, before);
    assert.deepEqual(change, patchBefore);
  }
});

test('audit may place differences on an existing D row and a genuine new drawing row while preserving the norm row', () => {
  for (const kind of ['conflict', 'drawing_override']) {
    const raw = result();
    raw.requirements.push({ ...requirement('D-EXISTING'), requirement: '图纸专用值', origin: 'drawing', ruleIds: [], sources: [evidence('part.pdf')] });
    const change = patch();
    change.replacements = [{ ...structuredClone(raw.requirements[1]), origin: 'combined', ruleIds: ['R1'],
      sources: [evidence('part.pdf'), evidence()], conflict: { kind, specificationRequirement: '规范默认值', reason: '图纸专用值优先' } }];
    change.additions = [{ ...requirement('ADD-D-NEW'), requirement: '图纸另一区域专用值', origin: 'combined',
      sources: [evidence('part.pdf'), evidence()], conflict: { kind, specificationRequirement: '规范默认值', reason: '图纸新增区域另有要求' } }];
    const before = structuredClone(raw), patchBefore = structuredClone(change);
    const checked = applyDrawingPatch(raw, change, specification(), drawPrepared, specPrepared).result;
    assert.equal(checked.requirements.length, 3);
    assert.equal(checked.requirements[0].origin, 'specification');
    assert.equal(checked.requirements[0].conflict, null);
    assert.equal(checked.requirements[0].requirement, raw.requirements[0].requirement);
    assert.equal(checked.requirements[1].requirement, '图纸专用值');
    assert.equal(checked.requirements[1].conflict.kind, kind);
    assert.equal(checked.requirements[2].requirement, '图纸另一区域专用值');
    assert.equal(checked.requirements[2].conflict.kind, kind);
    assert.deepEqual(raw, before);
    assert.deepEqual(change, patchBefore);
  }
});

test('an active norm row may gain drawing support during audit when it has no conflict main-value claim', () => {
  const raw = result(), change = patch();
  change.replacements = [{ ...structuredClone(raw.requirements[0]), origin: 'combined', sources: [evidence(), evidence('part.pdf')], conflict: null }];
  const before = structuredClone(raw), patchBefore = structuredClone(change);
  const checked = applyDrawingPatch(raw, change, specification(), drawPrepared, specPrepared).result;
  assert.equal(checked.dispositions[0].status, 'applicable');
  assert.equal(checked.requirements[0].requirement, raw.requirements[0].requirement);
  assert.equal(checked.requirements[0].origin, 'combined');
  assert.equal(checked.requirements[0].conflict, null);
  assert.ok(checked.requirements[0].sources.some(item => item.file === 'part.pdf'));
  assert.deepEqual(raw, before);
  assert.deepEqual(change, patchBefore);
});

test('the model audit can replace malformed evidence arrays without modifying either original object', () => {
  const spec = specification(); spec.rules[1].usage = 'inspection';
  const raw = result(); raw.requirements.push({ ...requirement('REQ2'), ruleIds: ['R2'] });
  raw.dispositions.push({ ruleId: 'R2', status: 'applicable', reason: '适用', evidence: [evidence()] });
  for (const disposition of raw.dispositions) disposition.evidence = disposition.evidence[0];
  const change = patch(); change.dispositionReplacements = raw.dispositions.map(d => ({ ...d, evidence: [structuredClone(d.evidence)] }));
  const before = structuredClone(raw), patchBefore = structuredClone(change);
  const fixed = applyDrawingPatch(raw, change, spec, drawPrepared, specPrepared).result;
  assert.equal(fixed.dispositions.length, 2); assert.ok(fixed.dispositions.every(d => Array.isArray(d.evidence)));
  assert.deepEqual(raw, before); assert.deepEqual(change, patchBefore);
  change.dispositionReplacements.pop();
  assert.throws(() => applyDrawingPatch(raw, change, spec, drawPrepared, specPrepared), /dispositions\.1\.evidence/);
  assert.deepEqual(raw, before);
});

test('scope-aware material guards retain the selected material and never expand the entire normative table', () => {
  const spec = specification(); Object.assign(spec.rules[0], { category: '力学性能', requirement: '6082和6061板材按各厚度分档', scope: '原料厚度', parameters: [{ name: '厚度', value: '分档', unit: 'mm' }] });
  const raw = result(); raw.requirements[0].requirement = '6082板材：Rm≥295MPa，厚度条件待确认';
  const guarded = guardMaterialSectionDimensions(raw, spec);
  assert.equal(guarded.result.requirements.length, 1);
  assert.match(guarded.result.requirements[0].requirement, /6082/);
  assert.doesNotMatch(guarded.result.requirements[0].requirement, /6061/);
  assert.equal(guarded.result.requirements[0].processCategory, '检验');
  assert.equal(guarded.result.dispositions[0].status, 'needs_confirmation');
  assert.equal(validate(guarded.result, spec).requirements[0].review_required, true);
  const comparison = specification(); Object.assign(comparison.rules[1], { category: '内部质量', requirement: '按壁厚分档', scope: '', parameters: [] });
  assert.equal(guardRegionalWallThickness(result(), comparison).changes.length, 0);
});

test('historical validation remains readable with its original complete-rule policy', () => {
  const old = specification(); delete old.scopePolicy;
  old.rules = [old.rules[0]]; delete old.rules[0].usage;
  const raw = result(); delete raw.requirements[0].processCategory; delete raw.requirements[0].conflict;
  assert.equal(validate(raw, old).requirements.length, 1);
  old.rules.push(rule('R2', 'comparison'));
  assert.throws(() => validate(raw, old), /没有适用性结论/);
});

test('specification usage survives merging and cannot disappear from a new-policy audit patch', () => {
  const batch = { pages: [{ file: 'spec.pdf', page: 1 }] };
  const merged = mergeRules([{ batch, result: specification() }], specPrepared.documents);
  assert.equal(merged.scopePolicy, SCOPE_POLICY);
  assert.equal(merged.inspectionCount, 1); assert.equal(merged.comparisonCount, 1);
  const change = { replacements: [{ ...merged.rules[0] }], additions: [], warnings: [] }; delete change.replacements[0].usage;
  assert.throws(() => applyRulePatch(merged, change, batch, specPrepared.documents), /缺少检验\/对照用途/);
});

test('read-only API preserves the new scope and reports inspection counts separately from comparisons', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'honghe-scope-api-'));
  const specId = '11111111-1111-4111-8111-111111111111', batchId = '22222222-2222-4222-8222-222222222222';
  const spec = specification(), output = validate();
  await fs.mkdir(path.join(directory, 'specifications', specId), { recursive: true });
  await fs.mkdir(path.join(directory, 'drawing-batches', batchId), { recursive: true });
  await fs.writeFile(path.join(directory, 'specifications', specId, 'job.json'), JSON.stringify({ id: specId, name: '规范', status: 'completed', createdAt: '2026-10-30T00:00:00.000Z', result: spec }));
  await fs.writeFile(path.join(directory, 'drawing-batches', batchId, 'job.json'), JSON.stringify({ id: batchId, specificationId: specId, specification: { metadata: spec.metadata }, status: 'completed', createdAt: '2026-10-30T00:00:00.000Z', drawings: [{ id: 'part', name: 'part.pdf', status: 'completed', result: output }] }));
  const app = express(); app.use('/api', createTwoStageRouter({ root: directory, configured: () => false }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert.match(path.basename(directory), /^honghe-scope-api-/);
    await fs.rm(directory, { recursive: true, force: true });
  });
  const get = endpoint => fetch(`http://127.0.0.1:${server.address().port}/api${endpoint}`).then(r => r.json());
  const listing = await get('/specifications');
  assert.equal(listing.specifications[0].scopePolicy, SCOPE_POLICY);
  assert.equal(listing.specifications[0].ruleCount, 1); assert.equal(listing.specifications[0].recordCount, 2);
  assert.equal(listing.specifications[0].inspectionCount, 1); assert.equal(listing.specifications[0].comparisonCount, 1);
  assert.equal(listing.specifications[0].result, undefined);
  const detail = await get(`/specifications/${specId}`); assert.equal(detail.result.scopePolicy, SCOPE_POLICY);
  const batch = await get(`/drawing-batches/${batchId}`);
  assert.equal(batch.specification.scopePolicy, SCOPE_POLICY); assert.equal(batch.specification.ruleCount, 1);
  assert.equal(batch.drawings[0].result.ruleCoverage.total, 1); assert.equal(batch.drawings[0].result.requirements[0].processCategory, '检验');
});

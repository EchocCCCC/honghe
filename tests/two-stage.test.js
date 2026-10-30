import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { validateMatching, ruleSchema, applyDrawingPatch } from '../server/two-stage-schema.js';
import { mergeRules, applyRulePatch, ruleKey, matchDrawing } from '../server/two-stage-pipeline.js';
import { loadSkillBundle, compileSkill } from '../server/skills.js';
import { DRAWING_SKILL } from '../server/two-stage-pipeline.js';
import { createTwoStageRouter, WorkQueue } from '../server/two-stage-routes.js';
import { sourceAliases, mapSourceNames, guardRegionalWallThickness, guardPressurePurpose, guardDrawingStandardClaims, guardMaterialSectionDimensions } from '../server/drawing-guards.js';

const evidence = (file = 'spec.pdf', page = 1) => ({ file, page, section: '3.1', quote: 'test requirement' });
const base = (id = 'R001', file = 'spec.pdf') => ({ id, informationType: 'quality', category: '检验', requirement: 'test requirement', scope: 'conditional', parameters: [], sources: [evidence(file)], review_required: false, review_note: '' });
const rule = id => ({ ...base(id), strength: 'required', conditions: ['when applicable'], exceptions: [], overridePolicy: 'drawing priority', externalReferences: [] });
const doc = name => ({ name, pages: 1, textPages: ['test requirement'], imagePages: [1], needsVisualReview: [] });
const specPrepared = { documents: [doc('spec.pdf')] }, drawingPrepared = { documents: [doc('part.pdf')] };
const metadata = { number: 'SPEC-X', title: 'Example', version: '1', scope: 'test', excludedProcesses: [], priorityPolicy: 'drawing priority' };
const specification = { metadata, rules: [rule('R001')], warnings: [] };
function matchResult() {
  return { drawing: { partNumber: 'P-A', name: 'part', revision: 'A', material: 'M', materialForm: '', process: '', castingClass: '', airtightness: 'unspecified', dimensionState: 'unspecified', references: [], facts: [], uncertainties: [] }, summary: '', requirements: [{ ...base('REQ001'), origin: 'specification', ruleIds: ['R001'] }], dispositions: [{ ruleId: 'R001', status: 'applicable', reason: 'global rule applies', evidence: [evidence()] }], warnings: [] };
}
const auditPatch = () => ({ drawing: matchResult().drawing, summary: 'reviewed', replacements: matchResult().requirements, additions: [], removals: [], dispositionReplacements: [], warnings: [] });
test('every specification rule must have exactly one disposition', () => {
  const raw = matchResult(); raw.dispositions = [];
  assert.throws(() => validateMatching(raw, specification, drawingPrepared, specPrepared), /没有适用性结论/);
  raw.dispositions = [matchResult().dispositions[0], matchResult().dispositions[0]];
  assert.throws(() => validateMatching(raw, specification, drawingPrepared, specPrepared), /重复判定/);
});
test('not-applicable rules cannot enter effective requirements', () => {
  const raw = matchResult(); raw.dispositions[0].status = 'not_applicable';
  assert.throws(() => validateMatching(raw, specification, drawingPrepared, specPrepared), /不适用规则/);
});
test('applicable and overridden rules must link to an output requirement', () => {
  const raw = matchResult(); raw.requirements = [{ ...base('REQ001', 'part.pdf'), origin: 'drawing', ruleIds: [] }];
  assert.throws(() => validateMatching(raw, specification, drawingPrepared, specPrepared), /缺少要求条目/);
  raw.dispositions[0].status = 'overridden';
  raw.dispositions[0].evidence.push(evidence('part.pdf'));
  assert.throws(() => validateMatching(raw, specification, drawingPrepared, specPrepared), /缺少要求条目/);
});
test('evidence from another part or an invalid page is rejected', () => {
  const raw = matchResult(); raw.requirements[0].sources = [evidence('other-part.pdf')];
  assert.throws(() => validateMatching(raw, specification, drawingPrepared, specPrepared), /不属于本次资料/);
  raw.requirements[0].sources = [evidence('spec.pdf', 2)];
  assert.throws(() => validateMatching(raw, specification, drawingPrepared, specPrepared), /页码越界/);
});
test('unresolved rule ambiguity propagates to the linked requirement', () => {
  const spec = structuredClone(specification); spec.rules[0].review_required = true;
  const result = validateMatching(matchResult(), spec, drawingPrepared, specPrepared);
  assert.equal(result.requirements[0].review_required, true);
  assert.equal(result.ruleCoverage.decided, 1);
});
test('missing condition and exception fields cannot silently become unconditional rules', () => {
  for (const field of ['informationType', 'conditions', 'exceptions', 'overridePolicy', 'externalReferences', 'parameters', 'review_required']) {
    const raw = rule('R001'); delete raw[field];
    assert.equal(ruleSchema.safeParse(raw).success, false, field);
  }
});
test('sources must support their role and overridden conclusions need both documents', () => {
  const wrongSpec = matchResult(); wrongSpec.requirements[0].sources = [evidence('part.pdf')];
  assert.throws(() => validateMatching(wrongSpec, specification, drawingPrepared, specPrepared), /规范原文证据/);
  const wrongFact = matchResult(); wrongFact.drawing.facts = [{ name: 'material', value: 'M', sources: [evidence()] }];
  assert.throws(() => validateMatching(wrongFact, specification, drawingPrepared, specPrepared), /身份事实/);
  const override = matchResult(); override.dispositions[0].status = 'overridden';
  assert.throws(() => validateMatching(override, specification, drawingPrepared, specPrepared), /双方证据/);
});
test('clear visual applicability evidence does not flag an inherited requirement', () => {
  const raw = matchResult(); raw.dispositions[0].evidence = [evidence('part.pdf')];
  const scanned = structuredClone(drawingPrepared); scanned.documents[0].textPages = [''];
  const result = validateMatching(raw, specification, scanned, specPrepared);
  assert.equal(result.dispositions[0].evidence[0].verification, 'visual_review');
  assert.equal(result.requirements[0].review_required, false);
  assert.equal(result.requirements[0].review_note, '');
});

test('clear image-only rules and combined evidence remain unflagged downstream', () => {
  const raw = matchResult(); raw.requirements[0].origin = 'combined';
  raw.requirements[0].sources.push(evidence('part.pdf'));
  raw.dispositions[0].evidence = [evidence(), evidence('part.pdf')];
  const scans = [structuredClone(specPrepared), structuredClone(drawingPrepared)];
  for (const prepared of scans) prepared.documents[0].textPages = [''];
  const result = validateMatching(raw, specification, scans[1], scans[0]);
  assert.ok(result.requirements[0].sources.every(s => s.verification === 'visual_review'));
  assert.equal(result.requirements[0].review_required, false);
  assert.equal(result.requirements[0].review_note, '');
});

test('a missing applicability condition still propagates through clear visual evidence', () => {
  const raw = matchResult(); raw.dispositions[0].status = 'needs_confirmation';
  raw.dispositions[0].reason = '受检区域壁厚未提供';
  const scans = structuredClone(specPrepared); scans.documents[0].textPages = [''];
  const result = validateMatching(raw, specification, drawingPrepared, scans);
  assert.equal(result.dispositions[0].evidence[0].verification, 'visual_review');
  assert.equal(result.requirements[0].review_required, true);
  assert.match(result.requirements[0].review_note, /关联规则或适用条件尚待确认/);
});

test('unlocated applicability evidence without an image still flags linked requirements', () => {
  const raw = matchResult(); raw.dispositions[0].evidence = [evidence('part.pdf')];
  const absent = structuredClone(drawingPrepared); absent.documents[0].textPages = ['']; absent.documents[0].imagePages = [];
  const result = validateMatching(raw, specification, absent, specPrepared);
  assert.equal(result.dispositions[0].evidence[0].verification, 'unmatched_quote');
  assert.equal(result.requirements[0].review_required, true);
  assert.match(result.requirements[0].review_note, /关联规则或适用条件尚待确认/);
});

test('incomplete applicability-page coverage remains a concrete inherited review reason', () => {
  const raw = matchResult(); raw.dispositions[0].evidence = [evidence('part.pdf')];
  const incomplete = structuredClone(drawingPrepared); incomplete.documents[0].needsVisualReview = [1];
  const result = validateMatching(raw, specification, incomplete, specPrepared);
  assert.equal(result.requirements[0].sources[0].verification, 'text_match');
  assert.equal(result.requirements[0].review_required, true);
  assert.match(result.requirements[0].review_note, /关联规则或适用条件尚待确认/);
});
test('drawing and combined requirements need evidence from this drawing', () => {
  const raw = matchResult(); raw.requirements[0].origin = 'combined';
  assert.throws(() => validateMatching(raw, specification, drawingPrepared, specPrepared), /本零件证据/);
  raw.requirements[0].sources.push(evidence('part.pdf'));
  assert.equal(validateMatching(raw, specification, drawingPrepared, specPrepared).requirements.length, 1);
});
test('deduplication preserves distinct conditions, strength and exceptions', () => {
  const first = rule('a'), second = { ...rule('b'), conditions: ['different condition'] };
  assert.notEqual(ruleKey(first), ruleKey(second));
  assert.notEqual(ruleKey(first), ruleKey({ ...first, strength: 'recommended' }));
  const batch = { pages: [{ file: 'spec.pdf', page: 1 }] };
  const result = mergeRules([{ batch, result: { metadata, rules: [first, second], warnings: [] } }], specPrepared.documents);
  assert.deepEqual(result.rules.map(r => r.id), ['R001', 'R002']);
});
test('audit can add a missing rule but cannot modify another page', () => {
  const batch = { pages: [{ file: 'spec.pdf', page: 1 }] };
  const added = { ...rule('ADD1'), conditions: ['new branch'] };
  const result = applyRulePatch(specification, { replacements: [], additions: [added], warnings: [] }, batch, specPrepared.documents);
  assert.equal(result.added, 1); assert.equal(result.result.rules[1].id, 'R002');
  added.sources[0].page = 2;
  assert.throws(() => applyRulePatch(specification, { replacements: [], additions: [added], warnings: [] }, batch, specPrepared.documents), /超出负责页/);
});
test('work queue never exceeds its concurrency', async () => {
  const queue = new WorkQueue(2); let active = 0, maximum = 0, completed = 0;
  await new Promise(resolve => {
    for (let i = 0; i < 5; i++) queue.add(async () => { active++; maximum = Math.max(maximum, active); await new Promise(r => setTimeout(r, 5)); active--; completed++; if (completed === 5) resolve(); });
  });
  assert.equal(maximum, 2);
});
test('drawing audit patches preserve unrelated requirements and reject nonexistent IDs', () => {
  const candidate = matchResult(); candidate.requirements.push({ ...base('REQ002', 'part.pdf'), origin: 'drawing', ruleIds: [] });
  const original = structuredClone(candidate), patch = auditPatch();
  const result = applyDrawingPatch(candidate, patch, specification, drawingPrepared, specPrepared);
  assert.equal(result.result.requirements.length, 2); assert.equal(result.result.requirements[1].id, 'REQ002');
  assert.deepEqual(candidate, original);
  patch.replacements[0].id = 'unknown';
  assert.throws(() => applyDrawingPatch(candidate, patch, specification, drawingPrepared, specPrepared), /不存在的要求/);
});
test('drawing audit removals require evidence and cannot remove a still-applicable requirement', () => {
  const candidate = matchResult(), patch = auditPatch(); patch.replacements = [];
  patch.removals = [{ id: 'REQ001', reason: 'not applicable', evidence: [evidence()] }];
  assert.throws(() => applyDrawingPatch(candidate, patch, specification, drawingPrepared, specPrepared), /结构不符合|缺少要求条目/);
  patch.replacements = matchResult().requirements;
  assert.throws(() => applyDrawingPatch(candidate, patch, specification, drawingPrepared, specPrepared), /同时替换和移除/);
});
test('short source IDs restore only exact aliases and do not guess abbreviated filenames', () => {
  const aliases = sourceAliases(specPrepared, drawingPrepared);
  const transported = mapSourceNames(matchResult(), aliases);
  assert.equal(transported.requirements[0].sources[0].file, 'S1');
  assert.deepEqual(mapSourceNames(transported, aliases, true), matchResult());
  const wrong = matchResult(); wrong.requirements[0].sources[0].file = 'part_internal';
  assert.equal(mapSourceNames(wrong, aliases, true).requirements[0].sources[0].file, 'part_internal');
  assert.throws(() => validateMatching(mapSourceNames(wrong, aliases, true), specification, drawingPrepared, specPrepared), /不属于本次资料/);
});
test('unconfirmed regional wall bands replace geometric inferences with original conditional rules', () => {
  const wall = { ...rule('R001'), category: '内部质量', requirement: '壁厚分档甲/乙按各自限值', parameters: [{ name: '壁厚分档', value: '甲、乙', unit: '' }] };
  const crack = { ...rule('R002'), category: '内部质量', requirement: '不允许裂纹' };
  const spec = { ...specification, rules: [wall, crack] }, raw = matchResult();
  raw.requirements[0] = { ...base('REQ001'), requirement: '以总高83作为壁厚并按乙档执行', origin: 'combined', ruleIds: ['R001', 'R002'], sources: [evidence(), evidence('part.pdf')] };
  raw.dispositions.push({ ruleId: 'R002', status: 'applicable', reason: 'global', evidence: [evidence()] });
  const before = structuredClone(raw), guarded = guardRegionalWallThickness(raw, spec);
  assert.deepEqual(raw, before);
  assert.equal(guarded.result.requirements.length, 2);
  assert.equal(guarded.result.requirements.some(r => /总高83/.test(r.requirement)), false);
  assert.equal(guarded.result.dispositions[0].status, 'needs_confirmation');
  assert.match(guarded.result.requirements[0].requirement, /条件要求/);
  assert.equal(validateMatching(guarded.result, spec, drawingPrepared, specPrepared).ruleCoverage.decided, 2);
  raw.dispositions[1].status = 'overridden';
  assert.throws(() => guardRegionalWallThickness(raw, spec), /混在同一条/);
});
test('proof pressure cannot silently override a conditional leakage-test pressure', () => {
  const leak = { ...rule('R001'), category: '气密性', requirement: '图纸未规定方法时沉水气密试验压力不小于0.6MPa', parameters: [{ name: '气密试验压力', value: '≥0.6', unit: 'MPa' }] };
  const spec = { ...specification, rules: [leak] }, raw = matchResult();
  const proof = { ...evidence('part.pdf'), quote: '所有焊缝均有气密性要求，要求耐压3MPa；' };
  raw.requirements[0] = { ...base('REQ001'), requirement: '沉水气密试验压力3MPa覆盖规范默认值', parameters: [{ name: '最终气密压力', value: '3', unit: 'MPa' }], origin: 'combined', ruleIds: ['R001'], sources: [evidence(), proof] };
  raw.dispositions[0] = { ruleId: 'R001', status: 'overridden', reason: 'proof pressure', evidence: [evidence(), proof] };
  const before = structuredClone(raw), guarded = guardPressurePurpose(raw, spec, drawingPrepared);
  assert.deepEqual(raw, before);
  assert.equal(guarded.changes.length, 1);
  assert.equal(guarded.result.dispositions[0].status, 'needs_confirmation');
  assert.equal(guarded.result.requirements[0].origin, 'specification');
  assert.match(guarded.result.requirements[0].requirement, /条件要求/);
  assert.equal(guarded.result.requirements[0].parameters[0].value, '≥0.6');
  assert.equal(/压力3MPa/.test(guarded.result.requirements[0].requirement), false);
  assert.equal(validateMatching(guarded.result, spec, drawingPrepared, specPrepared).ruleCoverage.decided, 1);
  raw.requirements[0].sources.push({ ...proof, quote: '耐压3MPa。表面处理前进行0.7MPa沉水气密性试验，保压4分钟。' });
  assert.equal(guardPressurePurpose(raw, spec, drawingPrepared).changes.length, 0);
});

test('material section bands stay conditional instead of using a counterbore dimension as stock thickness', () => {
  const dimensional = { ...rule('R001'), category: '力学性能', requirement: '板材厚度甲乙档分别按表中限值', parameters: [{ name: '公称厚度', value: '甲、乙', unit: '' }] };
  const spec = { ...specification, rules: [dimensional] }, raw = matchResult();
  raw.requirements[0].requirement = '由沉孔深度9mm确定原料板厚并选择乙档';
  raw.requirements.push({ ...base('REQ002', 'part.pdf'), origin: 'drawing', ruleIds: [], requirement: '板厚9mm', parameters: [{ name: '板厚', value: '9', unit: 'mm' }] });
  const guarded = guardMaterialSectionDimensions(raw, spec);
  assert.equal(guarded.result.dispositions[0].status, 'needs_confirmation');
  assert.equal(/沉孔深度9/.test(guarded.result.requirements[0].requirement), false);
  assert.deepEqual(guarded.result.requirements[0].parameters, dimensional.parameters);
  assert.match(guarded.result.requirements[1].requirement, /^候选几何对象/);
  assert.equal(guarded.result.requirements[1].parameters[0].value, '9');
  assert.equal(validateMatching(guarded.result, spec, drawingPrepared, specPrepared).ruleCoverage.decided, 1);
});

test('unlocated drawing standard codes remain candidates and are never fuzzily corrected', () => {
  const raw = matchResult();
  raw.drawing.references = ['EN 12345-2 CL1', 'ISO 54321'];
  raw.drawing.facts = [{ name: '认证', value: 'EN 12345-2 CL1', sources: [{ ...evidence('part.pdf'), quote: '部件认证等级 CL1' }] }];
  const prepared = { documents: [{ ...doc('part.pdf'), textPages: ['EN 12346-2 ISO 54321'] }] };
  const guarded = guardDrawingStandardClaims(raw, prepared);
  assert.match(guarded.result.drawing.references[0], /^候选图面引用/);
  assert.equal(guarded.result.drawing.references[1], 'ISO 54321');
  assert.match(guarded.result.drawing.facts[0].value, /^候选标准解释/);
  assert.match(guarded.result.drawing.references[0], /12345/);
  assert.equal(guarded.result.drawing.references[0].includes('12346'), false);
});

test('planned audit may repair a complete JSON candidate, but invalid audit output is never published', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'honghe-two-stage-'));
  try {
    const specText = path.join(root, 'spec.txt'), drawingText = path.join(root, 'drawing.txt');
    await fs.writeFile(specText, 'test requirement'); await fs.writeFile(drawingText, 'test requirement');
    await fs.writeFile(path.join(root, 'prepared.json'), JSON.stringify({ ...specPrepared, sourcePath: specText }));
    const prepared = { ...drawingPrepared, sourcePath: drawingText, images: [], warnings: [], pages: [{ file: 'part.pdf', page: 1, imagePaths: [], landscape: false, text: 'test requirement' }] };
    const job = { id: 'spec', result: specification, fingerprint: { sourceSha256: 'source' } };
    const invalid = matchResult(); invalid.requirements[0].origin = 'combined';
    let calls = 0;
    const successDir = path.join(root, 'repaired');
    const result = await matchDrawing({ file: { name: 'part.pdf' }, directory: successDir, specificationJob: job, specificationDirectory: root, prepare: async () => structuredClone(prepared),
      invoke: async () => ({ result: ++calls === 1 ? structuredClone(invalid) : auditPatch(), metadata: { model: 'deepseek-flash' } }) });
    assert.equal(calls, 2); assert.match(result.run.initialContractError, /本零件证据/);
    assert.equal(JSON.parse(await fs.readFile(path.join(successDir, 'result.json'), 'utf8')).ruleCoverage.decided, 1);
    const failedDir = path.join(root, 'rejected');
    let badCalls = 0; const badPatch = auditPatch(); badPatch.replacements = invalid.requirements;
    await assert.rejects(matchDrawing({ file: { name: 'part.pdf' }, directory: failedDir, specificationJob: job, specificationDirectory: root, prepare: async () => structuredClone(prepared), invoke: async () => ({ result: ++badCalls === 1 ? structuredClone(invalid) : badPatch, metadata: {} }) }), /本零件证据/);
    await assert.rejects(fs.access(path.join(failedDir, 'result.json')));
    const matchingSkill = compileSkill(await loadSkillBundle(DRAWING_SKILL), 'match');
    let retries = 0;
    const retry = await matchDrawing({ file: { name: 'part.pdf' }, directory: path.join(root, 'retry'), specificationJob: job, specificationDirectory: root, prepare: async () => structuredClone(prepared), initialRun: { result: invalid, metadata: { model: 'deepseek-flash', stopReason: 'stop', skillBundleSha256: matchingSkill.bundleSha256, skillSha256: matchingSkill.sha256 } }, retryId: 'test', invoke: async () => { retries++; return { result: auditPatch(), metadata: {} }; } });
    assert.equal(retries, 1); assert.equal(retry.run.reusedMatching, true);
    let reruns = 0;
    const stale = await matchDrawing({ file: { name: 'part.pdf' }, directory: path.join(root, 'stale-retry'), specificationJob: job, specificationDirectory: root,
      prepare: async () => structuredClone(prepared), initialRun: { result: invalid, metadata: { model: 'deepseek-flash', stopReason: 'stop' } },
      invoke: async () => ({ result: ++reruns === 1 ? matchResult() : auditPatch(), metadata: {} }) });
    assert.equal(reruns, 2); assert.equal(stale.run.reusedMatching, false);
  } finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.match(path.basename(root), /^honghe-two-stage-/);
    await fs.rm(root, { recursive: true, force: true });
  }
});
test('two-stage API persists separate parts, caches a specification and hides filesystem paths', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'honghe-two-stage-'));
  let calls = 0;
  const app = express();
  app.use('/api', createTwoStageRouter({ root, configured: () => true,
    build: async () => { calls++; return structuredClone(specification); },
    match: async ({ file }) => { if (file.name === 'bad.pdf') throw new Error('unreadable part'); return { ...matchResult(), part: file.name }; } }));
  app.use((err, _req, res, _next) => res.status(400).json({ error: err.message }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api`;
  const post = async (endpoint, form) => { const response = await fetch(url + endpoint, { method: 'POST', body: form }); return { status: response.status, body: await response.json() }; };
  const get = endpoint => fetch(url + endpoint).then(r => r.json());
  const pdf = name => { const form = new FormData(); form.append('file', new Blob(['%PDF-1.4\ntest']), name); return form; };
  async function waitFor(endpoint, done) { for (let i = 0; i < 100; i++) { const result = await get(endpoint); if (done(result)) return result; await new Promise(r => setTimeout(r, 10)); } throw new Error('test timed out'); }
  try {
    const [created, simultaneous] = await Promise.all([post('/specifications', pdf('spec.pdf')), post('/specifications', pdf('duplicate.pdf'))]);
    assert.equal(created.status, 202); assert.equal(simultaneous.body.id, created.body.id);
    const spec = await waitFor(`/specifications/${created.body.id}`, r => r.status === 'completed');
    assert.equal(JSON.stringify(spec).includes(root), false);
    const reused = await post('/specifications', pdf('same-content.pdf')); assert.equal(reused.body.id, spec.id); assert.equal(reused.body.cached, true); assert.equal(calls, 1);
    const form = new FormData(); form.append('specificationId', spec.id); form.append('files', new Blob(['%PDF-1.4\npart']), 'part.pdf'); form.append('files', new Blob(['%PDF-1.4\nbad']), 'bad.pdf');
    const batch = await post('/drawing-batches', form); assert.equal(batch.status, 202);
    const result = await waitFor(`/drawing-batches/${batch.body.id}`, r => r.status === 'partial');
    assert.equal(result.drawings.length, 2); assert.equal(result.drawings.filter(d => d.status === 'completed').length, 1);
    assert.equal(result.drawings.filter(d => d.status === 'failed').length, 1);
    assert.equal(JSON.stringify(result).includes(root), false);
    const failed = result.drawings.find(d => d.status === 'failed');
    assert.equal((await post(`/drawing-batches/${result.id}/drawings/${failed.id}/retry`)).status, 202);
    const retried = await waitFor(`/drawing-batches/${result.id}`, r => r.status === 'partial');
    assert.equal(retried.drawings.find(d => d.id === failed.id).retryCount, 1);
    assert.equal(retried.drawings.find(d => d.status === 'completed').name, 'part.pdf');
    const interruptedId = '11111111-1111-4111-8111-111111111111';
    const interrupted = { id: interruptedId, status: 'running', drawings: [{ id: 'finished', name: 'one.pdf', status: 'completed', result: { valid: true } }, { id: 'interrupted', name: 'two.pdf', status: 'matching' }] };
    await fs.mkdir(path.join(root, 'drawing-batches', interruptedId));
    await fs.writeFile(path.join(root, 'drawing-batches', interruptedId, 'job.json'), JSON.stringify(interrupted));
    const restored = await get(`/drawing-batches/${interruptedId}`);
    assert.equal(restored.status, 'partial'); assert.equal(restored.drawings[0].status, 'completed'); assert.equal(restored.drawings[1].status, 'failed');
    const invalid = new FormData(); invalid.append('specificationId', 'missing'); invalid.append('files', new Blob(['%PDF-1.4']), 'p.pdf');
    assert.equal((await post('/drawing-batches', invalid)).status, 400);
  } finally {
    await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.match(path.basename(root), /^honghe-two-stage-/);
    await fs.rm(root, { recursive: true, force: true });
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { modelInputJson, writeBatchSource } from '../server/batches.js';
import { matchDrawing, invokeWithContractRetry, digest } from '../server/two-stage-pipeline.js';
import { validateDrawingRead, applyNormMatchDelta } from '../server/two-stage-schema.js';

const source = (file = 'part.pdf') => ({ file, page: 1, section: '模拟条款', quote: '原图明确要求 80±5' });
const document = name => ({ name, pages: 1, textPages: ['原图明确要求 80±5'], imagePages: [1], needsVisualReview: [] });
const row = (id, file = 'part.pdf') => ({
  id, informationType: 'quality', processCategory: '机加', category: '图示标准', requirement: '按 ISO TEST-X，专用值80±5',
  scope: '图示指定对象', parameters: [{ name: '专用值', value: '80±5', unit: 'mm' }], sources: [source(file)],
  review_required: false, review_note: '', origin: 'drawing', ruleIds: [], conflict: null,
});
const drawing = () => ({
  partNumber: 'MOCK-PART', name: '模拟件', revision: 'A', material: '6082', materialForm: '', process: '', castingClass: '',
  airtightness: 'unspecified', dimensionState: 'unspecified', references: ['ISO TEST-X'],
  facts: [{ name: '材料', value: '6082', sources: [source()] }], uncertainties: [],
});
const read = () => ({ drawing: drawing(), summary: '图纸独立识读', requirements: [row('D-001')], dispositions: [], warnings: [] });
const specification = () => ({
  scopePolicy: 'drawing-plus-inspection-v1', metadata: { number: 'MOCK-SPEC', version: '1' }, warnings: [],
  rules: [{ ...row('R-001', 'spec.pdf'), processCategory: '检验', strength: 'required', conditions: [], exceptions: [],
    overridePolicy: '', externalReferences: [], usage: 'inspection', sources: [{ ...source('spec.pdf'), verification: 'text_match' }] }],
});
const delta = () => ({
  additions: [{ ...row('N-001', 'spec.pdf'), processCategory: '检验', origin: 'specification', ruleIds: ['R-001'] }],
  bindings: [], dispositions: [{ ruleId: 'R-001', status: 'applicable', reason: '本件适用', evidence: [source('spec.pdf')] }], warnings: [],
});
const audit = () => ({ drawing: drawing(), summary: '', replacements: [], additions: [], removals: [], dispositionReplacements: [], warnings: [] });
const block = (input, tag) => JSON.parse(input.split(`<${tag}>`)[1].split(`</${tag}>`)[0]);
async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'honghe-model-input-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.match(path.basename(directory), /^honghe-model-input-/);
    await fs.rm(directory, { recursive: true, force: true });
  });
  return directory;
}

test('model-input serialization removes only derived source verification and preserves the original object hash', () => {
  const verified = { ...source(), verification: 'visual_review' };
  const value = { verification: 'ordinary non-source field', rows: [{ sources: [verified], parameters: [{ name: 'a', value: '-0.2', unit: 'mm' }] }],
    facts: [{ sources: [verified] }], dispositions: [{ evidence: [verified] }], literal: 'verification is also a possible word in original text' };
  const before = structuredClone(value), beforeHash = digest(JSON.stringify(value));
  const clean = JSON.parse(modelInputJson(value));
  const expected = structuredClone(value);
  delete expected.rows[0].sources[0].verification;
  delete expected.facts[0].sources[0].verification;
  delete expected.dispositions[0].evidence[0].verification;
  assert.deepEqual(clean, expected);
  assert.deepEqual(value, before);
  assert.equal(digest(JSON.stringify(value)), beforeHash);
});

test('specification audit input omits source verification without changing its source or extraction records', async t => {
  const directory = await temporary(t), sourcePath = path.join(directory, 'original.txt');
  await fs.writeFile(sourcePath, '原始规范文字保持原样');
  const originalHash = digest(await fs.readFile(sourcePath)), candidate = specification(), before = structuredClone(candidate);
  const batch = { pages: [{ file: 'spec.pdf', page: 1, imagePaths: ['page.png'] }] };
  const inputPath = await writeBatchSource(path.join(directory, 'audit'), { sourcePath }, batch, candidate);
  const submitted = block(await fs.readFile(inputPath, 'utf8'), 'COMPLETE_EXTRACTION_RESULT_DATA');
  assert.deepEqual(submitted.rules[0].sources, [source('spec.pdf')]);
  assert.deepEqual(candidate, before);
  assert.equal(digest(await fs.readFile(sourcePath)), originalHash);
});

test('drawing read, norm match and audit receive clean source JSON while saved backend verification and original bytes remain intact', async t => {
  const directory = await temporary(t), sourcePath = path.join(directory, 'drawing.txt'), specText = path.join(directory, 'spec.txt');
  const pdf = path.join(directory, 'source.pdf');
  await fs.writeFile(pdf, '%PDF-mock-original-bytes');
  await fs.writeFile(sourcePath, '原图明确要求 80±5');
  await fs.writeFile(specText, '原图明确要求 80±5');
  const sourceHash = digest(await fs.readFile(pdf)), textHash = digest(await fs.readFile(sourcePath));
  const spec = specification(), specBefore = structuredClone(spec), specHash = digest(JSON.stringify(spec));
  await fs.writeFile(path.join(directory, 'prepared.json'), JSON.stringify({ sourcePath: specText, documents: [document('spec.pdf')] }));
  const prepared = { sourcePath, documents: [document('part.pdf')], images: ['page.png'], warnings: [],
    pages: [{ file: 'part.pdf', page: 1, imagePaths: ['page.png'] }] };
  const modes = [], modelOutputs = [];
  const result = await matchDrawing({ file: { name: 'part.pdf', path: pdf }, directory: path.join(directory, 'drawing'),
    specificationJob: { id: 'spec', fingerprint: { sourceSha256: 'original-spec-hash' }, result: spec }, specificationDirectory: directory,
    prepare: async () => structuredClone(prepared), invoke: async options => {
      const input = await fs.readFile(options.sourcePath, 'utf8'), mode = options.skillProvenance.mode;
      modes.push(mode);
      assert.doesNotMatch(input, /"verification"\s*:/);
      if (mode === 'match') {
        const rules = block(input, 'SELECTED_SPECIFICATION_RULE_PACKAGE');
        assert.deepEqual(rules.rules[0].sources, [{ ...source('S1') }]);
        const conditions = block(input, 'DRAWING_MATCHING_CONDITIONS_DATA');
        assert.deepEqual(conditions.technicalConstraints[0].sources, [source('D1')]);
        assert.equal(conditions.technicalConstraints[0].id, 'D-001');
        assert.equal(conditions.technicalConstraints[0].requirement, '按 ISO TEST-X，专用值80±5');
      }
      if (mode === 'audit') {
        const candidate = block(input, 'CANDIDATE_RESULT_DATA');
        assert.equal(candidate.requirements[0].id, 'D-001');
        assert.deepEqual(candidate.requirements[0].sources, [source('D1')]);
        assert.deepEqual(candidate.dispositions[0].evidence, [source('S1')]);
      }
      const output = mode === 'read' ? read() : mode === 'match' ? delta() : audit();
      const outputHash = digest(JSON.stringify(output));
      modelOutputs.push({ output, outputHash });
      return { result: output, metadata: { model: 'deepseek-flash' } };
    } });
  assert.deepEqual(modes, ['read', 'match', 'audit']);
  assert.equal(result.run.pipelineVersion, 'two-stage-v21-clean-input');
  assert.equal(result.requirements[0].sources[0].verification, 'text_match');
  const saved = JSON.parse(await fs.readFile(path.join(directory, 'drawing/drawing-read.json'), 'utf8'));
  assert.equal(saved.requirements[0].sources[0].verification, 'text_match');
  assert.deepEqual(saved.requirements[0].parameters, read().requirements[0].parameters);
  assert.deepEqual(spec, specBefore);
  assert.equal(digest(JSON.stringify(spec)), specHash);
  assert.equal(digest(await fs.readFile(pdf)), sourceHash);
  assert.equal(digest(await fs.readFile(sourcePath)), textHash);
  for (const { output, outputHash } of modelOutputs) assert.equal(digest(JSON.stringify(output)), outputHash);
});

test('a strict-output rejection stays strict while only the retry context drops derived source verification', async t => {
  const directory = await temporary(t), sourcePath = path.join(directory, 'read-input.txt');
  await fs.writeFile(sourcePath, '原始图纸输入 80±5');
  const sourceHash = digest(await fs.readFile(sourcePath)), invalid = read();
  invalid.requirements[0].sources[0].verification = 'visual_review';
  const invalidHash = digest(JSON.stringify(invalid)), drawingPrepared = { documents: [document('part.pdf')] };
  assert.throws(() => validateDrawingRead(invalid, drawingPrepared), /verification/);
  const badDelta = delta();
  badDelta.additions[0].sources[0].verification = 'text_match';
  assert.throws(() => applyNormMatchDelta(validateDrawingRead(read(), drawingPrepared), badDelta, specification(), drawingPrepared,
    { documents: [document('spec.pdf')] }), /verification/);
  let calls = 0;
  await invokeWithContractRetry({ invocation: { directory: path.join(directory, 'read'), sourcePath },
    validate: value => validateDrawingRead(value, drawingPrepared), invoke: async options => {
      if (++calls === 2) {
        const retry = block(await fs.readFile(options.sourcePath, 'utf8'), 'FAILED_CANDIDATE_AND_DIAGNOSTIC_DATA');
        assert.match(retry.diagnostic, /verification/);
        assert.deepEqual(retry.result.requirements[0].sources, [source()]);
      }
      return { result: calls === 1 ? invalid : read(), metadata: { model: 'fake' } };
    } });
  assert.equal(calls, 2);
  const failure = JSON.parse(await fs.readFile(path.join(directory, 'read/contract-failure.json'), 'utf8'));
  assert.equal(failure.result.requirements[0].sources[0].verification, 'visual_review');
  assert.equal(digest(JSON.stringify(invalid)), invalidHash);
  assert.equal(digest(await fs.readFile(sourcePath)), sourceHash);
});

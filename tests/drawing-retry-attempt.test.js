import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { createTwoStageRouter } from '../server/two-stage-routes.js';
import { matchDrawing } from '../server/two-stage-pipeline.js';
import { SCOPE_POLICY } from '../server/information-types.js';

const evidence = file => ({ file, page: 1, section: '模拟原文', quote: '测试原文' });
const doc = name => ({ name, pages: 1, textPages: ['测试原文'], imagePages: [1], needsVisualReview: [] });
const inspection = {
  id: 'R001', category: '表面质量', requirement: '表面不允许损伤', scope: '本件', informationType: 'quality',
  processCategory: '检验', parameters: [], sources: [evidence('spec.pdf')], review_required: false, review_note: '',
  usage: 'inspection', strength: 'required', conditions: [], exceptions: [], overridePolicy: '图纸优先', externalReferences: [],
};
const specification = {
  metadata: { number: 'MOCK-SPEC', title: '模拟规范', version: '1', scope: '测试', excludedProcesses: [], priorityPolicy: '图纸优先' },
  scopePolicy: SCOPE_POLICY, rules: [inspection], warnings: [],
};
const reading = material => ({
  drawing: { partNumber: 'MOCK-PART', name: '模拟零件', revision: 'A', material, materialForm: '', process: '',
    castingClass: '', airtightness: 'unspecified', dimensionState: 'unspecified', references: [], facts: [], uncertainties: [] },
  summary: '仅图纸读取',
  requirements: [{
    id: 'D001', category: '材料', requirement: material, scope: '本件', informationType: 'quality', processCategory: '其他',
    parameters: [], sources: [evidence('part.pdf')], review_required: false, review_note: '', origin: 'drawing', ruleIds: [], conflict: null,
  }],
  dispositions: [], warnings: [],
});
const delta = () => ({
  additions: [{
    id: 'N001', category: '表面质量', requirement: '表面不允许损伤', scope: '本件', informationType: 'quality', processCategory: '检验',
    parameters: [], sources: [evidence('spec.pdf')], review_required: false, review_note: '', origin: 'specification', ruleIds: ['R001'], conflict: null,
  }],
  bindings: [], dispositions: [{ ruleId: 'R001', status: 'applicable', reason: '本件适用', evidence: [evidence('spec.pdf')] }], warnings: [],
});

test('ordinary API retry preserves a reviewable first result when bounded rematching still changes conditions', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'honghe-retry-attempt-'));
  const specId = '11111111-1111-4111-8111-111111111111';
  const specDirectory = path.join(root, 'specifications', specId);
  await fs.mkdir(specDirectory, { recursive: true });
  const specSource = path.join(specDirectory, 'source.txt');
  await fs.writeFile(specSource, '测试原文', { flag: 'wx' });
  await fs.writeFile(path.join(specDirectory, 'prepared.json'), JSON.stringify({ documents: [doc('spec.pdf')], sourcePath: specSource }), { flag: 'wx' });
  await fs.writeFile(path.join(specDirectory, 'source.pdf'), '%PDF-1.4 mock spec', { flag: 'wx' });
  await fs.writeFile(path.join(specDirectory, 'job.json'), JSON.stringify({
    id: specId, status: 'completed', createdAt: '2026-01-01T00:00:00.000Z',
    file: { name: 'spec.pdf', path: path.join(specDirectory, 'source.pdf') },
    fingerprint: { sourceSha256: 'mock-spec-sha' }, result: specification,
  }), { flag: 'wx' });

  const calls = [], prepareDirectories = [];
  const app = express();
  app.use('/api', createTwoStageRouter({
    root, configured: () => true,
    match: options => matchDrawing({
      ...options,
      prepare: async (files, directory, requestedOptions) => {
        assert.deepEqual(requestedOptions, { detailMode: true, ocr: true });
        assert.equal(files[0].name, 'part.pdf');
        await fs.mkdir(directory, { recursive: true });
        prepareDirectories.push(directory);
        const sourcePath = path.join(directory, 'source-input.txt');
        const ocrTextPath = path.join(directory, 'ocr-candidates.txt');
        await fs.writeFile(sourcePath, '测试原文', { flag: 'wx' });
        await fs.writeFile(ocrTextPath, '模拟OCR候选，不是原文', { flag: 'wx' });
        return { documents: [doc('part.pdf')], sourcePath, ocrTextPath, images: [], warnings: [],
          pages: [{ docId: 'doc-1', file: 'part.pdf', page: 1, text: '测试原文', imagePaths: [], landscape: false }] };
      },
      invoke: async invocation => {
        const mode = invocation.skillProvenance.mode;
        const retry = invocation.directory.includes(path.sep + 'attempts' + path.sep);
        const material = retry ? 'P' : 'M';
        calls.push({ mode, retry, directory: invocation.directory });
        await fs.mkdir(invocation.directory, { recursive: true });
        assert.ok((await fs.readFile(invocation.sourcePath, 'utf8')).length > 0);
        let result;
        if (mode === 'read') result = reading(material);
        else if (mode === 'match') result = delta();
        else {
          assert.equal(mode, 'audit');
          const corrected = retry || invocation.directory.includes(path.sep + 'rematch-1' + path.sep) ? 'P' : 'N';
          result = { drawing: reading(corrected).drawing, summary: '按原图纠正后审计',
            replacements: retry ? [] : reading(corrected).requirements, additions: [], removals: [], dispositionReplacements: [], warnings: [] };
        }
        const metadata = { model: 'deepseek-flash', stopReason: 'stop', mode,
          skillBundleSha256: invocation.skillProvenance.bundleSha256, skillSha256: invocation.skillProvenance.promptSha256 };
        await fs.writeFile(path.join(invocation.directory, 'model-result.json'), JSON.stringify(result), { flag: 'wx' });
        await fs.writeFile(path.join(invocation.directory, 'run-metadata.json'), JSON.stringify(metadata), { flag: 'wx' });
        return { result, metadata };
      },
    }),
  }));
  app.use((error, _request, response, _next) => response.status(400).json({ error: error.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.match(path.basename(root), /^honghe-retry-attempt-/);
    await fs.rm(root, { recursive: true, force: true });
  });
  const url = 'http://127.0.0.1:' + server.address().port + '/api';
  const get = endpoint => fetch(url + endpoint).then(response => response.json());
  const post = async (endpoint, body) => {
    const response = await fetch(url + endpoint, { method: 'POST', body });
    return { status: response.status, body: await response.json() };
  };
  const wait = async (endpoint, condition) => {
    for (let index = 0; index < 100; index++) {
      const result = await get(endpoint);
      if (condition(result)) return result;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('mock API task did not finish');
  };

  const partBytes = Buffer.from('%PDF-1.4 original-part-bytes');
  const form = new FormData();
  form.append('specificationId', specId);
  form.append('files', new Blob([partBytes]), 'part.pdf');
  const created = await post('/drawing-batches', form);
  assert.equal(created.status, 202);
  const endpoint = '/drawing-batches/' + created.body.id;
  const failed = await wait(endpoint, result => result.status === 'completed');
  const drawingId = failed.drawings[0].id;
  const firstDirectory = path.join(root, 'drawing-batches', failed.id, drawingId);
  assert.equal(failed.drawings[0].error, undefined);
  assert.equal(failed.drawings[0].result.review.status, 'needs_review');
  assert.match(failed.drawings[0].message, /待复核/);
  assert.equal(failed.drawings[0].result.ruleCoverage.decided, 0);
  assert.equal(failed.drawings[0].result.ruleCoverage.pending, 1);
  assert.equal(failed.drawings[0].result.drawing.material, 'P');
  const summary = await get('/drawing-batches?specificationId=' + specId);
  assert.equal(summary.batches[0].drawings[0].reviewStatus, 'needs_review');
  assert.equal(summary.batches[0].drawings[0].reviewRequiredCount, 2);
  assert.equal(JSON.stringify(failed).includes(root), false);
  assert.equal(JSON.parse(await fs.readFile(path.join(firstDirectory, 'audited-result.json'), 'utf8')).drawing.material, 'N');
  assert.equal(JSON.parse(await fs.readFile(path.join(firstDirectory, 'rematch-1/audited-result.json'), 'utf8')).drawing.material, 'P');
  assert.match(JSON.parse(await fs.readFile(path.join(firstDirectory, 'rematch-1/rematch-required.json'), 'utf8')).reason, /重新匹配/);
  assert.match(JSON.parse(await fs.readFile(path.join(firstDirectory, 'rematch-required.json'), 'utf8')).reason, /重新匹配/);
  await fs.access(path.join(firstDirectory, 'result.json'));
  const historyPaths = [
    'result.json', 'prepared.json', 'prepared/source-input.txt', 'prepared/ocr-candidates.txt',
    'drawing-read-input.txt', 'drawing-read.json', 'matching-conditions.json', 'matching-input.txt',
    'norm-match-delta.json', 'matched-result.json', 'review-input.txt', 'audited-result.json', 'rematch-required.json',
    'reading/model-result.json', 'reading/run-metadata.json', 'matching/model-result.json', 'matching/run-metadata.json',
    'audit/model-result.json', 'audit/run-metadata.json',
    'rematch-1/drawing-read.json', 'rematch-1/rebaseline-provenance.json', 'rematch-1/matching-conditions.json',
    'rematch-1/matching-input.txt', 'rematch-1/norm-match-delta.json', 'rematch-1/matched-result.json',
    'rematch-1/review-input.txt', 'rematch-1/audited-result.json', 'rematch-1/rematch-required.json',
    'rematch-1/matching/model-result.json', 'rematch-1/matching/run-metadata.json',
    'rematch-1/audit/model-result.json', 'rematch-1/audit/run-metadata.json',
  ];
  const originalArtifacts = new Map(await Promise.all(historyPaths.map(async relative => [relative, await fs.readFile(path.join(firstDirectory, relative))])));
  assert.deepEqual(calls.map(call => call.mode), ['read', 'match', 'audit', 'match', 'audit']);
  await assert.rejects(fs.access(path.join(firstDirectory, 'rematch-2')));
  await assert.rejects(fs.access(path.join(firstDirectory, 'rematch-1/audit/contract-failure.json')));

  const retried = await post(endpoint + '/drawings/' + drawingId + '/retry');
  assert.equal(retried.status, 202);
  const completed = await wait(endpoint, result => result.status === 'completed');
  const completedDrawing = completed.drawings[0];
  assert.equal(completedDrawing.result.drawing.material, 'P');
  assert.equal(completedDrawing.retryCount, 1);
  assert.match(completedDrawing.attemptId, /^[a-f0-9-]{36}$/);
  assert.equal(completedDrawing.result.run.attemptId, completedDrawing.attemptId);
  assert.equal(completedDrawing.result.run.reusedMatching, false);
  assert.equal(JSON.stringify(completed).includes(root), false);
  const nextDirectory = path.join(firstDirectory, 'attempts', completedDrawing.attemptId);
  const savedResult = JSON.parse(await fs.readFile(path.join(nextDirectory, 'result.json'), 'utf8'));
  assert.equal(savedResult.drawing.material, 'P');
  assert.equal(savedResult.run.attemptId, completedDrawing.attemptId);
  assert.deepEqual(calls.map(call => call.mode), ['read', 'match', 'audit', 'match', 'audit', 'read', 'match', 'audit']);
  assert.deepEqual(calls.map(call => call.retry), [false, false, false, false, false, true, true, true]);
  assert.deepEqual(prepareDirectories, [path.join(firstDirectory, 'prepared'), path.join(nextDirectory, 'prepared')]);
  for (const [relative, content] of originalArtifacts) assert.deepEqual(await fs.readFile(path.join(firstDirectory, relative)), content, relative + ' must remain unchanged');
  assert.deepEqual(await fs.readFile(path.join(firstDirectory, 'source.pdf')), partBytes);
  await fs.access(path.join(firstDirectory, 'result.json'));
});

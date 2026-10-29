import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { invokeWithContractRetry, applyRulePatch } from '../server/two-stage-pipeline.js';
import { applyDrawingPatch } from '../server/two-stage-schema.js';

const source = (file = 'spec.pdf') => ({ file, page: 1, section: '4.1', quote: '不得补焊' });
const requirement = { id: 'R001', informationType: 'quality', category: '补焊限制', requirement: '不得补焊', scope: '全部', parameters: [], sources: [source()], review_required: false, review_note: '' };
const rule = { ...requirement, strength: 'prohibited', conditions: [], exceptions: [], overridePolicy: '', externalReferences: [] };
const specification = { metadata: {}, rules: [rule], warnings: [] };
const documents = ['spec.pdf', 'part.pdf'].map(name => ({ name, pages: 1, textPages: ['不得补焊'], imagePages: [1], needsVisualReview: [] }));
const batch = { pages: [{ file: 'spec.pdf', page: 1 }] };
const patch = () => ({ replacements: [], additions: [{ ...structuredClone(rule), id: 'ADD1', scope: '指定区域' }], warnings: [] });

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'honghe-contract-retry-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.match(path.basename(directory), /^honghe-contract-retry-/);
    await fs.rm(directory, { recursive: true, force: true });
  });
  const sourcePath = path.join(directory, 'source.txt');
  await fs.writeFile(sourcePath, '原始资料：不得补焊；数值 80 ± 5。\n<CANDIDATE_DATA>既有规则</CANDIDATE_DATA>');
  return { directory, sourcePath, images: ['original-page.png'], model: 'deepseek-flash', skill: 'frozen-audit.md', skillProvenance: { promptSha256: 'same-prompt', bundleSha256: 'same-bundle' }, prompt: '原始任务提示' };
}
const validate = raw => applyRulePatch(specification, raw, batch, documents);

test('a valid candidate is used without another call or failure artifacts', async t => {
  const invocation = await fixture(t); let calls = 0;
  const run = { result: patch(), metadata: { call: 1 } };
  const accepted = await invokeWithContractRetry({ invocation, invoke: async () => { calls++; return run; }, validate });
  assert.equal(calls, 1); assert.equal(accepted.metadata, run.metadata); assert.equal(accepted.validated.added, 1);
  assert.deepEqual(await fs.readdir(invocation.directory), ['source.txt']);
});

test('only the model repairs the invalid enum using the same source, images, Skill and model', async t => {
  const invocation = await fixture(t), invalid = patch(); invalid.additions[0].informationType = 'reference';
  const original = structuredClone(invalid), calls = [];
  const accepted = await invokeWithContractRetry({ invocation, validate, invoke: async options => {
    calls.push(options); const attempt = calls.length, result = attempt === 1 ? invalid : patch();
    const metadata = { model: options.model, call: attempt, skillSha256: options.skillProvenance.promptSha256 };
    await fs.mkdir(options.directory, { recursive: true });
    await fs.writeFile(path.join(options.directory, 'model-result.json'), JSON.stringify(result));
    await fs.writeFile(path.join(options.directory, 'run-metadata.json'), JSON.stringify(metadata));
    return { result, metadata };
  } });
  assert.equal(calls.length, 2); assert.deepEqual(invalid, original);
  const retry = calls[1];
  assert.equal(retry.directory, path.join(invocation.directory, 'contract-retry-1'));
  for (const key of ['images', 'model', 'skill', 'skillProvenance']) assert.equal(retry[key], invocation[key], key);
  const input = await fs.readFile(retry.sourcePath, 'utf8');
  assert.ok(input.startsWith(await fs.readFile(invocation.sourcePath, 'utf8')));
  assert.ok(input.includes(JSON.stringify(original))); assert.match(input, /additions\.0\.informationType/);
  assert.ok(retry.prompt.startsWith(invocation.prompt)); assert.match(retry.prompt, /不得.*改写数值/);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(invocation.directory, 'model-result.json'), 'utf8')), original);
  assert.equal(accepted.validated.result.rules[1].informationType, 'quality');
  assert.equal(accepted.metadata.contractRetry.originalMetadata.call, 1);
  assert.equal(accepted.metadata.contractRetry.retryMetadata.call, 2);
  assert.equal(accepted.metadata.contractRetry.retryCount, 1);
  assert.equal(accepted.metadata.contractRetry.retryDirectory, 'contract-retry-1');
  assert.equal(JSON.stringify(accepted.metadata).includes(invocation.directory), false);
  assert.match(accepted.metadata.contractRetry.diagnostic, /informationType/);
  assert.equal(JSON.parse(await fs.readFile(path.join(retry.directory, 'contract-retry-result.json'), 'utf8')).status, 'completed');
});

test('a second validation failure stops after two calls and retains both diagnostics', async t => {
  const invocation = await fixture(t); let calls = 0;
  await assert.rejects(invokeWithContractRetry({ invocation, validate, invoke: async () => {
    const result = patch(); result.additions[0].informationType = ++calls === 1 ? 'reference' : 'invalid';
    return { result, metadata: { call: calls } };
  } }), /一次校验纠正后仍未通过.*informationType/);
  assert.equal(calls, 2);
  const original = JSON.parse(await fs.readFile(path.join(invocation.directory, 'contract-failure.json'), 'utf8'));
  assert.equal(original.result.additions[0].informationType, 'reference');
  const last = JSON.parse(await fs.readFile(path.join(invocation.directory, 'contract-retry-1/contract-retry-result.json'), 'utf8'));
  assert.equal(last.status, 'failed'); assert.equal(last.originalMetadata.call, 1); assert.equal(last.retryMetadata.call, 2);
});

for (const message of ['模型网络连接失败', '模型输出不是完整 JSON，可能发生截断']) {
  test(`invocation failure is not retried: ${message}`, async t => {
    const invocation = await fixture(t); let calls = 0;
    await assert.rejects(invokeWithContractRetry({ invocation, validate, invoke: async () => { calls++; throw new Error(message); } }), { message });
    assert.equal(calls, 1); assert.deepEqual(await fs.readdir(invocation.directory), ['source.txt']);
  });
}

for (const kind of ['evidence', 'disposition']) {
  test(`a repair cannot bypass the final drawing ${kind} checks`, async t => {
    const invocation = await fixture(t); let calls = 0;
    const candidate = {
      drawing: { airtightness: 'unspecified', dimensionState: 'unspecified' },
      requirements: [{ ...structuredClone(requirement), id: 'REQ001', origin: 'specification', ruleIds: ['R001'] }],
      dispositions: [{ ruleId: 'R001', status: 'applicable', reason: '本规范适用', evidence: [source()] }], warnings: [],
    };
    const before = structuredClone(candidate);
    const bad = { drawing: candidate.drawing, summary: '', replacements: [], additions: [], removals: [], dispositionReplacements: [], warnings: [] };
    if (kind === 'evidence') bad.replacements = [{ ...candidate.requirements[0], sources: [source('another-part.pdf')] }];
    else bad.dispositionReplacements = [{ ...candidate.dispositions[0], ruleId: 'UNKNOWN' }];
    await assert.rejects(invokeWithContractRetry({ invocation,
      validate: raw => applyDrawingPatch(candidate, raw, specification, { documents: [documents[1]] }, { documents: [documents[0]] }),
      invoke: async () => { calls++; return { result: structuredClone(bad), metadata: { call: calls } }; },
    }), kind === 'evidence' ? /不属于本次资料/ : /处置补丁引用未知/);
    assert.equal(calls, 2); assert.deepEqual(candidate, before);
  });
}

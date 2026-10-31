import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const project = fileURLToPath(new URL('../', import.meta.url));
try { process.loadEnvFile(path.join(project, '.env')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const python = process.env.PYTHON_PATH || (process.platform === 'win32' ? 'python' : 'python3');
const execute = promisify(execFile);
const sid = '11111111-1111-1111-1111-111111111111';
const bid1 = '22222222-2222-2222-2222-222222222222', bid2 = '33333333-3333-3333-3333-333333333333';
const policy = 'drawing-plus-inspection-v1';
const requirement = (id, extra = {}) => ({ id, category: '焊缝要求', processCategory: '焊接', requirement: '不得补焊 </script><img src=x onerror=alert(1)>', informationType: 'manufacturing', sources: [{ file: 'part.pdf', page: 1, quote: '不得补焊' }], review_required: true, review_note: '标准号待核对', conflict: { kind: 'conflict', specificationRequirement: '可修复', reason: '要求不同' }, ...extra });
const part = (id, sourceSha256, extra = {}) => ({ id, name: id + '.pdf', sourceSha256, status: 'completed', file: { path: 'PRIVATE_DISK_PATH' }, result: { scopePolicy: policy, drawing: { name: id, partNumber: 'P1', uncertainties: [] }, requirements: [requirement(id)], warnings: ['【原图复核】保留此提示'], dispositions: [], run: { model: 'deepseek-flash', prompt: 'PRIVATE_PROMPT', apiKey: 'PRIVATE_API_KEY' }, ...extra } });
async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'static-export-'));
  const specs = { id: sid, status: 'completed', sourceSha256: 'spec-hash', file: { path: 'PRIVATE_DISK_PATH' }, result: { scopePolicy: policy, metadata: { number: 'SPEC', title: '规范', version: '1', scope: '金属件' }, rules: [{ ...requirement('R1'), usage: 'inspection' }, { ...requirement('R2'), usage: 'comparison' }], warnings: [] } };
  const batches = { [bid1]: { id: bid1, status: 'completed', specificationId: sid, stage: 'all', drawings: [part('old', 'same-hash')] }, [bid2]: { id: bid2, status: 'completed', specificationId: sid, stage: 'all', drawings: [part('new', 'same-hash'), part('second', 'another-hash', { requirements: [requirement('second', { processCategory: '检验', conflict: null })] })] } };
  const requests = [], server = http.createServer((req, res) => {
    requests.push({ url: req.url, method: req.method }); res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (req.url === '/api/specifications/' + sid) return res.end(JSON.stringify(specs));
    const batch = batches[req.url?.split('/').at(-1)];
    res.statusCode = batch ? 200 : 404; res.end(JSON.stringify(batch || { error: 'missing' }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const state = path.join(directory, 'state.json'), output = path.join(directory, 'report.html');
  await fs.writeFile(state, JSON.stringify({ specifications: { TMT0103: sid }, batches: [{ series: 'TMT0103', id: bid1 }, { series: 'TMT0103', id: bid2 }] }));
  const run = (extra = []) => execute(python, [path.join(project, 'scripts/export_static.py'), '--state-file', state, '--base-url', `http://127.0.0.1:${server.address().port}`, '--output', output, ...extra], { windowsHide: true, timeout: 20000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  return { directory, state, output, run, batches, requests, close: async () => { server.close(); await once(server, 'close'); assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('static-export-')); await fs.rm(directory, { recursive: true, force: true }); } };
}

test('static export follows explicit batch bindings, includes new business fields and has no fixed row count', async () => {
  const f = await fixture();
  try {
    await f.run(); const html = await fs.readFile(f.output, 'utf8');
    const data = JSON.parse(html.match(/<script id="report-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
    assert.deepEqual(data.totals, { specifications: 1, drawings: 2, requirements: 2 });
    const spec = data.specifications[0]; assert.equal(spec.scopePolicy, policy); assert.deepEqual(spec.rules.map(r => r.usage), ['inspection', 'comparison']);
    assert.deepEqual(spec.drawings.map(d => d.id), ['new', 'second']);
    assert.equal(spec.drawings[0].requirements[0].processCategory, '焊接');
    assert.equal(spec.drawings[0].requirements[0].conflict.specificationRequirement, '可修复');
    assert.equal(spec.drawings[0].warnings[0], '【原图复核】保留此提示');
    for (const secret of ['PRIVATE_DISK_PATH', 'PRIVATE_PROMPT', 'PRIVATE_API_KEY']) assert.ok(!html.includes(secret), secret);
    assert.ok(!html.includes('</script><img'));
    assert.equal(spec.drawings[0].requirements[0].requirement, requirement('new').requirement);
    const script = html.match(/<script>([\s\S]*?)<\/script>/)[1]; assert.doesNotThrow(() => new vm.Script(script));
    assert.ok(!/\b(fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/.test(script));
    assert.ok(!/<script\b[^>]*\bsrc=|<link\b|<iframe\b/.test(html));
    assert.ok(f.requests.every(r => r.method === 'GET'));
  } finally { await f.close(); }
});

test('static export rejects a batch bound to a different specification without publishing a partial file', async () => {
  const f = await fixture();
  try {
    f.batches[bid2].specificationId = '44444444-4444-4444-4444-444444444444';
    await assert.rejects(f.run(), /exactly linked/);
    await assert.rejects(fs.access(f.output), { code: 'ENOENT' });
  } finally { await f.close(); }
});

test('static export rejects unfinished drawings and invalid selected IDs', async () => {
  const f = await fixture();
  try {
    f.batches[bid2].drawings[0].status = 'running'; await assert.rejects(f.run(), /incomplete/);
    await assert.rejects(fs.access(f.output), { code: 'ENOENT' });
    await fs.writeFile(f.state, JSON.stringify({ specifications: { TMT0103: '../wrong' }, batches: [] }));
    await assert.rejects(f.run(), /Invalid specification ID/);
  } finally { await f.close(); }
});

test('static export retains successful parts from a partial batch after later same-source successes replace its failed parts', async () => {
  const f = await fixture();
  try {
    const failed = { ...part('failed-old', 'another-hash'), status: 'failed', result: null };
    const retained = { ...part('retained', 'retained-hash'), name: 'shared.pdf' };
    f.batches[bid1].status = 'partial';
    f.batches[bid1].drawings.push(failed, retained);
    f.batches[bid2].drawings[0].name = 'shared.pdf';
    await f.run();
    const html = await fs.readFile(f.output, 'utf8');
    const data = JSON.parse(html.match(/<script id="report-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
    assert.deepEqual(data.totals, { specifications: 1, drawings: 3, requirements: 3 });
    assert.deepEqual(data.specifications[0].drawings.map(d => d.id), ['new', 'second', 'retained']);
    assert.equal(data.specifications[0].drawings.filter(d => d.filename === 'shared.pdf').length, 2);
    assert.equal(f.batches[bid1].status, 'partial');
    assert.equal(failed.status, 'failed');
    assert.equal(failed.result, null);
  } finally { await f.close(); }
});

test('static export refuses the latest failed same-source attempt instead of falling back to an older success', async () => {
  const f = await fixture();
  try {
    f.batches[bid2].status = 'partial';
    f.batches[bid2].drawings[0].status = 'failed';
    f.batches[bid2].drawings[0].result = null;
    await assert.rejects(f.run(), /Latest selected drawing result is incomplete: .*\/new \(failed\)/);
    await assert.rejects(fs.access(f.output), { code: 'ENOENT' });
    assert.equal(f.batches[bid1].drawings[0].status, 'completed');
  } finally { await f.close(); }
});

test('explicit status export retains latest failed and pending cards, never stale requirements or private diagnostics', async () => {
  const f = await fixture();
  try {
    const batch = f.batches[bid2];
    batch.status = 'partial'; batch.createdAt = '2026-10-31T01:00:00Z'; batch.updatedAt = '2026-10-31T02:00:00Z';
    Object.assign(batch.drawings[0], { status: 'failed', attemptId: 'latest-failed', error: '原图复核未通过。C:/private/prompt.txt\nsk-abcdefghijklmnopqrstuv' });
    // Retained result is deliberately populated to prove a failed attempt cannot publish it.
    Object.assign(batch.drawings[1], { status: 'reading', attemptId: 'latest-pending', message: '识读图纸' });
    await f.run(['--allow-incomplete']);
    const html = await fs.readFile(f.output, 'utf8');
    const data = JSON.parse(html.match(/<script id="report-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
    assert.deepEqual(data.totals, { specifications: 1, drawings: 2, requirements: 0 });
    const drawings = data.specifications[0].drawings;
    assert.deepEqual(drawings.map(d => [d.id, d.status, d.published, d.requirements.length]), [['new', 'failed', false, 0], ['second', 'reading', false, 0]]);
    assert.equal(drawings[0].attemptId, 'latest-failed');
    assert.equal(drawings[0].batchCreatedAt, batch.createdAt); assert.equal(drawings[0].batchUpdatedAt, batch.updatedAt);
    assert.match(drawings[0].error, /原图复核未通过/);
    for (const secret of ['C:/private', 'sk-abcdefghijklmnopqrstuv', 'PRIVATE_DISK_PATH', 'PRIVATE_PROMPT', 'PRIVATE_API_KEY']) assert.ok(!html.includes(secret), secret);
    assert.deepEqual(drawings[0].drawing, {}); assert.deepEqual(drawings[0].warnings, []); assert.equal(drawings[0].pipelineVersion, '');
    const script = html.match(/<script>([\s\S]*?)<\/script>/)[1]; assert.doesNotThrow(() => new vm.Script(script));
    const start = script.indexOf('const published='), end = script.indexOf('function categoryOptions');
    const context = vm.createContext({}); vm.runInContext(script.slice(start, end) + '\nthis.isPublished=published;this.label=statusLabel;', context);
    assert.equal(context.isPublished(drawings[0]), false); assert.equal(context.label(drawings[0]), '处理失败');
    assert.equal(context.label(drawings[1]), '识读图纸');
    assert.match(context.snapshotStatusText(drawings), /本轮 2 张图纸 · 0 张已有清单（0 张待复核） · 1 张失败 · 1 张待完成/);
    assert.match(html, /本次无有效清单/); assert.match(html, /批次建立/); assert.match(html, /本轮更新/);
  } finally { await f.close(); }
});

test('row-review and partial API results are exported as visible current lists with minimal review provenance', async () => {
  const f = await fixture();
  try {
    const first = f.batches[bid2].drawings[0], second = f.batches[bid2].drawings[1];
    first.result.review = { status: 'needs_review', note: '匹配前提变化，关联规范待复核。', pendingRuleIds: ['R1'], affectedRequirementIds: ['new'], rawPath: 'PRIVATE_REVIEW_PATH' };
    first.result.run.processingMode = 'reprocess_existing';
    first.result.dispositions = [{ ruleId: 'R1', status: 'not_applicable', reason: '原模型材料条件不适用', evidence: [] }];
    second.result.review = { status: 'partial', note: '复核未完成，已保留合法提取内容。C:/private/audit.txt\nsk-abcdefghijklmnopqrstuv', pendingRuleIds: ['R2'] };
    const before = structuredClone(f.batches);
    await f.run();
    const html = await fs.readFile(f.output, 'utf8'), data = JSON.parse(html.match(/<script id="report-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
    const drawings = data.specifications[0].drawings;
    assert.deepEqual(drawings.map(d => [d.published, d.requirements.length, d.review.status]), [[true, 1, 'needs_review'], [true, 1, 'partial']]);
    assert.deepEqual(drawings[0].review.pendingRuleIds, ['R1']); assert.deepEqual(drawings[0].review.affectedRequirementIds, ['new']);
    assert.equal(drawings[0].processingMode, 'reprocess_existing');
    assert.equal(drawings[0].dispositions[0].status, 'not_applicable');
    for (const secret of ['PRIVATE_REVIEW_PATH', 'C:/private', 'sk-abcdefghijklmnopqrstuv']) assert.ok(!html.includes(secret), secret);
    const script = html.match(/<script>([\s\S]*?)<\/script>/)[1], start = script.indexOf('const published='), end = script.indexOf('function categoryOptions');
    const context = vm.createContext({}); vm.runInContext(script.slice(start, end) + '\nthis.label=statusLabel;this.pending=pendingApplicability;this.counts=snapshotStatusText;', context);
    assert.equal(context.label(drawings[0]), '已提取 · 待复核'); assert.equal(context.label(drawings[1]), '部分提取 · 待复核');
    assert.match(context.pending(data.specifications[0], drawings[0])[0], /待复核（原模型：不适用）/);
    assert.match(context.pending(data.specifications[0], drawings[1])[0], /待复核（尚未匹配）/);
    assert.match(context.counts(drawings), /2 张已有清单（2 张待复核） · 0 张失败/);
    assert.deepEqual(f.batches, before);
  } finally { await f.close(); }
});

test('static renderer and CSV move the process category from the name cell to the third stage column', async () => {
  const f = await fixture();
  try {
    f.batches[bid2].drawings[0].result.requirements = [requirement('R1', { category: '甲', processCategory: '焊接', stage: '批产' }), requirement('R2', { category: '乙', processCategory: '检验' })];
    await f.run();
    const html = await fs.readFile(f.output, 'utf8'), script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
    const data = JSON.parse(html.match(/<script id="report-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
    const nodes = new Map();
    const node = tag => ({ tag, children: [], textContent: '', value: '', checked: false, style: {},
      get childNodes() { return this.children; }, append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children.flatMap(child => child.tag === 'fragment' ? child.children : child); } });
    const get = id => { if (!nodes.has(id)) nodes.set(id, node('div')); return nodes.get(id); };
    const context = vm.createContext({ document: { createElement: node, createDocumentFragment: () => node('fragment') }, $: get,
      mode: 'drawing', spec: data.specifications[0], drawing: data.specifications[0].drawings[0], visibleRows: [] });
    get('search').value = '焊接';
    const helpers = script.slice(script.indexOf('const simple='), script.indexOf('const published='));
    const renderer = script.slice(script.indexOf('function renderTable(){'), script.indexOf("$('tab-drawing').addEventListener"));
    const csv = script.slice(script.indexOf('function csvCell('), script.indexOf("$('export-csv').addEventListener"));
    vm.runInContext(helpers + '\n' + renderer + '\n' + csv + '\nrenderTable();this.csv=csvContent;', context);
    const rendered = get('requirements').children;
    assert.equal(rendered.length, 1); assert.equal(rendered[0].children.length, 3);
    assert.equal(rendered[0].children[2].textContent, '焊接');
    assert.ok(!rendered[0].children[0].children.some(child => child.className === 'process-chip'));
    const text = context.csv([{ category: '甲', requirement: '不得补焊', processCategory: '焊接', stage: '样件' }, { category: '=公式', requirement: '值', processCategory: undefined }]);
    assert.equal(text, '\ufeff"工艺要求的名称","量化指标","阶段"\r\n"甲","不得补焊","焊接"\r\n"\'=公式","值","待分类"');
    assert.match(html, /<th scope="col">阶段<\/th>/);
  } finally { await f.close(); }
});

test('current attempt mismatch is rejected by default and shown without results only with explicit status export', async () => {
  const f = await fixture();
  try {
    const drawing = f.batches[bid2].drawings[0];
    drawing.attemptId = 'current-attempt'; drawing.result.run.attemptId = 'stale-attempt';
    await assert.rejects(f.run(), /Latest selected drawing result is incomplete/);
    await assert.rejects(fs.access(f.output), { code: 'ENOENT' });
    await f.run(['--allow-incomplete']);
    const html = await fs.readFile(f.output, 'utf8');
    const data = JSON.parse(html.match(/<script id="report-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
    const latest = data.specifications[0].drawings[0];
    assert.equal(latest.published, false); assert.equal(latest.requirements.length, 0);
    assert.match(latest.error, /本轮尝试不一致/); assert.equal(latest.id, 'new');
    assert.equal(data.totals.drawings, 2); assert.equal(data.totals.requirements, 1);
  } finally { await f.close(); }
});

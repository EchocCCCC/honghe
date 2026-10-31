import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const slice = (start, end) => {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a); return source.slice(a, b);
};
const helpers = slice('  function savedDrawingRows(', '  function renderFiles(');
const batchLoader = slice('  async function loadBatch(', '  function schedulePoll(');
const specSelector = slice('  async function selectSpec(', '  function savedDrawingRows(');
const drawing = (id, extra = {}) => ({ id, name: `${id}.pdf`, sourceSha256: id, status: 'completed', hasResult: true, requirementCount: 3, ...extra });
const batch = (id, specificationId, drawings, extra = {}) => ({ id, specificationId, drawings, stage: 'all', status: 'completed', createdAt: '2026-10-29T08:00:00.000Z', ...extra });
const full = summary => ({ ...summary, drawings: summary.drawings.map(d => ({ ...d, result: d.hasResult ? { requirements: [{}, {}, {}], drawing: { name: d.name } } : undefined })) });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function fixture(specId, responder, overrides = {}) {
  const state = { specId, specifications: [], batchId: null, batch: null, drawingId: null, resultKey: '', filter: 'core', search: '', savedRequest: 0, savedSpecId: specId, savedBatches: [], savedLoading: false, savedError: '', ...overrides };
  const created = [];
  const node = (tag, className, textContent) => ({ tag, className, textContent, children: [], setAttribute() {}, addEventListener() {}, append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; } });
  const nodes = { 'new-drawings': { open: false }, 'results-heading': { scrollIntoView() { nodes.scrolls++; } }, 'saved-drawings-list': node('div'), 'saved-drawings-count': node('span'), 'refresh-drawings': node('button'), 'spec-detail': node('div'), 'spec-select': node('select'), scrolls: 0 };
  const calls = [], alerts = [], rendered = [];
  const context = vm.createContext({ state, list: value => Array.isArray(value) ? value : [], enc: encodeURIComponent,
    api: async (url, options) => { calls.push({ url, options }); return responder(url, options); },
    el: (tag, cls, text) => { const item = node(tag, cls, text); created.push(item); return item; }, badge: status => node('span', 'status', status), str: String, stageNames: { all: '全部阶段' }, active: value => Boolean(value) && !['completed', 'failed', 'partial'].includes(value),
    $: id => nodes[id], showAlert: message => alerts.push(message), updateControls() {}, updateUrl() {}, schedulePoll() {}, renderSpecList() {}, updateSpecSummary() {}, renderSpec() {}, fetchSpecJob: id => responder(`/api/specifications/${id}`), renderBatch() { rendered.push(state.batch?.id || null); } });
  vm.runInContext(`${helpers}\n${batchLoader}\n${specSelector}\nvar actualRenderSavedDrawings = renderSavedDrawings; renderSavedDrawings = () => {};`, context);
  return { state, calls, alerts, nodes, rendered, created, rows: context.savedDrawingRows, refresh: context.refreshSavedDrawings, open: context.openSavedDrawing, load: context.loadBatch, render: context.actualRenderSavedDrawings, select: context.selectSpec };
}

test('drawing discovery deduplicates the same PDF within its stage and preserves different contents and stages', () => {
  const older = batch('old', 'spec', [drawing('a', { sourceSha256: 'same' })]);
  const newer = batch('new', 'spec', [drawing('retry', { sourceSha256: 'same', status: 'failed', hasResult: false }), drawing('b')], { createdAt: '2026-10-29T09:00:00.000Z' });
  const phase = batch('sample', 'spec', [drawing('c', { sourceSha256: 'same' })], { stage: 'sample' });
  const legacy = batch('legacy', 'spec', [drawing('missing-a', { sourceSha256: '', name: 'same.pdf' }), drawing('missing-b', { sourceSha256: null, name: 'same.pdf' })]);
  const foreign = batch('foreign', 'other-spec', [drawing('foreign')]);
  const input = [older, newer, phase, legacy, foreign], before = structuredClone(input);
  const f = fixture('spec', () => {}), rows = f.rows(input, 'spec');
  assert.equal(rows.length, 5);
  assert.equal(rows.find(row => row.sourceSha256 === 'same' && row.stage === 'all').id, 'retry');
  assert.equal(rows.find(row => row.stage === 'sample').id, 'c');
  assert.equal(rows.some(row => row.id === 'foreign' || row.id === 'a'), false);
  assert.deepEqual(input, before);
});

test('new unfinished or failed attempts remain visible instead of silently selecting an older successful result', async () => {
  for (const status of ['reading', 'matching', 'auditing', 'failed']) {
    const old = batch('old-batch', 'spec', [drawing('old', { sourceSha256: 'same' })]);
    const latest = batch('latest-batch', 'spec', [drawing('latest', { sourceSha256: 'same', status, hasResult: false })], { createdAt: '2026-10-29T10:00:00.000Z', status: status === 'failed' ? 'failed' : 'running' });
    const f = fixture('spec', url => url.includes('?') ? { batches: [old, latest] } : full(latest));
    await f.refresh('spec', { open: true });
    const rows = f.rows(f.state.savedBatches, 'spec');
    assert.equal(rows.length, 1); assert.equal(rows[0].status, status); assert.equal(rows[0].hasResult, false);
    assert.equal(f.state.batchId, latest.id); assert.equal(f.state.drawingId, 'latest');
    assert.equal(f.calls.at(-1).url, '/api/drawing-batches/latest-batch');
  }
});

test('selecting a specification discovers its saved results with GETs and replaces a mismatched old batch', async () => {
  const saved = batch('batch-04', 'spec-04', Array.from({ length: 5 }, (_, i) => drawing(`d-${i}`)));
  const f = fixture('spec-04', url => url.includes('?') ? { batches: [batch('bad', 'spec-03', [drawing('wrong')]), saved] } : full(saved), { batchId: 'batch-03', drawingId: 'old-drawing' });
  await f.refresh('spec-04', { open: true });
  assert.equal(f.state.batchId, 'batch-04'); assert.equal(f.state.batch.specificationId, 'spec-04'); assert.equal(f.state.drawingId, 'd-0');
  assert.equal(f.state.savedBatches.length, 1); assert.equal(f.rows(f.state.savedBatches, 'spec-04').length, 5);
  assert.equal(f.nodes['new-drawings'].open, false);
  assert.deepEqual(f.calls.map(call => call.url), ['/api/drawing-batches?specificationId=spec-04', '/api/drawing-batches/batch-04']);
  assert.equal(f.calls.every(call => !call.options?.method || call.options.method === 'GET'), true);
});

test('a matching history deep link preserves its exact batch and drawing even if a newer duplicate exists', async () => {
  const old = batch('old-batch', 'spec', [drawing('first'), drawing('target', { sourceSha256: 'same' })]);
  const newer = batch('new-batch', 'spec', [drawing('new-target', { sourceSha256: 'same' })], { createdAt: '2026-10-29T09:00:00.000Z' });
  const f = fixture('spec', url => url.includes('?') ? { batches: [newer, old] } : full(old), { batchId: 'old-batch', drawingId: 'target' });
  await f.refresh('spec', { open: true });
  assert.equal(f.state.batchId, 'old-batch'); assert.equal(f.state.drawingId, 'target');
  assert.equal(f.calls.at(-1).url, '/api/drawing-batches/old-batch');
});

test('a late history response cannot replace a newer specification selection', async () => {
  const old = deferred(), current = batch('current-batch', 'new-spec', [drawing('new')]);
  const f = fixture('old-spec', url => url.includes('specificationId=old-spec') ? old.promise : url.includes('?') ? { batches: [current] } : full(current));
  const stale = f.refresh('old-spec', { open: true });
  f.state.specId = 'new-spec'; f.state.batchId = null;
  await f.refresh('new-spec', { open: true });
  old.resolve({ batches: [batch('stale-batch', 'old-spec', [drawing('old')])] }); await stale;
  assert.equal(f.state.batchId, 'current-batch'); assert.equal(f.state.savedSpecId, 'new-spec');
  assert.equal(f.state.savedBatches[0].specificationId, 'new-spec'); assert.equal(f.state.drawingId, 'new');
});

test('a late full-result response cannot restore a different specification result', async () => {
  const pending = deferred(), f = fixture('old-spec', () => pending.promise, { batchId: 'old-batch', drawingId: 'old' });
  const opened = f.open({ batchId: 'old-batch', id: 'old', specificationId: 'old-spec' }, { scroll: true });
  f.state.specId = 'new-spec'; f.state.batchId = 'new-batch'; f.state.batch = { id: 'new-batch', specificationId: 'new-spec' };
  pending.resolve(full(batch('old-batch', 'old-spec', [drawing('old')]))); await opened;
  assert.equal(f.state.batch.id, 'new-batch'); assert.equal(f.nodes.scrolls, 0);
});

test('opening saved results ignores stale rows and never starts a model task', async () => {
  const saved = batch('ready-batch', 'spec', [drawing('ready')]);
  const f = fixture('spec', () => full(saved));
  await f.open({ batchId: 'foreign-batch', id: 'foreign', specificationId: 'other' }); assert.equal(f.calls.length, 0);
  await f.open({ batchId: saved.id, id: 'ready', specificationId: 'spec' }, { scroll: true });
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].url, '/api/drawing-batches/ready-batch'); assert.equal(f.calls[0].options, undefined);
  assert.equal(f.state.drawingId, 'ready'); assert.equal(f.nodes.scrolls, 1);
});

test('new specifications with no existing drawings expose the new-upload controls without inventing results', async () => {
  const f = fixture('empty', () => ({ batches: [] }), { batchId: 'unrelated', batch: { id: 'unrelated', specificationId: 'other' } });
  await f.refresh('empty', { open: true });
  assert.equal(f.nodes['new-drawings'].open, true); assert.equal(f.state.batch, null); assert.equal(f.state.batchId, null);
  assert.equal(f.calls.length, 1); assert.equal(f.state.savedBatches.length, 0);
});

test('discovery errors are explicit and do not present a fabricated empty success', async () => {
  const f = fixture('spec', () => { throw new Error('read failed'); });
  await f.refresh('spec', { open: true });
  assert.equal(f.state.savedError, 'read failed'); assert.equal(f.state.savedLoading, false); assert.equal(f.state.batch, null);
  assert.deepEqual(f.alerts, ['read failed']); assert.equal(f.nodes['new-drawings'].open, false);
});

test('the full-result loader rejects wrong specification identity even when the requested batch ID matches', async () => {
  const f = fixture('spec', () => full(batch('same-id', 'wrong-spec', [drawing('wrong')])) , { batchId: 'same-id' });
  await f.load('same-id'); assert.equal(f.state.batch, null); assert.equal(f.rendered.length, 0);
});

test('the live-batch overlay cannot promote a broken or unfinished result into a completed saved result', () => {
  for (const [status, result, expected] of [['completed', { valid: true }, 0], ['completed', { requirements: [] }, 0], ['auditing', { requirements: [{}] }, 0], ['completed', { requirements: [{}] }, 1]]) {
    const saved = batch('batch', 'spec', [drawing('part')]);
    const f = fixture('spec', () => {}, { savedBatches: [saved], batch: { ...saved, drawings: [{ id: 'part', name: 'part.pdf', status, result }] } });
    f.render();
    assert.equal(f.nodes['saved-drawings-count'].textContent, `${expected} 张已完成 / 共 1 张`);
    assert.equal(f.created.find(item => item.className === 'saved-drawing-action').textContent, expected ? '查看结果 →' : '查看处理状态 →');
  }
});

test('specification read failures leave an explicit discovery error, while stale failures are ignored', async () => {
  const failed = fixture('spec', () => { throw new Error('spec read failed'); });
  await assert.rejects(failed.select('spec'), /spec read failed/);
  assert.equal(failed.state.savedLoading, false); assert.equal(failed.state.savedError, 'spec read failed');
  const pending = deferred(), f = fixture('old', () => pending.promise);
  const selecting = f.select('old'); f.state.specId = 'new';
  pending.reject(new Error('old failure')); await selecting;
  assert.equal(f.state.specId, 'new'); assert.equal(f.state.savedError, '');
});

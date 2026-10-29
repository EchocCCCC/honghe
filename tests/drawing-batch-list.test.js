import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { createTwoStageRouter } from '../server/two-stage-routes.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'honghe-batch-list-'));
  const servers = [];
  t.after(async () => {
    for (const server of servers) if (server.listening) await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.match(path.basename(root), /^honghe-batch-list-/);
    await fs.rm(root, { recursive: true, force: true });
  });
  const save = async (type, job) => {
    const directory = path.join(root, type, job.id); await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'job.json'), JSON.stringify(job));
  };
  const start = async (options = {}) => {
    const app = express();
    app.use('/api', createTwoStageRouter({ root, configured: () => false,
      build: async () => { throw new Error('A read must not build a specification'); },
      match: async () => { throw new Error('A read must not invoke the model'); }, ...options }));
    app.use((error, _req, res, _next) => res.status(400).json({ error: error.message }));
    const server = app.listen(0, '127.0.0.1'); servers.push(server);
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api`;
    return { server, base, get: async endpoint => { const response = await fetch(base + endpoint); return { status: response.status, body: await response.json() }; } };
  };
  return { root, save, start };
}
const specification = id => ({ id, status: 'completed', createdAt: '2026-10-29T00:00:00.000Z', file: { name: 'spec.pdf', path: 'private-specification.pdf' }, result: { metadata: { number: 'SPEC', version: '1' }, rules: [], warnings: [] } });
const drawing = (id, status = 'completed', hasResult = true) => ({
  id, name: `${id}.pdf`, sourceSha256: 'a'.repeat(64), status,
  file: { path: 'private-drawing.pdf' }, error: 'private-error-path',
  ...(hasResult ? { result: { drawing: { partNumber: `PART-${id}`, name: `零件${id}` }, requirements: [{ category: '原图要求', requirement: 'source-only' }], prompt: 'private-prompt' } } : {}),
});
const batch = (id, specificationId, drawings, overrides = {}) => ({
  id, specificationId, stage: 'all', status: 'completed', createdAt: '2026-10-29T08:00:00.000Z', updatedAt: '2026-10-29T08:30:00.000Z',
  file: { path: 'private-batch.pdf' }, prompt: 'private-top-level-prompt', drawings, ...overrides,
});

test('saved batches can be discovered by exact specification ID after a server restart without model access', async t => {
  const { save, start, root } = await fixture(t);
  const spec03 = randomUUID(), spec04 = randomUUID(), emptySpec = randomUUID();
  for (const id of [spec03, spec04, emptySpec]) await save('specifications', specification(id));
  const older = batch(randomUUID(), spec03, [drawing('450')]);
  const latest = batch(randomUUID(), spec03, [drawing('530'), drawing('560')], { createdAt: '2026-10-29T09:00:00.000Z' });
  const other = batch(randomUUID(), spec04, [drawing('480'), drawing('420')]);
  for (const job of [older, latest, other]) await save('drawing-batches', job);
  // An unrelated folder and an incomplete record must not break discovery.
  await fs.mkdir(path.join(root, 'drawing-batches', 'uploads'));
  await fs.mkdir(path.join(root, 'drawing-batches', randomUUID()));
  let firstBody;
  for (let restart = 0; restart < 2; restart++) {
    const api = await start();
    const response = await api.get(`/drawing-batches?specificationId=${spec03}`);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.batches.map(job => job.id), [latest.id, older.id]);
    assert.ok(response.body.batches.every(job => job.specificationId === spec03));
    assert.equal(response.body.batches[0].drawingCount, 2);
    assert.equal(response.body.batches[0].completedCount, 2);
    assert.deepEqual(response.body.batches[0].drawings[0], {
      id: '530', name: '530.pdf', status: 'completed', sourceSha256: 'a'.repeat(64), hasResult: true,
      partNumber: 'PART-530', partName: '零件530', requirementCount: 1,
    });
    const serialized = JSON.stringify(response.body);
    for (const privateValue of ['private-specification', 'private-drawing', 'private-batch', 'private-error', 'private-prompt', 'private-top-level', 'source-only', root]) assert.equal(serialized.includes(privateValue), false, privateValue);
    assert.equal(serialized.includes('requirements'), false);
    if (firstBody) assert.deepEqual(response.body, firstBody); else firstBody = response.body;
    const second = await api.get(`/drawing-batches?specificationId=${spec04}`);
    assert.deepEqual(second.body.batches.map(job => job.id), [other.id]);
    const empty = await api.get(`/drawing-batches?specificationId=${emptySpec}`);
    assert.equal(empty.status, 200); assert.deepEqual(empty.body, { batches: [] });
    await new Promise(resolve => api.server.close(resolve));
  }
});

test('list validation rejects missing or invalid IDs and distinguishes a missing specification from an empty library', async t => {
  const { save, start } = await fixture(t), id = randomUUID();
  await save('specifications', specification(id));
  const api = await start();
  for (const query of ['', '?specificationId=bad', '?specificationId=..%2F..%2Fsecret', `?specificationId=${id}&specificationId=${id}`]) assert.equal((await api.get('/drawing-batches' + query)).status, 400, query);
  assert.equal((await api.get(`/drawing-batches?specificationId=${randomUUID()}`)).status, 404);
  const response = await api.get(`/drawing-batches?specificationId=${id}`);
  assert.equal(response.status, 200); assert.deepEqual(response.body, { batches: [] });
});

test('restored interrupted parts retain completed results and malformed completed parts are not advertised as viewable', async t => {
  const { root, save, start } = await fixture(t), spec = randomUUID();
  await save('specifications', specification(spec));
  const job = batch(randomUUID(), spec, [drawing('ready'), drawing('interrupted', 'matching', false), drawing('broken', 'completed', false)], { status: 'running' });
  await save('drawing-batches', job);
  const rawBefore = await fs.readFile(path.join(root, 'drawing-batches', job.id, 'job.json'), 'utf8');
  const api = await start(), response = await api.get(`/drawing-batches?specificationId=${spec}`);
  assert.equal(response.status, 200);
  const saved = response.body.batches[0];
  assert.equal(saved.status, 'partial'); assert.equal(saved.completedCount, 1);
  assert.deepEqual(saved.drawings.map(item => [item.status, item.hasResult]), [['completed', true], ['failed', false], ['completed', false]]);
  assert.equal(await fs.readFile(path.join(root, 'drawing-batches', job.id, 'job.json'), 'utf8'), rawBefore, 'Read-only discovery must not overwrite the original saved job');
});

test('a newly submitted in-memory task appears in discovery without being mistaken for a restarted job', async t => {
  const { save, start } = await fixture(t), spec = randomUUID();
  await save('specifications', specification(spec));
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const api = await start({ configured: () => true, match: async () => { entered(); return pending; } });
  t.after(() => release({ drawing: {}, requirements: [{ requirement: 'test' }] }));
  const form = new FormData(); form.append('specificationId', spec); form.append('files', new Blob(['%PDF-1.4\npart']), 'part.pdf');
  const posted = await fetch(api.base + '/drawing-batches', { method: 'POST', body: form });
  assert.equal(posted.status, 202); const accepted = await posted.json(); await started;
  const response = await api.get(`/drawing-batches?specificationId=${spec}`);
  assert.equal(response.status, 200); assert.equal(response.body.batches[0].id, accepted.id);
  assert.equal(response.body.batches[0].status, 'running');
  assert.equal(response.body.batches[0].drawings[0].status, 'preparing');
  assert.equal(response.body.batches[0].drawings[0].hasResult, false);
  release({ drawing: {}, requirements: [{ requirement: 'test' }] });
  for (let count = 0; count < 100; count++) {
    const response = await api.get(`/drawing-batches?specificationId=${spec}`);
    if (response.body.batches[0].status === 'completed') return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('The submitted fixture task did not complete');
});

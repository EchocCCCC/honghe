import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';

// Override before imports so these negative-path tests never use real credentials.
process.env.DEEPSEEK_API_KEY = 'test-local-placeholder';
process.env.HOST = '127.0.0.1';
const { app } = await import('../server/app.js');
const { RUNTIME } = await import('../server/config.js');
const createdJobs = new Set();
const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
let server, baseUrl;

before(async () => {
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
  const jobsRoot = path.resolve(RUNTIME, 'jobs');
  for (const id of createdJobs) {
    assert.match(id, uuid);
    const directory = path.resolve(jobsRoot, id);
    assert.equal(path.dirname(directory), jobsRoot);
    // Remove only UUIDs returned by this test's own POST requests.
    await fs.rm(directory, { recursive: true, force: true });
  }
});

const malformedPdfForm = (model = 'deepseek-flash') => {
  const form = new FormData();
  form.append('model', model);
  form.append('files', new Blob(['THIS IS NOT A PDF'], { type: 'application/pdf' }), 'malformed-test.pdf');
  return form;
};

test('health exposes readiness and model names without credentials', async () => {
  const response = await fetch(`${baseUrl}/api/health`);
  assert.equal(response.status, 200);
  const text = await response.text(), health = JSON.parse(text);
  assert.equal(health.ok, true);
  assert.equal(health.configured, true);
  assert.ok(health.models.includes('deepseek-flash'));
  assert.equal(text.includes('test-local-placeholder'), false);
  assert.equal('apiKey' in health, false);
});

test('unsupported models are rejected before creating an inference job', async () => {
  const response = await fetch(`${baseUrl}/api/jobs`, { method: 'POST', body: malformedPdfForm('unsupported-test-model') });
  assert.equal(response.status, 400);
  const result = await response.json();
  assert.match(result.error, /模型不在允许列表/);
  assert.equal(result.id, undefined);
});

test('invalid PDF signatures fail before Poppler or Pi can run', async () => {
  const response = await fetch(`${baseUrl}/api/jobs`, { method: 'POST', body: malformedPdfForm() });
  assert.equal(response.status, 202);
  const { id } = await response.json();
  assert.match(id, uuid); createdJobs.add(id);
  const deadline = Date.now() + 4000;
  let job;
  do {
    const status = await fetch(`${baseUrl}/api/jobs/${id}`);
    assert.equal(status.status, 200);
    job = await status.json();
    if (['failed', 'completed'].includes(job.status)) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  assert.equal(job.status, 'failed');
  assert.match(job.error, /不是有效的 PDF/);
  assert.equal(job.result, undefined);
  await assert.rejects(fs.access(path.join(RUNTIME, 'jobs', id, 'pi-config')), { code: 'ENOENT' });
});

test('cross-origin uploads are rejected before processing request data', async () => {
  const response = await fetch(`${baseUrl}/api/jobs`, { method: 'POST', headers: { origin: 'https://unrelated.invalid' } });
  assert.equal(response.status, 403);
  assert.match((await response.json()).error, /跨站上传/);
});

test('unknown jobs return 404', async () => {
  const response = await fetch(`${baseUrl}/api/jobs/00000000-0000-4000-8000-000000000000`);
  assert.equal(response.status, 404);
  assert.match((await response.json()).error, /任务不存在/);
});

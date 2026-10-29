import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

// Exercise the shipped browser helpers without duplicating their business logic
// or starting the app, DOM, service, or model provider.
const source = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const utilitiesStart = source.indexOf('  const list = ');
const utilitiesEnd = source.indexOf('  const enc = ', utilitiesStart);
const helpersStart = source.indexOf('  function specificationKey(');
const helpersEnd = source.indexOf('  function renderSpecList(', helpersStart);
assert.ok(utilitiesStart >= 0 && utilitiesEnd > utilitiesStart && helpersStart >= 0 && helpersEnd > helpersStart);
const { specificationKey, specificationViews } = vm.runInNewContext(`(() => {
${source.slice(utilitiesStart, utilitiesEnd)}
${source.slice(helpersStart, helpersEnd)}
return { specificationKey, specificationViews };
})()`);

const SHA_A = 'a'.repeat(64), SHA_B = 'b'.repeat(64);
const attempt = (id, sourceSha256, status, minute, extra = {}) => ({
  id, sourceSha256, status, createdAt: `2026-10-29T08:${String(minute).padStart(2, '0')}:00.000Z`,
  name: '技术规范.pdf', metadata: { number: 'SPEC-1', version: '2021' }, ...extra,
});
const ids = rows => Array.from(rows, row => row.id);

test('ten parsing attempts for two PDFs produce two library cards and two usable choices', () => {
  const runs = [
    attempt('a-old-failed', SHA_A, 'failed', 1),
    attempt('b-old-ready', SHA_B, 'completed', 4),
    attempt('a-old-ready', SHA_A, 'completed', 3),
    attempt('a-new-failed', SHA_A, 'failed', 12),
    attempt('b-new-ready', SHA_B, 'completed', 11),
    attempt('b-first-failed', SHA_B, 'failed', 0),
    attempt('a-new-ready', SHA_A, 'completed', 10),
    attempt('b-middle-failed', SHA_B, 'failed', 6),
    attempt('a-middle-failed', SHA_A, 'failed', 5),
    attempt('b-new-failed', SHA_B, 'failed', 13),
  ];
  const result = specificationViews(runs);
  assert.equal(result.library.length, 2);
  assert.equal(result.completed.length, 2);
  assert.deepEqual(ids(result.library).sort(), ['a-new-ready', 'b-new-ready']);
  assert.deepEqual(ids(result.completed).sort(), ['a-new-ready', 'b-new-ready']);
});

test('a current parsing attempt remains visible while its last completed result stays selectable', () => {
  for (const status of ['queued', 'preparing', 'extracting', 'auditing']) {
    const ready = attempt('ready', SHA_A, 'completed', 1);
    const pending = attempt('pending', SHA_A, status, 2);
    const result = specificationViews([ready, pending]);
    assert.deepEqual(ids(result.library), ['pending'], status);
    assert.deepEqual(ids(result.completed), ['ready'], status);
    assert.equal(result.library[0], pending);
    assert.equal(result.completed[0], ready);
  }
});

test('a newer failed attempt does not replace an available completed result', () => {
  const ready = attempt('ready', SHA_A, 'completed', 1);
  const result = specificationViews([attempt('failed', SHA_A, 'failed', 2), ready]);
  assert.deepEqual(ids(result.library), ['ready']);
  assert.deepEqual(ids(result.completed), ['ready']);
});

test('an initial failure remains visible when that PDF has no usable result', () => {
  const result = specificationViews([
    attempt('failed-old', SHA_A, 'failed', 1),
    attempt('failed-new', SHA_A, 'failed', 2),
  ]);
  assert.deepEqual(ids(result.library), ['failed-new']);
  assert.equal(result.completed.length, 0);
});

test('identical names and specification labels cannot merge different PDF contents', () => {
  const first = attempt('first', SHA_A, 'completed', 1);
  const second = attempt('second', SHA_B, 'completed', 2);
  assert.notEqual(specificationKey(first), specificationKey(second));
  const result = specificationViews([first, second]);
  assert.equal(result.library.length, 2);
  assert.deepEqual(ids(result.completed).sort(), ['first', 'second']);
});

test('legacy records without a source hash remain separate by their original job IDs', () => {
  const first = attempt('legacy-a', undefined, 'completed', 1);
  const second = attempt('legacy-b', null, 'failed', 2);
  const third = attempt('legacy-c', '', 'completed', 3);
  assert.notEqual(specificationKey(first), specificationKey(second));
  assert.notEqual(specificationKey(first), specificationKey(third));
  const result = specificationViews([first, second, third]);
  assert.equal(result.library.length, 3);
  assert.deepEqual(ids(result.completed).sort(), ['legacy-a', 'legacy-c']);
});

test('a selected historic completed job stays exact without adding another card or changing stored records', () => {
  const old = attempt('old-version', SHA_A, 'completed', 1);
  const current = attempt('current-version', SHA_A, 'completed', 3);
  const other = attempt('other-document', SHA_B, 'completed', 2);
  const runs = [old, current, other];
  const before = structuredClone(runs);
  for (const run of runs) { Object.freeze(run.metadata); Object.freeze(run); }
  Object.freeze(runs);
  const result = specificationViews(runs, old.id);
  assert.deepEqual(ids(result.library).sort(), ['current-version', 'other-document']);
  assert.deepEqual(ids(result.completed).sort(), ['old-version', 'other-document']);
  assert.equal(result.completed.find(run => run.id === old.id), old);
  assert.equal(result.library.find(run => run.id === current.id), current);
  assert.equal(specificationKey(old), specificationKey(current));
  assert.deepEqual(runs, before);
});

test('selected active or failed jobs cannot become usable drawing choices', () => {
  const ready = attempt('ready', SHA_A, 'completed', 1);
  for (const status of ['auditing', 'failed']) {
    const selected = attempt('selected', SHA_A, status, 2);
    const result = specificationViews([ready, selected], selected.id);
    assert.deepEqual(ids(result.completed), ['ready'], status);
    assert.deepEqual(ids(result.library), [status === 'failed' ? 'ready' : 'selected'], status);
  }
  const failedOnly = specificationViews([attempt('failed', SHA_A, 'failed', 1)], 'failed');
  assert.equal(failedOnly.completed.length, 0);
});

test('an older running job does not displace a later completed job, and unknown selection adds no record', () => {
  const old = attempt('old-running', SHA_A, 'auditing', 1);
  const ready = attempt('new-ready', SHA_A, 'completed', 2);
  const result = specificationViews([old, ready], 'missing-id');
  assert.deepEqual(ids(result.library), ['new-ready']);
  assert.deepEqual(ids(result.completed), ['new-ready']);
  assert.equal(result.completed[0], ready);
});

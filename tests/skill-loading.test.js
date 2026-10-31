import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { ROOT } from '../server/config.js';
import { loadSkillBundle, compileSkill, freezeSkillBundle, freezeSkillPrompt, verifySkillProvenance } from '../server/skills.js';
import { specificationFingerprint } from '../server/two-stage-pipeline.js';
import { createTwoStageRouter } from '../server/two-stage-routes.js';

const specPath = path.join(ROOT, 'skills/specification-rule-parser');
const drawPath = path.join(ROOT, 'skills/drawing-requirements-matcher');
async function temporary(work) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'honghe-skill-loading-'));
  try { return await work(directory); }
  finally {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.match(path.basename(directory), /^honghe-skill-loading-/);
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('each actual Skill mode includes only its selected protocol and records the source hashes', async () => {
  for (const [skill, modes] of [[specPath, ['extract', 'audit', 'classify']], [drawPath, ['read', 'match', 'audit']]]) {
    const bundle = await loadSkillBundle(skill);
    for (const mode of modes) {
      const compiled = compileSkill(bundle, mode);
      assert.equal(compiled.bundleSha256, bundle.sha256);
      assert.deepEqual(compiled.files[1].sections, mode === 'classify' ? ['classify'] : ['common', mode]);
      assert.match(compiled.sha256, /^[a-f0-9]{64}$/);
      assert.match(compiled.files[1].sha256, /^[a-f0-9]{64}$/);
      for (const other of ['common', ...modes]) {
        const selected = other === mode || (other === 'common' && mode !== 'classify');
        assert.equal(compiled.text.includes('\n## ' + other + '\n'), selected, bundle.name + '/' + mode + '/' + other);
      }
      if (mode !== 'classify') assert.equal(compiled.text.includes('"classifications"'), false);
    }
  }
});

test('queued snapshots keep both source files and changed references invalidate specification cache identity', async () => temporary(async directory => {
  const bundle = await loadSkillBundle(specPath);
  const file = path.join(directory, 'source.pdf'); await fs.writeFile(file, '%PDF-test');
  const before = await specificationFingerprint(file, bundle);
  const snapshot = await freezeSkillBundle(bundle, path.join(directory, 'parser-bundle.json'));
  const frozen = await loadSkillBundle(snapshot);
  const prior = compileSkill(frozen, 'extract');
  const changed = structuredClone(bundle); delete changed.sha256;
  changed.files[1].content += '\nProtocol revision retained by future jobs.\n';
  const after = await specificationFingerprint(file, changed);
  assert.equal(before.sourceSha256, after.sourceSha256);
  assert.notEqual(before.parserSha256, after.parserSha256);
  assert.equal((await loadSkillBundle(snapshot)).sha256, before.parserSha256);
  assert.equal(compileSkill(frozen, 'extract').sha256, prior.sha256);
  await assert.rejects(freezeSkillBundle(changed, snapshot), /不可覆盖/);
}));

test('invalid modes, missing or duplicate sections and unsafe Skill sources fail before a run can begin', async () => {
  const bundle = await loadSkillBundle(specPath);
  assert.throws(() => compileSkill(bundle, 'match'), /不支持任务模式/);
  assert.throws(() => compileSkill(bundle, '../audit'), /不支持任务模式/);
  for (const modify of [
    value => { value.name = 'unknown-skill'; },
    value => { value.files[1].path = '../protocol.md'; },
    value => { value.files[1].content = value.files[1].content.replace('## audit', '## omitted'); },
    value => { value.files[1].content += '\n## audit\nDuplicate.\n'; },
  ]) {
    const invalid = structuredClone(bundle); delete invalid.sha256; modify(invalid);
    assert.throws(() => compileSkill(invalid, 'extract'), /Skill/);
  }
  await assert.rejects(loadSkillBundle(path.join(ROOT, 'skills/unknown-skill')), /未知Skill/);
  await assert.rejects(loadSkillBundle(ROOT + '/skills/../skills/specification-rule-parser'), /上级目录/);
});

test('compiled snapshots are immutable and provenance must describe their actual text and sections', async () => temporary(async directory => {
  const bundle = await loadSkillBundle(drawPath);
  const snapshot = await freezeSkillPrompt(bundle, 'match', directory, 'match.md');
  const text = await fs.readFile(snapshot.skill, 'utf8');
  assert.equal(verifySkillProvenance(text, snapshot.skillProvenance), snapshot.skillProvenance);
  assert.deepEqual(await freezeSkillPrompt(bundle, 'match', directory, 'match.md'), snapshot);
  await assert.rejects(freezeSkillPrompt(bundle, 'audit', directory, 'match.md'), /不可覆盖/);
  await assert.rejects(freezeSkillPrompt(bundle, 'match', directory, '../escape.md'), /文件名/);
  assert.throws(() => verifySkillProvenance(text + 'modified', snapshot.skillProvenance), /不一致/);
  const changed = structuredClone(snapshot.skillProvenance);
  changed.files[1].sections.push('audit');
  assert.throws(() => verifySkillProvenance(text, changed), /不完整/);
}));

test('specification admission freezes the bundle and validates bundle identity across different phase prompts', async () => temporary(async directory => {
  let mismatch = false, seenBundle = null;
  const app = express();
  app.use('/api', createTwoStageRouter({ root: directory, configured: () => true, build: async ({ skill }) => {
    seenBundle = await loadSkillBundle(skill);
    const initial = compileSkill(seenBundle, 'extract'), audit = compileSkill(seenBundle, 'audit');
    assert.notEqual(initial.sha256, audit.sha256);
    return {
      metadata: { number: 'TEST', title: 'Test', version: '1', scope: '', excludedProcesses: [], priorityPolicy: '' },
      rules: [{ id: 'R1', category: '原文指标', requirement: 'test', informationType: 'quality', sources: [{ file: 'spec.pdf', page: 1, section: '', quote: 'test' }] }],
      warnings: [], run: { extractionRuns: [{ skillSha256: initial.sha256, skillBundleSha256: mismatch ? '0'.repeat(64) : seenBundle.sha256 }] },
      review: { runs: [{ skillSha256: audit.sha256, skillBundleSha256: seenBundle.sha256 }] },
    };
  } }));
  app.use((error, _req, res, _next) => res.status(400).json({ error: error.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const url = 'http://127.0.0.1:' + server.address().port + '/api/specifications';
  const post = async text => {
    const form = new FormData(); form.append('file', new Blob([text]), 'spec.pdf');
    const response = await fetch(url, { method: 'POST', body: form });
    assert.equal(response.status, 202);
    return response.json();
  };
  const finished = async id => {
    for (let count = 0; count < 100; count++) {
      const job = await fetch(url + '/' + id).then(response => response.json());
      if (['completed', 'failed'].includes(job.status)) return job;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('test job timeout');
  };
  try {
    const accepted = await post('%PDF-test-one');
    assert.equal((await finished(accepted.id)).status, 'completed');
    assert.deepEqual(seenBundle.files.map(file => file.path), ['SKILL.md', 'references/protocol.md']);
    const cached = await post('%PDF-test-one'); assert.equal(cached.id, accepted.id); assert.equal(cached.cached, true);
    mismatch = true;
    const invalid = await finished((await post('%PDF-test-two')).id);
    assert.equal(invalid.status, 'failed');
    assert.match(invalid.error, /资料快照与缓存指纹不一致/);
  } finally { await new Promise(resolve => server.close(resolve)); }
}));

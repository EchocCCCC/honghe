import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcess } from '../server/process.js';

process.env.DEEPSEEK_API_KEY = 'test-local-placeholder';
const { writePiConfig, runPi } = await import('../server/pi.js');
const { runExtractionPipeline } = await import('../server/pipeline.js');
const { config, MODEL_ID, MODELS } = await import('../server/config.js');
const workRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..', 'work');
let temporaryRoot;
before(async () => {
  await fs.mkdir(workRoot, { recursive: true });
  temporaryRoot = await fs.mkdtemp(path.join(workRoot, 'model-tests-'));
});
after(async () => {
  assert.equal(path.dirname(path.resolve(temporaryRoot)), workRoot);
  assert.match(path.basename(temporaryRoot), /^model-tests-/);
  await fs.rm(temporaryRoot, { recursive: true, force: true });
});

test('Pi custom configuration exposes only Flash with image support and an environment key reference', async () => {
  const directory = path.join(temporaryRoot, 'config');
  await writePiConfig(directory);
  const source = await fs.readFile(path.join(directory, 'models.json'), 'utf8');
  const provider = JSON.parse(source).providers['deepseek-extract'];
  assert.deepEqual(provider.models.map(model => model.id), ['deepseek-flash']);
  assert.ok(provider.models[0].input.includes('image'));
  assert.equal(provider.apiKey, '$DEEPSEEK_API_KEY');
  assert.equal(source.includes('test-local-placeholder'), false);
  assert.equal(config.model, MODEL_ID);
  assert.deepEqual(MODELS, ['deepseek-flash']);
});

test('Pi and pipeline entry points reject Pro and all other model IDs before creating a run', async () => {
  for (const model of ['deepseek-v4-pro', 'unsupported-test-model']) {
    const directory = path.join(temporaryRoot, model);
    // The absent source is a second barrier: even a guard regression must not
    // reach a provider request in this negative-path test.
    await assert.rejects(runPi({ directory, sourcePath: path.join(directory, 'missing-source.txt'), model, skill: null }), /固定使用.*Flash/);
    await assert.rejects(runExtractionPipeline({ directory, prepared: {}, model }), /只能使用deepseek-flash/);
    await assert.rejects(fs.access(directory), { code: 'ENOENT' });
  }
});

test('a legacy DEEPSEEK_MODEL setting cannot switch any configured model to Pro', async () => {
  const configUrl = new URL('../server/config.js', import.meta.url).href;
  const script = `const {config,MODEL_ID,MODELS}=await import(${JSON.stringify(configUrl)});process.stdout.write(JSON.stringify({model:config.model,id:MODEL_ID,models:MODELS}));`;
  const { stdout } = await runProcess(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, DEEPSEEK_MODEL: 'deepseek-v4-pro', DEEPSEEK_API_KEY: 'test-local-placeholder' },
  });
  assert.deepEqual(JSON.parse(stdout), { model: 'deepseek-flash', id: 'deepseek-flash', models: ['deepseek-flash'] });
  assert.equal(stdout.includes('test-local-placeholder'), false);
});

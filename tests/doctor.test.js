import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OCR_CHECK_SOURCE, drawingOcrEnvironment, runDoctor } from '../scripts/doctor.js';
import { python } from '../server/python-pdf.js';
import { runProcess } from '../server/process.js';

const settings = { baseUrl: 'https://example.invalid', model: 'mock-model', apiKey: 'doctor-test-secret' };

async function ocrPackages(t, { rapidocrVersion = '3.10.0', onnxVersion = '1.31.1', brokenImport = false } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'honghe-doctor-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.match(path.basename(directory), /^honghe-doctor-/);
    await fs.rm(directory, { recursive: true, force: true });
  });
  for (const [name, version] of [['rapidocr', rapidocrVersion], ['onnxruntime', onnxVersion]]) {
    await fs.mkdir(path.join(directory, name));
    const body = name === 'onnxruntime' && brokenImport
      ? 'raise ImportError("mock native OCR import unavailable")\n'
      : 'class RapidOCR:\n    def __init__(self, *args, **kwargs):\n        raise RuntimeError("doctor must not construct an OCR engine")\nclass InferenceSession:\n    def __init__(self, *args, **kwargs):\n        raise RuntimeError("doctor must not construct an inference session")\n';
    await fs.writeFile(path.join(directory, name, '__init__.py'), body);
    const metadata = path.join(directory, name + '-' + version + '.dist-info');
    await fs.mkdir(metadata);
    await fs.writeFile(path.join(metadata, 'METADATA'), 'Metadata-Version: 2.1\nName: ' + name + '\nVersion: ' + version + '\n');
  }
  return directory;
}

function probe(directory, prefix = '') {
  return runProcess(python(), ['-X', 'utf8', '-c', prefix + OCR_CHECK_SOURCE], {
    env: drawingOcrEnvironment({ ...process.env, DRAWING_OCR_PYTHONPATH: directory }),
    timeout: 20000, maxBytes: 100000,
  });
}

test('OCR doctor prepends private packages only in a cloned, credential-free child environment', () => {
  const environment = Object.freeze({
    DRAWING_OCR_PYTHONPATH: path.join('private', 'OCR packages'),
    PYTHONPATH: path.join('existing', 'packages'),
    DEEPSEEK_API_KEY: 'private-key', OPENAI_API_KEY: 'private-key', ANTHROPIC_API_KEY: 'private-key',
    OTHER_SETTING: 'retained',
  });
  const isolated = drawingOcrEnvironment(environment);
  assert.equal(isolated.PYTHONPATH, [environment.DRAWING_OCR_PYTHONPATH, environment.PYTHONPATH].join(path.delimiter));
  assert.equal(environment.PYTHONPATH, path.join('existing', 'packages'));
  assert.equal(isolated.OTHER_SETTING, 'retained');
  for (const key of ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) assert.equal(Object.hasOwn(isolated, key), false);
  assert.equal(drawingOcrEnvironment({ PYTHONPATH: 'old' }).PYTHONPATH, 'old');
});

test('doctor preserves PDF probes and isolates the OCR path without using the model API', async () => {
  const calls = [], logs = [], errors = [];
  const globalPath = process.env.PYTHONPATH;
  const environment = { PYTHON_PATH: 'test-python', DRAWING_OCR_PYTHONPATH: 'private-ocr', PYTHONPATH: 'base-python' };
  const status = await runDoctor({
    settings, environment, api: false, loadSkill: async () => ({}),
    log: message => logs.push(message), error: message => errors.push(message),
    invoke: async (command, args, options) => {
      calls.push({ command, args, options });
      return { stdout: 'probe passed', stderr: '' };
    },
  });
  assert.equal(status, 0);
  assert.deepEqual(errors, []);
  const ocr = calls.filter(call => call.args.includes(OCR_CHECK_SOURCE));
  assert.equal(ocr.length, 1);
  assert.equal(ocr[0].command, 'test-python');
  assert.equal(ocr[0].options.env.PYTHONPATH, ['private-ocr', 'base-python'].join(path.delimiter));
  assert.ok(calls.filter(call => !call.args.includes(OCR_CHECK_SOURCE)).every(call => call.options === undefined));
  assert.ok(calls.some(call => call.args.includes('-v')));
  assert.ok(calls.some(call => call.args.some(value => String(value).includes('import pdfplumber'))));
  assert.ok(calls.some(call => call.args.some(value => String(value).includes('sys.version_info >= (3, 10)'))));
  assert.equal(calls.filter(call => call.args.includes('--help')).length, 2);
  assert.equal(process.env.PYTHONPATH, globalPath);
  assert.doesNotMatch(logs.join('\n'), /doctor-test-secret|base-python|private-ocr/);
});

test('OCR probe imports both locked packages without constructing OCR or inference engines', async t => {
  const directory = await ocrPackages(t);
  const response = await probe(directory);
  assert.match(response.stdout, /rapidocr 3\.10\.0/);
  assert.match(response.stdout, /onnxruntime 1\.31\.1/);
});

test('Python 3.10 can pass the basic PDF threshold but cannot make the full service ready', async t => {
  const directory = await ocrPackages(t, { brokenImport: true });
  const logs = [], errors = [];
  const status = await runDoctor({
    settings, environment: { ...process.env, DRAWING_OCR_PYTHONPATH: directory }, api: false,
    loadSkill: async () => ({}), log: value => logs.push(value), error: value => errors.push(value),
    invoke: async (_command, args, options) => args.includes(OCR_CHECK_SOURCE)
      ? runProcess(python(), ['-X', 'utf8', '-c', 'import sys\nsys.version_info = (3, 10, 99)\n' + OCR_CHECK_SOURCE], options)
      : { stdout: 'basic PDF dependency passed', stderr: '' },
  });
  assert.equal(status, 1);
  assert.ok(logs.some(value => value.startsWith('Skill Python:')));
  assert.ok(errors.some(value => value.includes('本地OCR:') && value.includes('Python 3.11+')));
  assert.doesNotMatch(errors.join('\n'), /mock native OCR import unavailable/);
  assert.equal(logs.some(value => value.startsWith('本地OCR:')), false);
});

test('OCR probe rejects a different RapidOCR version', async t => {
  const directory = await ocrPackages(t, { rapidocrVersion: '3.9.9' });
  await assert.rejects(probe(directory), /rapidocr需要3\.10\.0.*3\.9\.9/s);
});

test('OCR probe rejects a different ONNX Runtime version', async t => {
  const directory = await ocrPackages(t, { onnxVersion: '1.30.0' });
  await assert.rejects(probe(directory), /onnxruntime需要1\.31\.1.*1\.30\.0/s);
});

test('import failure is a failed doctor check rather than an OCR ready message', async t => {
  const directory = await ocrPackages(t, { brokenImport: true });
  const logs = [], errors = [];
  const status = await runDoctor({
    settings, environment: { ...process.env, DRAWING_OCR_PYTHONPATH: directory }, api: false,
    loadSkill: async () => ({}), log: value => logs.push(value), error: value => errors.push(value),
    invoke: async (_command, args, options) => args.includes(OCR_CHECK_SOURCE)
      ? runProcess(python(), ['-X', 'utf8', '-c', OCR_CHECK_SOURCE], options)
      : { stdout: 'PDF dependency passed', stderr: '' },
  });
  assert.equal(status, 1);
  assert.ok(errors.some(value => value.includes('本地OCR:') && value.includes('mock native OCR import unavailable')));
  assert.equal(logs.some(value => value.startsWith('本地OCR:')), false);
  assert.doesNotMatch([...logs, ...errors].join('\n'), /doctor-test-secret/);
});

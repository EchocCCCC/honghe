import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { invokeDrawingOcr } from '../server/python-pdf.js';

async function removeFixture(directory) {
  const absolute = path.resolve(directory), temporaryRoot = path.resolve(os.tmpdir());
  assert.equal(path.dirname(absolute).toLowerCase(), temporaryRoot.toLowerCase());
  assert.ok(path.basename(absolute).startsWith('honghe-ocr-'));
  await fs.rm(absolute, { recursive: true, force: true });
}

test('OCR worker uses data files, isolated module path, and no model credentials', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'honghe-ocr-adapter-'));
  const keys = ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'DRAWING_OCR_PYTHONPATH', 'PYTHONPATH'];
  const before = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { DEEPSEEK_API_KEY: 'ocr-test-key', OPENAI_API_KEY: 'ocr-test-key', ANTHROPIC_API_KEY: 'ocr-test-key', DRAWING_OCR_PYTHONPATH: path.join(directory, 'local packages'), PYTHONPATH: path.join(directory, 'existing packages') });
  const prepared = { images: [path.join(directory, 'tile.png')], sourcePath: path.join(directory, 'original.txt'), documents: [{ name: 'x; $(anything).pdf' }] };
  const original = structuredClone(prepared);
  try {
    const result = await invokeDrawingOcr(prepared, directory, { invoke: async (command, args, options) => {
      assert.equal(typeof command, 'string');
      assert.deepEqual(args.slice(0, 2), ['-X', 'utf8']);
      assert.equal(args.some(arg => arg.includes('$(anything)')), false);
      for (const key of keys.slice(0, 3)) assert.equal(Object.hasOwn(options.env, key), false);
      assert.equal(options.env.PYTHONPATH, [process.env.DRAWING_OCR_PYTHONPATH, process.env.PYTHONPATH].join(path.delimiter));
      const request = args[args.indexOf('--prepared') + 1];
      assert.deepEqual(JSON.parse(await fs.readFile(request, 'utf8')), prepared);
      const outputPath = args[args.indexOf('--output') + 1], textPath = path.join(path.dirname(outputPath), 'ocr-candidates.txt');
      await fs.writeFile(outputPath, '{}'); await fs.writeFile(textPath, 'OCR candidates only');
      return { stdout: JSON.stringify({ outputPath, textPath, complete: true, imageCount: 1, candidateCount: 0, engine: {} }) };
    } });
    assert.equal(result.ocr.authority, 'candidate_only');
    assert.deepEqual(prepared, original);
    assert.equal(await fs.readFile(result.ocrTextPath, 'utf8'), 'OCR candidates only');
  } finally {
    for (const key of keys) if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key];
    await removeFixture(directory);
  }
});

test('OCR adapter rejects invalid, incomplete or redirected worker output', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'honghe-ocr-invalid-'));
  try {
    for (const stdout of ['log\n{}', JSON.stringify({ complete: false }), JSON.stringify({ complete: true, outputPath: path.join(directory, 'other.json'), textPath: path.join(directory, 'other.txt') })]) {
      await assert.rejects(invokeDrawingOcr({ images: [] }, directory, { invoke: async () => ({ stdout }) }), /OCR/);
    }
    await assert.rejects(invokeDrawingOcr({ images: Array(13).fill('same') }, directory), /12/);
  } finally { await removeFixture(directory); }
});

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const project = fileURLToPath(new URL('../', import.meta.url));
// Only the test host loads local executable paths. The isolated skill bundle
// contains no application, package manifest, .env file, or API credentials.
try { process.loadEnvFile(path.join(project, '.env')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const environment = { ...process.env };
for (const key of ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) delete environment[key];
const poppler = {
  info: environment.PDFINFO_PATH || 'pdfinfo',
  text: environment.PDFTOTEXT_PATH || 'pdftotext',
  render: environment.PDFTOPPM_PATH || 'pdftoppm',
};
const python = environment.PYTHON_PATH || (process.platform === 'win32' ? 'python' : 'python3');
const childOptions = { env: environment, windowsHide: true, timeout: 120000, maxBuffer: 2e6, encoding: 'utf8' };
async function available(command, args) {
  try { await execute(command, args, { ...childOptions, timeout: 20000 }); return true; }
  catch { return false; }
}
const hasPoppler = (await Promise.all(Object.values(poppler).map(command => available(command, ['-v'])))).every(Boolean);
const hasTables = await available(python, ['-X', 'utf8', '-c', 'import pdfplumber']);
const pdfOptions = { skip: !hasPoppler && 'Poppler is needed for real PDF CLI integration tests' };
const specOptions = { skip: (!hasPoppler || !hasTables) && 'Poppler and pdfplumber are needed for real specification CLI integration tests' };
let temporaryRoot, bundle;
before(async () => {
  temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'honghe-skill-cli-'));
  bundle = path.join(temporaryRoot, 'portable bundle');
  for (const skill of ['specification-rule-parser', 'drawing-requirements-matcher']) {
    await fs.cp(path.join(project, 'skills', skill), path.join(bundle, 'skills', skill), { recursive: true });
  }
  for (const absent of ['server', 'package.json', 'node_modules', '.env']) {
    await assert.rejects(fs.access(path.join(bundle, absent)), { code: 'ENOENT' });
  }
});
after(async () => {
  if (!temporaryRoot) return;
  assert.equal(path.dirname(path.resolve(temporaryRoot)), path.resolve(os.tmpdir()));
  assert.match(path.basename(temporaryRoot), /^honghe-skill-cli-/);
  await fs.rm(temporaryRoot, { recursive: true, force: true });
});

function cli(skill) { return path.join(bundle, 'skills', skill, 'scripts', 'prepare-pdf.mjs'); }
async function runCli(skill, args, overrides = {}) {
  try {
    const result = await execute(process.execPath, [cli(skill), ...args], { ...childOptions, cwd: bundle, ...overrides });
    return { ...result, code: 0 };
  } catch (error) {
    // Preserve the observable exit code and output rather than hiding a CLI
    // failure inside a shell or a mocked preprocessing implementation.
    if (typeof error.code !== 'number') throw error;
    return { code: error.code, stdout: error.stdout || '', stderr: error.stderr || '' };
  }
}
async function readJson(filename) { return JSON.parse(await fs.readFile(filename, 'utf8')); }

// The fixture is a complete PDF with a real page tree, xref offsets, rotations,
// optional inline raster content and vector grid lines. No PDF package is used.
async function fixture(name, pages) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, index) => `${5 + index * 2} 0 R`).join(' ')}] >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  for (const page of pages) {
    const lines = page.text?.match(/.{1,32}/g) || [];
    let stream = lines.length ? `BT /F1 8 Tf 15 ${(page.height || 400) - 20} Td ${lines.map((line, index) => `${index ? '0 -12 Td ' : ''}(${line.replace(/[()\\]/g, '\\$&')}) Tj`).join(' ')} ET\n` : '';
    if (page.visual) stream += 'q 140 0 0 80 30 70 cm BI /W 2 /H 2 /CS /RGB /BPC 8 /F /AHx ID FF000000FF000000FF000000> EI Q\n';
    if (page.extraStream) stream += page.extraStream;
    const contentId = objects.length + 1;
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page.width || 240} ${page.height || 400}] /Rotate ${page.rotate || 0} /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`);
  }
  let source = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(source));
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(source);
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const filename = path.join(temporaryRoot, name);
  await fs.writeFile(filename, source, 'ascii');
  return filename;
}

test('portable specification CLI preserves merged grid cells, rotation and the trailing blank physical page', specOptions, async () => {
  const grid = '0.5 w 10 20 300 160 re S 90 20 m 90 180 l S 190 20 m 190 180 l S 10 140 m 310 140 l S 10 100 m 190 100 l S 10 60 m 310 60 l S\n' +
    'BT /F1 10 Tf 20 155 Td (condition) Tj ET BT /F1 10 Tf 110 155 Td (note) Tj ET BT /F1 10 Tf 210 155 Td (value) Tj ET\n' +
    'BT /F1 10 Tf 20 115 Td (10) Tj ET BT /F1 10 Tf 20 75 Td (20) Tj ET BT /F1 10 Tf 20 35 Td (30) Tj ET\n' +
    'BT /F1 10 Tf 110 115 Td (A) Tj ET BT /F1 10 Tf 110 35 Td (B) Tj ET BT /F1 10 Tf 210 95 Td (7) Tj ET BT /F1 10 Tf 210 35 Td (8) Tj ET\n';
  const input = await fixture('technical specification.pdf', [
    { width: 340, height: 220, extraStream: grid },
    { text: 'Rotated specification page', rotate: 90 },
    {},
  ]);
  const output = path.join(temporaryRoot, '规范输出');
  const response = await runCli('specification-rule-parser', ['--input', input, '--output', output, '--name', '技术规范（验收）.pdf', '--audit-details']);
  assert.equal(response.code, 0, response.stderr);
  const summary = JSON.parse(response.stdout);
  assert.equal(path.resolve(summary.preparedPath), path.join(output, 'prepared.json'));
  assert.equal(path.resolve(summary.sourcePath), path.join(output, 'source.txt'));
  assert.ok(Array.isArray(summary.warnings));
  const prepared = await readJson(summary.preparedPath);
  assert.deepEqual(prepared.pages.map(page => page.page), [1, 2, 3]);
  assert.equal(prepared.documents[0].name, '技术规范（验收）.pdf');
  assert.equal(prepared.documents[0].pages, 3);
  assert.equal(prepared.pages[1].landscape, true);
  assert.equal(prepared.pages[1].width, 400);
  assert.equal(prepared.pages[1].height, 240);
  assert.equal(prepared.pages[2].blankText, true);
  assert.equal(prepared.pages[2].imagePaths.length, 5, 'the blank-text page must also receive audit detail images');
  assert.deepEqual(prepared.documents[0].imagePages, [1, 2, 3]);
  const tables = await readJson(path.join(output, 'table-structure.json'));
  assert.equal(tables.file, '技术规范（验收）.pdf');
  assert.equal(tables.pages.length, 3);
  const rows = tables.pages[0].tables[0].expandedRows;
  assert.deepEqual(rows.slice(1).map(row => row.values), [['10', 'A', '7'], ['20', '', '7'], ['30', 'B', '8']]);
  assert.equal(rows[1].cellRefs[2], rows[2].cellRefs[2]);
  assert.notEqual(rows[1].cellRefs[1], rows[2].cellRefs[1]);
  const coverage = await readJson(path.join(output, 'coverage.json'));
  assert.equal(coverage.physicalPages, 3);
  assert.equal(coverage.renderedPages, 3);
  assert.equal(coverage.totalImages, prepared.images.length);
  assert.equal(coverage.totalImages, summary.coverage.totalImages);
  assert.equal(coverage.totalImages, coverage.pages.reduce((count, page) => count + page.images.length, 0));
  assert.deepEqual(coverage.pages.map(page => page.images), prepared.pages.map(page => page.imagePaths.map(image => path.basename(image))));
  const source = await fs.readFile(summary.sourcePath, 'utf8');
  assert.equal((source.match(/--- PDF物理页 /g) || []).length, 3);
  assert.match(source, /PDF_VECTOR_TABLE_STRUCTURE_DATA/);
  assert.match(source, /VISUAL_TABLE_EVIDENCE_DATA/);
  await Promise.all(prepared.images.map(image => fs.access(image)));
});

test('portable drawing CLI makes five genuine detail images for a portrait scan without Python or model credentials', pdfOptions, async () => {
  const input = await fixture('portrait drawing.pdf', [{ text: 'Drawing notes and raster detail', visual: true }]);
  const output = path.join(temporaryRoot, 'drawing output');
  const response = await runCli('drawing-requirements-matcher', ['--input', input, '--output', output, '--name', '零件图纸.pdf'], {
    env: { ...environment, PYTHON_PATH: path.join(temporaryRoot, '__missing_python__') },
  });
  assert.equal(response.code, 0, response.stderr);
  const summary = JSON.parse(response.stdout), prepared = await readJson(summary.preparedPath);
  assert.equal(path.resolve(summary.preparedPath), path.join(output, 'prepared.json'));
  assert.equal(prepared.pages.length, 1);
  assert.equal(prepared.pages[0].landscape, false);
  assert.equal(prepared.documents[0].name, '零件图纸.pdf');
  assert.equal(prepared.images.length, 5);
  const overview = await fs.readFile(prepared.images[0]), crop = await fs.readFile(prepared.images[1]);
  assert.equal(overview.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.ok(crop.readUInt32BE(16) > overview.readUInt32BE(16) / 2 * 1.8, 'a crop must be rerendered above overview resolution');
  assert.deepEqual(prepared.documents[0].needsVisualReview, []);
  const coverage = await readJson(path.join(output, 'coverage.json'));
  assert.equal(coverage.totalImages, 5);
  assert.equal(summary.coverage.totalImages, 5);
  assert.deepEqual(coverage.pages[0].images, prepared.images.map(image => path.basename(image)));
  await assert.rejects(fs.access(path.join(output, 'table-structure.json')), { code: 'ENOENT' });
});

test('skill PDF CLIs reject unknown arguments and missing argument values before writing an output', async () => {
  const input = await fixture('arguments.pdf', [{ text: 'input must remain unchanged' }]);
  const original = await fs.readFile(input);
  for (const [index, skill] of ['specification-rule-parser', 'drawing-requirements-matcher'].entries()) {
    const output = path.join(temporaryRoot, `invalid-arguments-${index}`);
    const unknown = await runCli(skill, ['--input', input, '--output', output, '--unrecognized-option']);
    assert.notEqual(unknown.code, 0);
    assert.equal(unknown.stdout.trim(), '');
    assert.ok(unknown.stderr.trim());
    await assert.rejects(fs.access(path.join(output, 'prepared.json')), { code: 'ENOENT' });
    const missing = await runCli(skill, ['--input']);
    assert.notEqual(missing.code, 0);
    assert.equal(missing.stdout.trim(), '');
    assert.ok(missing.stderr.trim());
  }
  assert.deepEqual(await fs.readFile(input), original);
});

test('skill PDF CLIs refuse nonempty output directories and preserve their files', async () => {
  const input = await fixture('existing-output.pdf', [{ text: 'valid source PDF' }]);
  for (const [index, skill] of ['specification-rule-parser', 'drawing-requirements-matcher'].entries()) {
    const output = path.join(temporaryRoot, `already-populated-${index}`);
    await fs.mkdir(output);
    const marker = path.join(output, 'prepared.json'), original = Buffer.from('keep this existing result exactly\n');
    await fs.writeFile(marker, original);
    const response = await runCli(skill, ['--input', input, '--output', output]);
    assert.notEqual(response.code, 0);
    assert.equal(response.stdout.trim(), '');
    assert.ok(response.stderr.trim());
    assert.deepEqual(await fs.readFile(marker), original);
    assert.deepEqual(await fs.readdir(output), ['prepared.json']);
  }
});

test('missing PDF tooling fails explicitly without publishing a prepared result', async () => {
  const input = await fixture('missing-tool.pdf', [{ text: 'valid source PDF' }]);
  const output = path.join(temporaryRoot, 'missing-info-output');
  const response = await runCli('drawing-requirements-matcher', ['--input', input, '--output', output], {
    env: { ...environment, PDFINFO_PATH: path.join(temporaryRoot, '__missing_pdfinfo__') },
  });
  assert.notEqual(response.code, 0);
  assert.equal(response.stdout.trim(), '');
  assert.match(response.stderr, /Poppler|pdfinfo|PDFINFO_PATH/i);
  await assert.rejects(fs.access(path.join(output, 'prepared.json')), { code: 'ENOENT' });
});

test('missing table Python fails explicitly without publishing a specification result', pdfOptions, async () => {
  const input = await fixture('missing-python.pdf', [{ text: 'valid specification source' }]);
  const output = path.join(temporaryRoot, 'missing-python-output');
  const response = await runCli('specification-rule-parser', ['--input', input, '--output', output], {
    env: { ...environment, PYTHON_PATH: path.join(temporaryRoot, '__missing_python__') },
  });
  assert.notEqual(response.code, 0);
  assert.equal(response.stdout.trim(), '');
  assert.match(response.stderr, /PYTHON_PATH|Python|python|表格/);
  await assert.rejects(fs.access(path.join(output, 'prepared.json')), { code: 'ENOENT' });
});

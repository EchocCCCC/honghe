import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareDocuments, poppler, augmentTableEvidence } from '../server/pdf.js';
import { runProcess } from '../server/process.js';
import { appendTableStructure, python } from '../server/table-structure.js';

let popplerAvailable = true;
try { await Promise.all(Object.values(poppler).map(command => runProcess(command, ['-v'], { timeout: 15000 }))); }
catch { popplerAvailable = false; }
const options = { skip: !popplerAvailable && 'Poppler is required for these real PDF integration tests' };
const workRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..', 'work');
let temporaryRoot;
before(async () => {
  if (!popplerAvailable) return;
  await fs.mkdir(workRoot, { recursive: true });
  temporaryRoot = await fs.mkdtemp(path.join(workRoot, 'pdf-tests-'));
});
after(async () => {
  if (!temporaryRoot) return;
  assert.equal(path.dirname(path.resolve(temporaryRoot)), workRoot);
  assert.match(path.basename(temporaryRoot), /^pdf-tests-/);
  await fs.rm(temporaryRoot, { recursive: true, force: true });
});

// Small ASCII PDF fixtures with a real page tree, explicit blank pages, optional
// rotation, and an embedded inline image that cannot appear in pdftotext output.
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
  for (let index = 0; index < objects.length; index++) {
    offsets.push(Buffer.byteLength(source));
    source += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(source);
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  const filename = path.join(temporaryRoot, name);
  await fs.writeFile(filename, source, 'ascii');
  return { name, path: filename };
}

test('every physical page is rendered, including a high-text portrait visual and a trailing blank', options, async () => {
  const file = await fixture('coverage.pdf', [
    { text: 'Portrait page with enough searchable text to evade the former low-text and table heuristics.', visual: true },
    { text: 'Rotated drawing page', width: 240, height: 400, rotate: 90, visual: true },
    {},
  ]);
  const result = await prepareDocuments([file], path.join(temporaryRoot, 'coverage'));
  assert.equal(result.documents[0].pages, 3);
  assert.equal(result.documents[0].textPages.length, 3);
  assert.deepEqual(result.pages.map(page => page.page), [1, 2, 3]);
  assert.ok(result.pages[0].text.replace(/\s/g, '').length > 50);
  assert.equal(result.pages[0].imagePaths.length, 1);
  assert.equal(result.pages[1].landscape, true);
  assert.equal(result.pages[1].imagePaths.length, 5);
  assert.equal(result.pages[1].width, 400);
  assert.equal(result.pages[1].height, 240);
  assert.equal(result.pages[2].blankText, true);
  assert.equal(result.pages[2].imagePaths.length, 1);
  assert.deepEqual(result.documents[0].imagePages, [1, 2, 3]);
  assert.equal(result.coverage.physicalPages, 3);
  assert.equal(result.coverage.renderedPages, 3);
  assert.equal(result.coverage.totalImages, 7);
  assert.deepEqual(result.coverage.missingImagePages, []);
  const source = await fs.readFile(result.sourcePath, 'utf8');
  assert.equal((source.match(/--- PDF物理页 /g) || []).length, 3);
  const manifest = JSON.parse(await fs.readFile(result.coverage.manifestPath, 'utf8'));
  assert.equal(manifest.pages.length, 3);
  assert.equal(manifest.pages[2].blankText, true);
  assert.equal('text' in manifest.pages[0], false);
  assert.equal(manifest.pages[0].images[0], 'doc-1-page-1.png');
  for (const image of result.images) await fs.access(image);
});

test('attachments are not silently capped at twelve pages', options, async () => {
  const file = await fixture('thirteen-pages.pdf', Array.from({ length: 13 }, (_, index) => ({ text: `Physical page ${index + 1}` })));
  const result = await prepareDocuments([file], path.join(temporaryRoot, 'thirteen'));
  assert.equal(result.pages.length, 13);
  assert.equal(result.images.length, 13);
  assert.deepEqual(result.documents[0].imagePages, Array.from({ length: 13 }, (_, index) => index + 1));
  assert.ok(result.pages.every(page => page.imagePaths.length === 1));
  assert.deepEqual(result.coverage.missingImagePages, []);
  assert.equal(result.warnings.some(warning => /12.*上限|未附该页/.test(warning)), false);
});

test('drawing detail mode supplies genuinely higher-resolution crops for portrait scans too', options, async () => {
  const file = await fixture('portrait-drawing.pdf', [{ text: 'Detailed drawing notes', visual: true }]);
  const result = await prepareDocuments([file], path.join(temporaryRoot, 'detail'), { detailMode: true });
  assert.equal(result.pages[0].landscape, false);
  assert.equal(result.images.length, 5);
  const overview = await fs.readFile(result.images[0]);
  const crop = await fs.readFile(result.images[1]);
  assert.ok(crop.readUInt32BE(16) > overview.readUInt32BE(16) / 2 * 1.8);
  assert.equal(result.documents[0].needsVisualReview.length, 0);
});
test('table audit augments image-only pages without dropping other physical pages', options, async () => {
  const file = await fixture('table-audit.pdf', [{ text: 'normal source page' }, { visual: true }]);
  const result = await prepareDocuments([file], path.join(temporaryRoot, 'table-audit-base'));
  await augmentTableEvidence(result, [file], path.join(temporaryRoot, 'table-audit-detail'));
  assert.deepEqual(result.pages.map(p => p.page), [1, 2]);
  assert.equal(result.pages[0].imagePaths.length, 1); assert.equal(result.pages[1].imagePaths.length, 5);
  assert.equal(result.images.length, 6); assert.equal(result.coverage.totalImages, 6);
  assert.match(await fs.readFile(result.sourcePath, 'utf8'), /VISUAL_TABLE_EVIDENCE_DATA/);
});
let tableParserAvailable = true;
try { await runProcess(python(), ['-X', 'utf8', '-c', 'import pdfplumber'], { timeout: 20000 }); } catch { tableParserAvailable = false; }
test('vector grid expands only a physically merged cell, leaving a neighboring empty cell empty', { skip: !popplerAvailable || !tableParserAvailable }, async () => {
  const stream = '0.5 w 10 20 300 160 re S 90 20 m 90 180 l S 190 20 m 190 180 l S 10 140 m 310 140 l S 10 100 m 190 100 l S 10 60 m 310 60 l S\n' +
    'BT /F1 10 Tf 20 155 Td (condition) Tj ET BT /F1 10 Tf 110 155 Td (note) Tj ET BT /F1 10 Tf 210 155 Td (value) Tj ET\n' +
    'BT /F1 10 Tf 20 115 Td (10) Tj ET BT /F1 10 Tf 20 75 Td (20) Tj ET BT /F1 10 Tf 20 35 Td (30) Tj ET\n' +
    'BT /F1 10 Tf 110 115 Td (A) Tj ET BT /F1 10 Tf 110 35 Td (B) Tj ET BT /F1 10 Tf 210 95 Td (7) Tj ET BT /F1 10 Tf 210 35 Td (8) Tj ET\n';
  const file = await fixture('merged-vector-table.pdf', [{ width: 340, height: 220, extraStream: stream }]);
  const directory = path.join(temporaryRoot, 'vector-table');
  const prepared = await prepareDocuments([file], directory, { renderImages: false });
  const payload = await appendTableStructure(prepared, file, directory);
  const rows = payload.pages[0].tables[0].expandedRows;
  assert.deepEqual(rows.slice(1).map(row => row.values), [['10', 'A', '7'], ['20', '', '7'], ['30', 'B', '8']]);
  assert.equal(rows[1].cellRefs[2], rows[2].cellRefs[2]);
  assert.notEqual(rows[1].cellRefs[1], rows[2].cellRefs[1]);
  assert.match(await fs.readFile(prepared.sourcePath, 'utf8'), /PDF_VECTOR_TABLE_STRUCTURE_DATA/);
});

test('render failures remain explicit coverage gaps and force review', options, async () => {
  const file = await fixture('render-failure.pdf', [{ text: 'A readable page whose image renderer will deliberately be unavailable.' }]);
  const render = poppler.render;
  try {
    poppler.render = path.join(temporaryRoot, 'missing-pdftoppm');
    const result = await prepareDocuments([file], path.join(temporaryRoot, 'render-failure'));
    assert.deepEqual(result.documents[0].needsVisualReview, [1]);
    assert.equal(result.pages[0].imagePaths.length, 0);
    assert.equal(result.coverage.renderedPages, 0);
    assert.deepEqual(result.coverage.missingImagePages, [{ docId: 'doc-1', file: file.name, page: 1 }]);
    assert.ok(result.warnings.some(warning => /视觉覆盖缺失/.test(warning)));
  } finally { poppler.render = render; }
});

test('physical page limits fail explicitly rather than omitting pages', options, async () => {
  const oversized = await fixture('oversized.pdf', Array.from({ length: 101 }, () => ({})));
  await assert.rejects(prepareDocuments([oversized], path.join(temporaryRoot, 'oversized'), { renderImages: false }), /1–100.*物理页/);
  const hundred = await fixture('hundred.pdf', Array.from({ length: 100 }, () => ({ text: 'x' })));
  const one = await fixture('one.pdf', [{ text: 'x' }]);
  await assert.rejects(prepareDocuments([hundred, hundred, one], path.join(temporaryRoot, 'total-limit'), { renderImages: false }), /不得超过200个物理页/);
});

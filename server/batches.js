import fs from 'node:fs/promises';
import path from 'node:path';

export const pageKey = (file, page) => JSON.stringify([file, page]);
// Verification is derived by the backend, not a source field the model may
// return. Remove it only while serializing source records for model input.
export function modelInputJson(value) {
  return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) &&
    Object.hasOwn(item, 'file') && Object.hasOwn(item, 'page') && Object.hasOwn(item, 'quote')
    ? Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'verification')) : item);
}
const normalize = value => String(value ?? '').normalize('NFKC').replace(/\s/g, '');
// Only exact technical equivalence is deduplicated. Different scopes, states,
// values, units or evidence must remain separate even with identical prose.
export function technicalFactKey(item) {
  return JSON.stringify({ category: normalize(item.category), scope: normalize(item.scope), requirement: normalize(item.requirement),
    parameters: (item.parameters || []).map(p => [normalize(p.name), normalize(p.value), normalize(p.unit)]).map(JSON.stringify).sort(),
    sources: (item.sources || []).map(s => [s.file, s.page, normalize(s.section), normalize(s.quote)]).map(JSON.stringify).sort() });
}

// A page is an indivisible unit: its overview and visual tiles travel together.
export function planPageBatches(pages, { maxImages = 12, maxPages = 8 } = {}) {
  if (!Number.isInteger(maxImages) || maxImages < 1 || maxImages > 12 || !Number.isInteger(maxPages) || maxPages < 1) throw new Error('无效分批限制');
  const batches = [], seen = new Set();
  let current = { pages: [], images: [] };
  for (const page of pages) {
    const key = pageKey(page.file, page.page);
    if (seen.has(key)) throw new Error('物理页重复：' + key);
    seen.add(key);
    const images = page.imagePaths || [];
    if (images.length > maxImages) throw new Error('单页图像超过单批限制，不能静默丢图');
    if (current.pages.length && (current.images.length + images.length > maxImages || current.pages.length >= maxPages)) {
      batches.push(current); current = { pages: [], images: [] };
    }
    current.pages.push(page); current.images.push(...images);
  }
  if (current.pages.length) batches.push(current);
  return batches.map((batch, index) => ({ ...batch, id: `B${String(index + 1).padStart(2, '0')}` }));
}

export function ownsSource(item, pages) {
  const keys = new Set(pages.map(p => pageKey(p.file, p.page)));
  return item.sources?.some(s => keys.has(pageKey(s.file, s.page)));
}

export async function writeBatchSource(directory, prepared, batch, extraData) {
  await fs.mkdir(directory, { recursive: true });
  const targets = batch.pages.map(({ file, page, imagePaths }) => ({ file, page, images: imagePaths.map(p => path.basename(p)) }));
  const sourcePath = path.join(directory, 'batch-source.txt');
  const original = await fs.readFile(prepared.sourcePath, 'utf8');
  await fs.writeFile(sourcePath, `本批负责的物理页：${JSON.stringify(targets)}\n\n${original}\n` +
    (extraData ? '\n<COMPLETE_EXTRACTION_RESULT_DATA>\n' + modelInputJson(extraData) + '\n</COMPLETE_EXTRACTION_RESULT_DATA>\n' : ''));
  return sourcePath;
}

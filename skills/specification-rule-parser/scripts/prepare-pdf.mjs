import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareDocuments, augmentTableEvidence } from './pdf-core.mjs';
import { appendTableStructure } from './table-structure.mjs';
import { runPdfCli } from './cli.mjs';

export async function prepareSpecification(file, directory, { tableDirectory = directory, auditDetails = false } = {}) {
  const prepared = await prepareDocuments([file], directory);
  await appendTableStructure(prepared, file, tableDirectory);
  if (auditDetails) await augmentTableEvidence(prepared, [file], path.join(directory, 'table-details'));
  prepared.preparation = { mode: 'specification', version: 'skill-pdf-v1' };
  return prepared;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runPdfCli({ label: '规范PDF预处理', prepare: prepareSpecification, allowAuditDetails: true }); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

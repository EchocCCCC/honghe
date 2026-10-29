import path from 'node:path';
import { fileURLToPath } from 'node:url';

async function sharedRuntime() {
  try {
    const [pdf, cli] = await Promise.all([
      import('../../specification-rule-parser/scripts/pdf-core.mjs'),
      import('../../specification-rule-parser/scripts/cli.mjs'),
    ]);
    return { ...pdf, ...cli };
  } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    throw new Error('缺少配套规范Skill的PDF脚本：请将 specification-rule-parser 与 drawing-requirements-matcher 两个完整目录并列安装。');
  }
}

export async function prepareDrawingDocuments(files, directory) {
  const { prepareDocuments } = await sharedRuntime();
  const prepared = await prepareDocuments(files, directory, { detailMode: true });
  prepared.preparation = { mode: 'drawing', version: 'skill-pdf-v1' };
  return prepared;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { runPdfCli } = await sharedRuntime();
    await runPdfCli({ label: '图纸PDF预处理', prepare: (file, directory) => prepareDrawingDocuments([file], directory) });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

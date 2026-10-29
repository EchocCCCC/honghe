import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcess } from './process.mjs';

export const python = () => process.env.PYTHON_PATH || (process.platform === 'win32' ? 'python' : 'python3');
export async function appendTableStructure(prepared, file, directory) {
  let result;
  try {
    const output = await runProcess(python(), ['-X', 'utf8', fileURLToPath(new URL('./table_structure.py', import.meta.url)), file.path], { timeout: 120000, maxBytes: 16e6 });
    result = JSON.parse(output.stdout);
  } catch (error) {
    throw new Error('规范表格结构读取失败：请配置PYTHON_PATH，并用该Python安装规范Skill的scripts/requirements.txt。' + String(error.message).slice(0, 240));
  }
  const payload = { file: file.name, ...result };
  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized) + (await fs.stat(prepared.sourcePath)).size > 1800000) throw new Error('规范文字与格线结构合计超过输入上限，请按完整章节拆分后重新建库；未丢弃表格。');
  await fs.writeFile(path.join(directory, 'table-structure.json'), JSON.stringify(payload, null, 2));
  await fs.appendFile(prepared.sourcePath, `\n<PDF_VECTOR_TABLE_STRUCTURE_DATA>\n${serialized}\n</PDF_VECTOR_TABLE_STRUCTURE_DATA>\n`);
  prepared.tableStructure = { engine: result.engine, version: result.version, tables: result.pages.reduce((n, page) => n + page.tables.length, 0), warnings: result.warnings };
  prepared.warnings.push(...result.warnings.map(w => `表格结构：${w}`));
  return payload;
}

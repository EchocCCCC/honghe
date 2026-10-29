import fs from 'node:fs/promises';
import path from 'node:path';

export async function runPdfCli({ label, prepare, allowAuditDetails = false }, args = process.argv.slice(2)) {
  const usage = label + '：node scripts/prepare-pdf.mjs --input 文件.pdf --output 新目录 [--name 原文件名.pdf]' + (allowAuditDetails ? ' [--audit-details]' : '');
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { console.log(usage); return; }
  const options = new Map();
  const valued = new Set(['--input', '--output', '--name']);
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (options.has(key)) throw new Error('重复参数：' + key);
    if (key === '--audit-details' && allowAuditDetails) options.set(key, true);
    else if (valued.has(key) && args[i + 1] && !args[i + 1].startsWith('--')) options.set(key, args[++i]);
    else throw new Error('未知参数或缺少参数值：' + key + '。' + usage);
  }
  if (!options.get('--input') || !options.get('--output')) throw new Error(usage);
  const input = path.resolve(options.get('--input')), output = path.resolve(options.get('--output'));
  if (!(await fs.stat(input)).isFile()) throw new Error('输入必须是PDF文件');
  let entries;
  try { entries = await fs.readdir(output); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (entries?.length) throw new Error('输出目录必须是新目录或空目录，已有文件未覆盖');
  const name = options.get('--name') || path.basename(input);
  if (path.basename(name) !== name || /[\\/\x00-\x1f]/.test(name)) throw new Error('--name 只能是原文件名，不能包含目录');
  await fs.mkdir(output, { recursive: true });
  const prepared = await prepare({ name, path: input }, output, { auditDetails: options.has('--audit-details') });
  const preparedPath = path.join(output, 'prepared.json');
  await fs.writeFile(preparedPath, JSON.stringify(prepared, null, 2));
  console.log(JSON.stringify({ preparedPath, sourcePath: prepared.sourcePath, coverage: prepared.coverage, warnings: prepared.warnings }));
}

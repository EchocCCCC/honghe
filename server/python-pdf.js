import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcess } from './process.js';

export const python = () => process.env.PYTHON_PATH || (process.platform === 'win32' ? 'python' : 'python3');
export const poppler = {
  text: process.env.PDFTOTEXT_PATH || 'pdftotext',
  render: process.env.PDFTOPPM_PATH || 'pdftoppm',
  info: process.env.PDFINFO_PATH || 'pdfinfo',
};
const bridge = fileURLToPath(new URL('../skills/specification-rule-parser/scripts/bridge.py', import.meta.url));
const drawingOcr = fileURLToPath(new URL('../skills/drawing-requirements-matcher/scripts/ocr_candidates.py', import.meta.url));

export async function invokeDrawingOcr(prepared, directory, { invoke = runProcess } = {}) {
  if (!Array.isArray(prepared.images) || prepared.images.length > 12) throw new Error('OCR前检查：图纸证据图超过12张，请拆分有效页；未丢弃任何页。');
  const runDirectory = await fs.mkdtemp(path.join(directory, 'ocr-'));
  const request = path.join(runDirectory, 'prepared-input.json');
  const outputPath = path.join(runDirectory, 'ocr-candidates.json');
  const textPath = path.join(runDirectory, 'ocr-candidates.txt');
  await fs.writeFile(request, JSON.stringify(prepared));
  const environment = { ...process.env };
  for (const key of ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) delete environment[key];
  if (process.env.DRAWING_OCR_PYTHONPATH) environment.PYTHONPATH = [process.env.DRAWING_OCR_PYTHONPATH, environment.PYTHONPATH].filter(Boolean).join(path.delimiter);
  let response;
  try {
    response = await invoke(python(), ['-X', 'utf8', drawingOcr, '--prepared', request, '--output', outputPath], { timeout: 1800000, maxBytes: 24e6, env: environment });
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('找不到Python，请配置PYTHON_PATH或安装Python 3.10+');
    throw error;
  }
  let summary;
  try { summary = JSON.parse(response.stdout); } catch { throw new Error('OCR脚本未返回完整JSON摘要；未将候选当作PDF原文'); }
  if (summary?.complete !== true || path.resolve(summary.outputPath || '') !== outputPath || path.resolve(summary.textPath || '') !== textPath) throw new Error('OCR输出路径或完成状态无效；未采用不完整候选');
  for (const file of [outputPath, textPath]) if (!(await fs.stat(file)).isFile()) throw new Error('OCR候选文件缺失');
  return { ocrCandidatesPath: outputPath, ocrTextPath: textPath, ocr: { ...summary, authority: 'candidate_only' } };
}

// The service passes JSON data to the Python Skill. File names never enter a shell.
export async function invokeSkillPdf(operation, payload) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'honghe-pdf-request-'));
  const request = path.join(temporary, 'request.json');
  try {
    await fs.writeFile(request, JSON.stringify({ operation, payload: { ...payload, poppler: { ...poppler } } }), { mode: 0o600 });
    const environment = { ...process.env };
    for (const key of ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) delete environment[key];
    const { stdout } = await runProcess(python(), ['-X', 'utf8', bridge, '--request', request], { timeout: 1800000, maxBytes: 24e6, env: environment });
    let result;
    try { result = JSON.parse(stdout); } catch { throw new Error('Python PDF脚本未返回完整JSON，请检查预处理日志'); }
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Python PDF脚本返回结构无效');
    return result;
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('找不到Python，请配置PYTHON_PATH或安装Python 3.10+');
    throw error;
  } finally {
    await fs.rm(request, { force: true }).catch(() => {});
    await fs.rmdir(temporary).catch(() => {});
  }
}

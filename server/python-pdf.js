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

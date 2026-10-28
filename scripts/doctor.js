import fs from 'node:fs/promises';
import path from 'node:path';
import { config, safeError } from '../server/config.js';
import { runProcess } from '../server/process.js';
import { PI_CLI } from '../server/pi.js';
import { poppler } from '../server/pdf.js';
import { SPEC_SKILL, DRAWING_SKILL } from '../server/two-stage-pipeline.js';
import { python } from '../server/table-structure.js';

let failed = false;
console.log(`Node ${process.version}`);
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 19)) { failed = true; console.error('Pi需要Node >=22.19，请安装Node24 LTS'); }
console.log(`DeepSeek: ${config.baseUrl} / ${config.model} / 密钥${config.apiKey ? '已配置' : '未配置'}`);
for (const skill of [SPEC_SKILL, DRAWING_SKILL]) {
  try { await fs.access(path.join(skill, 'SKILL.md')); console.log(`Skill: ${path.basename(skill)} 就绪`); }
  catch { failed = true; console.error(`缺少Skill：${path.basename(skill)}`); }
}
for (const [label, command, args] of [
  ['Pi', process.execPath, [PI_CLI, '--version']],
  ['PDF文字', poppler.text, ['-v']],
  ['PDF图像', poppler.render, ['-v']],
  ['PDF信息', poppler.info, ['-v']],
  ['表格结构', python(), ['-X', 'utf8', '-c', 'import pdfplumber; print("pdfplumber " + pdfplumber.__version__)']],
]) {
  try { const r = await runProcess(command, args); console.log(`${label}: ${(r.stdout || r.stderr).trim().split('\n')[0]}`); }
  catch (e) { failed = true; console.error(`${label}: ${safeError(e)}`); }
}
if (process.argv.includes('--api')) {
  try {
    const response = await fetch(config.baseUrl.replace(/\/$/, '') + '/models', { headers: { Authorization: `Bearer ${config.apiKey}` }, signal: AbortSignal.timeout(20000) });
    const data = await response.json();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${data.error?.message || 'API访问失败'}`);
    console.log('可用模型: ' + data.data.map(m => m.id).join(', '));
  } catch (e) { failed = true; console.error('API: ' + safeError(e)); }
}
if (!config.apiKey) failed = true;
process.exitCode = failed ? 1 : 0;

import path from 'node:path';
import { config, safeError } from '../server/config.js';
import { runProcess } from '../server/process.js';
import { PI_CLI } from '../server/pi.js';
import { poppler } from '../server/pdf.js';
import { SPEC_SKILL, DRAWING_SKILL } from '../server/two-stage-pipeline.js';
import { python } from '../server/table-structure.js';
import { fileURLToPath } from 'node:url';
import { loadSkillBundle } from '../server/skills.js';

export const OCR_CHECK_SOURCE = [
  'import sys',
  'if sys.version_info < (3, 11):',
  '    raise RuntimeError("完整服务的本地OCR需要Python 3.11+；基本PDF脚本仍支持3.10+")',
  'from importlib.metadata import version',
  'import rapidocr',
  'import onnxruntime',
  'for name, expected in (("rapidocr", "3.10.0"), ("onnxruntime", "1.31.1")):',
  '    actual = version(name)',
  '    if actual != expected:',
  '        raise RuntimeError(f"{name}需要{expected}，当前{actual}")',
  'print("Python " + sys.version.split()[0] + "; rapidocr " + version("rapidocr") + "; onnxruntime " + version("onnxruntime"))',
].join('\n');

export function drawingOcrEnvironment(environment = process.env) {
  const isolated = { ...environment };
  for (const key of ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) delete isolated[key];
  if (environment.DRAWING_OCR_PYTHONPATH) isolated.PYTHONPATH = [environment.DRAWING_OCR_PYTHONPATH, environment.PYTHONPATH].filter(Boolean).join(path.delimiter);
  return isolated;
}

export async function runDoctor({ invoke = runProcess, environment = process.env, settings = config, loadSkill = loadSkillBundle, log = console.log, error = console.error, api = process.argv.includes('--api') } = {}) {
  let failed = false;
  log(`Node ${process.version}`);
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 19)) { failed = true; error('Pi需要Node >=22.19，请安装Node24 LTS'); }
  log(`DeepSeek: ${settings.baseUrl} / ${settings.model} / 密钥${settings.apiKey ? '已配置' : '未配置'}`);
  for (const skill of [SPEC_SKILL, DRAWING_SKILL]) {
    try { await loadSkill(skill); log(`Skill: ${path.basename(skill)} 入口与协议就绪`); }
    catch { failed = true; error(`缺少Skill：${path.basename(skill)}`); }
  }
  const pythonCommand = environment.PYTHON_PATH || python();
  for (const [label, command, args, options] of [
    ['Pi', process.execPath, [PI_CLI, '--version']],
    ['PDF文字', poppler.text, ['-v']],
    ['PDF图像', poppler.render, ['-v']],
    ['PDF信息', poppler.info, ['-v']],
    ['Skill Python', pythonCommand, ['-X', 'utf8', '-c', 'import sys; assert sys.version_info >= (3, 10), "Skill需要Python 3.10+"; print(sys.version.split()[0])']],
    ['规范脚本', pythonCommand, ['-X', 'utf8', fileURLToPath(new URL('../skills/specification-rule-parser/scripts/prepare_pdf.py', import.meta.url)), '--help']],
    ['图纸脚本', pythonCommand, ['-X', 'utf8', fileURLToPath(new URL('../skills/drawing-requirements-matcher/scripts/prepare_pdf.py', import.meta.url)), '--help']],
    ['表格结构', pythonCommand, ['-X', 'utf8', '-c', 'import pdfplumber; print("pdfplumber " + pdfplumber.__version__)']],
    ['本地OCR', pythonCommand, ['-X', 'utf8', '-c', OCR_CHECK_SOURCE], { env: drawingOcrEnvironment(environment) }],
  ]) {
    try { const r = await invoke(command, args, options); log(`${label}: ${(r.stdout || r.stderr).trim().split('\n')[0]}`); }
    catch (e) { failed = true; error(`${label}: ${safeError(e)}`); }
  }
  if (api) {
    try {
      const response = await fetch(settings.baseUrl.replace(/\/$/, '') + '/models', { headers: { Authorization: `Bearer ${settings.apiKey}` }, signal: AbortSignal.timeout(20000) });
      const data = await response.json();
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${data.error?.message || 'API访问失败'}`);
      log('可用模型: ' + data.data.map(m => m.id).join(', '));
    } catch (e) { failed = true; error('API: ' + safeError(e)); }
  }
  if (!settings.apiKey) failed = true;
  return failed ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await runDoctor();

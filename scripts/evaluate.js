import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT, config, safeError } from '../server/config.js';
import { prepareDocuments } from '../server/pdf.js';
import { runPi, SKILL } from '../server/pi.js';
import { validateResult, normalizeEvidence } from '../server/validation.js';

// Real paid API evaluation; never import gold into the model's extraction context.
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const label = option('--label', new Date().toISOString().replace(/[:.]/g, '-'));
if (!/^[\w-]+$/.test(label)) throw new Error('label 只能包含字母、数字、下划线和短横线');
const model = option('--model', config.model);
const skillArg = option('--skill', SKILL);
const skill = skillArg === 'none' ? null : path.resolve(skillArg);
const fixtureDir = path.resolve(option('--fixtures', path.join(ROOT, 'evaluation/fixtures')));
const files = (await fs.readdir(fixtureDir)).filter(n => /\.pdf$/i.test(n)).map(name => ({ name, path: path.join(fixtureDir, name) }));
if (!files.length) throw new Error('fixtures 目录中没有PDF；请先复制待评估原文件');
const directory = path.join(ROOT, 'evaluation/runs', label);
await fs.mkdir(directory, { recursive: false });
try {
  console.log(`准备 ${files.length} 个文件，运行 ${model} / ${label}`);
  const prepared = await prepareDocuments(files, directory, { renderImages: model === 'deepseek-flash' });
  await fs.writeFile(path.join(directory, 'prepared.json'), JSON.stringify(prepared, null, 2));
  const run = await runPi({ directory, ...prepared, model, skill, onProgress: message => console.log(message) });
  const result = validateResult(run.result, prepared);
  result.run = run.metadata;
  await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ label, quality: result.quality, run: result.run }, null, 2));
} catch (e) { await fs.writeFile(path.join(directory, 'failure.json'), JSON.stringify({ error: safeError(e) })); console.error(safeError(e)); process.exitCode = 1; }

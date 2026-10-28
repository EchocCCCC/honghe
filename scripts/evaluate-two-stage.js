import fs from 'node:fs/promises';
import path from 'node:path';

// The manifest and generated results stay in the user's private evaluation folder.
// Each item is {series,kind:'spec'|'drawing',source:absolutePdfPath}.
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const manifestPath = option('--manifest'), output = option('--output'), mode = option('--stage', 'all');
const base = option('--url', 'http://127.0.0.1:3000');
const selectedSeries = option('--series');
if (!manifestPath || !output || !['specs', 'representatives', 'remaining', 'all'].includes(mode)) throw new Error('用法：node scripts/evaluate-two-stage.js --manifest 绝对路径.json --output 私有结果目录 [--stage specs|representatives|remaining|all] [--url 本机服务地址]');
await fs.mkdir(output, { recursive: true });
const manifest = JSON.parse((await fs.readFile(manifestPath, 'utf8')).replace(/^\uFEFF/, ''));
const statePath = path.join(output, 'validation-state.json');
let state = { specifications: {}, batches: [] };
try { state = JSON.parse(await fs.readFile(statePath, 'utf8')); } catch {}
let pendingSave = Promise.resolve();
const save = () => { const content = JSON.stringify(state, null, 2); pendingSave = pendingSave.then(() => fs.writeFile(statePath, content)); return pendingSave; };
async function request(endpoint, options) {
  const response = await fetch(base + endpoint, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}
async function wait(endpoint, label) {
  let last = 0, status;
  for (;;) {
    const job = await request(endpoint);
    if (Date.now() - last > 30000 || status !== job.status) { console.log(`${label}: ${job.status} ${job.message || ''}`); last = Date.now(); status = job.status; }
    if (['completed', 'partial', 'failed'].includes(job.status)) return job;
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
}
const specifications = manifest.filter(item => item.kind === 'spec' && (!selectedSeries || item.series === selectedSeries));
const specOutcomes = await Promise.allSettled(specifications.map(async item => {
  const form = new FormData(); form.append('file', new Blob([await fs.readFile(item.source)]), path.basename(item.source)); form.append('label', item.series);
  const accepted = await request('/api/specifications', { method: 'POST', body: form });
  state.specifications[item.series] = accepted.id; await save();
  const job = await wait(`/api/specifications/${accepted.id}`, item.series);
  await fs.writeFile(path.join(output, `${item.series}-specification.json`), JSON.stringify(job, null, 2));
  if (job.status !== 'completed') throw new Error(`${item.series}规范失败：${job.error}`);
}));
if (specOutcomes.some(outcome => outcome.status === 'rejected')) throw new AggregateError(specOutcomes.filter(o => o.status === 'rejected').map(o => o.reason), '规范评估未全部完成；其他规范结果已保存');
if (mode !== 'specs') {
  const acceptedBatches = [];
  for (const spec of specifications) {
    const all = manifest.filter(item => item.series === spec.series && item.kind === 'drawing');
    const files = mode === 'representatives' ? all.slice(0, 1) : mode === 'remaining' ? all.slice(1) : all;
    if (!files.length) continue;
    const form = new FormData(); form.append('specificationId', state.specifications[spec.series]); form.append('stage', 'all');
    for (const file of files) form.append('files', new Blob([await fs.readFile(file.source)]), path.basename(file.source));
    const accepted = await request('/api/drawing-batches', { method: 'POST', body: form });
    state.batches.push({ series: spec.series, mode, id: accepted.id, files: files.map(f => path.basename(f.source)) }); await save();
    acceptedBatches.push({ ...accepted, series: spec.series });
  }
  const drawingOutcomes = await Promise.allSettled(acceptedBatches.map(async batch => {
    const result = await wait(`/api/drawing-batches/${batch.id}`, `${batch.series}/${mode}`);
    await fs.writeFile(path.join(output, `${batch.series}-${mode}-${batch.id}.json`), JSON.stringify(result, null, 2));
    if (result.status !== 'completed') throw new Error(`${batch.series}有图纸未完成：${result.message}`);
  }));
  if (drawingOutcomes.some(outcome => outcome.status === 'rejected')) throw new AggregateError(drawingOutcomes.filter(o => o.status === 'rejected').map(o => o.reason), '图纸评估未全部完成；各批结果已保存');
}
console.log(`本次${mode}评估结束，结果位于指定私有目录`);

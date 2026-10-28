import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from '../server/config.js';

// End-to-end test of the exact public upload API; this makes a real paid run.
const url = process.argv[2] || 'http://127.0.0.1:3000';
const label = process.argv[3] || 'web-run';
if (!/^[\w-]+$/.test(label)) throw new Error('invalid label');
const directory = path.join(ROOT, 'evaluation/runs', label);
await fs.mkdir(directory, { recursive: false });
const form = new FormData();
for (const name of ['drawing.pdf', 'specification.pdf']) {
  form.append('files', new Blob([await fs.readFile(path.join(ROOT, 'evaluation/fixtures', name))], { type: 'application/pdf' }), name);
}
form.append('model', 'deepseek-flash');
const response = await fetch(url + '/api/jobs', { method: 'POST', body: form });
const created = await response.json();
if (!response.ok) throw new Error(JSON.stringify(created));
await fs.writeFile(path.join(directory, 'web-job.json'), JSON.stringify({ id: created.id, url, label }, null, 2));
console.log('实际上传任务：' + created.id);
let previous = '';
for (;;) {
  const job = await fetch(url + '/api/jobs/' + created.id).then(r => r.json());
  if (job.status !== previous) { console.log(job.status + ': ' + job.message); previous = job.status; }
  if (job.status === 'failed') throw new Error(job.error);
  if (job.status === 'completed') {
    await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify(job.result, null, 2));
    console.log(JSON.stringify({ id: created.id, quality: job.result.quality, run: job.result.run }, null, 2));
    break;
  }
  await new Promise(resolve => setTimeout(resolve, 3000));
}

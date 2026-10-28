import express from 'express';
import multer from 'multer';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ROOT, RUNTIME, MODELS, MODEL_NAME, config, safeError } from './config.js';
import { prepareDocuments } from './pdf.js';
import { runExtractionPipeline } from './pipeline.js';
import { createTwoStageRouter } from './two-stage-routes.js';

await fs.mkdir(path.join(RUNTIME, 'uploads'), { recursive: true });
await fs.mkdir(path.join(RUNTIME, 'jobs'), { recursive: true });
const jobs = new Map(), queue = [];
let busy = false;
const jobPath = id => path.join(RUNTIME, 'jobs', id);
const upload = multer({ dest: path.join(RUNTIME, 'uploads'), limits: { files: 10, fileSize: config.maxUpload, fields: 3 },
  fileFilter: (_req, file, callback) => /\.pdf$/i.test(file.originalname) ? callback(null, true) : callback(new Error('仅支持PDF')) });
export const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  const host = req.hostname;
  // Bind loopback by default. Reject cross-origin state mutations and DNS rebinding.
  if (config.host === '127.0.0.1' && !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) return res.status(403).json({ error: '不允许的主机' });
  if (req.method === 'POST' && req.headers.origin) {
    try { if (new URL(req.headers.origin).host !== req.headers.host) return res.status(403).json({ error: '不允许跨站上传' }); } catch { return res.status(403).json({ error: '无效来源' }); }
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});
app.use(express.static(path.join(ROOT, 'public')));
app.get('/api/health', (_req, res) => res.json({ ok: true, configured: Boolean(config.apiKey), model: config.model, modelName: MODEL_NAME, models: MODELS, piVersion: '1.4.0' }));
app.use('/api', createTwoStageRouter());

async function persist(job) {
  job.updatedAt = new Date().toISOString();
  await fs.writeFile(path.join(jobPath(job.id), 'job.json'), JSON.stringify(job, null, 2));
}
async function drain() {
  if (busy || !queue.length) return;
  busy = true;
  const job = queue.shift();
  try {
    job.status = 'extracting'; job.message = '读取 PDF 文本并生成图纸证据'; await persist(job);
    const prepared = await prepareDocuments(job.files, jobPath(job.id));
    job.status = 'running'; job.message = '通过 Pi 加载 skill，调用 DeepSeek 提取要求'; await persist(job);
    job.result = await runExtractionPipeline({ directory: jobPath(job.id), prepared, model: job.model,
      onProgress: message => { job.message = message; if (message.startsWith('逐页查漏')) job.status = 'validating'; job.updatedAt = new Date().toISOString(); } });
    job.status = 'completed'; job.message = `完成：${job.result.requirements.length}条要求，请核对待复核项`;
  } catch (error) { job.status = 'failed'; job.error = safeError(error); job.message = '提取失败，可按提示处理后重试'; }
  finally { await persist(job); busy = false; setImmediate(drain); }
}

app.post('/api/jobs', (req, res, next) => {
  if (!config.apiKey) return res.status(503).json({ error: '请在本地 .env 配置 DEEPSEEK_API_KEY 并重启' });
  if (queue.length >= 5) return res.status(429).json({ error: '等待队列已满，请稍后再试' });
  upload.array('files', 10)(req, res, error => {
    if (error) {
      Promise.all((req.files || []).map(f => fs.rm(f.path, { force: true }))).catch(() => {});
      return res.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? `单个文件不得超过${config.maxUpload / 1024 / 1024}MB` : '上传失败，请检查文件数量和大小' });
    }
    next();
  });
}, async (req, res, next) => {
  const files = req.files || [];
  try {
    if (!files.length) throw new Error('请至少上传一个 PDF 文件');
    if (files.length !== new Set(files.map(f => f.originalname)).size) throw new Error('文件名重复，请重命名后上传');
    const model = req.body.model || config.model;
    if (!MODELS.includes(model)) throw new Error('模型不在允许列表');
    const id = randomUUID();
    await fs.mkdir(jobPath(id));
    const stored = [];
    for (let index = 0; index < files.length; index++) {
      const f = files[index];
      // Multipart clients may encode UTF-8 filenames as latin1.
      const name = /[\u0080-\u00ff]/.test(f.originalname) ? Buffer.from(f.originalname, 'latin1').toString('utf8') : f.originalname;
      const dest = path.join(jobPath(id), `${index + 1}.pdf`);
      await fs.rename(f.path, dest);
      stored.push({ name: path.basename(name), path: dest });
    }
    const job = { id, model, status: 'queued', message: '任务已创建，等待处理', createdAt: new Date().toISOString(), files: stored };
    jobs.set(id, job); await persist(job); queue.push(job); res.status(202).json({ id }); setImmediate(drain);
  } catch (e) { await Promise.all(files.map(f => fs.rm(f.path, { force: true }).catch(() => {}))); next(e); }
});

async function findJob(id) {
  if (!/^[\da-f-]{36}$/i.test(id)) return null;
  if (jobs.has(id)) return jobs.get(id);
  try {
    const job = JSON.parse(await fs.readFile(path.join(jobPath(id), 'job.json'), 'utf8'));
    if (!['completed', 'failed'].includes(job.status)) { job.status = 'failed'; job.error = '服务在任务结束前重启，请重新提交'; }
    jobs.set(id, job); return job;
  } catch { return null; }
}
app.get('/api/jobs/:id', async (req, res) => {
  const job = await findJob(req.params.id);
  if (!job) return res.status(404).json({ error: '任务不存在' });
  const { files, ...publicJob } = job;
  res.json({ ...publicJob, files: files.map(f => ({ name: f.name })) });
});
app.get('/api/jobs/:id/files/:index', async (req, res) => {
  const job = await findJob(req.params.id);
  const index = Number(req.params.index);
  if (!job || !Number.isInteger(index) || !job.files[index]) return res.status(404).end();
  res.type('pdf').sendFile(job.files[index].path);
});
app.use((error, _req, res, _next) => res.status(400).json({ error: safeError(error) }));

if (process.argv[1] && path.resolve(process.argv[1]) === path.join(ROOT, 'server/app.js')) {
  app.listen(config.port, config.host, () => console.log(`工艺要求工作台 http://${config.host}:${config.port}`));
}

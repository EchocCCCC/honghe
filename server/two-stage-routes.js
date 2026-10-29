import express from 'express';
import multer from 'multer';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ACTIONABLE_TYPES, informationSummary, readInformationView, decorateDispositions } from './information-types.js';
import { RUNTIME, config, MODEL_ID, safeError } from './config.js';
import { buildSpecification, matchDrawing, specificationFingerprint, SPEC_SKILL, digest } from './two-stage-pipeline.js';
import { loadSkillBundle, freezeSkillBundle } from './skills.js';

const terminal = new Set(['completed', 'failed', 'partial']);
const validId = value => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const filename = original => path.basename((/[\u0080-\u00ff]/.test(original) ? Buffer.from(original, 'latin1').toString('utf8') : original).replaceAll('\\', '/'));
export class WorkQueue {
  constructor(concurrency = 2) { this.concurrency = concurrency; this.running = 0; this.tasks = []; }
  get size() { return this.running + this.tasks.length; }
  add(task) { this.tasks.push(task); this.drain(); }
  drain() {
    while (this.running < this.concurrency && this.tasks.length) {
      const task = this.tasks.shift(); this.running++;
      Promise.resolve().then(task).catch(() => {}).finally(() => { this.running--; this.drain(); });
    }
  }
}
export function createTwoStageRouter({ root = RUNTIME, build = buildSpecification, match = matchDrawing, configured = () => Boolean(config.apiKey) } = {}) {
  const router = express.Router(), queue = new WorkQueue(2), records = new Map(), writes = new Map();
  let specificationAdmission = Promise.resolve();
  const retryAdmissions = new Set();
  const directory = (type, id) => path.join(root, type, id);
  const key = (type, id) => `${type}/${id}`;
  const upload = multer({ dest: path.join(root, 'uploads'), limits: { files: 20, fileSize: config.maxUpload, fields: 4 }, fileFilter: (_req, file, callback) => /\.pdf$/i.test(file.originalname) ? callback(null, true) : callback(new Error('仅支持PDF')) });
  const cleanup = files => Promise.all(files.map(f => fs.rm(f.path, { force: true }).catch(() => {})));
  async function persist(type, job) {
    job.updatedAt = new Date().toISOString(); records.set(key(type, job.id), job);
    const content = JSON.stringify(job, null, 2), target = directory(type, job.id), recordKey = key(type, job.id);
    const operation = (writes.get(recordKey) || Promise.resolve()).catch(() => {}).then(async () => {
      await fs.mkdir(target, { recursive: true });
      const temp = path.join(target, `job-${randomUUID()}.tmp`);
      await fs.writeFile(temp, content); await fs.rename(temp, path.join(target, 'job.json'));
    });
    writes.set(recordKey, operation); await operation;
  }
  async function find(type, id) {
    if (!validId(id)) return null;
    if (records.has(key(type, id))) return records.get(key(type, id));
    try {
      const job = JSON.parse(await fs.readFile(path.join(directory(type, id), 'job.json'), 'utf8'));
      if (!terminal.has(job.status)) {
        job.status = 'failed'; job.error = '服务在完成任务前重启，请重新提交。'; job.message = job.error;
        for (const drawing of job.drawings || []) if (!terminal.has(drawing.status)) { drawing.status = 'failed'; drawing.error = job.error; }
        if (job.drawings?.length) {
          const completed = job.drawings.filter(d => d.status === 'completed').length;
          job.status = completed === job.drawings.length ? 'completed' : completed ? 'partial' : 'failed';
          job.message = `${completed}/${job.drawings.length}个零件完成；服务重启时未结束的零件已标记失败。`;
        }
      }
      records.set(key(type, id), job); return job;
    } catch { return null; }
  }
  async function allSpecifications() {
    await fs.mkdir(path.join(root, 'specifications'), { recursive: true });
    const dirs = await fs.readdir(path.join(root, 'specifications'));
    const found = await Promise.all(dirs.filter(validId).map(id => find('specifications', id)));
    return found.filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async function publicSpecification(job, detail = true) {
    const { file, fingerprint, ...publicJob } = job;
    const view = await readInformationView(root, job.result);
    if (view) {
      publicJob.informationSummary = view.informationSummary;
      publicJob.classification = view.classification;
      publicJob.ruleCount = view.informationSummary.actionable;
      publicJob.recordCount = view.informationSummary.total;
      if (job.status === 'completed') publicJob.message = `制造与检验${view.informationSummary.core}项；采购交付${view.informationSummary.procurement}项；背景说明${view.informationSummary.context}项${view.informationSummary.unclassified ? `；未归类${view.informationSummary.unclassified}项` : ''}`;
    }
    if (!detail) {
      delete publicJob.result;
      publicJob.metadata = job.result?.metadata;
      publicJob.ruleCount ??= 0;
      publicJob.recordCount ??= 0;
      publicJob.warningsCount = job.result?.warnings.length || 0;
    } else if (view) publicJob.result = view;
    return { ...publicJob, sourceSha256: fingerprint?.sourceSha256 };
  }
  async function publicBatch(job) {
    const spec = await find('specifications', job.specificationId);
    const specification = await readInformationView(root, spec?.result);
    return { ...job, ...(specification ? { specification: { ...job.specification, informationSummary: specification.informationSummary, ruleCount: specification.informationSummary.actionable, recordCount: specification.informationSummary.total } } : {}), drawings: await Promise.all(job.drawings.map(async ({ file, ...drawing }) => {
      if (!drawing.result) return drawing;
      const result = decorateDispositions(await readInformationView(root, drawing.result), specification);
      return { ...drawing, result, ...(drawing.status === 'completed' ? { message: `完成：制造与检验${result.informationSummary.core}项；采购交付${result.informationSummary.procurement}项；背景说明${result.informationSummary.context}项` } : {}) };
    })) };
  }
  function batchSummary(job) {
    const drawings = (job.drawings || []).map(drawing => {
      const requirements = drawing.result?.requirements;
      const hasResult = drawing.status === 'completed' && Array.isArray(requirements) && requirements.length > 0;
      return { id: drawing.id, name: drawing.name, status: drawing.status, sourceSha256: drawing.sourceSha256 || '', hasResult,
        partNumber: drawing.result?.drawing?.partNumber || '', partName: drawing.result?.drawing?.name || '', requirementCount: hasResult ? requirements.length : 0 };
    });
    return { id: job.id, specificationId: job.specificationId, stage: job.stage, status: job.status, createdAt: job.createdAt, updatedAt: job.updatedAt,
      drawingCount: drawings.length, completedCount: drawings.filter(drawing => drawing.hasResult).length, drawings };
  }
  function requireService(req, res, next) {
    if (!configured()) return res.status(503).json({ error: '请在本地 .env 配置 DEEPSEEK_API_KEY 并重启' });
    if (queue.size >= 40) return res.status(429).json({ error: '等待队列已满，请稍后提交' });
    next();
  }
  function receive(mode) {
    return (req, res, next) => {
      const handler = mode === 'spec' ? upload.single('file') : upload.array('files', 20);
      handler(req, res, error => {
        if (!error) return next();
        cleanup(req.file ? [req.file] : req.files || []).catch(() => {});
        res.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? `单个PDF不得超过${config.maxUpload / 1024 / 1024}MB` : '上传失败，请检查PDF、文件数量和大小' });
      });
    };
  }
  function enqueueDrawing(job, drawing, spec, options = {}) {
    queue.add(async () => {
      const target = directory('drawing-batches', job.id), child = path.join(target, drawing.id);
      try {
        job.status = 'running'; drawing.status = 'preparing'; drawing.message = '读取本零件原图与高分辨率局部'; await persist('drawing-batches', job);
        let initialRun;
        if (options.reuseMatching) {
          try {
            const metadata = JSON.parse(await fs.readFile(path.join(child, 'matching/run-metadata.json'), 'utf8'));
            const candidate = JSON.parse(await fs.readFile(path.join(child, 'matching/model-result.json'), 'utf8'));
            if (metadata.stopReason === 'stop' && metadata.model === MODEL_ID && candidate.requirements?.length && candidate.requirements.every(item => ACTIONABLE_TYPES.includes(item.informationType))) initialRun = { metadata, result: candidate };
          } catch { /* An incomplete initial generation is rerun, never repaired as JSON. */ }
        }
        const specificationView = await readInformationView(root, spec.result);
        drawing.result = await match({ file: drawing.file, directory: child, specificationJob: { ...spec, result: specificationView }, specificationDirectory: directory('specifications', spec.id), stage: job.stage,
          initialRun, retryId: options.retryId || '', onProgress: (status, message) => { drawing.status = status; drawing.message = message; job.message = `${job.drawings.filter(d => d.status === 'completed').length}/${job.drawings.length}个零件完成；${drawing.name}：${message}`; } });
        drawing.status = 'completed'; drawing.message = `完成：${drawing.result.requirements.length}条要求`; delete drawing.error;
      } catch (error) { drawing.status = 'failed'; drawing.error = safeError(error); drawing.message = '本零件处理失败；其他零件继续'; }
      const completed = job.drawings.filter(d => d.status === 'completed').length, failed = job.drawings.filter(d => d.status === 'failed').length;
      if (completed + failed === job.drawings.length) job.status = failed === 0 ? 'completed' : completed === 0 ? 'failed' : 'partial';
      job.message = `${completed}/${job.drawings.length}个零件完成${failed ? `，${failed}个失败` : ''}`;
      await persist('drawing-batches', job);
    });
  }
  router.get('/specifications', async (_req, res) => res.json({ specifications: await Promise.all((await allSpecifications()).map(job => publicSpecification(job, false))) }));
  router.post('/specifications', requireService, receive('spec'), async (req, res, next) => {
    const uploaded = req.file;
    const previous = specificationAdmission; let unlock;
    specificationAdmission = new Promise(resolve => { unlock = resolve; });
    await previous;
    try {
      if (!uploaded) throw new Error('请选择一份技术规范PDF');
      const parserBundle = await loadSkillBundle(SPEC_SKILL);
      const fingerprint = await specificationFingerprint(uploaded.path, parserBundle);
      const cached = (await allSpecifications()).find(job => job.status !== 'failed' && job.fingerprint && Object.keys(fingerprint).every(k => job.fingerprint[k] === fingerprint[k]));
      if (cached) { await cleanup([uploaded]); return res.status(202).json({ id: cached.id, cached: true }); }
      const id = randomUUID(), target = directory('specifications', id); await fs.mkdir(target, { recursive: true });
      const file = { name: filename(uploaded.originalname), path: path.join(target, 'source.pdf') };
      await fs.rename(uploaded.path, file.path);
      const skill = await freezeSkillBundle(parserBundle, path.join(target, 'parser-bundle.json'));
      const job = { id, name: String(req.body.label || file.name).slice(0, 180), file, fingerprint, model: MODEL_ID, status: 'queued', message: '等待建立规范规则库', createdAt: new Date().toISOString() };
      await persist('specifications', job);
      res.status(202).json({ id, cached: false });
      queue.add(async () => {
        try {
          job.status = 'preparing'; job.message = '读取规范全部物理页并生成证据'; await persist('specifications', job);
          job.result = await build({ file, directory: target, skill, onProgress: (status, message) => { job.status = status; job.message = message; } });
          const runs = [...(job.result.run?.extractionRuns || []), ...(job.result.review?.runs || [])];
          if (runs.some(run => run.skillBundleSha256 !== fingerprint.parserSha256)) throw new Error('规范调用的Skill资料快照与缓存指纹不一致，拒绝保存为可用规则库');
          job.status = 'completed'; job.message = `规范库已建立：${job.result.informationSummary?.core ?? job.result.rules.length}项制造与检验要求，请核对分类与原文疑点`;
        } catch (error) { job.status = 'failed'; job.error = safeError(error); job.message = '规范解析失败，可重新提交'; }
        await persist('specifications', job);
      });
    } catch (error) { if (uploaded) await cleanup([uploaded]); next(error); }
    finally { unlock(); }
  });
  router.get('/specifications/:id', async (req, res) => {
    const job = await find('specifications', req.params.id);
    if (!job) return res.status(404).json({ error: '规范不存在' });
    res.json(await publicSpecification(job));
  });
  router.get('/specifications/:id/file', async (req, res) => {
    const job = await find('specifications', req.params.id);
    if (!job) return res.status(404).end();
    res.type('pdf').sendFile(job.file.path);
  });
  router.post('/drawing-batches', requireService, receive('drawing'), async (req, res, next) => {
    const files = req.files || [];
    try {
      if (!files.length) throw new Error('请至少选择一张图纸PDF');
      const spec = await find('specifications', req.body.specificationId || '');
      if (!spec || spec.status !== 'completed') throw new Error('请选择已经完成解析的规范版本');
      const stage = req.body.stage || 'all';
      if (!['all', 'sample', 'trial', 'batch'].includes(stage)) throw new Error('无效的交付阶段');
      const names = files.map(f => filename(f.originalname));
      if (new Set(names).size !== names.length || names.includes(spec.file.name)) throw new Error('规范和图纸的文件名必须唯一，请重命名后重试');
      if (queue.size + files.length > 40) throw new Error('图纸任务超过队列容量，请稍后提交');
      const id = randomUUID(), target = directory('drawing-batches', id); await fs.mkdir(target, { recursive: true });
      const drawings = [];
      for (const [index, uploaded] of files.entries()) {
        const drawingId = randomUUID(), childDirectory = path.join(target, drawingId); await fs.mkdir(childDirectory);
        const file = { name: names[index], path: path.join(childDirectory, 'source.pdf') };
        await fs.rename(uploaded.path, file.path);
        drawings.push({ id: drawingId, name: names[index], file, sourceSha256: digest(await fs.readFile(file.path)), status: 'queued', message: '等待处理本零件' });
      }
      const specificationView = await readInformationView(root, spec.result);
      const counts = informationSummary(specificationView.rules);
      const job = { id, specificationId: spec.id, specification: { id: spec.id, metadata: spec.result.metadata, ruleCount: counts.actionable, recordCount: counts.total }, model: MODEL_ID, stage, status: 'queued', message: `${drawings.length}个零件等待处理`, drawings, createdAt: new Date().toISOString() };
      await persist('drawing-batches', job); res.status(202).json({ id });
      for (const drawing of drawings) enqueueDrawing(job, drawing, spec);
    } catch (error) { await cleanup(files); next(error); }
  });
  router.get('/drawing-batches', async (req, res) => {
    const specificationId = req.query.specificationId;
    if (typeof specificationId !== 'string' || !validId(specificationId)) return res.status(400).json({ error: '请提供有效的技术规范ID' });
    if (!await find('specifications', specificationId)) return res.status(404).json({ error: '规范不存在' });
    let dirs;
    try { dirs = await fs.readdir(path.join(root, 'drawing-batches')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; dirs = []; }
    const jobs = await Promise.all(dirs.filter(validId).map(id => find('drawing-batches', id)));
    const batches = jobs.filter(job => job?.specificationId === specificationId)
      .sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0)).map(batchSummary);
    res.json({ batches });
  });
  router.get('/drawing-batches/:id', async (req, res) => {
    const job = await find('drawing-batches', req.params.id);
    if (!job) return res.status(404).json({ error: '图纸批次不存在' });
    res.json(await publicBatch(job));
  });
  router.post('/drawing-batches/:id/drawings/:drawingId/retry', requireService, async (req, res, next) => {
    const admission = `${req.params.id}/${req.params.drawingId}`;
    if (retryAdmissions.has(admission)) return res.status(409).json({ error: '已在提交重新核对，请等待状态更新' });
    retryAdmissions.add(admission);
    try {
      const job = await find('drawing-batches', req.params.id), drawing = job?.drawings.find(d => d.id === req.params.drawingId);
      if (!drawing) return res.status(404).json({ error: '零件不存在' });
      if (!terminal.has(drawing.status)) throw new Error('该零件仍在处理中，请等待');
      const spec = await find('specifications', job.specificationId);
      if (!spec || spec.status !== 'completed') throw new Error('原规范版本已不可用，请关联可用版本重新提交');
      const sourceSha256 = digest(await fs.readFile(drawing.file.path));
      if (drawing.sourceSha256 && drawing.sourceSha256 !== sourceSha256) throw new Error('保存的图纸已发生变化，请重新上传，不复用旧候选');
      drawing.sourceSha256 = sourceSha256;
      const retryId = randomUUID();
      if (drawing.result) await fs.writeFile(path.join(directory('drawing-batches', job.id), drawing.id, `result-before-${retryId}.json`), JSON.stringify(drawing.result, null, 2));
      delete drawing.result; delete drawing.error; drawing.status = 'queued'; drawing.message = '等待重新核对'; job.status = 'queued'; job.message = `重新核对 ${drawing.name}`; drawing.retryCount = (drawing.retryCount || 0) + 1;
      await persist('drawing-batches', job);
      res.status(202).json({ id: job.id, drawingId: drawing.id });
      enqueueDrawing(job, drawing, spec, { reuseMatching: true, retryId });
    } catch (error) { next(error); }
    finally { retryAdmissions.delete(admission); }
  });
  router.get('/drawing-batches/:id/drawings/:drawingId', async (req, res) => {
    const job = await find('drawing-batches', req.params.id), drawing = job?.drawings.find(d => d.id === req.params.drawingId);
    if (!drawing) return res.status(404).json({ error: '零件不存在' });
    const view = await publicBatch(job); res.json(view.drawings.find(item => item.id === drawing.id));
  });
  router.get('/drawing-batches/:id/drawings/:drawingId/file', async (req, res) => {
    const job = await find('drawing-batches', req.params.id), drawing = job?.drawings.find(d => d.id === req.params.drawingId);
    if (!drawing) return res.status(404).end();
    res.type('pdf').sendFile(drawing.file.path);
  });
  return router;
}

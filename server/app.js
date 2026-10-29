import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT, RUNTIME, MODELS, MODEL_NAME, config, safeError } from './config.js';
import { createTwoStageRouter } from './two-stage-routes.js';

await fs.mkdir(path.join(RUNTIME, 'uploads'), { recursive: true });
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
app.use('/api/jobs', (_req, res) => res.status(410).json({ error: '旧版综合提取接口已停用，请先建立技术规范库，再提交对应零件图纸。' }));
app.use((error, _req, res, _next) => res.status(400).json({ error: safeError(error) }));

if (process.argv[1] && path.resolve(process.argv[1]) === path.join(ROOT, 'server/app.js')) {
  app.listen(config.port, config.host, () => console.log(`工艺要求工作台 http://${config.host}:${config.port}`));
}

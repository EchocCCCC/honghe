import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(ROOT, '.env'), quiet: true });
export const RUNTIME = path.join(ROOT, 'runtime');
export const MODELS = ['deepseek-flash', 'deepseek-v4-pro'];
export const config = {
  host: process.env.HOST || '127.0.0.1',
  port: Number(process.env.PORT || 3000),
  model: process.env.DEEPSEEK_MODEL || MODELS[0],
  baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
  apiKey: process.env.DEEPSEEK_API_KEY || '',
  timeout: Number(process.env.PI_TIMEOUT_MS || 600000),
  maxUpload: Number(process.env.MAX_UPLOAD_MB || 25) * 1024 * 1024,
};

export function safeError(error) {
  let message = String(error?.message || error || '未知错误');
  if (config.apiKey) message = message.split(config.apiKey).join('[REDACTED]');
  return message.replace(/sk-[a-zA-Z0-9_-]{12,}/g, '[REDACTED]').slice(0, 1800);
}

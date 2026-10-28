import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT, config } from '../server/config.js';

const target = process.argv[2];
if (!target) throw new Error('请提供新的绝对打包目录');
const directory = path.resolve(target);
await fs.mkdir(directory, { recursive: false });
const excluded = new Set(['node_modules', '.git', '.env', 'runtime', 'fixtures', 'runs', 'test-results', 'playwright-report', '__pycache__']);
await fs.cp(ROOT, path.join(directory, 'honghe'), {
  recursive: true,
  filter: src => !path.relative(ROOT, src).split(path.sep).some(part => excluded.has(part) || (part.startsWith('.env.') && part !== '.env.example')),
});
const files = [];
async function inspect(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) await inspect(file);
    else {
      const buffer = await fs.readFile(file);
      if (config.apiKey && buffer.includes(Buffer.from(config.apiKey))) throw new Error('打包检查失败：发现密钥内容');
      files.push({ file: path.relative(directory, file).replaceAll('\\', '/'), bytes: buffer.length });
    }
  }
}
await inspect(directory);
await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ secretCheck: 'passed', files }, null, 2));
console.log(`已准备${files.length}个交付文件，密钥检查通过`);

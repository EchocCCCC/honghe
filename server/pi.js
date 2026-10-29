import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { createHash } from 'node:crypto';
import { config, MODEL_ID, MODEL_NAME, MODEL_VERSION } from './config.js';
import { loadSkillBundle, freezeSkillPrompt, verifySkillProvenance } from './skills.js';

export const PI_CLI = fileURLToPath(new URL('./bundle/cli.js', import.meta.resolve('@earendil-works/pi-coding-agent')));

export async function writePiConfig(directory) {
  await fs.mkdir(directory, { recursive: true });
  const models = [{
    id: MODEL_ID, name: MODEL_NAME, reasoning: true, input: ['text', 'image'], contextWindow: 1000000, maxTokens: Number(process.env.PI_MAX_TOKENS || 98304),
    thinkingLevelMap: { minimal: 'low', low: 'low', medium: 'high', high: 'high', xhigh: 'high', max: 'max' },
    samplingParams: { response_format: { type: 'json_object' } },
  }];
  await fs.writeFile(path.join(directory, 'models.json'), JSON.stringify({ providers: { 'deepseek-extract': {
    baseUrl: config.baseUrl, api: 'openai-completions', apiKey: '$DEEPSEEK_API_KEY',
    compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: true, maxTokensField: 'max_tokens', thinkingFormat: 'deepseek' }, models,
  } } }, null, 2));
  await fs.writeFile(path.join(directory, 'settings.json'), JSON.stringify({ quietStartup: true }));
}

export function parseAssistantEvents(events) {
  const final = events.filter(e => e.type === 'message_end' && e.message?.role === 'assistant').at(-1)?.message;
  if (!final) throw new Error('Pi 没有返回最终 assistant 消息');
  if (final.stopReason !== 'stop') throw new Error(`模型未完成：${final.errorMessage || final.stopReason || '缺少结束状态'}`);
  if (!Array.isArray(final.content) || final.content.some(c => !c || (c.type === 'text' && typeof c.text !== 'string'))) throw new Error('Pi 返回的 assistant 内容格式无效');
  const text = final.content.filter(c => c.type === 'text').map(c => c.text).join('');
  if (!text.trim()) throw new Error('模型返回了空结果');
  // Fenced JSON is tolerated; no regex repair or silent fabrication of missing data.
  const clean = text.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  let result;
  try { result = JSON.parse(clean); } catch { throw new Error('模型输出不是完整 JSON，可能发生截断；请拆分资料重试'); }
  return { result, usage: final.usage || {}, model: final.model, stopReason: final.stopReason };
}

// Decode UTF-8 across arbitrary pipe chunks and split only on LF. In particular,
// U+2028/U+2029 are legal JSON string characters, not JSONL record separators.
export function createJsonlDecoder(onEvent) {
  const decoder = new StringDecoder('utf8');
  let pending = '', lineNumber = 0;
  function consume(line) {
    lineNumber++;
    if (!line.trim()) return;
    let event;
    try { event = JSON.parse(line); } catch { throw new Error(`Pi JSONL 协议第${lineNumber}行不是完整 JSON`); }
    if (!event || Array.isArray(event) || typeof event !== 'object' || typeof event.type !== 'string') throw new Error(`Pi JSONL 协议第${lineNumber}行缺少事件类型`);
    onEvent(event);
  }
  return {
    push(chunk) {
      pending += decoder.write(chunk);
      let end;
      while ((end = pending.indexOf('\n')) >= 0) { consume(pending.slice(0, end)); pending = pending.slice(end + 1); }
    },
    end() { pending += decoder.end(); if (pending) { consume(pending); pending = ''; } },
  };
}

export async function runPi({ directory, sourcePath, images = [], model = config.model, skill, skillMode, skillProvenance, prompt, onProgress = () => {} }) {
  if (!config.apiKey) throw new Error('请先在本地 .env 配置 DEEPSEEK_API_KEY 并重启服务');
  if (model !== MODEL_ID) throw new Error(`本项目全部阶段固定使用 ${MODEL_NAME}（${MODEL_ID}）`);
  if (typeof skill !== 'string' || !skill.trim()) throw new Error('调用Pi时必须显式指定本阶段的Skill或已保存的Skill快照');
  if (images.length > 12) throw new Error('单次Pi调用图片超过12张，请通过逐页分批管线运行');
  if (!skillProvenance) {
    if (!skillMode) throw new Error('调用Pi时必须显式指定Skill任务模式或已编译快照的加载记录');
    ({ skill, skillProvenance } = await freezeSkillPrompt(await loadSkillBundle(skill), skillMode, directory));
  } else if (skillMode && skillMode !== skillProvenance.mode) throw new Error('Skill模式与加载记录不一致');
  const content = await fs.readFile(skill);
  const loading = verifySkillProvenance(content, skillProvenance);
  const skillHash = createHash('sha256').update(content).digest('hex');
  const agentDir = path.join(directory, 'pi-config');
  await writePiConfig(agentDir);
  const args = [PI_CLI, '-p', '--mode', 'json', '--provider', 'deepseek-extract', '--model', model,
    '--thinking', 'high', '--no-session', '--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-approve', '--no-tools'];
  // Pi prepends @file text before expanding /skill commands, which only expand
  // at the beginning of a prompt. Supplying the skill as the system prompt
  // guarantees its full instructions are present even with all tools disabled.
  await fs.writeFile(path.join(directory, 'skill-used.md'), content);
  args.push('--skill', skill, '--system-prompt', path.join(directory, 'skill-used.md'));
  args.push('@' + sourcePath, ...images.map(p => '@' + p));
  args.push(prompt || '按所加载Skill处理所附资料，严格输出当前任务的JSON契约。');
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: directory, shell: false, windowsHide: true,
      env: { ...process.env, DEEPSEEK_API_KEY: config.apiKey, PI_CODING_AGENT_DIR: agentDir, PI_SKIP_VERSION_CHECK: '1', NO_COLOR: '1' } });
    // Pi reads redirected stdin until EOF before print mode; the backend has no
    // stdin payload, so close it immediately rather than leaving the CLI waiting.
    child.stdin.end();
    const stderrDecoder = new StringDecoder('utf8');
    let stderr = '', bytes = 0, failure, lines = 0, lastUpdate = 0;
    const events = [];
    const kill = e => { failure ||= e; child.kill('SIGKILL'); };
    const timer = setTimeout(() => kill(new Error(`Pi 超时（${Math.round(config.timeout / 60000)}分钟）；请拆分文件或提高 PI_TIMEOUT_MS`)), config.timeout);
    child.on('error', e => { clearTimeout(timer); reject(e); });
    const stream = createJsonlDecoder(event => {
      lines++;
      if (event.type === 'message_end') events.push(event);
      if (Date.now() - lastUpdate > 5000 && event.type === 'message_update') {
        lastUpdate = Date.now(); onProgress(`模型正在分析与生成要求（已运行${Math.round((Date.now() - started) / 1000)}秒）`);
      }
    });
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 48e6) { kill(new Error('Pi 输出超过48MB限制')); return; }
      if (!failure) { try { stream.push(chunk); } catch (e) { kill(e); } }
    });
    child.stderr.on('data', b => { const text = stderrDecoder.write(b); if (stderr.length < 16000) stderr += text.slice(0, 16000 - stderr.length); });
    child.on('close', async code => {
      clearTimeout(timer);
      try {
        if (failure) throw failure;
        stream.end(); stderr += stderrDecoder.end();
        if (code !== 0) throw new Error(`Pi 退出码 ${code}：${stderr.slice(-2200)}`);
        const final = events.filter(e => e.type === 'message_end' && e.message?.role === 'assistant').at(-1)?.message;
        await fs.writeFile(path.join(directory, 'completion-metadata.json'), JSON.stringify({ model, elapsedMs: Date.now() - started, stopReason: final?.stopReason, usage: final?.usage, skillSha256: skillHash, skillBundleSha256: loading.bundleSha256, skillMode: loading.mode, attachedImages: images.length }, null, 2));
        if (final && final.stopReason !== 'stop') {
          const partial = (final.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
          await fs.writeFile(path.join(directory, 'incomplete-output.txt'), partial);
        }
        let parsed;
        try { parsed = parseAssistantEvents(events); }
        catch (error) {
          const raw = (final?.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
          await fs.writeFile(path.join(directory, 'invalid-output.txt'), raw);
          throw error;
        }
        const metadata = { model, modelLabel: MODEL_NAME, documentedModelVersion: MODEL_VERSION, versionNote: '版本依据2026-10-28官方映射；API别名并非不可变快照', providerReportedModel: parsed.model, elapsedMs: Date.now() - started, protocolEvents: lines, usage: parsed.usage, stopReason: parsed.stopReason, piVersion: '1.4.0', skill: loading.name, skillSha256: skillHash, skillBundleSha256: loading.bundleSha256, skillMode: loading.mode, skillLoading: loading, attachedImages: images.length };
        await fs.writeFile(path.join(directory, 'model-result.json'), JSON.stringify(parsed.result, null, 2));
        await fs.writeFile(path.join(directory, 'run-metadata.json'), JSON.stringify(metadata, null, 2));
        resolve({ ...parsed, metadata });
      } catch (e) { reject(e); }
    });
  });
}

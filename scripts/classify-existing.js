import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ROOT, RUNTIME, MODEL_ID } from '../server/config.js';
import { runPi } from '../server/pi.js';
import { informationDigest, validateInformationProfile, informationSummary } from '../server/information-types.js';

const args = process.argv.slice(2);
const arg = (name, fallback) => { const i = args.indexOf(name); if (i < 0) return fallback; if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`缺少${name}参数`); return args[i + 1]; };
const runtime = path.resolve(arg('--runtime', RUNTIME));
const output = path.resolve(arg('--output', path.join(runtime, 'information-profiles')));
const evidence = path.resolve(arg('--evidence', path.join(runtime, 'information-classification-runs', new Date().toISOString().replace(/[:.]/g, '-'))));
const skill = path.join(ROOT, 'skills/specification-rule-parser/SKILL.md');
const skillBytes = await fs.readFile(skill);
const skillSha256 = createHash('sha256').update(skillBytes).digest('hex');
const json = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2));
const resources = [];
for (const kind of ['specifications', 'drawing-batches']) {
  let entries;
  try { entries = await fs.readdir(path.join(runtime, kind), { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
  for (const entry of entries.filter(e => e.isDirectory())) {
    let job;
    try { job = JSON.parse(await fs.readFile(path.join(runtime, kind, entry.name, 'job.json'), 'utf8')); } catch (error) { throw new Error(`无法读取任务${entry.name}：${error.code || 'JSON格式错误'}`); }
    if (kind === 'specifications' && job.status === 'completed' && job.result) resources.push({ kind: 'specification', id: job.id, result: job.result });
    if (kind === 'drawing-batches') for (const drawing of job.drawings || []) if (drawing.status === 'completed' && drawing.result) resources.push({ kind: 'drawing', id: `${job.id}/${drawing.id}`, result: drawing.result });
  }
}
await fs.mkdir(output, { recursive: true });
await fs.mkdir(evidence, { recursive: true });
const fixedSkill = path.join(evidence, 'classifier-skill-used.md');
await fs.writeFile(fixedSkill, skillBytes);
const outcomes = [];
let cursor = 0;
async function worker() {
  while (cursor < resources.length) {
    const resource = resources[cursor++], resultSha256 = informationDigest(resource.result);
    const profileFile = path.join(output, resultSha256 + '.json');
    let cachedProfile = null;
    try {
      const cached = JSON.parse(await fs.readFile(profileFile, 'utf8'));
      validateInformationProfile(resource.result, cached);
      if (cached.skillSha256 === skillSha256) {
        if (cached.review?.status === 'completed' && cached.review.version === 'noncore-review-v1') { outcomes.push({ kind: resource.kind, id: resource.id, status: 'cached', resultSha256, counts: informationSummary(cached.items) }); console.log(`复用分类 ${resource.kind} ${resource.id}`); continue; }
        cachedProfile = cached;
      }
    } catch (error) { if (error.code !== 'ENOENT') console.log(`重新归类 ${resource.kind} ${resource.id}（旧分类不可复用）`); }
    try {
      const directory = path.join(evidence, resource.kind, ...resource.id.split('/'));
      await fs.mkdir(directory, { recursive: true });
      const rows = resource.result.rules || resource.result.requirements;
      const records = rows.map(({ id, category, requirement, scope, parameters, sources, conditions, exceptions, strength, origin, ruleIds }) => ({ id, category, requirement, scope, parameters, sources: sources.map(({ file, page, section, quote }) => ({ file, page, section, quote })), conditions, exceptions, strength, origin, ruleIds }));
      const sourcePath = path.join(directory, 'classification-input.json');
      await json(sourcePath, { task: '已有条目归类', kind: resource.kind, note: '只判断已有句子的功能，不重新提取技术要求，不修改数值、条件、原文和编号。', records });
      let profile = cachedProfile;
      if (!profile) {
      console.log(`开始归类 ${resource.kind} ${resource.id}：${records.length}条记录`);
      const run = await runPi({ directory, sourcePath, images: [], skill: fixedSkill, model: MODEL_ID,
        prompt: '任务模式：已有条目归类。对附件records每个id恰好归类一次。按句子实际功能区分manufacturing、quality、procurement、context，不按文件标题或原category整体套用。定义与纯导航为context；引用标准但包含具体制造/检验义务仍属核心。已有混合条目含制造或检验义务时保留核心类别并在reason说明需拆分。只输出Skill规定的classifications数组JSON，禁止改写原技术内容。',
        onProgress: message => console.log(`${resource.kind} ${resource.id}：${message}`) });
      if (!Array.isArray(run.result?.classifications)) throw new Error('分类结果缺少classifications数组');
      profile = { version: 1, resultSha256, model: MODEL_ID, skillSha256, createdAt: new Date().toISOString(), sourceKind: resource.kind, sourceId: resource.id, items: run.result.classifications, run: run.metadata };
      }
      validateInformationProfile(resource.result, profile);
      await json(path.join(directory, 'before-noncore-review.json'), profile);
      const noncoreIds = new Set(profile.items.filter(item => ['procurement', 'context'].includes(item.informationType)).map(item => item.id));
      const reviewRecords = records.filter(item => noncoreIds.has(item.id));
      let reviewed = 0, changes = 0, reviewRun = null;
      if (reviewRecords.length) {
        const reviewDirectory = path.join(directory, 'noncore-review'); await fs.mkdir(reviewDirectory, { recursive: true });
        const reviewSourcePath = path.join(reviewDirectory, 'input.json');
        await json(reviewSourcePath, { task: '已有条目归类', records: reviewRecords });
        console.log(`复核次要类别 ${resource.kind} ${resource.id}：${reviewRecords.length}条`);
        const audit = await runPi({ directory: reviewDirectory, sourcePath: reviewSourcePath, images: [], skill: fixedSkill, model: MODEL_ID,
          prompt: '任务模式：已有条目归类。请独立重读这些已有条目，重点避免真实制造/检验义务被藏入采购或背景。纯“见某表”导航是context；“检测按照某表执行”仍有检验义务，是quality。条目同时含检测执行与报告提交时，已有混合条目须保留核心类别并在reason说明需拆分，不能仅因报告内容较长就整体归采购。只要求提交报告或保存样件而不另含制造/检验义务时仍可procurement。对每个id恰好输出一次classification，不改原文数值和条件。',
          onProgress: message => console.log(`${resource.kind} ${resource.id}复核：${message}`) });
        const subset = { rules: reviewRecords };
        const checked = validateInformationProfile(subset, { resultSha256: informationDigest(subset), model: MODEL_ID, skillSha256, items: audit.result?.classifications });
        profile = { ...profile, items: profile.items.map(item => { const revised = checked.get(item.id); if (!revised) return item; if (revised.informationType !== item.informationType) changes++; return revised; }) };
        reviewed = reviewRecords.length; reviewRun = audit.metadata;
      }
      profile.items = profile.items.map(item => ({ ...item, review_required: Boolean(item.review_required || /混合|混有|兼有|需拆|拆分复核/.test(item.reason)) }));
      profile.review = { version: 'noncore-review-v1', status: 'completed', records: reviewed, changedTypes: changes, ...(reviewRun ? { run: reviewRun } : {}) };
      validateInformationProfile(resource.result, profile);
      const temporary = profileFile + '.tmp'; await json(temporary, profile); await fs.rename(temporary, profileFile);
      const counts = informationSummary(profile.items);
      outcomes.push({ kind: resource.kind, id: resource.id, status: 'completed', resultSha256, counts, run: profile.run, review: profile.review });
      console.log(`归类完成 ${resource.kind} ${resource.id}：制造${counts.manufacturing}，质量检验${counts.quality}，采购交付${counts.procurement}，背景${counts.context}`);
    } catch (error) { outcomes.push({ kind: resource.kind, id: resource.id, status: 'failed', resultSha256, error: String(error.message) }); console.error(`归类失败 ${resource.kind} ${resource.id}：${error.message}`); }
  }
}
await Promise.all([worker(), worker()]);
await json(path.join(evidence, 'classification-summary.json'), { model: MODEL_ID, skillSha256, resources: resources.length, outcomes, note: '仅新增分类索引，原始结果与已冻结比较保持不变；归类不代表重新读图或修复原有技术内容。' });
const failed = outcomes.filter(row => row.status === 'failed').length;
console.log(`完成${outcomes.length - failed}/${resources.length}个分类索引；失败${failed}个；未覆盖原始结果`);
process.exitCode = failed ? 1 : 0;

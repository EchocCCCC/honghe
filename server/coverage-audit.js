import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { runPi, SKILL } from './pi.js';
import { resultSchema, validateResult } from './validation.js';
import { ownsSource, writeBatchSource, technicalFactKey } from './batches.js';

const itemSchema = resultSchema.shape.requirements.element;
const fields = ['id', 'category', 'requirement', 'scope', 'parameters', 'sources', 'review_required', 'review_note'];
const schema = z.object({ replacements: z.array(itemSchema), additions: z.array(itemSchema), warnings: z.array(z.string()) }).strict();

export function applyCoveragePatch(input, rawPatch, batch, prepared) {
  const patch = schema.parse(rawPatch);
  const allowed = new Set(input.requirements.filter(r => ownsSource(r, batch.pages)).map(r => r.id));
  const ids = new Set(input.requirements.map(r => r.id)), changed = new Set();
  const knownLocations = new Set(prepared.documents.flatMap(d => Array.from({ length: d.pages }, (_, i) => JSON.stringify([d.name, i + 1]))));
  function check(item, raw) {
    if (!fields.every(field => Object.hasOwn(raw, field))) throw new Error('逐页核对必须返回完整条目');
    if (!ownsSource(item, batch.pages)) throw new Error('逐页核对补丁来源不属于本批负责的页面');
    if (item.sources.some(s => !knownLocations.has(JSON.stringify([s.file, s.page])))) throw new Error('逐页核对引用了不存在的文件或页码');
  }
  const replacements = new Map();
  patch.replacements.forEach((r, i) => {
    check(r, rawPatch.replacements[i]);
    if (!allowed.has(r.id) || changed.has(r.id)) throw new Error('逐页核对替换了非候选或重复编号：' + r.id);
    changed.add(r.id); replacements.set(r.id, r);
  });
  const result = structuredClone(input);
  result.requirements = result.requirements.map(r => replacements.has(r.id) ? replacements.get(r.id) : r);
  let nextId = result.requirements.reduce((max, r) => Math.max(max, Number(r.id.match(/^REQ-(\d+)$/)?.[1] || 0)), 0);
  const proposedIds = new Set(), addedIds = [];
  const exactFacts = new Set(result.requirements.map(technicalFactKey));
  patch.additions.forEach((r, i) => {
    check(r, rawPatch.additions[i]);
    if (ids.has(r.id) || proposedIds.has(r.id)) throw new Error('逐页核对新增条目的临时编号重复');
    proposedIds.add(r.id);
    const fact = technicalFactKey(r);
    if (exactFacts.has(fact)) return;
    exactFacts.add(fact);
    do { r.id = `REQ-${String(++nextId).padStart(3, '0')}`; } while (ids.has(r.id));
    ids.add(r.id); addedIds.push(r.id); result.requirements.push(r);
  });
  // Scoped free-text advice cannot overwrite global extraction warnings.
  result.warnings = [...input.warnings];
  const validated = validateResult(result, prepared);
  return { result: { ...result, ...validated }, addedIds, replacementIds: [...replacements.keys()], submittedIds: [...allowed], unmergedAdvisoryCount: patch.warnings.length };
}

export async function auditAllPages({ directory, prepared, batches, result, model, skill = SKILL, onProgress = () => {} }) {
  const runs = [], reviewedIds = new Set(), addedIds = [];
  let current = result;
  for (const batch of batches) {
    const reviewDir = path.join(directory, 'coverage-review', batch.id);
    const sourcePath = await writeBatchSource(reviewDir, prepared, batch, current);
    onProgress(`逐页查漏 ${batch.id}（${batch.pages.length}页），当前${current.requirements.length}条`);
    const run = await runPi({ directory: reviewDir, sourcePath, images: batch.images, model, skill,
      prompt: `任务模式：逐页完整性核对。你得到了全部源文本、完整的当前提取结果，以及本批负责页的图像。先逐页核对源文每个独立条款、表格行列、脚注、标注，不要只检查已提取候选。只针对附件开头列出的负责物理页输出补丁：修正已有条目放replacements，完全漏掉的独立要求放additions。新增要求必须有本批原文来源，不可补写外部标准内容或常识工艺。已有同义内容不重复新增，不为了凑数拆条。不要声称负责页之外内容遗漏。图纸分类/字段配对证据不充分时如实待确认。保留所有数值、力度、例外和阶段条件。必须检查刻字中的炉次/班次定义、离散编码、边缘偏差、角度与孔深的空间对应。输出紧凑JSON {"replacements":[完整要求条目],"additions":[完整要求条目，临时id用ADD-${batch.id}-001形式],"warnings":[]}，条目字段同主Skill契约；没有修改或新增则空数组。`,
      onProgress: message => onProgress(`逐页查漏 ${batch.id}：${message}`) });
    const applied = applyCoveragePatch(current, run.result, batch, prepared);
    current = applied.result;
    applied.submittedIds.forEach(id => reviewedIds.add(id)); addedIds.push(...applied.addedIds);
    runs.push({ batchId: batch.id, pages: batch.pages.map(({ file, page }) => ({ file, page })), ...run.metadata,
      replacementIds: applied.replacementIds, addedIds: applied.addedIds, submittedIds: applied.submittedIds, unmergedAdvisoryCount: applied.unmergedAdvisoryCount });
  }
  await fs.writeFile(path.join(directory, 'coverage-review-runs.json'), JSON.stringify(runs, null, 2));
  return { result: current, review: { status: 'completed', mode: 'all-pages-completeness', batchCount: runs.length,
    reviewedRequirementCount: reviewedIds.size, addedRequirementCount: addedIds.length, addedIds, runs,
    note: '逐页查漏可补回漏项；提交页数和复核条数不是准确率，也不代替工程师审核。' } };
}

import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { config, MODEL_ID } from './config.js';
import { runPi, SKILL } from './pi.js';
import { resultSchema, validateResult } from './validation.js';
import { planPageBatches, ownsSource, writeBatchSource, technicalFactKey } from './batches.js';
import { auditAllPages } from './coverage-audit.js';
import { addNumericCoverageWarnings } from './numeric-coverage.js';

const batchSchema = resultSchema.extend({ requirements: z.array(resultSchema.shape.requirements.element).max(1200) });

export function mergeBatchResults(batchResults) {
  const requirements = [], warnings = [], summaries = [], origins = [], facts = new Map();
  for (const { batch, result: raw } of batchResults) {
    const result = batchSchema.parse(raw);
    if (result.summary) summaries.push(`${batch.id}：${result.summary}`);
    warnings.push(...result.warnings);
    for (const item of result.requirements) {
      if (!ownsSource(item, batch.pages)) throw new Error(`提取${batch.id}输出了不属于负责页的要求：${item.id}`);
      const fact = technicalFactKey(item);
      if (facts.has(fact)) {
        const existing = facts.get(fact);
        existing.review_required ||= item.review_required;
        if (item.review_note && !existing.review_note.includes(item.review_note)) existing.review_note = [existing.review_note, item.review_note].filter(Boolean).join(' ');
        origins.push({ id: existing.id, originalId: item.id, batchId: batch.id, exactDuplicate: true }); continue;
      }
      const id = `REQ-${String(requirements.length + 1).padStart(3, '0')}`;
      const kept = { ...item, id };
      origins.push({ id, originalId: item.id, batchId: batch.id }); requirements.push(kept); facts.set(fact, kept);
    }
  }
  if (!requirements.length) throw new Error('全部页面均未提取到要求，请检查文件内容');
  return { summary: summaries.join('\n'), requirements, warnings: [...new Set(warnings)], origins };
}

export async function runExtractionPipeline({ directory, prepared, model = MODEL_ID, skill = SKILL, autoReview = process.env.PI_AUTO_REVIEW !== '0', onProgress = () => {} }) {
  if (model !== MODEL_ID) throw new Error('全部提取及核对阶段只能使用deepseek-flash（4.1 Flash）');
  const batches = planPageBatches(prepared.pages);
  const extracted = new Array(batches.length);
  let cursor = 0;
  const workers = Math.min(2, batches.length);
  const outcomes = await Promise.allSettled(Array.from({ length: workers }, async () => {
    for (;;) {
      const index = cursor++; if (index >= batches.length) break;
      const batch = batches[index], batchDir = path.join(directory, 'extraction', batch.id);
      const sourcePath = await writeBatchSource(batchDir, prepared, batch);
      onProgress(`提取 ${batch.id}/${batches.length}：${batch.pages.length}个物理页、${batch.images.length}张图像`);
      const run = await runPi({ directory: batchDir, sourcePath, images: batch.images, model, skill,
        prompt: '任务模式：分批提取。附件包含全部源文本作跨文件上下文，但本次只负责开头列出的物理页。完整提取负责页的正文、表格每行每列、脚注、图纸技术要求和标注，其他页只用于解释适用性和覆盖关系。每条至少有一个来源属于本批负责页。不把目录或前言修订记录当现行要求。完全没有要求的负责页允许requirements为空。全量提取不要只抽本产品参数；非本产品材料和类别标条件适用。引用其他条目使用源条款号，勿使用可能重编号的REQ编号。仅输出主Skill结构的紧凑JSON。',
        onProgress: message => onProgress(`提取 ${batch.id}：${message}`) });
      extracted[index] = { batch, result: run.result, metadata: run.metadata };
    }
  }));
  const failed = outcomes.find(outcome => outcome.status === 'rejected');
  if (failed) throw failed.reason;
  const merged = mergeBatchResults(extracted);
  let result = validateResult(merged, prepared);
  result.run = { model: config.model, mode: 'all-pages-batched', extractionBatchCount: batches.length, extractionRuns: extracted.map(({ batch, metadata }) => ({ batchId: batch.id, pages: batch.pages.map(({ file, page }) => ({ file, page })), ...metadata })) };
  await fs.writeFile(path.join(directory, 'extracted-result.json'), JSON.stringify(result, null, 2));
  await fs.writeFile(path.join(directory, 'requirement-origins.json'), JSON.stringify(merged.origins, null, 2));
  if (autoReview) {
    const audit = await auditAllPages({ directory, prepared, batches, result, model, skill, onProgress });
    result = audit.result; result.review = audit.review;
  } else result.review = { status: 'skipped', mode: 'all-pages-completeness', batchCount: 0, reviewedRequirementCount: 0, addedRequirementCount: 0 };
  const missingImages = prepared.documents.flatMap(d => (d.needsVisualReview || []).map(page => ({ file: d.name, page })));
  const numeric = addNumericCoverageWarnings(prepared, result);
  result.warnings = [...new Set([...result.warnings, ...numeric.warnings])];
  result.sourceCoverage = {
    totalPages: prepared.pages.length, visualPages: prepared.pages.filter(p => p.imagePaths.length > 0).length,
    failedVisualPages: missingImages.length, failedPageLocations: missingImages, extractionBatches: batches.length,
    reviewBatches: result.review.batchCount, reviewedRequirementCount: result.review.reviewedRequirementCount,
    addedDuringReview: result.review.addedRequirementCount || 0, totalRequirements: result.requirements.length,
    numericReviewFindings: numeric.findings,
    pages: prepared.pages.map(({ file, page, imagePaths }) => ({ file, page, images: imagePaths.length, visualSubmitted: imagePaths.length > 0 })),
    note: '覆盖率表示页面/条目已提交模型，不证明模型理解正确或没有语义遗漏；查漏阶段新增条目仍需人工确认。',
  };
  await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify(result, null, 2));
  return result;
}

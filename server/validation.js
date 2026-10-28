import { z } from 'zod';

const source = z.object({ file: z.string().min(1), page: z.number().int().positive(), section: z.string().optional().default(''), quote: z.string().min(1) });
export const resultSchema = z.object({
  summary: z.string().optional().default(''),
  requirements: z.array(z.object({
    id: z.string().min(1), category: z.string().min(1), requirement: z.string().min(1), scope: z.string().default(''),
    parameters: z.array(z.object({ name: z.string(), value: z.union([z.string(), z.number()]).transform(String), unit: z.string().optional().default('') })).default([]),
    sources: z.array(source).min(1), review_required: z.boolean().default(false), review_note: z.string().default(''),
  })).min(1).max(1200),
  warnings: z.array(z.string()).default([]),
});
export const normalizeEvidence = text => String(text).normalize('NFKC').replace(/[\s\u200b\u00ad]/g, '');
function markReview(item, note) {
  item.review_required = true;
  if (!item.review_note.includes(note)) item.review_note = (item.review_note + ' ' + note).trim();
}

export function validateResult(input, prepared) {
  const checked = resultSchema.safeParse(input);
  if (!checked.success) throw new Error('结果结构不符合要求：' + checked.error.issues.slice(0, 3).map(i => `${i.path.join('.')}: ${i.message}`).join('; '));
  const result = checked.data;
  const ids = new Set();
  let verified = 0, total = 0, visual = 0;
  for (const item of result.requirements) {
    if (ids.has(item.id)) throw new Error(`结果包含重复编号 ${item.id}`);
    ids.add(item.id);
    for (const s of item.sources) {
      total++;
      const doc = prepared.documents.find(d => d.name === s.file);
      if (!doc || s.page > doc.pages) {
        s.verification = 'invalid_location';
        markReview(item, '来源文件或页码不匹配，请核对。'); continue;
      }
      const quote = normalizeEvidence(s.quote);
      if (doc.needsVisualReview?.includes(s.page)) {
        markReview(item, '该页图像未能提交核对，请检查视觉覆盖记录。');
      }
      if (quote.length >= 2 && normalizeEvidence(doc.textPages[s.page - 1]).includes(quote)) {
        s.verification = 'text_match'; verified++;
      } else {
        const imagePresent = doc.imagePages.includes(s.page);
        s.verification = imagePresent ? 'visual_review' : 'unmatched_quote';
        if (imagePresent) visual++;
        markReview(item, imagePresent ? '图像/图纸证据需人工核对。' : '引文未在该页文本连续匹配，需人工核对。');
      }
    }
  }
  result.warnings = [...new Set([...prepared.warnings, ...result.warnings])];
  result.documents = prepared.documents.map(({ id, name, pages, imagePages }) => ({ id, name, pages, imagePages }));
  result.quality = { totalRequirements: result.requirements.length, totalSources: total, textMatchedSources: verified, visualReviewSources: visual,
    reviewRequired: result.requirements.filter(r => r.review_required).length, note: '文本匹配仅说明引文可定位，不等同于语义正确率或提取完整率。' };
  return result;
}

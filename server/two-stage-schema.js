import { z } from 'zod';
import { normalizeEvidence } from './validation.js';
import { INFORMATION_TYPES, ACTIONABLE_TYPES, informationSummary } from './information-types.js';

export const sourceSchema = z.object({ file: z.string().min(1), page: z.number().int().positive(), section: z.string().default(''), quote: z.string().min(1) });
const parameters = z.array(z.object({ name: z.string(), value: z.union([z.string(), z.number()]).transform(String), unit: z.string() }));
export const requirementSchema = z.object({
  id: z.string().min(1), informationType: z.enum(INFORMATION_TYPES), category: z.string().min(1), requirement: z.string().min(1), scope: z.string(),
  parameters, sources: z.array(sourceSchema).min(1), review_required: z.boolean(), review_note: z.string(),
});
export const ruleSchema = requirementSchema.extend({
  strength: z.enum(['required', 'prohibited', 'recommended', 'permitted', 'reference', 'conditional']),
  conditions: z.array(z.string()), exceptions: z.array(z.string()),
  overridePolicy: z.string(), externalReferences: z.array(z.string()),
});
export const metadataSchema = z.object({ number: z.string().default(''), title: z.string().default(''), version: z.string().default(''), scope: z.string().default(''), excludedProcesses: z.array(z.string()).default([]), priorityPolicy: z.string().default('') });
export const specificationSchema = z.object({ metadata: metadataSchema, rules: z.array(ruleSchema).max(2000), warnings: z.array(z.string()).default([]) });
export const specificationPatchSchema = z.object({ replacements: z.array(ruleSchema), additions: z.array(ruleSchema), warnings: z.array(z.string()).default([]) });
export const matchingSchema = z.object({
  drawing: z.object({
    partNumber: z.string().default(''), name: z.string().default(''), revision: z.string().default(''), material: z.string().default(''),
    materialForm: z.string().default(''), process: z.string().default(''), castingClass: z.string().default(''),
    airtightness: z.enum(['required', 'not_required', 'unspecified']), dimensionState: z.enum(['before_finish', 'after_finish', 'unspecified']),
    references: z.array(z.string()).default([]), facts: z.array(z.object({ name: z.string(), value: z.string(), sources: z.array(sourceSchema).min(1) })).default([]), uncertainties: z.array(z.string()).default([]),
  }), summary: z.string().default(''),
  requirements: z.array(requirementSchema.extend({ informationType: z.enum(ACTIONABLE_TYPES), origin: z.enum(['drawing', 'specification', 'combined']), ruleIds: z.array(z.string()) })).min(1).max(2000),
  dispositions: z.array(z.object({ ruleId: z.string(), status: z.enum(['applicable', 'not_applicable', 'overridden', 'needs_confirmation']), reason: z.string().min(1), evidence: z.array(sourceSchema).min(1) })),
  warnings: z.array(z.string()).default([]),
});
export const drawingPatchSchema = z.object({
  drawing: matchingSchema.shape.drawing, summary: z.string(),
  replacements: z.array(matchingSchema.shape.requirements.element), additions: z.array(matchingSchema.shape.requirements.element),
  removals: z.array(z.object({ id: z.string(), reason: z.string().min(1), evidence: z.array(sourceSchema).min(1) })),
  dispositionReplacements: z.array(matchingSchema.shape.dispositions.element), warnings: z.array(z.string()),
});

export function parseContract(schema, raw, label) {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new Error(`${label}结构不符合要求：` + parsed.error.issues.slice(0, 4).map(i => `${i.path.join('.')}: ${i.message}`).join('; '));
  return parsed.data;
}
export function verifySources(sources, documents) {
  return sources.map(source => {
    const doc = documents.find(d => d.name === source.file);
    if (!doc || source.page > doc.pages) throw new Error(`来源不属于本次资料或页码越界：${source.file}/${source.page}`);
    const text = normalizeEvidence(doc.textPages[source.page - 1] || '');
    const quote = normalizeEvidence(source.quote);
    const verification = quote.length >= 2 && text.includes(quote) ? 'text_match' : doc.imagePages.includes(source.page) ? 'visual_review' : 'unmatched_quote';
    return { ...source, verification };
  });
}
export function verifyRequirement(item, documents) {
  const sources = verifySources(item.sources, documents);
  const notes = [];
  if (sources.some(s => s.verification === 'visual_review')) notes.push('图像证据待人工核对；已提交模型不等于语义正确。');
  if (sources.some(s => s.verification === 'unmatched_quote')) notes.push('引文未能在文字层定位且该页未提交图像，请核对原件。');
  return { ...item, sources, review_required: item.review_required || notes.length > 0, review_note: appendReviewNotes(item.review_note, notes) };
}
function appendReviewNotes(current, notes) {
  let text = current || '';
  for (const note of notes) {
    // Revalidating a result must not repeat application-generated notices.
    text = text.split(note).join('').replace(/\s+/g, ' ').trim();
    text = [text, note].filter(Boolean).join(' ');
  }
  return text;
}
export function uniqueIds(items, label) {
  const ids = new Set();
  for (const item of items) { if (ids.has(item.id)) throw new Error(`${label}编号重复：${item.id}`); ids.add(item.id); }
  return ids;
}

export function applyDrawingPatch(candidate, rawPatch, specification, drawingPrepared, specPrepared) {
  const patch = parseContract(drawingPatchSchema, rawPatch, '逐图复核补丁');
  if (!Array.isArray(candidate.requirements) || !Array.isArray(candidate.dispositions)) throw new Error('初次候选缺少完整数组，无法安全应用补丁，请重新匹配');
  const existing = uniqueIds(candidate.requirements, '候选要求'), replacing = uniqueIds(patch.replacements, '替换要求'), removing = uniqueIds(patch.removals, '移除要求');
  uniqueIds(patch.additions, '新增要求');
  for (const id of [...replacing, ...removing]) if (!existing.has(id)) throw new Error(`补丁引用不存在的要求：${id}`);
  for (const id of removing) if (replacing.has(id)) throw new Error(`要求不能同时替换和移除：${id}`);
  const documents = [...drawingPrepared.documents, ...specPrepared.documents];
  for (const removal of patch.removals) verifySources(removal.evidence, documents);
  const replacements = new Map(patch.replacements.map(item => [item.id, item]));
  const requirements = candidate.requirements.filter(item => !removing.has(item.id)).map(item => replacements.get(item.id) || item);
  let nextId = candidate.requirements.length + 1;
  for (const addition of patch.additions) {
    if (existing.has(addition.id) || !/^ADD/i.test(addition.id)) throw new Error('新增要求必须使用未占用的ADD临时编号');
    let id; do { id = `REQ-${String(nextId++).padStart(3, '0')}`; } while (existing.has(id));
    existing.add(id); requirements.push({ ...addition, id });
  }
  const knownRules = new Set(specification.rules.map(rule => rule.id)), dispositions = new Map();
  for (const item of patch.dispositionReplacements) {
    if (!knownRules.has(item.ruleId) || dispositions.has(item.ruleId)) throw new Error('处置补丁引用未知或重复规则：' + item.ruleId);
    dispositions.set(item.ruleId, item);
  }
  const updated = [], applied = new Set();
  for (const item of candidate.dispositions) {
    if (dispositions.has(item.ruleId)) { if (!applied.has(item.ruleId)) updated.push(dispositions.get(item.ruleId)); applied.add(item.ruleId); }
    else updated.push(item);
  }
  for (const [id, item] of dispositions) if (!applied.has(id)) updated.push(item);
  const merged = { ...candidate, drawing: patch.drawing, summary: patch.summary || candidate.summary, requirements, dispositions: updated, warnings: [...new Set([...(candidate.warnings || []), ...patch.warnings])] };
  return { result: validateMatching(merged, specification, drawingPrepared, specPrepared), changes: { replacements: patch.replacements.length, additions: patch.additions.length, removals: patch.removals.length, dispositions: patch.dispositionReplacements.length } };
}

export function validateMatching(raw, specification, drawingPrepared, specPrepared) {
  const result = parseContract(matchingSchema, raw, '逐图结果');
  const documents = [...specPrepared.documents, ...drawingPrepared.documents];
  if (new Set(documents.map(d => d.name)).size !== documents.length) throw new Error('规范和图纸文件名重复，无法唯一定位证据');
  uniqueIds(result.requirements, '要求');
  const rules = new Map(specification.rules.map(r => [r.id, r]));
  const dispositions = new Map();
  const linked = new Set();
  const drawingNames = new Set(drawingPrepared.documents.map(d => d.name));
  const specNames = new Set(specPrepared.documents.map(d => d.name));
  for (const disposition of result.dispositions) {
    if (!rules.has(disposition.ruleId)) throw new Error(`未知规则：${disposition.ruleId}`);
    if (dispositions.has(disposition.ruleId)) throw new Error(`规则被重复判定：${disposition.ruleId}`);
    disposition.evidence = verifySources(disposition.evidence, documents);
    if (disposition.status === 'overridden' && (!disposition.evidence.some(s => drawingNames.has(s.file)) || !disposition.evidence.some(s => specNames.has(s.file)))) throw new Error(`覆盖处置缺少规范和本图双方证据：${disposition.ruleId}`);
    dispositions.set(disposition.ruleId, disposition);
  }
  const actionable = specification.rules.filter(r => r.informationType !== 'context');
  const missing = actionable.filter(r => !dispositions.has(r.id));
  if (missing.length) throw new Error(`规则没有适用性结论：${missing.slice(0, 8).map(r => r.id).join('、')}（共${missing.length}条）`);
  result.requirements = result.requirements.map(item => {
    let checked = verifyRequirement(item, documents);
    for (const id of item.ruleIds) {
      if (!rules.has(id)) throw new Error(`要求引用未知规则：${id}`);
      if (rules.get(id).informationType === 'context') throw new Error(`背景定义或导航不能进入有效要求：${item.id}/${id}`);
      if (dispositions.get(id).status === 'not_applicable') throw new Error(`不适用规则进入了本零件有效清单：${id}`);
      linked.add(id);
    }
    if (item.origin !== 'drawing' && !item.ruleIds.length) throw new Error(`规范要求缺少规则关联：${item.id}`);
    if (item.origin === 'drawing' && item.ruleIds.length) throw new Error(`图纸独有要求不应关联规范规则：${item.id}`);
    if (item.origin !== 'specification' && !item.sources.some(s => drawingNames.has(s.file))) throw new Error(`图纸要求缺少本零件证据：${item.id}`);
    if (item.origin !== 'drawing' && !item.sources.some(s => specNames.has(s.file))) throw new Error(`规范要求缺少规范原文证据：${item.id}`);
    for (const id of item.ruleIds) {
      if (!item.sources.some(s => rules.get(id).sources.some(r => s.file === r.file && s.page === r.page))) throw new Error(`要求缺少关联规则所在页的证据：${item.id}/${id}`);
    }
    const uncertain = item.ruleIds.some(id => dispositions.get(id).status === 'needs_confirmation' || rules.get(id).review_required || dispositions.get(id).evidence.some(s => s.verification !== 'text_match'));
    if (uncertain) checked = { ...checked, review_required: true, review_note: appendReviewNotes(checked.review_note, ['关联规则或适用条件尚待确认。']) };
    return checked;
  });
  const unlinked = result.dispositions.filter(d => rules.get(d.ruleId).informationType !== 'context' && d.status !== 'not_applicable' && !linked.has(d.ruleId));
  if (unlinked.length) throw new Error(`已判适用/覆盖/待确认的规则缺少要求条目：${unlinked.slice(0, 8).map(d => d.ruleId).join('、')}`);
  result.drawing.facts = result.drawing.facts.map(f => {
    if (f.sources.some(s => !drawingNames.has(s.file))) throw new Error(`零件身份事实不能从通用规范取值：${f.name}`);
    return { ...f, sources: verifySources(f.sources, documents) };
  });
  const operativeDispositions = result.dispositions.filter(d => rules.get(d.ruleId).informationType !== 'context');
  const counts = status => operativeDispositions.filter(d => d.status === status).length;
  result.ruleCoverage = { total: actionable.length, decided: operativeDispositions.length, backgroundRecords: rules.size - actionable.length, applicable: counts('applicable'), notApplicable: counts('not_applicable'), overridden: counts('overridden'), needsConfirmation: counts('needs_confirmation'), note: '仅对非背景要求统计处置；背景定义和引用关系用于判断，不计入有效要求。处置完整不代表语义正确。' };
  result.informationSummary = informationSummary(result.requirements);
  result.documents = documents.map(({ name, pages }) => ({ name, pages, role: drawingNames.has(name) ? 'drawing' : 'specification' }));
  return result;
}

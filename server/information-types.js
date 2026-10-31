import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const INFORMATION_TYPES = Object.freeze(['manufacturing', 'quality', 'procurement', 'context']);
export const ACTIONABLE_TYPES = Object.freeze(INFORMATION_TYPES.filter(type => type !== 'context'));
export const INFORMATION_VERSION = 'requirements-scope-v1';
export const SCOPE_POLICY = 'drawing-plus-inspection-v1';
export const PROCESS_CATEGORIES = Object.freeze(['铸造', '机加', '热处理', '表面处理', '刻字', '检验', '焊接', '其他']);
export const usesDrawingScope = result => result?.scopePolicy === SCOPE_POLICY;
export const inheritableRules = specification => (specification?.rules || []).filter(rule => rule.informationType !== 'context' && (!usesDrawingScope(specification) || rule.usage === 'inspection'));
export function ruleUsageSummary(rules) {
  return { inspectionCount: rules.filter(rule => rule.usage === 'inspection').length, comparisonCount: rules.filter(rule => rule.usage === 'comparison').length };
}
export const informationDigest = result => createHash('sha256').update(JSON.stringify(result)).digest('hex');
const validType = type => INFORMATION_TYPES.includes(type);
const rowsOf = result => Array.isArray(result?.rules) ? result.rules : result?.requirements || [];

export function informationSummary(items) {
  const counts = { total: items.length, manufacturing: 0, quality: 0, procurement: 0, context: 0, unclassified: 0 };
  for (const item of items) counts[validType(item.informationType) ? item.informationType : 'unclassified']++;
  return { ...counts, core: counts.manufacturing + counts.quality, actionable: counts.manufacturing + counts.quality + counts.procurement };
}

// Profiles add classification metadata only. They are bound to one exact raw
// result so stale profiles can never hide records from a newer extraction.
export function validateInformationProfile(result, profile) {
  if (!profile || profile.resultSha256 !== informationDigest(result)) throw new Error('分类记录与原始结果哈希不一致');
  if (profile.model !== 'deepseek-flash' || !/^[a-f0-9]{64}$/i.test(profile.skillSha256 || '')) throw new Error('分类记录缺少模型或Skill来源');
  const rows = rowsOf(result), expected = new Set(rows.map(item => item.id)), classified = new Map();
  if (expected.size !== rows.length || !Array.isArray(profile.items)) throw new Error('分类对象编号重复或分类数组缺失');
  for (const item of profile.items) {
    if (!expected.has(item.id) || classified.has(item.id) || !validType(item.informationType) || typeof item.reason !== 'string' || !item.reason.trim() || (item.review_required !== undefined && typeof item.review_required !== 'boolean')) throw new Error('分类记录含未知/重复编号、无效类型或缺少理由');
    classified.set(item.id, item);
  }
  if (classified.size !== expected.size) throw new Error('分类记录没有覆盖全部原始条目');
  return classified;
}

function legacyType(item) {
  const category = String(item.category || '');
  if (/^(力学性能|尺寸与公差|表面质量|内部质量|检验方法|检验频率|复验规则|气密性)$/.test(category)) return 'quality';
  if (/^(成形制造|热处理|修补与校正|表面处理|焊接)$/.test(category)) return 'manufacturing';
  if (/^(文件与交付|包装运输贮存|标识追溯)$/.test(category)) return 'procurement';
  // A category cannot establish that a sentence contains only a definition.
  // Unknown and mixed categories remain visible for classification review.
  return 'unclassified';
}

export function decorateInformation(result, profile = null, profileWarning = '') {
  if (!result) return result;
  let classified = null;
  const warnings = profileWarning ? [profileWarning] : [];
  if (profile) {
    try { classified = validateInformationProfile(result, profile); }
    catch (error) { warnings.push(error.message); }
  }
  const key = Array.isArray(result.rules) ? 'rules' : 'requirements';
  const rows = rowsOf(result).map(item => {
    const entry = classified?.get(item.id);
    if (entry) {
      // A self-reported mixed background item may contain an operative clause.
      // Keep it visible as unresolved instead of hiding it as pure context.
      const unresolvedContext = entry.informationType === 'context' && entry.review_required;
      return { ...item, informationType: unresolvedContext ? 'unclassified' : entry.informationType, classificationPending: Boolean(entry.review_required), classification: { source: 'legacy_profile', reason: entry.reason, pending: Boolean(entry.review_required), ...(unresolvedContext ? { proposedType: entry.informationType } : {}) } };
    }
    if (validType(item.informationType)) return { ...item, classificationPending: false, classification: { source: 'model_output', reason: '提取时按四类信息契约分类', pending: false } };
    return { ...item, informationType: legacyType(item), classificationPending: true, classification: { source: 'legacy_category', reason: '旧结果仅按原分类临时展示，需按原条文完成信息归类；未据类别隐藏背景条目。', pending: true } };
  });
  const pending = rows.filter(item => item.classificationPending).length;
  return { ...result, [key]: rows, informationSummary: informationSummary(rows), classification: {
    version: INFORMATION_VERSION, status: pending ? 'pending' : 'completed', pending, source: classified ? 'legacy_profile' : pending ? 'legacy_category' : 'model_output',
    resultSha256: informationDigest(result), ...(classified ? { model: profile.model, skillSha256: profile.skillSha256 } : {}), warnings,
  } };
}

export async function readInformationView(root, result) {
  if (!result) return result;
  const file = path.join(root, 'information-profiles', informationDigest(result) + '.json');
  try { return decorateInformation(result, JSON.parse(await fs.readFile(file, 'utf8'))); }
  catch (error) { return decorateInformation(result, null, error.code === 'ENOENT' ? '' : '分类记录不可读取，已保留全部原始条目并标记待归类。'); }
}

export function decorateDispositions(result, specification) {
  if (!result) return result;
  const types = new Map((specification?.rules || []).map(rule => [rule.id, rule.informationType]));
  const dispositions = (result.dispositions || []).map(item => ({ ...item, informationType: types.get(item.ruleId) || 'unclassified' }));
  const operativeIds = specification ? new Set(inheritableRules(specification).map(rule => rule.id)) : null;
  const relevant = dispositions.filter(item => operativeIds ? operativeIds.has(item.ruleId) : item.informationType !== 'context');
  const count = status => relevant.filter(item => item.status === status).length;
  const actionableRules = inheritableRules(specification);
  return { ...result, dispositions, ruleCoverage: {
    ...result.ruleCoverage, originalTotal: result.ruleCoverage?.total, total: specification ? actionableRules.length : relevant.length, decided: relevant.length,
    applicable: count('applicable'), notApplicable: count('not_applicable'), overridden: count('overridden'), needsConfirmation: count('needs_confirmation'),
    backgroundRecords: (specification?.rules || []).filter(rule => rule.informationType === 'context').length,
    ...(usesDrawingScope(specification) ? { comparisonRecords: (specification.rules || []).filter(rule => rule.usage === 'comparison').length } : {}),
    note: usesDrawingScope(specification) ? '仅对规范检验要求统计必需处置；非检验条款只供冲突对照，不自动进入最终清单。处置完整不代表语义正确。' : '仅对非背景规范要求统计处置；背景定义和引用关系供判断使用，不计入可执行要求。处置完整不代表语义正确。',
  } };
}

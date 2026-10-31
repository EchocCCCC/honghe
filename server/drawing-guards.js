import { usesDrawingScope, inheritableRules } from './information-types.js';

// Short source IDs are an exact transport mapping, never fuzzy filename repair.
export function sourceAliases(specPrepared, drawingPrepared) {
  return [...specPrepared.documents.map((d, i) => ({ id: `S${i + 1}`, file: d.name, pages: d.pages, role: 'specification' })),
    ...drawingPrepared.documents.map((d, i) => ({ id: `D${i + 1}`, file: d.name, pages: d.pages, role: 'drawing' }))];
}
export function mapSourceNames(value, aliases, restore = false) {
  const names = new Map(aliases.map(a => restore ? [a.id, a.file] : [a.file, a.id]));
  function visit(node) {
    if (Array.isArray(node)) return node.map(visit);
    if (!node || typeof node !== 'object') return node;
    return Object.fromEntries(Object.entries(node).map(([key, val]) => [key, key === 'file' && typeof val === 'string' && names.has(val) ? names.get(val) : visit(val)]));
  }
  return visit(value);
}
export function aliasSourceText(text, aliases) {
  for (const alias of aliases) {
    const original = JSON.stringify(alias.file), id = JSON.stringify(alias.id);
    text = text.replaceAll(`file=${original}`, `file=${id}`).replaceAll(`"file":${original}`, `"file":${id}`).replaceAll(`"file": ${original}`, `"file": ${id}`);
  }
  return text;
}

function conditionalInspection(result, specification, active, note, label) {
  const rules = new Map(specification.rules.map(rule => [rule.id, rule]));
  const changes = [];
  const requirements = result.requirements.map(item => {
    if (!item.ruleIds.some(id => active.has(id))) return item;
    changes.push({ candidateId: item.id, ruleIds: item.ruleIds.filter(id => active.has(id)), reason: note });
    // Keep the model's selected material/region and its evidence. Replacing an
    // item with an entire specification table would reintroduce other grades,
    // comparison-only manufacturing clauses, or erase drawing-specific values.
    return { ...item, requirement: item.requirement.startsWith(`条件要求（${label}）：`) ? item.requirement : `条件要求（${label}）：${item.requirement}`,
      scope: item.scope.includes(note) ? item.scope : `${item.scope}；${note}`, review_required: true,
      review_note: item.review_note.includes(note) ? item.review_note : [item.review_note, note].filter(Boolean).join(' ') };
  });
  const dispositions = result.dispositions.map(d => active.has(d.ruleId) ? { ...d, status: 'needs_confirmation', reason: note, evidence: structuredClone(rules.get(d.ruleId).sources) } : d);
  return { result: { ...result, requirements, dispositions,
    drawing: { ...result.drawing, uncertainties: [...new Set([...result.drawing.uncertainties, note])] },
    warnings: [...new Set([...result.warnings, note])] }, changes };
}

// This release has no operator-confirmed regional wall-thickness input. Keep
// NDT thickness bands conditional; overall/step/groove dimensions cannot confirm them.
export function guardRegionalWallThickness(result, specification) {
  const rules = new Map(specification.rules.map(r => [r.id, r]));
  const guarded = new Set(inheritableRules(specification).filter(r => /内部质量/.test(r.category) && /壁厚/.test([r.requirement, r.scope, ...r.conditions, ...r.parameters.map(p => p.name)].join(' '))).map(r => r.id));
  const active = new Set(result.dispositions.filter(d => guarded.has(d.ruleId) && d.status !== 'not_applicable' && (!usesDrawingScope(specification) || d.status !== 'overridden')).map(d => d.ruleId));
  if (!active.size) return { result, changes: [] };
  const note = '受检区域的局部壁厚未经人工确认，内部质量分档待确认；总高、台阶高、槽尺寸等不自动作为局部壁厚。';
  if (usesDrawingScope(specification)) return conditionalInspection(result, specification, active, note, '局部壁厚分档未确认');
  const changes = [], requirements = [], seen = new Set(result.requirements.map(r => r.id));
  for (const item of result.requirements) {
    if (!item.ruleIds.some(id => active.has(id))) { requirements.push(item); continue; }
    const related = item.ruleIds.map(id => rules.get(id));
    if (item.ruleIds.some(id => !active.has(id) && result.dispositions.find(d => d.ruleId === id)?.status === 'overridden')) throw new Error('壁厚选档与图纸覆盖要求被混在同一条，请拆分并重新核对');
    changes.push({ candidateId: item.id, ruleIds: [...item.ruleIds], reason: note });
    for (const [index, rule] of related.entries()) {
      let id = index === 0 ? item.id : `${item.id}-C${index + 1}`;
      while (index > 0 && seen.has(id)) id += 'C'; seen.add(id);
      const pending = active.has(rule.id);
      requirements.push({ id, informationType: rule.informationType, category: rule.category, requirement: pending ? `条件要求（未确定适用分档）：${rule.requirement}` : rule.requirement,
        scope: pending ? `${rule.scope}；${note}` : rule.scope, parameters: structuredClone(rule.parameters), sources: structuredClone(rule.sources),
        review_required: pending || rule.review_required, review_note: pending ? note : rule.review_note, origin: 'specification', ruleIds: [rule.id] });
    }
  }
  const dispositions = result.dispositions.map(d => active.has(d.ruleId) ? { ...d, status: 'needs_confirmation', reason: note, evidence: structuredClone(rules.get(d.ruleId).sources) } : d);
  const drawing = { ...result.drawing, facts: result.drawing.facts.map(f => /壁厚/.test(f.name + f.value) && !f.value.startsWith('候选几何解释，未用于确定受检区域壁厚：') ? { ...f, value: `候选几何解释，未用于确定受检区域壁厚：${f.value}` } : f), uncertainties: [...new Set([...result.drawing.uncertainties, note])] };
  return { result: { ...result, drawing, summary: `${drawing.name || '当前零件'}依据选定规范分析。${note}；其他已提取要求见逐项清单。`, requirements, dispositions, warnings: [...new Set([...result.warnings, note])] }, changes };
}

const proofPressure = /(?:耐压|爆破|水压)[^。；;\n]{0,24}\d(?:\.\d+)?\s*(?:MPa|kPa|Pa|bar)/i;
const leakagePressure = /(?:(?:气密(?:性)?(?:试验|检验)|泄漏(?:试验|检验)|沉水)[^。；;\n耐压爆破水压]{0,32}\d(?:\.\d+)?\s*(?:MPa|kPa|Pa|bar)|\d(?:\.\d+)?\s*(?:MPa|kPa|Pa|bar)[^。；;\n耐压爆破水压]{0,12}(?:沉水|气密(?:性)?(?:试验|检验)))/i;

// A proof/design pressure does not authorize selecting a leakage-test pressure.
// The original rule remains conditional until the purposes are confirmed.
export function guardPressurePurpose(result, specification, drawingPrepared) {
  const drawingFiles = new Set(drawingPrepared.documents.map(d => d.name));
  const rules = new Map(specification.rules.map(r => [r.id, r]));
  const pressureRules = new Set(inheritableRules(specification).filter(r => /气密|沉水|泄漏/.test(r.requirement) && /压力|MPa|kPa|bar/.test(r.requirement + JSON.stringify(r.parameters))).map(r => r.id));
  const sources = [...result.requirements.flatMap(r => r.sources), ...result.drawing.facts.flatMap(f => f.sources)].filter(s => drawingFiles.has(s.file));
  const drawingText = [...drawingPrepared.documents.flatMap(d => d.textPages || []), ...sources.map(s => s.quote)].join('\n');
  if (!proofPressure.test(drawingText) || leakagePressure.test(drawingText)) return { result, changes: [] };
  const active = new Set(result.dispositions.filter(d => pressureRules.has(d.ruleId) && d.status !== 'not_applicable' && (!usesDrawingScope(specification) || d.status !== 'overridden')).map(d => d.ruleId));
  if (!active.size) return { result, changes: [] };
  const note = '图纸耐压/爆破/水压与气密泄漏检验压力用途不同，未见明确气密试验压力依据；不得将其相互替代。须确认试验用途、压力、方法与时间及规范默认条款的适用关系。';
  if (usesDrawingScope(specification)) return conditionalInspection(result, specification, active, note, '试验用途与适用关系未确认');
  const changes = [], requirements = [], seen = new Set(result.requirements.map(r => r.id));
  for (const item of result.requirements) {
    if (!item.ruleIds.some(id => active.has(id))) { requirements.push(item); continue; }
    if (item.ruleIds.some(id => !active.has(id) && result.dispositions.find(d => d.ruleId === id)?.status === 'overridden')) throw new Error('气密压力与其他图纸覆盖要求混在同一条，请拆分并重新核对');
    changes.push({ candidateId: item.id, ruleIds: [...item.ruleIds], reason: note });
    for (const [index, ruleId] of item.ruleIds.entries()) {
      const rule = rules.get(ruleId), pending = active.has(ruleId);
      let id = index === 0 ? item.id : `${item.id}-P${index + 1}`;
      while (index > 0 && seen.has(id)) id += 'P'; seen.add(id);
      requirements.push({ id, informationType: rule.informationType, category: rule.category, requirement: pending ? `条件要求（试验用途与适用关系未确认，不确定执行压力）：${rule.requirement}` : rule.requirement,
        scope: pending ? `${rule.scope}；${note}` : rule.scope, parameters: structuredClone(rule.parameters), sources: structuredClone(rule.sources),
        review_required: pending || rule.review_required, review_note: pending ? note : rule.review_note, origin: 'specification', ruleIds: [ruleId] });
    }
  }
  const dispositions = result.dispositions.map(d => active.has(d.ruleId) ? { ...d, status: 'needs_confirmation', reason: note, evidence: structuredClone(rules.get(d.ruleId).sources) } : d);
  return { result: { ...result, requirements, dispositions,
    drawing: { ...result.drawing, uncertainties: [...new Set([...result.drawing.uncertainties, note])] },
    summary: `${result.drawing.name || '当前零件'}依据选定规范分析。${note}；逐项要求中的规范压力保留原适用条件。`, warnings: [...new Set([...result.warnings, note])] }, changes };
}

export function standardTokens(text) {
  return [...String(text).matchAll(/\b(?:EN|ISO|GB(?:\/T)?)\s*\d{3,6}(?:\s*[-－]\s*\d+)?/gi)].map(m => m[0].toUpperCase().replace(/\s/g, '').replaceAll('－', '-'));
}
// Absence of an exact source token causes a pending label, never a guessed code.
export function guardDrawingStandardClaims(result, drawingPrepared) {
  const files = new Set(drawingPrepared.documents.map(d => d.name));
  const text = [...drawingPrepared.documents.flatMap(d => d.textPages || []), ...result.drawing.facts.flatMap(f => f.sources.filter(s => files.has(s.file)).map(s => s.quote)), ...result.requirements.flatMap(item => item.sources.filter(s => files.has(s.file)).map(s => s.quote))].join('\n');
  const supported = new Set(standardTokens(text));
  const unsupported = value => standardTokens(value).some(token => !supported.has(token));
  const changes = [], note = '部分图面标准号未在独立文字层或事实引文中逐字定位，仅保留候选；须核对原图字形与编号差异，不自动改为常用标准号。';
  const references = result.drawing.references.map(value => {
    if (!unsupported(value) || value.startsWith('候选图面引用（编号待核实）：')) return value;
    changes.push({ field: 'drawing.references', candidate: value, reason: note });
    return `候选图面引用（编号待核实）：${value}`;
  });
  const facts = result.drawing.facts.map(f => {
    const exact = new Set(standardTokens(f.sources.filter(s => files.has(s.file)).map(s => s.quote).join('\n')));
    if (!standardTokens(f.value).some(t => !exact.has(t) && !supported.has(t)) || f.value.startsWith('候选标准解释（编号待核实）：')) return f;
    changes.push({ field: 'drawing.facts', name: f.name, reason: note });
    return { ...f, value: `候选标准解释（编号待核实）：${f.value}` };
  });
  if (!changes.length) return { result, changes };
  return { result: { ...result, drawing: { ...result.drawing, references, facts, uncertainties: [...new Set([...result.drawing.uncertainties, note])] }, warnings: [...new Set([...result.warnings, note])] }, changes };
}

// Finished local geometry is not a confirmed raw-stock nominal section size.
export function guardMaterialSectionDimensions(result, specification) {
  const rules = new Map(specification.rules.map(r => [r.id, r]));
  const dimensional = new Set(inheritableRules(specification).filter(r => /力学性能/.test(r.category) && /厚度|壁厚|直径/.test([r.requirement, r.scope, ...r.conditions, ...r.parameters.map(p => p.name)].join(' '))).map(r => r.id));
  const active = new Set(result.dispositions.filter(d => dimensional.has(d.ruleId) && d.status !== 'not_applicable' && (!usesDrawingScope(specification) || d.status !== 'overridden')).map(d => d.ruleId));
  if (!active.size) return { result, changes: [] };
  const note = '原材料公称厚度/直径及材料形态未由人工确认；成品局部厚度、沉孔深度、台阶或其他加工尺寸不能作为原材料尺寸选力学性能档。保留规范候选分档条件待确认。';
  if (usesDrawingScope(specification)) return conditionalInspection(result, specification, active, note, '原材料尺寸分档未确认');
  const changes = [], requirements = [], seen = new Set(result.requirements.map(r => r.id));
  for (const item of result.requirements) {
    if (!item.ruleIds.some(id => active.has(id))) {
      if (item.origin === 'drawing' && !item.requirement.startsWith('候选几何对象（不得据此确定原材料尺寸）：') && /板厚|原材料.{0,6}(?:厚度|直径)|原料.{0,6}(?:厚度|直径)/.test(item.requirement + item.scope + item.parameters.map(p => p.name).join(' '))) {
        changes.push({ candidateId: item.id, ruleIds: [], reason: note });
        requirements.push({ ...item, requirement: `候选几何对象（不得据此确定原材料尺寸）：${item.requirement}`, scope: `${item.scope}；${note}`,
          parameters: item.parameters.map(p => /板厚|原材料|原料/.test(p.name) ? { ...p, name: `候选几何对象（原材料尺寸未确认）：${p.name}` } : p), review_required: true, review_note: `${item.review_note} ${note}` });
      } else requirements.push(item);
      continue;
    }
    if (item.ruleIds.some(id => !active.has(id) && result.dispositions.find(d => d.ruleId === id)?.status === 'overridden')) throw new Error('原材料尺寸选档与其他图纸覆盖要求混在同一条，请拆分并重新核对');
    changes.push({ candidateId: item.id, ruleIds: [...item.ruleIds], reason: note });
    for (const [index, ruleId] of item.ruleIds.entries()) {
      const rule = rules.get(ruleId), pending = active.has(ruleId);
      let id = index === 0 ? item.id : `${item.id}-M${index + 1}`;
      while (index > 0 && seen.has(id)) id += 'M'; seen.add(id);
      requirements.push({ id, informationType: rule.informationType, category: rule.category, requirement: pending ? `条件要求（原材料尺寸分档未确认）：${rule.requirement}` : rule.requirement,
        scope: pending ? `${rule.scope}；${note}` : rule.scope, parameters: structuredClone(rule.parameters), sources: structuredClone(rule.sources),
        review_required: pending || rule.review_required, review_note: pending ? note : rule.review_note, origin: 'specification', ruleIds: [ruleId] });
    }
  }
  const dispositions = result.dispositions.map(d => active.has(d.ruleId) ? { ...d, status: 'needs_confirmation', reason: note, evidence: structuredClone(rules.get(d.ruleId).sources) } : d);
  const drawing = { ...result.drawing, facts: result.drawing.facts.map(f => /材料|板厚|棒径/.test(f.name + f.value) && /厚度|板厚|直径|mm/.test(f.value) && !f.value.startsWith('候选原材料解释（公称尺寸未确认）：') ? { ...f, value: `候选原材料解释（公称尺寸未确认）：${f.value}` } : f), uncertainties: [...new Set([...result.drawing.uncertainties, note])] };
  return { result: { ...result, drawing, requirements, dispositions, summary: `${drawing.name || '当前零件'}依据选定规范分析。${note}；其他要求见逐项清单。`, warnings: [...new Set([...result.warnings, note])] }, changes };
}

export function applyConservativeDrawingGuards(result, specification, drawingPrepared) {
  const wall = guardRegionalWallThickness(result, specification);
  const material = guardMaterialSectionDimensions(wall.result, specification);
  const pressure = guardPressurePurpose(material.result, specification, drawingPrepared);
  const standards = guardDrawingStandardClaims(pressure.result, drawingPrepared);
  return { result: standards.result, changes: [...wall.changes, ...material.changes, ...pressure.changes, ...standards.changes] };
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDrawingRead, applyNormMatchDelta } from '../server/two-stage-schema.js';
import { drawingMatchingInput, assertMatchingConditionsUnchanged, rebaselineDrawingRead, retainDrawingCandidate, reviewRuleCoverage } from '../server/two-stage-pipeline.js';
import { SCOPE_POLICY } from '../server/information-types.js';

function boundAuditFixture() {
  const item = fixture();
  const technical = item.read.requirements.find(value => value.id === 'D-008');
  technical.requirement = '图示表面10%PT';
  technical.scope = '产品指定区域（表面缺陷检验）';
  technical.parameters = [{ name: '图示比例', value: '10', unit: '%' }];
  const tolerance = item.read.requirements.find(value => value.id === 'D-005');
  tolerance.requirement = 'ISO TEST-P1；专用轮廓公差0.04';
  tolerance.parameters = [{ name: '图示公差', value: '0.04', unit: 'mm' }];
  item.read = validateDrawingRead(withRawStock(item.read), drawingPrepared);
  item.delta.bindings.push({
    id: 'D-008', ruleIds: ['R-I1'], sources: [source('spec.pdf')], conflict: null,
    review_required: false, review_note: '',
  });
  const matched = merge(item), audited = clone(matched);
  const enriched = audited.requirements.find(value => value.id === 'D-008');
  enriched.category += '及规范方法';
  enriched.requirement += '；规范补充方法按MOCK-METHOD执行';
  enriched.scope += '；规范方法仅在图纸未给方法时采用';
  enriched.parameters.push({ name: '规范保压时间', value: '12', unit: 's' });
  return { read: item.read, matched, audited };
}

test('a formerly specification-only row stays outside D conditions after audit adds drawing evidence', () => {
  const item = fixture();
  item.read = validateDrawingRead(item.read, drawingPrepared);
  const matched = merge(item), audited = clone(matched);
  const norm = audited.requirements.find(value => value.id === 'ADD-001');
  assert.equal(norm.origin, 'specification');
  norm.origin = 'combined';
  norm.sources.push(source());
  const snapshots = [clone(item.read), clone(matched), clone(audited)];
  assert.doesNotThrow(() => assertMatchingConditionsUnchanged(deepFreeze(item.read), deepFreeze(audited), deepFreeze(matched)));
  assert.deepEqual([item.read, matched, audited], snapshots);
});

test('a normative appendix may enrich a bound D technical row only while retaining its complete D content', () => {
  const { read, matched, audited } = boundAuditFixture();
  const snapshots = [clone(read), clone(matched), clone(audited)];
  assert.doesNotThrow(() => assertMatchingConditionsUnchanged(deepFreeze(read), deepFreeze(audited), deepFreeze(matched)));
  assert.deepEqual([read, matched, audited], snapshots);
});

test('rewriting the original controlled scope still requires rematching even with the D quotation unchanged', () => {
  const { read, matched, audited } = boundAuditFixture();
  const originalQuote = clone(read.requirements.find(value => value.id === 'D-008').sources);
  const edited = audited.requirements.find(value => value.id === 'D-008');
  edited.scope = '产品整体（技术要求规定的受检区域）；规范方法按需采用';
  assert.deepEqual(edited.sources.filter(value => value.file === 'part.pdf').map(({ verification, ...value }) => value),
    originalQuote.map(({ verification, ...value }) => value));
  const snapshots = [clone(read), clone(matched), clone(audited)];
  assert.throws(() => assertMatchingConditionsUnchanged(deepFreeze(read), deepFreeze(audited), deepFreeze(matched)));
  assert.deepEqual([read, matched, audited], snapshots);
});

test('a normative appendix cannot hide changed PT ratios, D tolerances, evidence, parameters or matching profiles', () => {
  for (const alter of [
    value => { value.requirements.find(row => row.id === 'D-008').requirement = '图示表面20%PT；规范补充方法按MOCK-METHOD执行'; },
    value => { value.requirements.find(row => row.id === 'D-005').requirement = 'ISO TEST-P2；专用轮廓公差0.04'; },
    value => { value.requirements.find(row => row.id === 'D-005').requirement = 'ISO TEST-P1；专用轮廓公差0.05'; },
    value => { value.requirements.find(row => row.id === 'D-008').parameters[0].value = '20'; },
    value => { value.requirements.find(row => row.id === 'D-008').parameters[0].unit = 'ratio'; },
    value => { value.requirements.find(row => row.id === 'D-008').parameters.push({ name: '图示比例', value: '20', unit: '%' }); },
    value => { value.requirements.find(row => row.id === 'D-008').sources.find(item => item.file === 'part.pdf').quote = '已改变的图纸引文'; },
    value => { value.requirements.find(row => row.id === 'D-008').sources.find(item => item.file === 'part.pdf').page = 2; },
    value => { value.requirements.find(row => row.id === 'D-008').sources.find(item => item.file === 'part.pdf').file = 'another-part.pdf'; },
    value => { value.drawing.material = '6061-T6'; },
    value => { value.drawing.airtightness = 'not_required'; },
    value => { value.drawing.materialForm = '棒材'; value.drawing.facts.find(item => item.name === '原材料形态').value = '棒材'; },
    value => { value.drawing.facts.find(item => item.name === '原材料公称厚度').value = '45'; },
    value => { value.drawing.facts.find(item => item.name === '原材料公称直径').value = '89'; },
    value => { value.requirements.push(row('NEW-D-TECHNICAL', '新增图示试验条件', '另一个受控区域须进行独立检验', '检验')); },
  ]) {
    const { read, matched, audited } = boundAuditFixture();
    alter(audited);
    const snapshots = [clone(read), clone(matched), clone(audited)];
    assert.throws(() => assertMatchingConditionsUnchanged(deepFreeze(read), deepFreeze(audited), deepFreeze(matched)), undefined, alter.toString());
    assert.deepEqual([read, matched, audited], snapshots);
  }
});


const clone = value => structuredClone(value);

test('rebaselining retains audited D corrections and profiles without turning norm rows into drawing evidence', () => {
  const item = fixture();
  item.read = validateDrawingRead(item.read, drawingPrepared);
  const matched = merge(item), audited = clone(matched);
  audited.drawing.material = '6061-T4';
  audited.drawing.airtightness = 'required';
  audited.drawing.facts.push({ name: '物资编码', value: 'MOCK-CORRECTED', sources: [source()] });
  const originalD = audited.requirements.find(value => value.id === 'D-008');
  originalD.requirement = '图示表面20%PT';
  originalD.parameters = [{ name: '图示比例', value: '20', unit: '%' }];
  originalD.sources = [source('part.pdf', 1, '更正后图示表面20%PT')];
  audited.requirements.find(value => value.id === 'D-003').requirement = '成品厚度16';
  const promotedNorm = audited.requirements.find(value => value.id === 'ADD-001');
  promotedNorm.origin = 'combined';
  promotedNorm.sources.push(source());
  audited.requirements.push(row('NEW-D-TECHNICAL', '补读技术条件', '图示独立区域须单独检验', '检验'));
  const snapshots = [clone(item.read), clone(matched), clone(audited)];
  const rebased = rebaselineDrawingRead(deepFreeze(item.read), deepFreeze(audited), deepFreeze(matched), drawingPrepared);
  assert.equal(rebased.drawing.material, '6061-T4');
  assert.equal(rebased.drawing.airtightness, 'required');
  assert.equal(rebased.drawing.facts.find(value => value.name === '物资编码').value, 'MOCK-CORRECTED');
  assert.equal(rebased.requirements.find(value => value.id === 'D-008').requirement, '图示表面20%PT');
  assert.equal(rebased.requirements.find(value => value.id === 'D-003').requirement, '成品厚度16');
  assert.ok(rebased.requirements.some(value => value.id === 'NEW-D-TECHNICAL'));
  assert.ok(!rebased.requirements.some(value => value.id === 'ADD-001'));
  assert.ok(rebased.requirements.every(value => value.origin === 'drawing' && value.ruleIds.length === 0 && value.conflict === null));
  assert.ok(rebased.requirements.every(value => value.sources.every(evidence => evidence.file === 'part.pdf')));
  assert.deepEqual(rebased.dispositions, []);
  assert.ok(rebased.drawing.facts.every(value => value.sources.every(evidence => evidence.file === 'part.pdf')));
  assert.deepEqual([item.read, matched, audited], snapshots);
});

test('rebaselining a bounded normative appendix restores only the original D technical content', () => {
  const { read, matched, audited } = boundAuditFixture();
  const snapshots = [clone(read), clone(matched), clone(audited)];
  const rebased = rebaselineDrawingRead(deepFreeze(read), deepFreeze(audited), deepFreeze(matched), drawingPrepared);
  const before = read.requirements.find(value => value.id === 'D-008');
  const after = rebased.requirements.find(value => value.id === 'D-008');
  for (const field of ['category', 'requirement', 'scope', 'parameters', 'processCategory']) assert.deepEqual(after[field], before[field]);
  assert.equal(after.origin, 'drawing');
  assert.deepEqual(after.ruleIds, []);
  assert.equal(after.conflict, null);
  assert.ok(after.sources.every(value => value.file === 'part.pdf'));
  assert.ok(!after.parameters.some(value => value.name === '规范保压时间'));
  assert.deepEqual([read, matched, audited], snapshots);
});

test('rebaselining refuses combined changes whose drawing and norm meaning cannot be separated', () => {
  for (const alter of [
    value => { value.requirements.find(row => row.id === 'D-008').requirement = '图示表面20%PT；规范补充方法按MOCK-METHOD执行'; },
    value => { value.requirements.find(row => row.id === 'D-008').scope = '另一受检对象；规范方法按需采用'; },
    value => { value.requirements.find(row => row.id === 'D-008').parameters[0].value = '20'; },
    value => { value.requirements.find(row => row.id === 'D-008').sources.find(item => item.file === 'part.pdf').quote = '已变更图纸引文'; },
  ]) {
    const { read, matched, audited } = boundAuditFixture();
    alter(audited);
    const snapshots = [clone(read), clone(matched), clone(audited)];
    assert.throws(() => rebaselineDrawingRead(deepFreeze(read), deepFreeze(audited), deepFreeze(matched), drawingPrepared), undefined, alter.toString());
    assert.deepEqual([read, matched, audited], snapshots);
  }
});

test('rebaselining rejects non-drawing facts or fabricated new combined drawing rows', () => {
  for (const alter of [
    value => { value.drawing.facts.push({ name: '物资编码', value: 'NORM-CODE', sources: [source('spec.pdf')] }); },
    value => { value.requirements.push({ ...row('NEW-COMBINED', '待辨来源', '混合来源的新技术条件', '检验'), origin: 'combined', ruleIds: ['R-I1'], sources: [source(), source('spec.pdf')] }); },
    value => { value.requirements.push({ ...row('NEW-FOREIGN', '别件', '其他图纸内容', '检验'), sources: [source('another-part.pdf')] }); },
  ]) {
    const item = fixture();
    item.read = validateDrawingRead(item.read, drawingPrepared);
    const matched = merge(item), audited = clone(matched);
    alter(audited);
    const snapshots = [clone(item.read), clone(matched), clone(audited)];
    assert.throws(() => rebaselineDrawingRead(deepFreeze(item.read), deepFreeze(audited), deepFreeze(matched), drawingPrepared), undefined, alter.toString());
    assert.deepEqual([item.read, matched, audited], snapshots);
  }
});

const source = (file = 'part.pdf', page = 1, quote = '测试原文') => ({ file, page, section: '测试条款', quote });
const prepared = name => ({ documents: [{ name, pages: 1, textPages: ['测试原文'], imagePages: [1], needsVisualReview: [] }] });
const drawingPrepared = prepared('part.pdf');
const specPrepared = prepared('spec.pdf');
const row = (id, category, requirement, processCategory = '机加') => ({
  id, category, requirement, processCategory, informationType: 'quality', scope: '本件',
  parameters: [], sources: [source()], review_required: false, review_note: '',
  origin: 'drawing', ruleIds: [], conflict: null,
});
const rule = (id, usage, category) => ({
  id, category, requirement: '测试规范指标', processCategory: '检验', informationType: 'quality', scope: '本件',
  parameters: [], sources: [source('spec.pdf')], review_required: false, review_note: '',
  strength: 'required', conditions: [], exceptions: [], overridePolicy: '图纸优先',
  externalReferences: [], usage,
});
function fixture() {
  const read = {
    drawing: {
      partNumber: 'MOCK-PART', name: '模拟零件', revision: 'A', material: '6082-T6',
      materialForm: '', process: '', castingClass: '', airtightness: 'unspecified',
      dimensionState: 'before_finish', references: ['ISO TEST-P1'], facts: [], uncertainties: [],
    },
    summary: '仅从模拟图纸读取',
    requirements: [
      row('D-001', '材料牌号', '6082', '其他'),
      row('D-002', '材料状态', 'T6', '热处理'),
      { ...row('D-003', '成品厚度', '成品厚度15'), parameters: [{ name: '厚度', value: '15', unit: 'mm' }] },
      { ...row('D-004', '成品总高', '成品总高120'), parameters: [{ name: '总高', value: '120', unit: 'mm' }] },
      row('D-005', '未注公差', 'ISO TEST-P1'),
      row('D-006', '关键尺寸', '★孔距80±0.1'),
      row('D-007', '具体表面保护', '图示保护膜覆盖指定表面', '表面处理'),
      row('D-008', '渗透探伤', '图示表面100%PT', '检验'),
    ],
    dispositions: [], warnings: [],
  };
  const specification = {
    scopePolicy: SCOPE_POLICY,
    metadata: { number: 'MOCK-SPEC', title: '模拟规范', version: '1', scope: '模拟材料', excludedProcesses: [], priorityPolicy: '图纸优先' },
    rules: [
      rule('R-I1', 'inspection', '模拟成分检验'),
      { ...rule('R-C1', 'comparison', '未注公差默认值'), requirement: '未规定时ISO TEST-P2' },
      { ...rule('R-I2', 'inspection', '另一材料的检验'), scope: '另一材料' },
    ],
    warnings: [],
  };
  const delta = {
    additions: [{
      ...row('ADD-001', '模拟成分检验', '测试成分≤0.09%', '检验'),
      origin: 'specification', ruleIds: ['R-I1'], sources: [source('spec.pdf')],
    }],
    bindings: [{
      id: 'D-005', ruleIds: ['R-C1'], sources: [source('spec.pdf')],
      conflict: { kind: 'drawing_override', specificationRequirement: '未规定时ISO TEST-P2', reason: '图纸已明确规定' },
      review_required: false, review_note: '',
    }],
    dispositions: [
      { ruleId: 'R-I1', status: 'applicable', reason: '本件材料符合', evidence: [source('spec.pdf')] },
      { ruleId: 'R-I2', status: 'not_applicable', reason: '仅另一材料适用', evidence: [source('spec.pdf')] },
    ],
    warnings: [],
  };
  return { read, specification, delta };
}
const merge = ({ read, delta, specification }) => applyNormMatchDelta(read, delta, specification, drawingPrepared, specPrepared);
const deepFreeze = value => {
  if (value && typeof value === 'object') {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
};
const withRawStock = read => {
  read.drawing.materialForm = '板材';
  read.drawing.facts.push(
    { name: '原材料形态', value: '板材', sources: [source()] },
    { name: '原材料公称厚度', value: '44', sources: [source()] },
    { name: '原材料公称直径', value: '88', sources: [source()] },
  );
  return read;
};

test('retained mixed wording changes keep the complete list and only flag affected rows and linked rules', () => {
  const { read, matched, audited } = boundAuditFixture();
  const item = fixture();
  audited.requirements.find(row => row.id === 'D-008').requirement = '图示表面：10%PT；规范补充方法按MOCK-METHOD执行';
  const snapshots = [clone(read), clone(matched), clone(audited)];
  const result = retainDrawingCandidate({ read: deepFreeze(read), matched: deepFreeze(matched), audited: deepFreeze(audited),
    specification: item.specification, drawingPrepared, specPrepared, reason: '复核修改措辞，相关条目待确认。' });
  assert.equal(result.review.status, 'needs_review');
  assert.equal(result.requirements.length, audited.requirements.length);
  assert.equal(result.requirements.find(row => row.id === 'D-008').requirement, audited.requirements.find(row => row.id === 'D-008').requirement);
  assert.equal(result.requirements.find(row => row.id === 'D-008').review_required, true);
  assert.equal(result.requirements.find(row => row.id === 'ADD-001').review_required, true);
  assert.equal(result.requirements.find(row => row.id === 'D-003').review_required, false);
  assert.deepEqual(result.review.pendingRuleIds, ['R-I1']);
  assert.equal(result.ruleCoverage.decided, 1);
  assert.equal(result.ruleCoverage.notApplicable, 1);
  assert.equal(result.ruleCoverage.pending, 1);
  assert.deepEqual([read, matched, audited], snapshots);
});

test('changed D bindings propagate both previous and new rule associations', () => {
  const { read, matched, audited } = boundAuditFixture(), item = fixture();
  const changed = audited.requirements.find(row => row.id === 'D-008');
  changed.scope = '另一个图示受检区域';
  changed.ruleIds = ['R-I2'];
  audited.dispositions.find(row => row.ruleId === 'R-I2').status = 'needs_confirmation';
  const result = retainDrawingCandidate({ read, matched, audited, specification: item.specification, drawingPrepared, specPrepared });
  assert.deepEqual(new Set(result.review.pendingRuleIds), new Set(['R-I1', 'R-I2']));
  assert.equal(result.requirements.find(row => row.id === 'ADD-001').review_required, true);
  assert.equal(result.requirements.find(row => row.id === 'D-008').scope, '另一个图示受检区域');
  assert.equal(result.ruleCoverage.decided, 0);
});

test('a changed matching profile also makes previously not-applicable rules pending without falsifying their model decision', () => {
  const item = fixture(); item.read = validateDrawingRead(item.read, drawingPrepared);
  const matched = merge(item), audited = clone(matched); audited.drawing.material = '另一个材料';
  const result = retainDrawingCandidate({ ...item, matched, audited, drawingPrepared, specPrepared });
  assert.deepEqual(new Set(result.review.pendingRuleIds), new Set(['R-I1', 'R-I2']));
  assert.equal(result.dispositions.find(row => row.ruleId === 'R-I2').status, 'not_applicable');
  assert.equal(result.ruleCoverage.notApplicable, 0);
  assert.equal(result.ruleCoverage.modelDecided, 2);
  assert.equal(result.ruleCoverage.decided, 0);
  assert.equal(result.requirements.find(row => row.id === 'D-004').review_required, false);
  assert.equal(reviewRuleCoverage({ ...result, ruleCoverage: { decided: 2 } }, item.specification).decided, 0);
});

test('ordinary corrected geometry only flags its own row rather than all normative inspection', () => {
  const item = fixture(); item.read = validateDrawingRead(item.read, drawingPrepared);
  const matched = merge(item), audited = clone(matched); audited.requirements.find(row => row.id === 'D-004').requirement = '成品总高121';
  const result = retainDrawingCandidate({ ...item, matched, audited, drawingPrepared, specPrepared });
  assert.deepEqual(result.review.affectedRequirementIds, ['D-004']);
  assert.deepEqual(result.review.pendingRuleIds, []);
  assert.equal(result.requirements.find(row => row.id === 'ADD-001').review_required, false);
});

test('partial norm failure retains only strict drawing contents and reports missing normative decisions', () => {
  const item = fixture(), before = clone(item.read);
  const result = retainDrawingCandidate({ read: item.read, specification: item.specification, drawingPrepared, specPrepared,
    partialStage: '规范匹配', reason: '失败 C:/private/key.txt\nsk-abcdefghijklmnop' });
  assert.equal(result.review.status, 'partial');
  assert.equal(result.requirements.length, item.read.requirements.length);
  assert.ok(result.requirements.every(row => row.origin === 'drawing' && !row.ruleIds.length));
  assert.deepEqual(result.dispositions, []);
  assert.equal(result.ruleCoverage.total, 2);
  assert.equal(result.ruleCoverage.decided, 0);
  assert.equal(result.ruleCoverage.pending, 2);
  assert.doesNotMatch(JSON.stringify(result.review), /C:\/private|sk-abcdefghijklmnop/);
  assert.deepEqual(item.read, before);
});

test('retaining saved candidates never accepts invalid pages, foreign sources or unknown rules', () => {
  for (const alter of [value => { value.requirements[0].sources[0].page = 2; },
    value => { value.requirements[0].sources[0].file = 'foreign.pdf'; },
    value => { value.requirements.find(row => row.id === 'ADD-001').ruleIds = ['UNKNOWN']; }]) {
    const item = fixture(); item.read = validateDrawingRead(item.read, drawingPrepared);
    const matched = merge(item), audited = clone(matched); alter(audited);
    assert.throws(() => retainDrawingCandidate({ ...item, matched, audited, drawingPrepared, specPrepared }));
  }
});

test('drawing read accepts only drawing facts and leaves the raw object unchanged', () => {
  const { read } = fixture(), before = clone(read);
  const checked = validateDrawingRead(deepFreeze(read), drawingPrepared);
  assert.equal(checked.drawing.material, '6082-T6');
  assert.equal(checked.requirements.length, before.requirements.length);
  assert.ok(checked.requirements.every(item => item.origin === 'drawing' && item.ruleIds.length === 0 && item.conflict === null));
  assert.deepEqual(checked.dispositions, []);
  assert.deepEqual(read, before);
});

test('drawing read rejects hidden normative content and arbitrary extra fields', () => {
  for (const alter of [
    value => { value.hiddenSpecification = '规范内容'; },
    value => { value.drawing.matchingProfile = { stockThickness: '15' }; },
    value => { value.requirements[0].usage = 'inspection'; },
    value => { value.requirements[0].parameters = [{ name: 'x', value: '1', unit: '', inferred: true }]; },
    value => { value.requirements[0].sources[0].foreignField = true; },
    value => { value.drawing.facts.push({ name: '图号', value: 'P', sources: [source()], inferred: true }); },
    value => { value.requirements[0].origin = 'specification'; },
    value => { value.requirements[0].ruleIds = ['R-I1']; },
    value => { value.requirements[0].conflict = { kind: 'conflict', specificationRequirement: 'S', reason: 'R' }; },
    value => { value.dispositions = [{ ruleId: 'R-I1', status: 'applicable', reason: '不能提前匹配', evidence: [source()] }]; },
  ]) {
    const { read } = fixture(); alter(read);
    assert.throws(() => validateDrawingRead(read, drawingPrepared));
  }
});

test('drawing read rejects duplicate IDs and sources outside the current drawing', () => {
  const duplicated = fixture().read;
  duplicated.requirements.push(clone(duplicated.requirements[0]));
  assert.throws(() => validateDrawingRead(duplicated, drawingPrepared));
  for (const badSource of [source('spec.pdf'), source('another-part.pdf'), source('part.pdf', 2)]) {
    const read = fixture().read; read.requirements[0].sources = [badSource];
    assert.throws(() => validateDrawingRead(read, drawingPrepared));
    const factRead = fixture().read; factRead.drawing.facts = [{ name: '图号', value: 'P', sources: [badSource] }];
    assert.throws(() => validateDrawingRead(factRead, drawingPrepared));
  }
});

test('raw material form needs an explicit same-value fact rather than a shape inference', () => {
  const read = fixture().read; read.drawing.materialForm = '板材';
  assert.throws(() => validateDrawingRead(read, drawingPrepared));
  read.drawing.facts = [{ name: '原材料形态', value: '棒材', sources: [source()] }];
  assert.throws(() => validateDrawingRead(read, drawingPrepared));
  read.drawing.facts[0].value = '板材';
  assert.equal(validateDrawingRead(read, drawingPrepared).drawing.materialForm, '板材');
  read.drawing.facts[0].name = '成品形态';
  assert.throws(() => validateDrawingRead(read, drawingPrepared));
});

test('norm delta binds evidence while preserving drawing wording, parameters and input objects', () => {
  const item = fixture();
  item.read = validateDrawingRead(item.read, drawingPrepared);
  const beforeRead = clone(item.read), beforeDelta = clone(item.delta);
  const merged = merge({ ...item, read: deepFreeze(item.read), delta: deepFreeze(item.delta) });
  const bound = merged.requirements.find(value => value.id === 'D-005');
  assert.equal(bound.origin, 'combined');
  assert.equal(bound.requirement, beforeRead.requirements.find(value => value.id === 'D-005').requirement);
  assert.deepEqual(bound.parameters, beforeRead.requirements.find(value => value.id === 'D-005').parameters);
  assert.deepEqual(bound.ruleIds, ['R-C1']);
  assert.ok(bound.sources.some(value => value.file === 'part.pdf'));
  assert.ok(bound.sources.some(value => value.file === 'spec.pdf'));
  assert.equal(bound.conflict.kind, 'drawing_override');
  assert.equal(bound.review_required, false);
  assert.equal(merged.requirements.find(value => value.id === 'ADD-001').origin, 'specification');
  assert.equal(merged.ruleCoverage.total, 2);
  assert.equal(merged.ruleCoverage.decided, 2);
  assert.deepEqual(item.read, beforeRead);
  assert.deepEqual(item.delta, beforeDelta);
});

test('norm delta cannot smuggle drawing changes through extra fields', () => {
  for (const alter of [
    value => { value.requirements = []; },
    value => { value.drawing = { material: 'OTHER' }; },
    value => { value.profile = { rawThickness: '15' }; },
    value => { value.bindings[0].requirement = '重写图纸指标'; },
    value => { value.bindings[0].parameters = [{ name: 'x', value: '1', unit: '' }]; },
    value => { value.bindings[0].scope = '改变受控区域'; },
    value => { value.bindings[0].origin = 'combined'; },
    value => { value.additions[0].profile = {}; },
    value => { value.additions[0].parameters = [{ name: 'x', value: '1', unit: '', inferred: true }]; },
    value => { value.bindings[0].sources[0].inferred = true; },
    value => { value.dispositions[0].replacementRequirement = '夹带改写'; },
    value => { value.dispositions[0].evidence[0].inferred = true; },
  ]) {
    const item = fixture(); alter(item.delta);
    assert.throws(() => merge(item), undefined, alter.toString());
  }
});

test('norm delta rejects unknown and duplicate drawing, addition, and rule IDs', () => {
  for (const alter of [
    value => { value.bindings[0].id = 'D-UNKNOWN'; },
    value => { value.bindings.push(clone(value.bindings[0])); },
    value => { value.additions.push(clone(value.additions[0])); },
    value => { value.additions[0].id = 'D-001'; },
    value => { value.additions[0].ruleIds = ['R-UNKNOWN']; },
    value => { value.bindings[0].ruleIds = ['R-UNKNOWN']; },
    value => { value.bindings[0].ruleIds = ['R-C1', 'R-C1']; },
    value => { value.additions[0].ruleIds = ['R-I1', 'R-I1']; },
  ]) {
    const item = fixture(); alter(item.delta);
    assert.throws(() => merge(item));
  }
});

test('norm delta additions are inspection-only and may not manufacture new drawing rows', () => {
  for (const alter of [
    value => { value.additions[0].ruleIds = ['R-C1']; },
    value => { value.additions[0].origin = 'drawing'; },
    value => { value.additions[0].origin = 'combined'; },
    value => { value.additions[0].conflict = { kind: 'conflict', specificationRequirement: 'S', reason: 'R' }; },
    value => { value.additions[0].ruleIds = []; },
  ]) {
    const item = fixture(); alter(item.delta);
    assert.throws(() => merge(item));
  }
});

test('norm delta sources stay within specification pages and never import another part', () => {
  for (const badSource of [source('part.pdf'), source('another-part.pdf'), source('spec.pdf', 2)]) {
    for (const field of ['additions', 'bindings']) {
      const item = fixture(); item.delta[field][0].sources = [badSource];
      assert.throws(() => merge(item));
    }
    const item = fixture(); item.delta.dispositions[0].evidence = [badSource.file === 'part.pdf' ? source('another-part.pdf') : badSource];
    assert.throws(() => merge(item));
  }
  const item = fixture(); item.delta.bindings[0].sources = [];
  assert.throws(() => merge(item));
});

test('the existing inspection disposition completeness and applicability checks still govern the merged result', () => {
  for (const alter of [
    value => { value.dispositions.pop(); },
    value => { value.dispositions.push(clone(value.dispositions[0])); },
    value => { value.dispositions[0].ruleId = 'R-UNKNOWN'; },
    value => { value.dispositions[0].status = 'not_applicable'; },
    value => { value.dispositions[1].status = 'needs_confirmation'; },
  ]) {
    const item = fixture(); alter(item.delta);
    assert.throws(() => merge(item));
  }
});

test('an overridden inspection needs both source documents and a prominent binding conflict', () => {
  const item = fixture();
  item.specification.rules.find(value => value.id === 'R-C1').usage = 'inspection';
  item.delta.dispositions.push({
    ruleId: 'R-C1', status: 'overridden', reason: '图纸专用规定覆盖默认值',
    evidence: [source(), source('spec.pdf')],
  });
  assert.equal(merge(item).ruleCoverage.overridden, 1);
  const oneSide = clone(item); oneSide.delta.dispositions.at(-1).evidence = [source('spec.pdf')];
  assert.throws(() => merge(oneSide));
  const noConflict = clone(item); noConflict.delta.bindings[0].conflict = null;
  assert.throws(() => merge(noConflict));
  const realConflict = clone(item);
  realConflict.delta.dispositions.at(-1).status = 'applicable';
  realConflict.delta.bindings[0].conflict.kind = 'conflict';
  assert.equal(merge(realConflict).requirements.find(value => value.id === 'D-005').review_required, true);
});

test('matching projection excludes ordinary finished geometry and marks unknown stock explicitly', () => {
  const read = validateDrawingRead(fixture().read, drawingPrepared);
  const projected = drawingMatchingInput(read), text = JSON.stringify(projected);
  assert.match(text, /6082/);
  assert.match(text, /T6/);
  assert.match(text, /unknown/i);
  assert.doesNotMatch(text, /成品厚度|成品总高|"15"|"120"/);
  assert.match(text, /ISO TEST-P1/);
  assert.match(text, /before_finish/);
  assert.match(text, /unspecified/);
  assert.deepEqual(drawingMatchingInput(read), projected);
});

test('matching projection accepts stock section values only from the explicit raw-material fact names', () => {
  const read = withRawStock(fixture().read);
  read.drawing.facts.push({ name: '成品厚度', value: '999', sources: [source()] });
  read.drawing.facts.push({ name: '原材料厚度', value: '777', sources: [source()] });
  read.drawing.facts.push({ name: '原材料直径', value: '666', sources: [source()] });
  const checked = validateDrawingRead(read, drawingPrepared);
  const text = JSON.stringify(drawingMatchingInput(checked));
  assert.match(text, /板材/);
  assert.match(text, /44/);
  assert.match(text, /88/);
  assert.doesNotMatch(text, /999|777|666|成品厚度|成品总高/);
});

test('annotated ISO, EN and GB references retain their actual standard rows without exposing ordinary geometry', () => {
  const item = fixture();
  item.read.drawing.references = ['ISO 2768-mK（尺寸未注公差）', 'EN 15085-3（焊缝等级依据）', 'GB/T 1804-m（另一明确约束）'];
  item.read.requirements.push(
    row('D-ISO', '未注公差', '尺寸未注公差按ISO 2768-mK'),
    row('D-EN', '图示标准依据', '本图明确采用EN 15085-3'),
    row('D-GB', '图示标准依据', '另一明确约束按GB/T 1804-m'),
    row('D-OTHER', '非所列标准', 'ISO 99999'),
  );
  const before = clone(item.read), projected = drawingMatchingInput(validateDrawingRead(item.read, drawingPrepared));
  const ids = projected.technicalConstraints.map(value => value.id);
  for (const id of ['D-ISO', 'D-EN', 'D-GB']) assert.ok(ids.includes(id), id);
  for (const id of ['D-003', 'D-004', 'D-OTHER']) assert.equal(ids.includes(id), false, id);
  assert.doesNotMatch(JSON.stringify(projected), /成品厚度|成品总高|"15"|"120"/);
  assert.equal(projected.rawMaterial.nominalThickness, 'unknown');
  item.delta.bindings[0].id = 'D-ISO';
  const combined = merge(item).requirements.find(value => value.id === 'D-ISO');
  assert.equal(combined.conflict.kind, 'drawing_override');
  assert.equal(combined.requirement, '尺寸未注公差按ISO 2768-mK');
  assert.ok(combined.sources.some(value => value.file === 'part.pdf'));
  assert.ok(combined.sources.some(value => value.file === 'spec.pdf'));
  assert.deepEqual(item.read, before);
});

test('dimensional importance maps concrete features with leading or trailing marks and excludes general legends', () => {
  const read = fixture().read;
  read.requirements.push(
    row('D013', '未注尺寸公差', '除标记★/▲之外的其余尺寸为一般尺寸，尺寸未注公差按ISO 2768-mK'),
    row('D-LEGEND', '标记说明', '标记★为关键尺寸；标记▲为重要尺寸；其余为一般尺寸'),
    row('D-PLAIN-LEGEND', '关键尺寸', '标记★为关键尺寸'),
    row('D-MULTILINE-LEGEND', '关键尺寸', '★为关键尺寸或项点，\n▲为重要尺寸或项点；其余为一般尺寸'),
    row('D-LEADING', '定位孔直径', '★孔径82±0.1'),
    row('D-TRAILING', '定位孔直径', '孔径83±0.1，标记★为关键尺寸'),
    row('D-IMPORTANT-LEADING', '螺纹孔', '▲M12螺纹孔'),
    row('D-IMPORTANT-TRAILING', '定位面', '上端定位面，标记▲为重要尺寸'),
  );
  const projected = drawingMatchingInput(validateDrawingRead(read, drawingPrepared));
  assert.deepEqual(projected.dimensionalInspection.critical, { exists: true, requirementIds: ['D-006', 'D-LEADING', 'D-TRAILING'] });
  assert.deepEqual(projected.dimensionalInspection.important, { exists: true, requirementIds: ['D-IMPORTANT-LEADING', 'D-IMPORTANT-TRAILING'] });
  const passedText = JSON.stringify(projected);
  assert.doesNotMatch(passedText, /82±|83±|M12|成品厚度|成品总高|"15"|"120"/);
  assert.equal(projected.rawMaterial.nominalThickness, 'unknown');
  read.requirements = read.requirements.filter(value => ['D013', 'D-LEGEND', 'D-PLAIN-LEGEND', 'D-MULTILINE-LEGEND'].includes(value.id));
  assert.deepEqual(drawingMatchingInput(read).dimensionalInspection, { critical: { exists: false, requirementIds: [] }, important: { exists: false, requirementIds: [] } });
});

test('norm bindings and audit review metadata do not falsely change drawing matching conditions', () => {
  const item = fixture();
  item.read = validateDrawingRead(withRawStock(item.read), drawingPrepared);
  const before = clone(item.read);
  const merged = merge(item);
  const bound = merged.requirements.find(value => value.id === 'D-005');
  assert.equal(bound.origin, 'combined');
  assert.ok(bound.sources.some(value => value.file === 'spec.pdf'));
  assert.doesNotThrow(() => assertMatchingConditionsUnchanged(before, merged));
  bound.review_required = true;
  bound.review_note = '审核只补充说明，不改变条件';
  for (const value of bound.sources) value.verification = 'visual_review';
  assert.doesNotThrow(() => assertMatchingConditionsUnchanged(before, merged));
  assert.deepEqual(item.read, before);
});

test('audit may correct ordinary geometry but must not silently change matching conditions', () => {
  const before = validateDrawingRead(withRawStock(fixture().read), drawingPrepared);
  const ordinaryCorrection = clone(before);
  ordinaryCorrection.requirements.find(value => value.id === 'D-003').requirement = '成品厚度16';
  ordinaryCorrection.requirements.find(value => value.id === 'D-003').parameters[0].value = '16';
  assert.doesNotThrow(() => assertMatchingConditionsUnchanged(before, ordinaryCorrection));
  for (const alter of [
    value => { value.drawing.material = '6061-T6'; },
    value => { value.drawing.airtightness = 'not_required'; },
    value => { value.drawing.dimensionState = 'after_finish'; },
    value => { value.drawing.materialForm = '棒材'; value.drawing.facts.find(fact => fact.name === '原材料形态').value = '棒材'; },
    value => { value.drawing.facts.find(fact => fact.name === '原材料公称厚度').value = '45'; },
    value => { value.drawing.facts.find(fact => fact.name === '原材料公称直径').value = '89'; },
    value => { value.requirements.find(requirement => requirement.id === 'D-005').requirement = 'ISO TEST-P3'; },
    value => { value.requirements.find(requirement => requirement.id === 'D-008').requirement = '图示表面10%PT'; },
  ]) {
    const after = clone(before); alter(after);
    assert.throws(() => assertMatchingConditionsUnchanged(before, after));
  }
});

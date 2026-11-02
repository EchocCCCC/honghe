import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { verifyRequirement } from '../server/two-stage-schema.js';

test('the browser does not turn explanatory source notes into review flags', async () => {
  const source = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('  const informationNames = '), end = source.indexOf('  function informationSummary(', start);
  assert.ok(start >= 0 && end > start);
  const { needsReview } = vm.runInNewContext(`(() => {${source.slice(start, end)} return {needsReview};})()`);
  const clear = { informationType: 'quality', review_required: false, review_note: '尺寸来自清晰的整图及局部图视觉识读。', sources: [{ verification: 'visual_review' }] };
  assert.equal(needsReview(clear), false);
  assert.equal(needsReview({ ...clear, review_required: true, review_note: 'k6下偏差看不清' }), true);
  assert.equal(needsReview({ ...clear, classificationPending: true }), true);
  assert.equal(needsReview({ ...clear, informationType: 'unclassified' }), true);
});

test('customer results hide iteration metadata while preserving technical issues and review flags', async () => {
  const source = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const section = (from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));
  const node = (tag, cls, text) => ({ tag, className: cls, textContent: text || '', children: [], append(...items) { this.children.push(...items); } });
  const flow = '复核修改了匹配使用的图纸依据，保留已提取内容并标明受影响的条目及规范关联。';
  const technical = 'Ra3.2引线指水平槽底，受控面需核对。', unlinked = 'φ72受控对象尚需核对。';
  const raw = { drawing: { name: '零件', uncertainties: ['原料厚度未提供'] }, requirements: [
    { id: 'D1', requirement: 'Ra3.2', review_required: true, review_note: flow + '；GPT原图复核：' + technical, sources: [{ file: 'part.pdf', page: 1, quote: 'Ra3.2' }] },
    { id: 'D2', requirement: '图中尺寸为阳极氧化后的尺寸', review_required: true, review_note: flow }],
    warnings: ['流程复核提示：' + flow, '【原图复核】' + technical, '【原图复核】GPT 对照原件的抽查提示，非 DeepSeek 自动结论：' + unlinked],
    run: { processingMode: 'reprocess_existing', model: 'deepseek-flash' }, summary: '已重新整理上轮提取结果',
    review: { status: 'needs_review', note: flow, pendingRuleIds: ['R1'], affectedRequirementIds: ['D1', 'D2'] } };
  const before = JSON.stringify(raw);
  const context = vm.createContext({ el: node,
    list: value => Array.isArray(value) ? value : [], str: value => value == null ? '' : String(value),
    details: title => { const element = node('details', '', title), body = node('div'); element.append(body); return { node: element, body }; } });
  vm.runInContext(section('  const informationNames = ', '  const uniqueText = ') + '\n' + section('  function warnings(', '  function coverage(') + '\nthis.project=customerResult;this.showNotes=warnings;', context);
  const result = context.project(raw), plain = value => JSON.parse(JSON.stringify(value));
  assert.equal(JSON.stringify(raw), before);
  assert.equal(result.requirements[0].review_note, technical);
  assert.equal(result.requirements[1].review_note, '');
  assert.deepEqual(plain(result.requirements.map(row => row.review_required)), [true, true]);
  assert.equal(result.requirements[0].requirement, raw.requirements[0].requirement);
  assert.deepEqual(plain(result.requirements[0].sources), raw.requirements[0].sources);
  assert.deepEqual(plain(result.review.pendingRuleIds), ['R1']);
  assert.deepEqual(plain(result.warnings), [unlinked]);
  assert.ok(!JSON.stringify(result).includes('GPT'));
  assert.ok(!JSON.stringify(result).includes('reprocess_existing'));
  assert.ok(!JSON.stringify(result).includes(flow));
  const panel = context.showNotes(result.warnings);
  assert.equal(panel.textContent, '提取说明与疑点 · 1 项');
  const body = panel.children[0];
  assert.match(body.children[0].textContent, /对应条目和原文依据/);
  assert.deepEqual(body.children[1].children.map(item => item.textContent), [unlinked]);
});

test('conditional hints keep structured pending issues without repeating extraction or GPT notes', async () => {
  const source = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('  function pendingIssues('), end = source.indexOf('  function retryAction(', start);
  const context = vm.createContext({ list: value => Array.isArray(value) ? value : [], str: String,
    withPendingDispositions: (_, rows) => rows, dispositionDisplayStatus: row => row.status,
    dispositionDisplayLabel: () => '待确认' });
  vm.runInContext(source.slice(start, end) + '\nthis.pending=pendingIssues;', context);
  const result = { drawing: { uncertainties: ['取样区域不清晰'] }, dispositions: [
    { ruleId: 'R015', status: 'needs_confirmation', reason: '取样条件尚未匹配' },
    { ruleId: 'R016', status: 'applicable', reason: '适用' }],
    warnings: ['已更正数据', '【原图复核】取样判定需重新检查'] };
  assert.deepEqual(Array.from(context.pending(result)), ['取样区域不清晰', 'R015：待确认；取样条件尚未匹配']);
});

test('customer drawing view removes whole-result review and GPT cards but retains row issues and incomplete status', async () => {
  const source = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const section = (from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));
  const node = (tag, cls, text) => ({ tag, className: cls || '', textContent: text || '', children: [], dataset: {},
    classList: { add() {}, toggle() {} }, setAttribute() {}, addEventListener() {}, querySelectorAll() { return []; },
    append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; } });
  const walk = element => [element, ...element.children.flatMap(walk)];
  const technical = 'Ra3.2指向槽底，需核对对应面。';
  const result = { scopePolicy: 'drawing-plus-inspection-v1', drawing: { name: '零件', uncertainties: [] },
    summary: '已重新整理上轮提取结果', run: { processingMode: 'reprocess_existing' },
    requirements: [{ id: 'D1', category: '槽底粗糙度', requirement: 'Ra3.2', processCategory: '机加', informationType: 'quality', origin: 'drawing', ruleIds: [], sources: [], review_required: true, review_note: 'GPT原图复核：' + technical }],
    warnings: ['【原图复核】GPT 对照原件的抽查提示，非 DeepSeek 自动结论：' + technical], dispositions: [],
    review: { status: 'needs_review', pendingRuleIds: [], affectedRequirementIds: ['D1'], note: '内部复核状态说明' } };
  for (const status of ['completed', 'partial', 'failed']) {
    const holder = node('div'), exports = node('button'), raw = structuredClone(result);
    if (status === 'partial') Object.assign(raw.review, { status: 'partial', incompleteStage: '规范匹配' });
    const before = JSON.stringify(raw);
    const context = vm.createContext({ state: { filter: 'core', search: '', batch: { stage: 'all' } },
      $: id => id === 'drawing-result' ? holder : exports, list: value => Array.isArray(value) ? value : [],
      str: value => value == null ? '' : String(value), enc: encodeURIComponent, el: node, statusNames: { failed: '处理失败' },
      stageNames: { all: '全部阶段' }, dispositionNames: { applicable: '适用', not_applicable: '不适用', needs_confirmation: '待确认' },
      originNames: { drawing: '图纸要求' }, uniqueText: values => [...new Set(values.filter(Boolean))],
      context: () => ({}), sourceLink: text => node('a', '', text), parameters: () => null, evidence: () => node('details', 'evidence'),
      coverage: () => null, dispositionPanel: () => node('details', 'dispositions'), retryAction: () => null,
      statusBox: drawing => node('div', 'status-box', drawing.status), stats: () => node('div', 'stats'),
      details: title => { const element = node('details', '', title), body = node('div'); element.append(body); return { node: element, body }; } });
    vm.runInContext(section('  const informationNames = ', '  const uniqueText = ') + '\n' +
      section('  function warnings(', '  function coverage(') + '\n' +
      section('  function renderRequirement(', '  function dispositionPanel(') + '\n' +
      section('  function pendingIssues(', '  function retryAction(') + '\n' +
      section('  function renderDrawing(', '  function renderBatch(') + '\nthis.show=renderDrawing;', context);
    context.show({ id: 'part', name: 'part.pdf', status, result: raw });
    const elements = walk(holder), text = elements.map(el => el.textContent).join(' ');
    assert.equal(JSON.stringify(raw), before);
    assert.ok(!text.includes('GPT'));
    assert.ok(!text.includes('已重新整理'));
    assert.ok(!text.includes('已提取 · 待复核'));
    assert.ok(!elements.some(el => el.className.includes('result-review-notice')));
    if (status === 'failed') {
      assert.ok(elements.some(el => el.className === 'status-box'));
      assert.match(text, /没有可展示的有效清单/);
    } else {
      assert.ok(text.includes(technical));
      assert.ok(text.includes('待复核'));
      assert.equal(elements.some(el => el.className.includes('partial-extraction-note')), status === 'partial');
      if (status === 'partial') assert.match(text, /规范匹配尚未完成/);
    }
  }
});

const source = { file: 'scan.pdf', page: 1, quote: '膜厚 20~40 μm' };
const clear = () => ({ review_required: false, review_note: '', sources: [{ ...source }] });
const scanned = () => [{ name: 'scan.pdf', pages: 1, textPages: [''], imagePages: [1], needsVisualReview: [] }];

test('clear image-only evidence keeps its visual provenance without a review flag', () => {
  const item = clear(), before = structuredClone(item);
  const checked = verifyRequirement(item, scanned());
  assert.equal(checked.sources[0].verification, 'visual_review');
  assert.equal(checked.review_required, false);
  assert.equal(checked.review_note, '');
  assert.deepEqual(item, before);
  assert.deepEqual(verifyRequirement(checked, scanned()), checked);
});

test('an explicit model reading ambiguity remains flagged for image evidence', () => {
  const item = { ...clear(), review_required: true, review_note: '膜厚末位可能为0或8，待核对。' };
  const checked = verifyRequirement(item, scanned());
  assert.equal(checked.review_required, true);
  assert.equal(checked.review_note, item.review_note);
});

test('retired blanket image notices are removed without clearing an existing model flag', () => {
  const note = '图像证据待人工核对；已提交模型不等于语义正确。';
  const item = { ...clear(), review_required: true, review_note: `引线对应区域不清。 ${note} ${note}` };
  const once = verifyRequirement(item, scanned()), twice = verifyRequirement(once, scanned());
  assert.equal(twice.review_note, '引线对应区域不清。');
  assert.equal(twice.review_required, true);
  assert.deepEqual(twice, once);
  // The normal validator cannot establish why a historical boolean was true.
  const historical = verifyRequirement({ ...clear(), review_required: true, review_note: note }, scanned());
  assert.equal(historical.review_required, true);
  assert.equal(historical.review_note, '');
});

test('an unlocated quote without a submitted page image still requires review', () => {
  const docs = scanned(); docs[0].imagePages = [];
  const once = verifyRequirement(clear(), docs), twice = verifyRequirement(once, docs);
  assert.equal(once.sources[0].verification, 'unmatched_quote');
  assert.equal(once.review_required, true);
  assert.match(once.review_note, /引文未能在文字层定位且该页未提交图像/);
  assert.deepEqual(twice, once);
});

test('incomplete visual page coverage remains a concrete review reason', () => {
  const docs = scanned(); docs[0].needsVisualReview = [1];
  const checked = verifyRequirement(clear(), docs);
  assert.equal(checked.review_required, true);
  assert.match(checked.review_note, /视觉覆盖不完整/);
});

test('matching text evidence does not clear an explicit semantic uncertainty', () => {
  const docs = scanned(); docs[0].textPages = [source.quote];
  const checked = verifyRequirement({ ...clear(), review_required: true, review_note: '该膜厚适用的区域未确认。' }, docs);
  assert.equal(checked.sources[0].verification, 'text_match');
  assert.equal(checked.review_required, true);
  assert.equal(checked.review_note, '该膜厚适用的区域未确认。');
});

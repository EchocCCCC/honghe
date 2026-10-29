import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { informationDigest, validateInformationProfile, decorateInformation, readInformationView, decorateDispositions } from '../server/information-types.js';
import { validateMatching, matchingSchema, ruleSchema } from '../server/two-stage-schema.js';

const source = { file: 'spec.pdf', page: 1, section: '3', quote: 'source text' };
const row = (id, informationType = 'quality') => ({ id, informationType, category: '检验方法', requirement: 'source text', scope: '', parameters: [], sources: [source], review_required: false, review_note: '', strength: 'required', conditions: [], exceptions: [], overridePolicy: '', externalReferences: [] });
const spec = () => ({ metadata: {}, rules: [row('R1'), row('R2', 'context')], warnings: [] });
const legacy = () => { const result = spec(); for (const item of result.rules) delete item.informationType; return result; };
const profile = result => ({ resultSha256: informationDigest(result), model: 'deepseek-flash', skillSha256: 'a'.repeat(64), items: [{ id: 'R1', informationType: 'quality', reason: '验收要求' }, { id: 'R2', informationType: 'context', reason: '仅定义术语' }] });
const docs = name => ({ documents: [{ name, pages: 1, textPages: ['source text'], imagePages: [1] }] });
const matching = () => ({ drawing: { airtightness: 'unspecified', dimensionState: 'unspecified' }, summary: '', requirements: [{ ...row('REQ1'), origin: 'specification', ruleIds: ['R1'] }], dispositions: [{ ruleId: 'R1', status: 'applicable', reason: 'applies', evidence: [source] }], warnings: [] });

test('background records do not increase actionable counts or require a disposition', () => {
  const result = validateMatching(matching(), spec(), docs('part.pdf'), docs('spec.pdf'));
  assert.equal(result.ruleCoverage.total, 1);
  assert.equal(result.ruleCoverage.decided, 1);
  assert.equal(result.ruleCoverage.backgroundRecords, 1);
  const extra = matching(); extra.dispositions.push({ ruleId: 'R2', status: 'applicable', reason: 'legacy background row', evidence: [source] });
  assert.equal(validateMatching(extra, spec(), docs('part.pdf'), docs('spec.pdf')).ruleCoverage.decided, 1);
  extra.requirements[0].ruleIds.push('R2');
  assert.throws(() => validateMatching(extra, spec(), docs('part.pdf'), docs('spec.pdf')), /背景定义或导航/);
});

test('new model contracts require valid types and reject background effective requirements', () => {
  const missing = row('R1'); delete missing.informationType;
  assert.equal(ruleSchema.safeParse(missing).success, false);
  const result = matching(); result.requirements[0].informationType = 'context';
  assert.equal(matchingSchema.safeParse(result).success, false);
  result.requirements[0].informationType = 'other';
  assert.equal(matchingSchema.safeParse(result).success, false);
});

test('exact-hash classification profiles annotate a copy without rewriting original records', () => {
  const original = legacy(), before = structuredClone(original), view = decorateInformation(original, profile(original));
  assert.deepEqual(original, before);
  assert.equal(view.rules[1].informationType, 'context');
  assert.deepEqual(view.informationSummary, { total: 2, manufacturing: 0, quality: 1, procurement: 0, context: 1, unclassified: 0, core: 1, actionable: 1 });
  assert.equal(view.rules[0].classification.source, 'legacy_profile');
  assert.equal(view.classification.resultSha256, informationDigest(original));
  assert.equal(view.rules[1].requirement, before.rules[1].requirement);
});

test('stale, incomplete, duplicate and fabricated profile IDs are rejected without hiding old records', () => {
  const raw = legacy(), valid = profile(raw);
  for (const change of [p => { p.resultSha256 = '0'.repeat(64); }, p => p.items.pop(), p => p.items.push(p.items[0]), p => { p.items[0].id = 'unknown'; }, p => { p.items[0].informationType = 'other'; }, p => { p.items[0].review_required = 'yes'; }]) {
    const bad = structuredClone(valid); change(bad);
    assert.throws(() => validateInformationProfile(raw, bad));
    const view = decorateInformation(raw, bad);
    assert.equal(view.rules.length, raw.rules.length);
    assert.equal(view.informationSummary.context, 0);
    assert.equal(view.classification.status, 'pending');
    assert.ok(view.classification.warnings.length);
  }
});

test('legacy categories never turn unknown material or batch definitions into confirmed manufacturing', () => {
  const raw = { rules: [{ id: 'a', category: '材料' }, { id: 'b', category: '检验频率', requirement: '炉批定义' }, { id: 'c', category: '文件与交付' }] };
  const view = decorateInformation(raw);
  assert.equal(view.rules[0].informationType, 'unclassified');
  assert.equal(view.rules[1].informationType, 'quality');
  assert.equal(view.rules[2].informationType, 'procurement');
  assert.equal(view.informationSummary.context, 0);
  assert.equal(view.rules.every(item => item.classification.pending), true);
});

test('mixed legacy profiles stay visible in core while carrying the need to split the source clause', () => {
  const raw = legacy(), p = profile(raw); p.items[0].review_required = true;
  const view = decorateInformation(raw, p);
  assert.equal(view.informationSummary.core, 1);
  assert.equal(view.rules[0].classification.pending, true);
  assert.equal(view.rules[0].review_required, false);
});

test('a mixed context candidate stays unclassified and visible rather than becoming confirmed background', () => {
  const raw = legacy(), p = profile(raw); p.items[1].review_required = true;
  const view = decorateInformation(raw, p);
  assert.equal(view.rules[1].informationType, 'unclassified');
  assert.equal(view.rules[1].classification.proposedType, 'context');
  assert.equal(view.informationSummary.context, 0);
  assert.equal(view.informationSummary.unclassified, 1);
  assert.equal(view.classification.status, 'pending');
  assert.equal(raw.rules[1].informationType, undefined);
});

test('historical background dispositions have their own type and are excluded from effective coverage', () => {
  const view = decorateDispositions({ dispositions: [{ ruleId: 'R1', status: 'applicable' }, { ruleId: 'R2', status: 'applicable' }], ruleCoverage: { total: 2 } }, spec());
  assert.equal(view.ruleCoverage.total, 1);
  assert.equal(view.ruleCoverage.decided, 1);
  assert.equal(view.dispositions[1].informationType, 'context');
});

test('sidecar lookup uses raw-result digest and reports invalid JSON without modifying source data', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'honghe-information-'));
  try {
    const raw = legacy(), before = JSON.stringify(raw), dir = path.join(root, 'information-profiles');
    await fs.mkdir(dir); await fs.writeFile(path.join(dir, informationDigest(raw) + '.json'), JSON.stringify(profile(raw)));
    assert.equal((await readInformationView(root, raw)).informationSummary.context, 1);
    await fs.writeFile(path.join(dir, informationDigest(raw) + '.json'), '{bad');
    const failed = await readInformationView(root, raw);
    assert.equal(failed.classification.status, 'pending'); assert.ok(failed.classification.warnings.length);
    assert.equal(JSON.stringify(raw), before);
  } finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.match(path.basename(root), /^honghe-information-/);
    await fs.rm(root, { recursive: true, force: true });
  }
});

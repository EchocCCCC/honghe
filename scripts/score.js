import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from '../server/config.js';
import { normalizeEvidence } from '../server/validation.js';

// A candidate locator, deliberately NOT an accuracy evaluator. The adjudication
// sheet must still be checked for numbers, conditions, contradictions and recall.
const resultPath = process.argv[2];
if (!resultPath) throw new Error('用法: node scripts/score.js evaluation/runs/LABEL/result.json');
const gold = JSON.parse(await fs.readFile(path.join(ROOT, 'evaluation/gold.json'), 'utf8'));
const result = JSON.parse(await fs.readFile(resultPath, 'utf8'));
const rows = gold.items.map(item => {
  const file = gold.documents.find(d => d.id === item.document).file;
  const anchors = item.anchors.map(normalizeEvidence);
  const candidates = result.requirements.filter(r => r.sources.some(s => s.file === file && s.page === item.page)).map(r => {
    const text = normalizeEvidence([r.requirement, r.scope, ...r.parameters.map(p => p.name + p.value + p.unit), ...r.sources.map(s => s.quote)].join(' '));
    const matched = anchors.filter(a => text.includes(a));
    return { id: r.id, matchedAnchors: matched, anchorFraction: matched.length / Math.max(1, anchors.length), requirement: r.requirement };
  }).filter(c => c.anchorFraction >= 0.5).sort((a, b) => b.anchorFraction - a.anchorFraction).slice(0, 5);
  return { goldId: item.id, critical: item.critical, requirement: item.requirement, section: item.section, candidates, judgment: 'UNREVIEWED', notes: '' };
});
const report = {
  label: path.basename(path.dirname(resultPath)), totalGold: rows.length,
  candidateItems: rows.filter(r => r.candidates.length).length,
  note: '仅为页码+关键词候选定位，不能称准确率、召回率或语义通过。需要在judgment字段逐条复核。', rows,
};
const output = path.join(path.dirname(resultPath), 'candidate-review.json');
await fs.writeFile(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ output, totalGold: report.totalGold, candidateItems: report.candidateItems, note: report.note }, null, 2));

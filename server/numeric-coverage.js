// A conservative review aid, not an accuracy metric: a number may be present
// elsewhere on a page without its actual feature having been understood.
function decimals(text) {
  const normalized = String(text || '').normalize('NFKC').replace(/[−–]/g, '-');
  return [...normalized.matchAll(/[+-]?\d+\.\d+/g)]
    .filter(match => !/[A-Za-z]/.test(normalized[match.index - 1] || ''))
    .map(match => ({ literal: match[0], value: Number(match[0]) }));
}

export function findUnrepresentedDrawingNumbers(pages, result) {
  const findings = [];
  for (const page of pages.filter(p => p.landscape)) {
    const items = result.requirements.filter(r => r.sources.some(s => s.file === page.file && s.page === page.page));
    // Quotes are excluded: copying an entire source block is not extraction.
    const renderedFacts = items.flatMap(r => [r.requirement, r.scope, ...r.parameters.flatMap(p => [p.name, p.value, p.unit])]).join(' ');
    const represented = new Set(decimals(renderedFacts).map(n => n.value));
    const seen = new Set();
    const unmatched = decimals(page.text).filter(n => {
      if (seen.has(n.value)) return false;
      seen.add(n.value); return !represented.has(n.value);
    }).map(n => n.literal);
    if (unmatched.length) findings.push({ file: page.file, page: page.page, unmatchedDecimalAnnotations: unmatched,
      note: '这些图纸文字层小数未在同页要求或参数中出现，可能遗漏、换算或识读变化；只提示复核，不自动生成工艺要求。' });
  }
  return findings;
}

export function addNumericCoverageWarnings(prepared, result) {
  const findings = findUnrepresentedDrawingNumbers(prepared.pages, result);
  const warnings = findings.map(f => `${f.file} 第${f.page}页：图纸文字层数值 ${f.unmatchedDecimalAnnotations.join('、')} 未在同页提取要求/参数中出现，疑似遗漏或表达变化，请对照原图核对；数值匹配不能证明语义正确。`);
  return { findings, warnings };
}
